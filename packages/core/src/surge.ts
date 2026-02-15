import { SurgeEmitError } from "./errors.js";
import { transpileRegexToSurge } from "./regex.js";
import type {
  DomainRule,
  EmitReport,
  EmitSurgeOptions,
  EmitSurgeResult,
  RegexIssue,
  RegexMode,
  ResolvedList,
  SurgeRule,
  SurgeRuleType
} from "./types.js";

const DEFAULT_REGEX_MODE: RegexMode = "balanced";

export function emitSurgeRuleset(list: ResolvedList, options: EmitSurgeOptions = {}): EmitSurgeResult {
  const regexMode = options.regexMode ?? DEFAULT_REGEX_MODE;
  const onUnsupportedRegex = options.onUnsupportedRegex ?? "skip";
  const dedupe = options.dedupe ?? true;

  const rules: SurgeRule[] = [];
  const report = initReport();

  for (const entry of list.entries) {
    if (entry.type === "regexp") {
      report.regex.total += 1;
      handleRegexRule(entry, list.name, regexMode, onUnsupportedRegex, report, rules);
      continue;
    }

    rules.push({
      type: mapRuleType(entry),
      value: entry.value,
      source: entry.source
    });
  }

  const normalizedRules = dedupe ? dedupeRules(rules) : rules;
  const lines = normalizedRules.map((rule) => `${rule.type},${rule.value}`);

  return {
    lines,
    text: lines.join("\n"),
    rules: normalizedRules,
    report
  };
}

function mapRuleType(rule: DomainRule): SurgeRuleType {
  switch (rule.type) {
    case "domain":
      return "DOMAIN-SUFFIX";
    case "full":
      return "DOMAIN";
    case "keyword":
      return "DOMAIN-KEYWORD";
    case "regexp":
      return "DOMAIN-WILDCARD";
    default:
      return "DOMAIN-WILDCARD";
  }
}

function handleRegexRule(
  entry: DomainRule,
  listName: string,
  regexMode: RegexMode,
  onUnsupportedRegex: "skip" | "error",
  report: EmitReport,
  rules: SurgeRule[]
): void {
  const result = transpileRegexToSurge(entry.value, regexMode);

  if (result.status === "unsupported") {
    report.regex.unsupported += 1;
    const issue = makeIssue(entry, regexMode, result.reason ?? "Unsupported regex pattern.");
    report.unsupported.push(issue);

    if (onUnsupportedRegex === "error") {
      throw new SurgeEmitError(
        `unsupported regex in ${listName} at line ${entry.source.line}: ${entry.value} (${issue.reason})`
      );
    }

    return;
  }

  if (result.status === "widened") {
    report.regex.widened += 1;
    report.widened.push(makeIssue(entry, regexMode, result.reason ?? "Regex widened during conversion."));
  } else {
    report.regex.lossless += 1;
  }

  for (const generated of result.rules) {
    rules.push({
      type: generated.type,
      value: generated.value,
      source: entry.source
    });
  }
}

function makeIssue(entry: DomainRule, mode: RegexMode, reason: string): RegexIssue {
  return {
    pattern: entry.value,
    source: entry.source,
    reason,
    mode
  };
}

function dedupeRules(rules: SurgeRule[]): SurgeRule[] {
  const seen = new Set<string>();
  const output: SurgeRule[] = [];

  for (const rule of rules) {
    const key = `${rule.type},${rule.value}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(rule);
  }

  return output;
}

function initReport(): EmitReport {
  return {
    regex: {
      total: 0,
      lossless: 0,
      widened: 0,
      unsupported: 0
    },
    widened: [],
    unsupported: []
  };
}
