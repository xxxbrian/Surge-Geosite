import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

import { afterAll, describe, expect, test } from "vitest";

import { parseListsFromText } from "../src/parser.js";
import { hasUnsupportedRegexSyntax, normalizeSimpleRe2Pattern } from "../src/regex-syntax.js";
import { emitSurgeRuleset } from "../src/surge.js";
import type { DomainRule, RegexMode, SourceEntry, SurgeRule } from "../src/types.js";

const MODES: RegexMode[] = ["strict", "balanced", "full"];
const DLC_DATA_DIR = requiredInputPath("REGEX_CORPUS_DLC_DATA_DIR");
const TRANCO_CSV = requiredInputPath("REGEX_CORPUS_TRANCO_CSV");
const TRANCO_LIMIT = readPositiveInt(process.env.REGEX_CORPUS_TRANCO_LIMIT, 1_000_000);
const OVERMATCH_LIMIT = readPositiveInt(process.env.REGEX_CORPUS_OVERMATCH_LIMIT, 50);
const OVERMATCH_FACTOR = readPositiveInt(process.env.REGEX_CORPUS_OVERMATCH_FACTOR, 20);
const WORKER_COUNT = readPositiveInt(
  process.env.REGEX_CORPUS_WORKERS,
  Math.max(1, Math.min(os.availableParallelism?.() ?? os.cpus().length, 8) - 1)
);
const VALID_LIST_FILE_NAME = /^[a-z0-9!-]+$/;

interface AuditCase {
  name: string;
  source: string;
  pattern: string;
  referencePattern: string | null;
  mode: RegexMode;
  rules: Array<Pick<SurgeRule, "type" | "value">>;
}

interface AuditResult {
  failures: string[];
  counts: {
    expected: number;
    actual: number;
    overmatches: number;
    omissions: number;
    oracleUnavailable: number;
  };
}

interface WorkerSlot {
  worker: Worker;
  busy: boolean;
}

interface QueueItem {
  auditCase: AuditCase;
  resolve: (result: AuditResult) => void;
  reject: (error: Error) => void;
}

async function createAuditContext(): Promise<{ cases: AuditCase[]; directory: string; corpusPath: string }> {
  const [sources, trancoBytes] = await Promise.all([
    loadListsFromDirectory(DLC_DATA_DIR),
    readFile(TRANCO_CSV)
  ]);
  const sourceHash = createHash("sha256");
  for (const name of Object.keys(sources).sort()) {
    sourceHash.update(name).update("\0").update(sources[name]!).update("\0");
  }
  const dlcSha256 = sourceHash.digest("hex");
  const trancoSha256 = createHash("sha256").update(trancoBytes).digest("hex");
  verifyDigest("REGEX_CORPUS_DLC_SHA256", dlcSha256);
  verifyDigest("REGEX_CORPUS_TRANCO_SHA256", trancoSha256);
  const parsed = parseListsFromText(sources);
  // Each case emits one source regex. Includes and affiliations only duplicate
  // these patterns, so graph resolution adds no coverage to this audit.
  const regexEntries = collectRegexEntries(parsed);
  const corpus = buildCorpus(sources, trancoBytes.toString("utf8"));
  const directory = await mkdtemp(path.join(os.tmpdir(), "surge-geosite-corpus-"));
  const corpusPath = path.join(directory, "corpus.txt");
  await writeFile(corpusPath, `${corpus.join("\n")}\n`, "utf8");
  console.info("Corpus inputs:", JSON.stringify({
    dlcDataDir: DLC_DATA_DIR, dlcSha256, trancoCsv: TRANCO_CSV, trancoSha256,
    trancoLimit: TRANCO_LIMIT, domains: corpus.length, regexes: regexEntries.length,
    overmatchLimit: OVERMATCH_LIMIT, overmatchFactor: OVERMATCH_FACTOR
  }));

  return {
    cases: regexEntries.flatMap((entry) => makeAuditCases(entry)),
    directory,
    corpusPath
  };
}

function makeAuditCases(entry: DomainRule): AuditCase[] {
  const normalized = normalizeSimpleRe2Pattern(entry.value);
  return MODES.map((mode) => {
    const emitted = emitSurgeRuleset({ name: entry.source.list, entries: [entry] }, { regexMode: mode });
    return {
      name: `${entry.source.list}:${entry.source.line} ${mode} ${entry.value}`,
      source: `${entry.source.list}:${entry.source.line}`,
      pattern: entry.value,
      referencePattern: hasUnsupportedRegexSyntax(normalized) ? null : normalized,
      mode,
      rules: emitted.rules.map((rule) => ({ type: rule.type, value: rule.value }))
    };
  });
}

class AuditWorkerPool {
  private readonly slots: WorkerSlot[];
  private readonly queue: QueueItem[] = [];
  private readonly pending = new Map<number, QueueItem>();
  private nextId = 1;

  constructor(size: number, corpusPath: string) {
    const workerUrl = new URL("./regex-corpus.worker.mjs", import.meta.url);
    this.slots = Array.from({ length: size }, () => {
      const worker = new Worker(workerUrl, {
        workerData: {
          corpusPath,
          overmatchFactor: OVERMATCH_FACTOR,
          overmatchLimit: OVERMATCH_LIMIT
        }
      });
      const slot: WorkerSlot = { worker, busy: false };

      worker.on("message", (message: { id: number; result?: AuditResult; error?: string }) => {
        const item = this.pending.get(message.id);
        this.pending.delete(message.id);
        slot.busy = false;

        if (item) {
          if (message.error) {
            item.reject(new Error(message.error));
          } else {
            if (message.result) item.resolve(message.result);
            else item.reject(new Error("Corpus worker returned no result"));
          }
        }

        this.dispatch();
      });

      worker.on("error", (error) => {
        slot.busy = false;
        for (const item of this.pending.values()) {
          item.reject(error instanceof Error ? error : new Error(String(error)));
        }
        this.pending.clear();
      });

      return slot;
    });
  }

  run(auditCase: AuditCase): Promise<AuditResult> {
    return new Promise((resolve, reject) => {
      this.queue.push({ auditCase, resolve, reject });
      this.dispatch();
    });
  }

  async close(): Promise<void> {
    await Promise.all(this.slots.map((slot) => slot.worker.terminate()));
  }

  private dispatch(): void {
    for (const slot of this.slots) {
      if (slot.busy) {
        continue;
      }

      const item = this.queue.shift();
      if (!item) {
        return;
      }

      const id = this.nextId;
      this.nextId += 1;
      slot.busy = true;
      this.pending.set(id, item);
      slot.worker.postMessage({ id, auditCase: item.auditCase });
    }
  }
}

const auditContext = await createAuditContext();
const workerPool = new AuditWorkerPool(WORKER_COUNT, auditContext.corpusPath);
const totals = Object.fromEntries(MODES.map((mode) => [mode, {
  expected: 0, actual: 0, overmatches: 0, omissions: 0, oracleUnavailable: 0
}])) as Record<RegexMode, AuditResult["counts"]>;

afterAll(async () => {
  await workerPool.close();
  await rm(auditContext.directory, { recursive: true, force: true });
  console.info("Corpus match counts (rule/domain pairs):", JSON.stringify(totals));
});

describe("regex conversion corpus audit", () => {
  test.concurrent.each(auditContext.cases)("$name", async (auditCase) => {
    const result = await workerPool.run(auditCase);
    for (const key of Object.keys(result.counts) as Array<keyof AuditResult["counts"]>) {
      totals[auditCase.mode][key] += result.counts[key];
    }
    expect(result.failures).toEqual([]);
  });
});

function requiredInputPath(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`test:corpus requires ${name}; see packages/core/README.md`);
  return path.resolve(value);
}

function verifyDigest(name: string, actual: string): void {
  const expected = process.env[name];
  if (expected && expected.toLowerCase() !== actual) {
    throw new Error(`${name} mismatch: expected ${expected}, received ${actual}`);
  }
}

async function loadListsFromDirectory(dataDir: string): Promise<Record<string, string>> {
  const entries = await readdir(dataDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && VALID_LIST_FILE_NAME.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const output: Record<string, string> = {};

  await Promise.all(
    files.map(async (fileName) => {
      output[fileName] = await readFile(path.join(dataDir, fileName), "utf8");
    })
  );

  return output;
}

function collectRegexEntries(parsed: Record<string, SourceEntry[]>): DomainRule[] {
  const seen = new Set<string>();
  const output: DomainRule[] = [];

  for (const entry of Object.keys(parsed).sort().flatMap((name) => parsed[name]!)) {
    if (entry.type !== "regexp" || seen.has(entry.value)) {
      continue;
    }
    seen.add(entry.value);
    output.push(entry);
  }

  return output;
}

function buildCorpus(sources: Record<string, string>, trancoContent: string): string[] {
  const domains = new Set<string>();

  for (const content of Object.values(sources)) {
    for (const line of content.split(/\r?\n/)) {
      const stripped = stripComment(line).trim();
      const token = stripped.split(/\s+/, 1)[0] ?? "";
      addDomainToken(domains, token);
    }
  }

  for (const domain of loadTrancoDomains(trancoContent)) {
    domains.add(domain);
  }

  for (const domain of generatedStressDomains()) {
    domains.add(domain);
  }

  return [...domains].sort();
}

function loadTrancoDomains(content: string): string[] {
  const domains: string[] = [];

  for (const line of content.split(/\r?\n/)) {
    if (domains.length >= TRANCO_LIMIT) {
      break;
    }
    const comma = line.indexOf(",");
    if (comma === -1) {
      continue;
    }

    const domain = normalizeDomain(line.slice(comma + 1));
    if (domain) {
      domains.push(domain);
    }
  }

  return domains;
}

function addDomainToken(domains: Set<string>, token: string): void {
  if (token.length === 0 || token.startsWith("regexp:") || token.startsWith("include:")) {
    return;
  }

  const colonIndex = token.indexOf(":");
  const value = colonIndex === -1 ? token : token.slice(colonIndex + 1);
  const domain = normalizeDomain(value);
  if (domain) {
    domains.add(domain);
  }
}

function normalizeDomain(input: string): string | null {
  const value = input.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
  if (!/^[a-z0-9.-]+$/.test(value) || value.length === 0) {
    return null;
  }
  return value;
}

function generatedStressDomains(): string[] {
  const labels = ["google", "apple", "microsoft", "github", "cloudflare", "example", "tracker", "cdn", "mail", "api"];
  const suffixes = ["com", "net", "org", "cn", "io", "co.uk", "com.cn", "vip", "xyz", "top"];
  const output: string[] = [];

  for (const label of labels) {
    for (const suffix of suffixes) {
      output.push(`${label}.${suffix}`);
      output.push(`www.${label}.${suffix}`);
      output.push(`api.${label}.${suffix}`);
    }
  }

  output.push(
    "a190a.com", "hs12.vip", "91porn.best", "sub.91porn.cool", "microsoft.com.cn",
    "nisservice.10010.com", "nis.service.10010.com", "cdn-akamai-123.gog-services.com",
    "cdn-akamai-.123.gog-services.com", "apiproxy-device-prod-nlb-123.amazonaws.com"
  );
  return output;
}

function stripComment(input: string): string {
  const commentIndex = input.indexOf("#");
  return commentIndex === -1 ? input : input.slice(0, commentIndex);
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
