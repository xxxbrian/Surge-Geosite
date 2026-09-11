import { describe, expect, test } from "vitest";

import { parseListText } from "../src/parser.js";
import { hasUnsupportedRegexSyntax, normalizeSimpleRe2Pattern } from "../src/regex-syntax.js";
import { emitSurgeRuleset } from "../src/surge.js";
import type { DomainRule, RegexMode } from "../src/types.js";
import { auditRegexCase, normalizeReferencePattern } from "./regex-corpus.worker.mjs";

function audit(pattern: string, mode: RegexMode, domains: string[]) {
  const entries = parseListText("fixture", `regexp:${pattern}`) as DomainRule[];
  const emitted = emitSurgeRuleset({ name: "FIXTURE", entries }, { regexMode: mode });
  const normalized = normalizeSimpleRe2Pattern(pattern);
  return auditRegexCase({
    pattern, mode, source: "FIXTURE:1", rules: emitted.rules,
    referencePattern: hasUnsupportedRegexSyntax(normalized) ? null : normalized
  }, domains);
}

describe("regex semantic audit", () => {
  test("uses an equivalent reference for repeated arbitrary subdomains", () => {
    const pattern = String.raw`^(.+\.)*zh\.okaapps\.com$`;
    const original = new RegExp(pattern);
    const reference = new RegExp(normalizeReferencePattern(pattern));
    for (const prefix of ["", ".", "..", "a.", "a.b.", "a..b.", "a\n.", "a-"]) {
      for (const suffix of ["zh.okaapps.com", "notzh.okaapps.com", "zh.okaapps.com.evil.net"]) {
        expect(reference.test(prefix + suffix)).toBe(original.test(prefix + suffix));
      }
    }
  });

  test.each([String.raw`^example\.com$`, String.raw`(^|\.)example\.com$`, String.raw`(?i)\AEXAMPLE\.COM\z`])(
    "checks strict equivalence on positive and boundary-negative hosts: %s",
    (pattern) => {
      const result = audit(pattern, "strict", [
        "example.com", "www.example.com", "example.com.evil.net", "notexample.com", "example.net"
      ]);
      expect(result.failures).toEqual([]);
      expect(result.counts.expected).toBeGreaterThan(0);
      expect(result.counts.omissions).toBe(0);
      expect(result.counts.overmatches).toBe(0);
    }
  );

  test("fails strict for a single extra match even with a large heuristic allowance", () => {
    const result = auditRegexCase({
      pattern: String.raw`^EXAMPLE\.COM$`, mode: "strict", source: "FIXTURE:1",
      rules: [{ type: "DOMAIN", value: "example.com" }]
    }, ["example.com"], { overmatchLimit: 1000, overmatchFactor: 1000 });
    expect(result.counts.overmatches).toBe(1);
    expect(result.failures).toHaveLength(1);
  });

  test("fails strict when an emitted conversion omits an original match", () => {
    const result = auditRegexCase({
      pattern: String.raw`(^|\.)example\.com$`, mode: "strict", source: "FIXTURE:1",
      rules: [{ type: "DOMAIN", value: "example.com" }]
    }, ["example.com", "sub.example.com"]);
    expect(result.counts.omissions).toBe(1);
    expect(result.failures).toHaveLength(1);
  });

  test("counts an unsupported strict pattern as an omission without calling it equivalent", () => {
    const result = audit(String.raw`^cdn[0-9]\.example\.com$`, "strict", ["cdn1.example.com"]);
    expect(result.failures).toEqual([]);
    expect(result.counts).toMatchObject({ expected: 1, actual: 0, omissions: 1 });
  });

  test.each([
    { pattern: String.raw`(^|\.)91porn\.(best|com)$`, omitted: "91porn.best", retained: "sub.91porn.best", negative: "sub.not91porn.best" },
    { pattern: String.raw`^nis.+\.10010\.com$`, omitted: "nisservice.10010.com", retained: "nis.service.10010.com", negative: "service.10010.com" },
    { pattern: String.raw`^cdn-akamai-.+\.gog-services\.com$`, omitted: "cdn-akamai-123.gog-services.com", retained: undefined, negative: "cdn-akamai-123.example.com" }
  ])("records a conservative balanced omission without broadening to recover it: $pattern", ({ pattern, omitted, retained, negative }) => {
    const result = audit(pattern, "balanced", [omitted, ...(retained ? [retained] : []), negative]);
    expect(result.failures).toEqual([]);
    expect(result.counts).toMatchObject({ expected: retained ? 2 : 1, actual: retained ? 1 : 0, omissions: 1, overmatches: 0 });
  });

  test("reports when unsupported syntax has no compatible audit oracle", () => {
    const result = audit(String.raw`^\Qexample.com\E$`, "balanced", ["example.com"]);
    expect(result.failures).toEqual([]);
    expect(result.counts.oracleUnavailable).toBe(1);
  });
});
