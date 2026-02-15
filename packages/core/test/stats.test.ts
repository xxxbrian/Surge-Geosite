import { describe, expect, test } from "vitest";

import {
  aggregateGlobalStats,
  countFilterAttrs,
  countResolvedEntries,
  countSourceEntries,
  emitSurgeRuleset,
  modeStatsFromEmit,
  parseListsFromText,
  resolveAllLists,
  type ListStats
} from "../src/index.js";

describe("stats helpers", () => {
  test("computes source and resolved counts", () => {
    const parsed = parseListsFromText({
      demo: [
        "domain:example.com @cn &other",
        "full:api.example.com @cn",
        "keyword:needle",
        "regexp:(^|\\.)netflix\\.com$",
        "include:other @cn"
      ].join("\n")
    });

    const demoParsed = parsed.DEMO!;
    const source = countSourceEntries(demoParsed);
    expect(source).toEqual({
      domain: 1,
      full: 1,
      keyword: 1,
      regexp: 1,
      include: 1,
      affiliations: 1,
      attributes: 3
    });

    const resolved = resolveAllLists(parsed);
    const demo = resolved.DEMO!;

    const resolvedCounts = countResolvedEntries(demo.entries);
    expect(resolvedCounts.rules).toBeGreaterThan(0);
    expect(resolvedCounts.domain + resolvedCounts.full + resolvedCounts.keyword + resolvedCounts.regexp).toBe(
      resolvedCounts.rules
    );

    const attrs = countFilterAttrs(demo.entries);
    expect(attrs.cn).toBeGreaterThan(0);
  });

  test("aggregates mode stats", () => {
    const parsed = parseListsFromText({
      demo: "domain:example.com\nregexp:(^|\\.)netflix\\.com$"
    });
    const resolved = resolveAllLists(parsed).DEMO!;

    const strict = modeStatsFromEmit(emitSurgeRuleset(resolved, { regexMode: "strict" }));
    const balanced = modeStatsFromEmit(emitSurgeRuleset(resolved, { regexMode: "balanced" }));
    const full = modeStatsFromEmit(emitSurgeRuleset(resolved, { regexMode: "full" }));

    const listStats: ListStats = {
      name: "DEMO",
      source: countSourceEntries(parsed.DEMO!),
      resolved: countResolvedEntries(resolved.entries),
      filters: { attrs: countFilterAttrs(resolved.entries) },
      modes: { strict, balanced, full }
    };

    const global = aggregateGlobalStats([listStats]);
    expect(global.lists).toBe(1);
    expect(global.modes.balanced.rules).toBe(listStats.modes.balanced.rules);
  });
});
