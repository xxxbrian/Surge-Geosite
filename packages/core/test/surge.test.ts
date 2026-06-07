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

  test("rejects wildcard downgrades without a registrable domain anchor in balanced mode", () => {
    expect(transpileRegexToSurge("(^|\\.)[a-z][1-9][0-9][a-z]\\.com$", "balanced")).toEqual({
      status: "unsupported",
      rules: [],
      reason: "Heuristic wildcard conversion would overmatch public suffixes."
    });

    expect(transpileRegexToSurge("(^|\\.)91porn\\.(best|com|cool|fun|group|party|plus|site|tw|work)$", "balanced")).toEqual({
      status: "widened",
      rules: [{ type: "DOMAIN-WILDCARD", value: "*.91porn.*" }],
      reason: "Regex converted to heuristic DOMAIN-WILDCARD pattern."
    });
  });

  test("allows low-information wildcard downgrades only in full mode", () => {
    expect(transpileRegexToSurge("(^|\\.)hs[1-9]{2}\\.vip$", "balanced")).toEqual({
      status: "unsupported",
      rules: [],
      reason: "Heuristic wildcard conversion would overmatch public suffixes."
    });

    expect(transpileRegexToSurge("(^|\\.)hs[1-9]{2}\\.vip$", "full")).toEqual({
      status: "widened",
      rules: [{ type: "DOMAIN-WILDCARD", value: "*.hs*.vip" }],
      reason: "Low-information regex converted to heuristic DOMAIN-WILDCARD pattern in full mode."
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

  test("drops overbroad wildcard output in every mode", () => {
    const parsed = parseListsFromText({
      demo: [
        "regexp:^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$",
        "regexp:(^|\\.)[a-z][1-9][0-9][a-z]\\.com$",
        "regexp:(^|\\.)91porn\\.(best|com|cool|fun)$"
      ].join("\n")
    });

    const resolved = resolveOneList(parsed, "demo");
    const balanced = emitSurgeRuleset(resolved, { regexMode: "balanced" });
    const full = emitSurgeRuleset(resolved, { regexMode: "full" });

    expect(balanced.lines).toEqual(["DOMAIN-WILDCARD,*.91porn.*"]);
    expect(full.lines).toEqual(["DOMAIN-WILDCARD,*.91porn.*"]);
    expect(full.report.regex).toEqual({
      total: 3,
      lossless: 0,
      widened: 1,
      unsupported: 2
    });
    expect(full.report.unsupported.map((issue) => issue.reason)).toContain(
      "Generated wildcard rule is too broad to emit safely."
    );
  });
});
