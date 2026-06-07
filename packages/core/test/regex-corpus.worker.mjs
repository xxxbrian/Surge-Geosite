import { readFile } from "node:fs/promises";
import { parentPort, workerData } from "node:worker_threads";

const corpus = (await readFile(workerData.corpusPath, "utf8"))
  .split(/\r?\n/)
  .filter((line) => line.length > 0);

parentPort.on("message", (message) => {
  try {
    parentPort.postMessage({
      id: message.id,
      result: auditCase(message.auditCase)
    });
  } catch (error) {
    parentPort.postMessage({
      id: message.id,
      error: error instanceof Error ? error.stack ?? error.message : String(error)
    });
  }
});

function auditCase(auditCase) {
  const failures = [];
  const overbroadRules = auditCase.rules.filter(isOverbroadRule).map(formatRule);
  if (overbroadRules.length > 0) {
    failures.push(`${auditCase.source} ${auditCase.mode} overbroad=${overbroadRules.join(" ")} pattern=${auditCase.pattern}`);
    return { failures };
  }

  if (auditCase.rules.length === 0) {
    return { failures };
  }

  const original = new RegExp(auditCase.pattern);
  const matchers = auditCase.rules.map(compileSurgeRule);
  let expectedWithinActual = 0;
  let actual = 0;
  let overmatches = 0;
  const samples = [];

  for (const domain of corpus) {
    const actualMatch = matchers.some((matcher) => matcher(domain));
    if (!actualMatch) {
      continue;
    }

    actual += 1;
    original.lastIndex = 0;
    if (original.test(domain)) {
      expectedWithinActual += 1;
      continue;
    }

      overmatches += 1;
      if (samples.length < 20) {
        samples.push(domain);
      }
  }

  const allowedOvermatches = Math.max(workerData.overmatchLimit, expectedWithinActual * workerData.overmatchFactor);
  if (overmatches > allowedOvermatches) {
    failures.push(
      `${auditCase.source} ${auditCase.mode} ${auditCase.rules.map(formatRule).join(" ")} expectedWithinActual=${expectedWithinActual} actual=${actual} overmatches=${overmatches} samples=${samples.join(",")} pattern=${auditCase.pattern}`
    );
  }

  return { failures };
}

function isOverbroadRule(rule) {
  if (rule.type !== "DOMAIN-WILDCARD") {
    return false;
  }
  if (rule.value === "*") {
    return true;
  }
  return rule.value.startsWith("*.") && !rule.value.slice(2).includes(".");
}

function compileSurgeRule(rule) {
  switch (rule.type) {
    case "DOMAIN":
      return (domain) => domain === rule.value;
    case "DOMAIN-SUFFIX":
      return (domain) => domain === rule.value || domain.endsWith(`.${rule.value}`);
    case "DOMAIN-KEYWORD":
      return (domain) => domain.includes(rule.value);
    case "DOMAIN-WILDCARD": {
      const regex = wildcardToRegex(rule.value);
      return (domain) => regex.test(domain);
    }
    default:
      return () => false;
  }
}

function wildcardToRegex(value) {
  const body = value
    .split("*")
    .map(escapeRegex)
    .join(".*");
  return new RegExp(`^${body}$`, "i");
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatRule(rule) {
  return `${rule.type},${rule.value}`;
}
