import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { runCli } from "../src/index.js";

describe("runCli build", () => {
  test("generates all mode artifacts and stats", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "geosite-build-"));
    const dataDir = path.join(root, "data");
    const outDir = path.join(root, "out");

    await mkdir(dataDir, { recursive: true });
    await writeFile(path.join(dataDir, "demo"), "domain:example.com\nregexp:(^|\\.)netflix\\.com$\n", "utf8");

    const code = await runCli(["build", "--data-dir", dataDir, "--out-dir", outDir]);
    expect(code).toBe(0);

    const balanced = await readFile(path.join(outDir, "rules", "balanced", "demo.txt"), "utf8");
    const strict = await readFile(path.join(outDir, "rules", "strict", "demo.txt"), "utf8");
    const full = await readFile(path.join(outDir, "rules", "full", "demo.txt"), "utf8");
    const resolved = await readFile(path.join(outDir, "resolved", "demo.json"), "utf8");
    const meta = await readFile(path.join(outDir, "meta.json"), "utf8");
    const globalStats = await readFile(path.join(outDir, "stats", "global.json"), "utf8");

    expect(strict).toContain("DOMAIN-SUFFIX,netflix.com");
    expect(balanced).toContain("DOMAIN-SUFFIX,netflix.com");
    expect(full).toContain("DOMAIN-SUFFIX,netflix.com");
    expect(resolved).toContain("\"type\": \"domain\"");
    expect(meta).toContain('"defaultMode": "balanced"');
    expect(globalStats).toContain('"lists": 1');
  });
});
