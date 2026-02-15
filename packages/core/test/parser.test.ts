import { describe, expect, test } from "vitest";

import { parseListText } from "../src/parser.js";

describe("parseListText", () => {
  test("parses comments, attrs, affiliations, include filters and bare domain", () => {
    const entries = parseListText(
      "demo",
      [
        "# comment",
        "domain:Google.com @cn @Ads &foo",
        "include:bar @cn @-ads",
        "example.org # inline comment"
      ].join("\n")
    );

    expect(entries).toHaveLength(3);

    expect(entries[0]).toMatchObject({
      type: "domain",
      value: "google.com",
      attrs: ["ads", "cn"],
      affiliations: ["FOO"],
      plain: "domain:google.com:@ads,@cn"
    });

    expect(entries[1]).toMatchObject({
      type: "include",
      sourceList: "BAR",
      attrs: ["-ads", "cn"],
      mustAttrs: ["cn"],
      banAttrs: ["ads"]
    });

    expect(entries[2]).toMatchObject({
      type: "domain",
      value: "example.org",
      attrs: []
    });
  });
});
