import { readFile } from "node:fs/promises";
import { parentPort, workerData } from "node:worker_threads";

// Also imported by the small offline semantic tests; no worker I/O occurs there.
if (parentPort && workerData?.corpusPath) {
  const corpus = (await readFile(workerData.corpusPath, "utf8"))
    .split(/\r?\n/)
    .filter((line) => line.length > 0);

  parentPort.on("message", (message) => {
    try {
      parentPort.postMessage({
        id: message.id,
        result: auditRegexCase(message.auditCase, corpus, workerData)
      });
    } catch (error) {
      parentPort.postMessage({
        id: message.id,
        error: error instanceof Error ? error.stack ?? error.message : String(error)
      });
    }
  });
}

export function auditRegexCase(auditCase, corpus, limits = { overmatchLimit: 50, overmatchFactor: 20 }) {
  const failures = [];
  const counts = { expected: 0, actual: 0, overmatches: 0, omissions: 0, oracleUnavailable: 0 };
  if (auditCase.referencePattern === null) {
    counts.oracleUnavailable = 1;
    if (auditCase.rules.length > 0) {
      failures.push(`${auditCase.source} emitted rules for syntax without a compatible reference matcher`);
    }
    return { failures, counts };
  }

  const original = new RegExp(normalizeReferencePattern(auditCase.referencePattern ?? auditCase.pattern));
  const matchers = auditCase.rules.map(compileSurgeRule);
  const extraSamples = [];
  const omittedSamples = [];

  for (const input of corpus) {
    const domain = input.toLowerCase().replace(/\.$/, "");
    const expectedMatch = original.test(domain);
    const actualMatch = matchers.some((matcher) => matcher(domain));
    if (expectedMatch) counts.expected += 1;
    if (actualMatch) counts.actual += 1;
    if (actualMatch && !expectedMatch) {
      counts.overmatches += 1;
      if (extraSamples.length < 20) extraSamples.push(domain);
    }
    if (expectedMatch && !actualMatch) {
      counts.omissions += 1;
      if (omittedSamples.length < 20) omittedSamples.push(domain);
    }
  }

  // An unsupported strict pattern is deliberately omitted. Every emitted strict
  // conversion, however, must be equivalent; the heuristic budget never applies.
  if (auditCase.mode === "strict") {
    if (auditCase.rules.length > 0 && (counts.overmatches > 0 || counts.omissions > 0)) {
      failures.push(`${auditCase.source} strict mismatch extra=${extraSamples.join(",")} omitted=${omittedSamples.join(",")} pattern=${auditCase.pattern}`);
    }
  } else {
    const expectedWithinActual = counts.expected - counts.omissions;
    const allowedOvermatches = Math.max(limits.overmatchLimit, expectedWithinActual * limits.overmatchFactor);
    if (counts.overmatches > allowedOvermatches) {
      failures.push(`${auditCase.source} ${auditCase.mode} ${auditCase.rules.map(formatRule).join(" ")} expected=${counts.expected} actual=${counts.actual} overmatches=${counts.overmatches} omissions=${counts.omissions} samples=${extraSamples.join(",")} pattern=${auditCase.pattern}`);
    }
  }

  return { failures, counts };
}

export function normalizeReferencePattern(pattern) {
  const repeated = pattern.match(/^\^\(\.\+\\\.\)\*([a-z0-9-]+(?:\\\.[a-z0-9-]+)+)\$$/i);
  // .+ already crosses dots: one nonempty prefix ending in a dot represents any
  // positive number of these groups. This equivalent oracle avoids exponential
  // JavaScript backtracking; Go/RE2 does not have that runtime behavior.
  return repeated ? `^(?:.+\\.)?${repeated[1]}$` : pattern;
}

function compileSurgeRule(rule) {
  const value = rule.value.toLowerCase();
  switch (rule.type) {
    case "DOMAIN":
      return (domain) => domain === value;
    case "DOMAIN-SUFFIX":
      return (domain) => domain === value || domain.endsWith(`.${value}`);
    case "DOMAIN-KEYWORD":
      return (domain) => domain.includes(value);
    case "DOMAIN-WILDCARD": {
      const regex = new RegExp(`^${value.split("*").map(escapeRegex).join(".*")}$`, "i");
      return (domain) => regex.test(domain);
    }
    default:
      throw new Error(`Unsupported generated rule type in corpus oracle: ${rule.type}`);
  }
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatRule(rule) {
  return `${rule.type},${rule.value}`;
}
