import { describe, expect, test } from "vitest";

import { getBooleanFlag, getStringFlag, parseCliArgs } from "../src/args.js";

describe("parseCliArgs", () => {
  test("parses command and flags", () => {
    const parsed = parseCliArgs([
      "build",
      "--data-dir",
      "./data",
      "--list=google,github",
      "extra",
      "--report-json"
    ]);

    expect(parsed.command).toBe("build");
    expect(getStringFlag(parsed.flags, "data-dir")).toBe("./data");
    expect(getStringFlag(parsed.flags, "list")).toBe("google,github");
    expect(getBooleanFlag(parsed.flags, "report-json")).toBe(true);
    expect(parsed.positionals).toEqual(["extra"]);
  });
});
