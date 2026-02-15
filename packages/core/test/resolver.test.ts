import { describe, expect, test } from "vitest";

import { GeositeResolveError } from "../src/errors.js";
import { parseListsFromText } from "../src/parser.js";
import { resolveAllLists } from "../src/resolver.js";

describe("resolveAllLists", () => {
  test("resolves include filters, affiliations and redundancy polish", () => {
    const parsed = parseListsFromText({
      a: [
        "domain:example.com",
        "full:www.example.com",
        "keyword:needle",
        "regexp:(^|\\.)rx-only\\.com$",
        "include:b @cn @-ads",
        "domain:seed.com &c"
      ].join("\n"),
      b: ["domain:service.com @cn", "domain:ads.service.com @cn @ads", "full:api.service.com @cn"].join("\n")
    });

    const resolved = resolveAllLists(parsed);

    expect(resolved.A.entries.map((item) => item.plain)).toEqual([
      "domain:example.com",
      "domain:seed.com",
      "domain:service.com:@cn",
      "full:api.service.com:@cn",
      "keyword:needle",
      "regexp:(^|\\.)rx-only\\.com$"
    ]);

    expect(resolved.C.entries.map((item) => item.plain)).toEqual(["domain:seed.com"]);
  });

  test("detects circular includes", () => {
    const parsed = parseListsFromText({
      a: "include:b",
      b: "include:a"
    });

    expect(() => resolveAllLists(parsed)).toThrow(GeositeResolveError);
  });
});
