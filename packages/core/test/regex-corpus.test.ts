import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import { afterAll, describe, expect, test } from "vitest";

import { parseListsFromText } from "../src/parser.js";
import { resolveAllLists } from "../src/resolver.js";
import { emitSurgeRuleset } from "../src/surge.js";
import type { DomainRule, RegexMode, SurgeRule } from "../src/types.js";

const MODES: RegexMode[] = ["strict", "balanced", "full"];
const DLC_TARBALL_URL = "https://github.com/v2fly/domain-list-community/archive/refs/heads/master.tar.gz";
const TRANCO_URL = "https://tranco-list.eu/top-1m.csv.zip";
const CACHE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "node_modules",
  ".vitest",
  "regex-corpus"
);
const DLC_DATA_DIR = path.join(CACHE_DIR, "domain-list-community-master", "data");
const TRANCO_CSV = path.join(CACHE_DIR, "top-1m.csv");
const CORPUS_TXT = path.join(CACHE_DIR, "corpus.txt");
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
  mode: RegexMode;
  rules: Array<Pick<SurgeRule, "type" | "value">>;
}

interface AuditResult {
  failures: string[];
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

let workerPool: AuditWorkerPool;

async function createAuditContext(): Promise<{ cases: AuditCase[] }> {
  await ensureCorpusCache();

  const sources = await loadListsFromDirectory(DLC_DATA_DIR);
  const parsed = parseListsFromText(sources);
  const resolved = resolveAllLists(parsed);
  const regexEntries = collectRegexEntries(resolved);
  const corpus = await buildCorpus(sources);
  await writeFile(CORPUS_TXT, `${corpus.join("\n")}\n`, "utf8");

  return {
    cases: regexEntries.flatMap((entry) => makeAuditCases(entry))
  };
}

function makeAuditCases(entry: DomainRule): AuditCase[] {
  return MODES.map((mode) => {
    const emitted = emitSurgeRuleset({ name: entry.source.list, entries: [entry] }, { regexMode: mode });
    return {
      name: `${entry.source.list}:${entry.source.line} ${mode} ${entry.value}`,
      source: `${entry.source.list}:${entry.source.line}`,
      pattern: entry.value,
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
            item.resolve(message.result ?? { failures: [] });
          }
        }

        this.dispatch();
      });

      worker.on("error", (error) => {
        slot.busy = false;
        for (const item of this.pending.values()) {
          item.reject(error);
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
workerPool = new AuditWorkerPool(WORKER_COUNT, CORPUS_TXT);

afterAll(async () => {
  await workerPool.close();
});

describe("regex conversion corpus audit", () => {
  test.concurrent.each(auditContext.cases)("$name", async (auditCase) => {
    const result = await workerPool.run(auditCase);
    expect(result.failures).toEqual([]);
  });
});

async function ensureCorpusCache(): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  await Promise.all([ensureDlcCache(), ensureTrancoCache()]);
}

async function ensureDlcCache(): Promise<void> {
  if (existsSync(DLC_DATA_DIR)) {
    return;
  }

  const archivePath = path.join(CACHE_DIR, "domain-list-community.tar.gz");
  await downloadFile(DLC_TARBALL_URL, archivePath);
  await rm(path.join(CACHE_DIR, "domain-list-community-master"), { recursive: true, force: true });
  await runCommand("tar", ["-xzf", archivePath, "-C", CACHE_DIR]);
}

async function ensureTrancoCache(): Promise<void> {
  if (existsSync(TRANCO_CSV)) {
    return;
  }

  const archivePath = path.join(CACHE_DIR, "top-1m.csv.zip");
  await downloadFile(TRANCO_URL, archivePath);
  await runCommand("unzip", ["-o", archivePath, "-d", CACHE_DIR]);
}

async function runCommand(command: string, args: string[]): Promise<void> {
  const { execFile } = await import("node:child_process");
  await new Promise<void>((resolve, reject) => {
    execFile(command, args, { maxBuffer: 1024 * 1024 * 20 }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function downloadFile(url: string, outputPath: string): Promise<void> {
  const response = await fetch(url, {
    headers: {
      accept: "application/octet-stream",
      "user-agent": "surge-geosite-regex-corpus-test/1"
    }
  });

  if (!response.ok || !response.body) {
    throw new Error(`failed to download ${url}: HTTP ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  await writeFile(outputPath, Buffer.from(arrayBuffer));
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

function collectRegexEntries(resolved: Record<string, { entries: DomainRule[] }>): DomainRule[] {
  const seen = new Set<string>();
  const output: DomainRule[] = [];

  for (const entry of Object.values(resolved).flatMap((list) => list.entries)) {
    if (entry.type !== "regexp" || seen.has(entry.value)) {
      continue;
    }
    seen.add(entry.value);
    output.push(entry);
  }

  return output;
}

async function buildCorpus(sources: Record<string, string>): Promise<string[]> {
  const domains = new Set<string>();

  for (const content of Object.values(sources)) {
    for (const line of content.split(/\r?\n/)) {
      const stripped = stripComment(line).trim();
      const token = stripped.split(/\s+/, 1)[0] ?? "";
      addDomainToken(domains, token);
    }
  }

  for (const domain of await loadTrancoDomains()) {
    domains.add(domain);
  }

  for (const domain of generatedStressDomains()) {
    domains.add(domain);
  }

  return [...domains].sort();
}

async function loadTrancoDomains(): Promise<string[]> {
  const content = await readFile(TRANCO_CSV, "utf8");
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

  output.push("a190a.com", "hs12.vip", "91porn.best", "sub.91porn.cool");
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
