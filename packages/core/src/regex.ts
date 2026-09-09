import { registrableLabelIndex } from "./domain-safety.js";
import { hasUnsupportedRegexSyntax, normalizeSimpleRe2Pattern } from "./regex-syntax.js";
import type { RegexMode, RegexTranspileResult } from "./types.js";

// Hosts are normalized to lowercase, but source regex literals remain case-sensitive.
// An uppercase literal must not be lowered and then reported as lossless.
const EXACT_DOMAIN_PATTERN = /^\^([a-z0-9-]+(?:\\\.[a-z0-9-]+)+)\$$/;
const SUFFIX_DOMAIN_PATTERN = /^\(\^\|\\\.\)([a-z0-9-]+(?:\\\.[a-z0-9-]+)+)\$$/;
const REPEATED_SUBDOMAIN_PATTERN = /^\^\(\.\+\\\.\)\*([a-z0-9-]+(?:\\\.[a-z0-9-]+)+)\$$/i;
const ADVANCED_TOKENS_PATTERN = /\(\?<?[=!]|\\[1-9]/;
const MIN_WILDCARD_LITERAL_CHARS = 3;

interface WildcardCandidate {
  value: string | null;
  safety: "safe" | "low-information" | "unsafe" | "none";
}

export function transpileRegexToSurge(pattern: string, mode: RegexMode): RegexTranspileResult {
  pattern = normalizeSimpleRe2Pattern(pattern);
  if (hasUnsupportedRegexSyntax(pattern)) {
    return {
      status: "unsupported",
      rules: [],
      reason: "Regex syntax is outside the supported Go/RE2 conversion subset."
    };
  }

  const exact = pattern.match(EXACT_DOMAIN_PATTERN);
  if (exact) {
    return {
      status: "lossless",
      rules: [
        {
          type: "DOMAIN",
          value: unescapeDomain(exact[1]!)
        }
      ]
    };
  }

  const suffix = pattern.match(SUFFIX_DOMAIN_PATTERN);
  if (suffix) {
    return {
      status: "lossless",
      rules: [
        {
          type: "DOMAIN-SUFFIX",
          value: unescapeDomain(suffix[1]!)
        }
      ]
    };
  }

  const repeatedSubdomain = pattern.match(REPEATED_SUBDOMAIN_PATTERN);
  if (repeatedSubdomain && mode !== "strict") {
    return {
      status: "widened",
      rules: [
        {
          type: "DOMAIN-SUFFIX",
          value: unescapeDomain(repeatedSubdomain[1]!)
        }
      ],
      reason: "Converted repeated subdomain regexp to DOMAIN-SUFFIX."
    };
  }

  if (mode === "strict") {
    return {
      status: "unsupported",
      rules: [],
      reason: "Pattern is not losslessly representable in Surge domain rules."
    };
  }

  if (ADVANCED_TOKENS_PATTERN.test(pattern)) {
    if (mode === "full") {
      const tail = extractLiteralTailDomain(pattern);
      if (tail) {
        return {
          status: "widened",
          rules: [
            {
              type: "DOMAIN-SUFFIX",
              value: tail
            }
          ],
          reason: "Advanced regexp token downgraded to literal domain suffix."
        };
      }

      return {
        status: "widened",
        rules: [
          {
            type: "DOMAIN-WILDCARD",
            value: "*"
          }
        ],
        reason: "Advanced regexp token downgraded to match-all wildcard in full mode."
      };
    }

    return {
      status: "unsupported",
      rules: [],
      reason: "Pattern uses advanced regexp tokens that cannot be safely converted."
    };
  }

  const wildcard = wildcardFromRegex(pattern);
  if (wildcard.value && (wildcard.safety === "safe" || mode === "full")) {
    return {
      status: "widened",
      rules: [
        {
          type: "DOMAIN-WILDCARD",
          value: wildcard.value
        }
      ],
      reason:
        wildcard.safety === "low-information"
          ? "Low-information regex converted to heuristic DOMAIN-WILDCARD pattern in full mode."
          : "Regex converted to heuristic DOMAIN-WILDCARD pattern."
    };
  }

  if (wildcard.safety === "low-information" || wildcard.safety === "unsafe") {
    return {
      status: "unsupported",
      rules: [],
      reason: "Heuristic wildcard conversion would overmatch public suffixes."
    };
  }

  if (mode === "full") {
    const tail = extractLiteralTailDomain(pattern);
    if (tail) {
      return {
        status: "widened",
        rules: [
          {
            type: "DOMAIN-SUFFIX",
            value: tail
          }
        ],
        reason: "Regex downgraded to literal domain suffix fallback."
      };
    }

    return {
      status: "widened",
      rules: [
        {
          type: "DOMAIN-WILDCARD",
          value: "*"
        }
      ],
      reason: "Regex downgraded to match-all wildcard in full mode."
    };
  }

  return {
    status: "unsupported",
    rules: [],
    reason: "Unable to convert regexp into a valid Surge domain pattern."
  };
}

function wildcardFromRegex(pattern: string): WildcardCandidate {
  let out = "";

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (!char) {
      continue;
    }

    if (char === "^" || char === "$") {
      continue;
    }

    if (pattern.startsWith("(^|\\.)", index)) {
      out += "*.";
      index += "(^|\\.)".length - 1;
      continue;
    }

    if (char === "\\") {
      const next = pattern[index + 1];
      if (!next) {
        out += "*";
        continue;
      }

      index += 1;

      if (next === "." || next === "-") {
        out += next;
        continue;
      }

      if (next === "d" || next === "w" || next === "s" || next === "S" || next === "D" || next === "W") {
        out += "*";
        continue;
      }

      if (isDomainChar(next)) {
        out += next;
        continue;
      }

      out += "*";
      continue;
    }

    if (char === "[") {
      const close = findCharClassEnd(pattern, index + 1);
      if (close === -1) {
        return { value: null, safety: "none" };
      }

      index = consumeQuantifier(pattern, close);
      out += "*";
      continue;
    }

    if (char === "(") {
      const close = findGroupEnd(pattern, index + 1);
      if (close === -1) {
        return { value: null, safety: "none" };
      }

      index = consumeQuantifier(pattern, close);
      out += "*";
      continue;
    }

    if (char === "{") {
      const close = pattern.indexOf("}", index + 1);
      if (close === -1) {
        return { value: null, safety: "none" };
      }
      index = close;
      out += "*";
      continue;
    }

    if (char === "|" || char === "?" || char === "+" || char === "*") {
      out += "*";
      continue;
    }

    if (char === "." || isDomainChar(char)) {
      out += char;
      continue;
    }

    out += "*";
  }

  out = normalizeWildcard(out);
  return {
    value: isHeuristicWildcardCandidate(out) ? out.toLowerCase() : null,
    safety: getHeuristicWildcardSafety(out)
  };
}

function getHeuristicWildcardSafety(value: string): WildcardCandidate["safety"] {
  if (value.length === 0 || !/[a-z0-9]/i.test(value) || !value.includes(".")) {
    return "none";
  }

  const labels = value.split(".");
  if (labels.length < 2 || labels.some((label) => label.length === 0)) {
    return "none";
  }

  const anchorIndex = registrableLabelIndex(labels);
  const registrableLabel = labels[anchorIndex];
  if (!registrableLabel || registrableLabel === "*" || !/[a-z0-9]/i.test(registrableLabel)) {
    return "unsafe";
  }

  const literalChars = labels
    .slice(0, anchorIndex + 1)
    .join("")
    .replace(/\*/g, "").length;
  return literalChars >= MIN_WILDCARD_LITERAL_CHARS ? "safe" : "low-information";
}

function isHeuristicWildcardCandidate(value: string): boolean {
  const safety = getHeuristicWildcardSafety(value);
  return safety === "safe" || safety === "low-information";
}

function normalizeWildcard(value: string): string {
  let output = value;
  output = output.replace(/\*{2,}/g, "*");
  output = output.replace(/\?\*/g, "*");
  output = output.replace(/\*\?/g, "*");
  output = output.replace(/\.{2,}/g, ".");
  output = output.replace(/^[*.]+/, (match) => (match.includes(".") ? "*." : "*"));
  output = output.replace(/\*\./g, "*.");
  output = output.replace(/^\.+|\.+$/g, "");
  return output;
}

function findCharClassEnd(input: string, start: number): number {
  let escaped = false;
  for (let index = start; index < input.length; index += 1) {
    const char = input[index];
    if (!char) {
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "]") {
      return index;
    }
  }
  return -1;
}

function findGroupEnd(input: string, start: number): number {
  let escaped = false;
  let depth = 1;

  for (let index = start; index < input.length; index += 1) {
    const char = input[index];
    if (!char) {
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === "(") {
      depth += 1;
      continue;
    }

    if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function consumeQuantifier(input: string, endIndex: number): number {
  const next = input[endIndex + 1];
  if (!next) {
    return endIndex;
  }

  if (next === "?" || next === "+" || next === "*") {
    return endIndex + 1;
  }

  if (next === "{") {
    const quantifierEnd = input.indexOf("}", endIndex + 2);
    if (quantifierEnd !== -1) {
      return quantifierEnd;
    }
  }

  return endIndex;
}

function extractLiteralTailDomain(pattern: string): string | null {
  const body = pattern.replace(/^\^/, "").replace(/\$$/, "");
  const tail = body.match(/([a-z0-9-]+(?:\\\.[a-z0-9-]+)+)$/i);
  if (!tail) {
    return null;
  }
  return unescapeDomain(tail[1]!);
}

function unescapeDomain(input: string): string {
  return input.replace(/\\\./g, ".").toLowerCase();
}

function isDomainChar(char: string): boolean {
  return /[a-z0-9-]/i.test(char);
}
