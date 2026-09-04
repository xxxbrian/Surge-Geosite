import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

const exec = promisify(execFile);
const script = fileURLToPath(new URL("../prewarm-geosite.mjs", import.meta.url));

async function runPrewarm(handler, extra = []) {
  const dir = await mkdtemp(path.join(tmpdir(), "geosite-prewarm-"));
  const server = createServer(handler);
  try {
    await mkdir(path.join(dir, "data"));
    await writeFile(path.join(dir, "data", "demo"), "example.com\n");
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    let code = 0;
    try {
      await exec(process.execPath, [script, "--base-url", baseUrl, "--data-dir", path.join(dir, "data"),
        "--out-dir", path.join(dir, "out"), "--modes", "balanced", "--retries", "0", "--timeout-ms", "1000", ...extra], { timeout: 6000 });
    } catch (error) {
      assert.equal(error.killed, false, "prewarm must finish without the test killing it");
      code = error.code;
    }
    const summary = JSON.parse(await readFile(path.join(dir, "out", "summary.json"), "utf8"));
    let rules = null;
    try { rules = await readFile(path.join(dir, "out/rules/balanced/demo.txt"), "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    return { code, summary, rules };
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
}

test("prewarm timeout includes a stalled success response body", async () => {
  const { code, summary } = await runPrewarm((_req, res) => { res.writeHead(200); res.flushHeaders(); res.write("DOMAIN,"); });
  assert.equal(code, 1);
  assert.equal(summary.counts.failed, 1);
  assert.equal(summary.counts.ok, 0);
});

test("prewarm retries a stalled error body and consumes the successful retry", async () => {
  let calls = 0;
  const { summary, rules } = await runPrewarm((_req, res) => {
    calls += 1;
    if (calls === 1) { res.writeHead(503); res.flushHeaders(); }
    else res.end("DOMAIN,example.com\n");
  }, ["--retries=1"]);
  assert.equal(calls, 2);
  assert.equal(summary.counts.ok, 1);
  assert.equal(rules, "DOMAIN,example.com\n");
});

for (const [name, status, body] of [
  ["HTTP errors", 404, "missing"],
  ["HTML masquerading as a ruleset", 200, "<html>error</html>"],
  ["match-all wildcards", 200, "DOMAIN-WILDCARD,*\n"]
]) {
  test(`prewarm fails for ${name} without writing a ruleset`, async () => {
    const { code, summary, rules } = await runPrewarm((_req, res) => { res.writeHead(status); res.end(body); });
    assert.equal(code, 1);
    assert.equal(summary.counts.ok, 0);
    assert.equal(summary.counts.failed, 1);
    assert.equal(rules, null);
  });
}

test("prewarm accepts an empty ruleset", async () => {
  const { code, summary, rules } = await runPrewarm((_req, res) => res.end(""));
  assert.equal(code, 0);
  assert.equal(summary.counts.ok, 1);
  assert.equal(rules, "");
});

for (const args of [["--modes=../invalid"], ["--modes=,,,"], ["--retries=abc"], ["--concurrency=0"], ["--limit"]]) {
  test(`prewarm rejects invalid options ${args.join(" ")}`, async () => {
    await assert.rejects(exec(process.execPath, [script, ...args]), (error) => error.code === 1);
  });
}
