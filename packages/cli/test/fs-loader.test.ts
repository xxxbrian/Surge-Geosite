import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { loadListsFromDirectory } from "../src/fs-loader.js";

describe("loadListsFromDirectory", () => {
  test("loads files into a record", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "geosite-cli-"));
    await writeFile(path.join(dir, "google"), "domain:google.com\n", "utf8");
    await writeFile(path.join(dir, "github"), "domain:github.com\n", "utf8");

    const loaded = await loadListsFromDirectory(dir);

    expect(Object.keys(loaded)).toEqual(["github", "google"]);
    expect(loaded.google).toContain("google.com");
  });

  test("ignores non-geosite file names", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "geosite-cli-"));
    await writeFile(path.join(dir, "google"), "domain:google.com\n", "utf8");
    await writeFile(path.join(dir, ".DS_Store"), "binary", "utf8");
    await writeFile(path.join(dir, "README"), "notes", "utf8");
    await writeFile(path.join(dir, "README.md"), "notes", "utf8");

    const loaded = await loadListsFromDirectory(dir);

    expect(Object.keys(loaded)).toEqual(["google"]);
  });
});
