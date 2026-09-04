#!/usr/bin/env node

import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const VALID_LIST_NAME = /^[a-z0-9!-]+$/;
const DEFAULT_MODES = ["strict", "balanced", "full"];
const DEFAULT_PREFIXES = [
  "DOMAIN,",
  "DOMAIN-SUFFIX,",
  "DOMAIN-KEYWORD,",
  "DOMAIN-WILDCARD,"
];

function getArg(name, fallback) {
  const withEq = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (withEq) {
    return withEq.slice(name.length + 1);
  }

  const idx = process.argv.indexOf(name);
  if (idx !== -1) {
    return process.argv[idx + 1] ?? fallback;
  }

  return fallback;
}

function asInt(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const n = Number.parseInt(String(value), 10);
  return Number.isFinite(n) ? n : fallback;
}

function sanitizeBaseUrl(input) {
  return input.endsWith("/") ? input.slice(0, -1) : input;
}

function linesOf(text) {
  return text.split(/\r?\n/).filter((line) => line.length > 0);
}

function validateRules(content) {
  const lines = linesOf(content);
  const invalidLines = [];
  const suspiciousWildcards = [];

  for (const line of lines) {
    const isAllowed = DEFAULT_PREFIXES.some((prefix) => line.startsWith(prefix));
    if (!isAllowed) {
      invalidLines.push(line);
      continue;
    }

    if (line === "DOMAIN-WILDCARD,*" || line === "DOMAIN-WILDCARD,?") {
      suspiciousWildcards.push(line);
    }
  }

  return {
    lines: lines.length,
    invalidLineCount: invalidLines.length,
    invalidLineSamples: invalidLines.slice(0, 5),
    suspiciousWildcardCount: suspiciousWildcards.length,
    suspiciousWildcardSamples: suspiciousWildcards.slice(0, 5)
  };
}

async function listDatasets(dataDir) {
  const items = await readdir(dataDir, { withFileTypes: true });
  return items
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name.toLowerCase())
    .filter((name) => VALID_LIST_NAME.test(name))
    .sort();
}

async function fetchWithRetry(url, options) {
  let lastError = null;

  for (let attempt = 0; attempt <= options.retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);

    try {
      const response = await fetch(url, {
        headers: {
          accept: "text/plain",
          "user-agent": "surge-geosite-prewarm/1"
        },
        signal: controller.signal
      });
      const body = await response.text();

      if (response.status >= 500 || response.status === 429) {
        lastError = new Error(`HTTP ${response.status}: ${body.slice(0, 240)}`);
      } else {
        return { response, body };
      }
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }

    if (attempt < options.retries) {
      const backoff = 300 * (attempt + 1);
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }

  throw lastError ?? new Error("request failed");
}

async function main() {
  const baseUrl = sanitizeBaseUrl(
    getArg("--base-url", "https://surge-geosite.bojin.workers.dev")
  );
  const dataDir = path.resolve(getArg("--data-dir", "./domain-list-community/data"));
  const outDir = path.resolve(getArg("--out-dir", "./out-remote"));
  const concurrency = Math.max(1, asInt(getArg("--concurrency", "8"), 8));
  const retries = Math.max(0, asInt(getArg("--retries", "2"), 2));
  const timeoutMs = Math.max(1000, asInt(getArg("--timeout-ms", "30000"), 30000));
  const limit = Math.max(0, asInt(getArg("--limit", "0"), 0));
  const modeArg = getArg("--modes", DEFAULT_MODES.join(","));
  const modes = modeArg
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  const startedAt = new Date().toISOString();
  const datasetsAll = await listDatasets(dataDir);
  const datasets = limit > 0 ? datasetsAll.slice(0, limit) : datasetsAll;

  await mkdir(outDir, { recursive: true });
  await mkdir(path.join(outDir, "rules"), { recursive: true });
  await mkdir(path.join(outDir, "errors"), { recursive: true });

  const jobs = [];
  for (const mode of modes) {
    for (const dataset of datasets) {
      jobs.push({ mode, dataset });
    }
  }

  const summary = {
    startedAt,
    finishedAt: "",
    baseUrl,
    dataDir,
    outDir,
    totalDatasets: datasets.length,
    totalJobs: jobs.length,
    modes,
    options: {
      concurrency,
      retries,
      timeoutMs,
      limit
    },
    counts: {
      ok: 0,
      failed: 0,
      byStatus: {}
    },
    jobs: []
  };

  const perList = new Map();
  let cursor = 0;
  let done = 0;

  const worker = async () => {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= jobs.length) {
        return;
      }

      const job = jobs[idx];
      const encoded = encodeURIComponent(job.dataset);
      const requestUrl = `${baseUrl}/geosite/${job.mode}/${encoded}`;
      const outputPath = path.join(outDir, "rules", job.mode, `${job.dataset}.txt`);
      const errorPath = path.join(outDir, "errors", job.mode, `${job.dataset}.txt`);
      const started = Date.now();

      await mkdir(path.dirname(outputPath), { recursive: true });
      await mkdir(path.dirname(errorPath), { recursive: true });

      try {
        const { response, body } = await fetchWithRetry(requestUrl, { retries, timeoutMs });
        const durationMs = Date.now() - started;
        const status = response.status;
        const result = {
          mode: job.mode,
          dataset: job.dataset,
          url: requestUrl,
          status,
          durationMs,
          bytes: Buffer.byteLength(body),
          etag: response.headers.get("x-upstream-etag"),
          stale: response.headers.get("x-stale") === "1"
        };

        summary.counts.byStatus[String(status)] = (summary.counts.byStatus[String(status)] ?? 0) + 1;

        const validation = status === 200 ? validateRules(body) : null;
        const valid = validation && validation.invalidLineCount === 0 && validation.suspiciousWildcardCount === 0;
        if (valid) {
          await writeFile(outputPath, body, "utf8");

          summary.jobs.push({
            ...result,
            file: outputPath,
            ...validation
          });
          summary.counts.ok += 1;

          const key = job.dataset;
          const entry = perList.get(key) ?? {};
          entry[job.mode] = {
            lines: validation.lines,
            bytes: result.bytes,
            status
          };
          perList.set(key, entry);
        } else {
          await writeFile(errorPath, body, "utf8");
          summary.jobs.push({
            ...result,
            file: errorPath,
            ...validation,
            errorBodyPreview: body.slice(0, 300)
          });
          summary.counts.failed += 1;
        }
      } catch (error) {
        const durationMs = Date.now() - started;
        const message = error instanceof Error ? error.message : String(error);
        await writeFile(errorPath, `${message}\n`, "utf8");

        summary.counts.failed += 1;
        summary.counts.byStatus.network = (summary.counts.byStatus.network ?? 0) + 1;

        summary.jobs.push({
          mode: job.mode,
          dataset: job.dataset,
          url: requestUrl,
          status: "network-error",
          durationMs,
          bytes: 0,
          file: errorPath,
          errorBodyPreview: message
        });
      }

      done += 1;
      if (done % 100 === 0 || done === jobs.length) {
        process.stdout.write(`[progress] ${done}/${jobs.length}\n`);
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const finishedAt = new Date().toISOString();
  summary.finishedAt = finishedAt;

  const largest = [...summary.jobs]
    .filter((item) => item.status === 200)
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 60);

  const anomalies = {
    invalidLines: summary.jobs
      .filter((item) => item.status === 200 && item.invalidLineCount > 0)
      .map((item) => ({
        mode: item.mode,
        dataset: item.dataset,
        invalidLineCount: item.invalidLineCount,
        invalidLineSamples: item.invalidLineSamples
      })),
    suspiciousWildcards: summary.jobs
      .filter((item) => item.status === 200 && item.suspiciousWildcardCount > 0)
      .map((item) => ({
        mode: item.mode,
        dataset: item.dataset,
        suspiciousWildcardCount: item.suspiciousWildcardCount,
        suspiciousWildcardSamples: item.suspiciousWildcardSamples
      })),
    nonMonotonicLineCounts: []
  };

  for (const [dataset, stats] of perList.entries()) {
    const strict = stats.strict?.lines;
    const balanced = stats.balanced?.lines;
    const full = stats.full?.lines;
    if (
      Number.isFinite(strict) &&
      Number.isFinite(balanced) &&
      Number.isFinite(full) &&
      !(strict <= balanced && balanced <= full)
    ) {
      anomalies.nonMonotonicLineCounts.push({ dataset, strict, balanced, full });
    }
  }

  await writeFile(path.join(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await writeFile(path.join(outDir, "largest.json"), `${JSON.stringify(largest, null, 2)}\n`, "utf8");
  await writeFile(path.join(outDir, "anomalies.json"), `${JSON.stringify(anomalies, null, 2)}\n`, "utf8");

  if (summary.counts.failed > 0) process.exitCode = 1;

  process.stdout.write(`done: ${summary.counts.ok} ok, ${summary.counts.failed} failed\n`);
  process.stdout.write(`summary: ${path.join(outDir, "summary.json")}\n`);
  process.stdout.write(`largest: ${path.join(outDir, "largest.json")}\n`);
  process.stdout.write(`anomalies: ${path.join(outDir, "anomalies.json")}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
