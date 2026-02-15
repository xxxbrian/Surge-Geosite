import { describe, expect, test } from "vitest";

import { SurgeEmitError } from "../src/errors.js";
import { parseListsFromText } from "../src/parser.js";
import { transpileRegexToSurge } from "../src/regex.js";
import { resolveOneList } from "../src/resolver.js";
import { emitSurgeRuleset } from "../src/surge.js";

describe("transpileRegexToSurge", () => {
  test("converts exact and suffix regex losslessly", () => {
    expect(transpileRegexToSurge("^github\\.com$", "strict")).toEqual({
      status: "lossless",
      rules: [{ type: "DOMAIN", value: "github.com" }]
    });

    expect(transpileRegexToSurge("(^|\\.)netflix\\.com$", "strict")).toEqual({
      status: "lossless",
      rules: [{ type: "DOMAIN-SUFFIX", value: "netflix.com" }]
    });
  });

  test("widens complex regex in balanced mode", () => {
    expect(transpileRegexToSurge("^cdn\\d-epicgames-\\d+\\.file\\.myqcloud\\.com$", "balanced")).toEqual({
      status: "widened",
      rules: [{ type: "DOMAIN-WILDCARD", value: "cdn*-epicgames-*.file.myqcloud.com" }],
      reason: "Regex converted to heuristic DOMAIN-WILDCARD pattern."
    });
  });

  test("forces conversion in full mode when balanced cannot convert", () => {
    expect(transpileRegexToSurge("^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$", "balanced")).toEqual({
      status: "unsupported",
      rules: [],
      reason: "Unable to convert regexp into a valid Surge domain pattern."
    });

    expect(transpileRegexToSurge("^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$", "full")).toEqual({
      status: "widened",
      rules: [{ type: "DOMAIN-WILDCARD", value: "*" }],
      reason: "Regex downgraded to match-all wildcard in full mode."
    });
  });
});

describe("emitSurgeRuleset", () => {
  test("emits surge rules and tracks regex report", () => {
    const parsed = parseListsFromText({
      demo: [
        "domain:example.com",
        "full:api.example.com",
        "keyword:tracker",
        "regexp:(^|\\.)netflix\\.com$",
        "regexp:^cdn\\d-epicgames-\\d+\\.file\\.myqcloud\\.com$"
      ].join("\n")
    });

    const resolved = resolveOneList(parsed, "demo");
    const output = emitSurgeRuleset(resolved, { regexMode: "balanced" });

    expect(output.lines).toEqual([
      "DOMAIN-SUFFIX,example.com",
      "DOMAIN-KEYWORD,tracker",
      "DOMAIN-SUFFIX,netflix.com",
      "DOMAIN-WILDCARD,cdn*-epicgames-*.file.myqcloud.com"
    ]);

    expect(output.report.regex).toEqual({
      total: 2,
      lossless: 1,
      widened: 1,
      unsupported: 0
    });
  });

  test("throws when unsupported regex is configured as error", () => {
    const parsed = parseListsFromText({
      demo: "regexp:^a(?=b)\\.example\\.com$"
    });

    const resolved = resolveOneList(parsed, "demo");
    expect(() =>
      emitSurgeRuleset(resolved, {
        regexMode: "balanced",
        onUnsupportedRegex: "error"
      })
    ).toThrow(SurgeEmitError);
  });
});
