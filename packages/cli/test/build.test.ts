import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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


test("rebuild removes obsolete manifest artifacts and preserves unrelated files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "geosite-rebuild-"));
  const dataDir = path.join(root, "data");
  const outDir = path.join(root, "out");
  try {
    await mkdir(dataDir);
    await writeFile(path.join(dataDir, "alpha"), "example.com\n");
    await writeFile(path.join(dataDir, "beta"), "example.org\n");
    expect(await runCli(["build", "--data-dir", dataDir, "--out-dir", outDir])).toBe(0);
    await writeFile(path.join(outDir, "notes.txt"), "keep me");
    await rm(path.join(dataDir, "beta"));
    expect(await runCli(["build", "--data-dir", dataDir, "--out-dir", outDir])).toBe(0);
    for (const relative of ["rules/strict/beta.txt", "rules/balanced/beta.txt", "rules/full/beta.txt", "resolved/beta.json", "stats/lists/beta.json"]) {
      await expect(readFile(path.join(outDir, relative))).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(JSON.parse(await readFile(path.join(outDir, "index/geosite.json"), "utf8"))).toEqual({ alpha: [] });
    expect(await readFile(path.join(outDir, "notes.txt"), "utf8")).toBe("keep me");
    await writeFile(path.join(outDir, "index/geosite.json"), JSON.stringify({ "../../notes": [] }));
    await expect(runCli(["build", "--data-dir", dataDir, "--out-dir", outDir])).rejects.toThrow("invalid list name");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("counts each normalized dataset only once", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "geosite-duplicates-"));
  try {
    const dataDir = path.join(root, "data");
    const outDir = path.join(root, "out");
    await mkdir(dataDir);
    await writeFile(path.join(dataDir, "alpha"), "example.com\n");
    expect(await runCli(["build", "--data-dir", dataDir, "--out-dir", outDir, "--list", "alpha,ALPHA,alpha"])).toBe(0);
    expect(JSON.parse(await readFile(path.join(outDir, "meta.json"), "utf8")).lists).toBe(1);
    expect(JSON.parse(await readFile(path.join(outDir, "stats/global.json"), "utf8")).lists).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
