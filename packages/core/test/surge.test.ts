import { describe, expect, test } from "vitest";

import { SurgeEmitError } from "../src/errors.js";
import { parseListsFromText } from "../src/parser.js";
import { transpileRegexToSurge } from "../src/regex.js";
import { resolveOneList } from "../src/resolver.js";
import { emitSurgeRuleset } from "../src/surge.js";

describe("transpileRegexToSurge", () => {
  test.each([
    String.raw`(?i)^EXAMPLE\.COM$`,
    String.raw`\Aexample\.com\z`,
    String.raw`(?i)\AEXAMPLE\.COM\z`
  ])("supports simple RE2 literal-domain syntax losslessly: %s", (pattern) => {
    expect(transpileRegexToSurge(pattern, "strict")).toEqual({
      status: "lossless",
      rules: [{ type: "DOMAIN", value: "example.com" }]
    });
  });

  test.each([
    String.raw`(?i)^cdn[0-9]+\.example\.com$`,
    String.raw`(?i:example)\.com$`,
    String.raw`^[[:alpha:]]+\.example\.com$`,
    String.raw`^\Qexample.com\E$`,
    String.raw`^\p{L}+\.example\.com$`
  ])("reports unsupported RE2 syntax without aborting ordinary rules: %s", (pattern) => {
    const list = resolveOneList(parseListsFromText({ demo: `example.org\nregexp:${pattern}` }), "demo");
    for (const regexMode of ["strict", "balanced", "full"] as const) {
      const output = emitSurgeRuleset(list, { regexMode });
      expect(output.lines).toEqual(["DOMAIN-SUFFIX,example.org"]);
      expect(output.report.regex).toEqual({ total: 1, lossless: 0, widened: 0, unsupported: 1 });
      expect(output.report.unsupported[0]).toMatchObject({ pattern, source: { list: "DEMO", line: 2 } });
      expect(() => emitSurgeRuleset(list, { regexMode, onUnsupportedRegex: "error" })).toThrow(SurgeEmitError);
    }
  });

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

  test.each([String.raw`^EXAMPLE\.COM$`, String.raw`(^|\.)EXAMPLE\.COM$`])(
    "does not lower case-sensitive uppercase literal regex in any mode: %s",
    (pattern) => {
      expect(new RegExp(pattern).test("example.com")).toBe(false);
      const parsed = parseListsFromText({ demo: `regexp:${pattern}` });
      for (const regexMode of ["strict", "balanced", "full"] as const) {
        const output = emitSurgeRuleset(resolveOneList(parsed, "demo"), { regexMode });
        expect(output.lines).toEqual([]);
        expect(output.report.regex).toEqual({ total: 1, lossless: 0, widened: 0, unsupported: 1 });
      }
    }
  );

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

  test.each(["com.cn", "co.uk", "github.io", "pages.dev", "foo.ck"])(
    "does not widen a registrant pattern to the public suffix %s",
    (suffix) => {
      const pattern = String.raw`^[a-z]{3}\.` + suffix.replaceAll(".", String.raw`\.`) + "$";
      const parsed = parseListsFromText({ demo: `regexp:${pattern}` });
      for (const regexMode of ["balanced", "full"] as const) {
        const output = emitSurgeRuleset(resolveOneList(parsed, "demo"), { regexMode });
        expect(output.lines).toEqual([]);
        expect(output.report.regex.unsupported).toBe(1);
      }
    }
  );

  test.each(["com.cn", "co.uk", "github.io", "pages.dev"])(
    "keeps heuristics anchored to a registrant beneath %s",
    (suffix) => {
      const pattern = String.raw`^cdn[0-9]+\.example\.` + suffix.replaceAll(".", String.raw`\.`) + "$";
      expect(transpileRegexToSurge(pattern, "balanced").rules).toEqual([
        { type: "DOMAIN-WILDCARD", value: `cdn*.example.${suffix}` }
      ]);
    }
  );
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
      "Generated rule has no registrable domain anchor and is too broad to emit safely."
    );
  });

  test("blocks a full-mode public-suffix fallback while preserving an explicit suffix regex", () => {
    const parsed = parseListsFromText({
      fallback: String.raw`regexp:^foo(?=bar)\.com\.cn$`,
      explicit: String.raw`regexp:(^|\.)com\.cn$`
    });
    expect(emitSurgeRuleset(resolveOneList(parsed, "fallback"), { regexMode: "full" }).lines).toEqual([]);
    expect(emitSurgeRuleset(resolveOneList(parsed, "explicit"), { regexMode: "strict" }).lines).toEqual([
      "DOMAIN-SUFFIX,com.cn"
    ]);
  });
});
