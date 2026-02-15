import type { RegexMode, RegexTranspileResult } from "./types.js";

const EXACT_DOMAIN_PATTERN = /^\^([a-z0-9-]+(?:\\\.[a-z0-9-]+)+)\$$/i;
const SUFFIX_DOMAIN_PATTERN = /^\(\^\|\\\.\)([a-z0-9-]+(?:\\\.[a-z0-9-]+)+)\$$/i;
const REPEATED_SUBDOMAIN_PATTERN = /^\^\(\.\+\\\.\)\*([a-z0-9-]+(?:\\\.[a-z0-9-]+)+)\$$/i;
const ADVANCED_TOKENS_PATTERN = /\(\?<?[=!]|\\[1-9]/;

export function transpileRegexToSurge(pattern: string, mode: RegexMode): RegexTranspileResult {
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
  if (wildcard) {
    return {
      status: "widened",
      rules: [
        {
          type: "DOMAIN-WILDCARD",
          value: wildcard
        }
      ],
      reason: "Regex converted to heuristic DOMAIN-WILDCARD pattern."
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

function wildcardFromRegex(pattern: string): string | null {
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
        return null;
      }

      index = consumeQuantifier(pattern, close);
      out += "*";
      continue;
    }

    if (char === "(") {
      const close = findGroupEnd(pattern, index + 1);
      if (close === -1) {
        return null;
      }

      index = consumeQuantifier(pattern, close);
      out += "*";
      continue;
    }

    if (char === "{") {
      const close = pattern.indexOf("}", index + 1);
      if (close === -1) {
        return null;
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
  if (out.length === 0 || !/[a-z0-9]/i.test(out) || !out.includes(".")) {
    return null;
  }

  return out.toLowerCase();
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
