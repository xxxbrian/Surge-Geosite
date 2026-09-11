import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const exec = promisify(execFile);
const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

test("runs the packaged CLI through a symlink with spaces and non-ASCII characters", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "geosite entry 中文 "));
  try {
    const link = path.join(dir, "surge-geosite.js");
    await symlink(entry, link);
    const { stdout, stderr } = await exec(process.execPath, [link, "help"]);
    expect(stdout).toContain("surge-geosite commands:");
    expect(stderr).toBe("");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
