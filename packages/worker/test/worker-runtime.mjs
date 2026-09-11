// Run with: node packages/worker/test/worker-runtime.mjs
// Builds the real entrypoint with Wrangler's dry-run, then uses local workerd/R2.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const require = createRequire(import.meta.url);
const wranglerPackage = require.resolve("wrangler/package.json");
const { Miniflare, createFetchMock } = createRequire(wranglerPackage)("miniflare");
const run = promisify(execFile);
const workerDir = fileURLToPath(new URL("..", import.meta.url));

test("bundled Worker handlers initialize, refresh, cache, and conditionally serve rules in workerd", async () => {
  const output = await mkdtemp(path.join(tmpdir(), "geosite-worker-runtime-"));
  const fetchMock = createFetchMock();
  fetchMock.disableNetConnect();
  let runtime;

  try {
    // Prevent a stale workspace dist from hiding a source regression.
    await run(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", "../core/tsconfig.json"], {
      cwd: workerDir, timeout: 30_000
    });
    await run(process.execPath, [path.join(path.dirname(wranglerPackage), "bin/wrangler.js"),
      "deploy", "--dry-run", "--outdir", output], {
      cwd: workerDir,
      timeout: 30_000,
      env: {
        ...process.env,
        CI: "true",
        WRANGLER_HIDE_BANNER: "true",
        WRANGLER_SEND_METRICS: "false",
        WRANGLER_SEND_ERROR_REPORTS: "false"
      }
    });

    const upstream = fetchMock.get("https://upstream.test");
    for (const version of ["v1", "v2"]) {
      const yaml = `lists:\n  - name: demo\n    length: 1\n    rules:\n      - "domain:${version}.example:@cn"\n`;
      upstream.intercept({ method: "HEAD", path: "/dlc.yml" }).reply(200, "", { headers: { etag: `"runtime-${version}"` } });
      upstream.intercept({ method: "GET", path: "/dlc.yml" }).reply(200, yaml, { headers: { etag: `"runtime-${version}"` } });
    }
    upstream.intercept({ method: "GET", path: "/srs/geosite-demo.srs" })
      .reply(200, "runtime-srs", { headers: { etag: '"srs-v1"', "content-type": "application/octet-stream" } });

    runtime = new Miniflare({
      modules: true,
      scriptPath: path.join(output, "index.js"),
      modulesRoot: output,
      compatibilityDate: "2026-02-15",
      compatibilityFlags: ["nodejs_compat"],
      r2Buckets: ["GEOSITE_BUCKET"],
      bindings: {
        UPSTREAM_YAML_URL: "https://upstream.test/dlc.yml",
        SRS_UPSTREAM_BASE_URL: "https://upstream.test/srs"
      },
      fetchMock
    });

    const index = await runtime.dispatchFetch("https://worker.test/geosite");
    assert.equal(index.status, 200);
    assert.deepEqual(await index.json(), { demo: ["cn"] });
    const indexEtag = index.headers.get("etag");
    assert.ok(indexEtag);
    assert.equal((await runtime.dispatchFetch("https://worker.test/geosite", {
      headers: { "if-none-match": `W/${indexEtag}` }
    })).status, 304);

    const rules = await runtime.dispatchFetch("https://worker.test/geosite/demo");
    assert.equal(rules.status, 200);
    assert.equal(await rules.text(), "DOMAIN-SUFFIX,v1.example\n");
    const rulesEtag = rules.headers.get("etag");
    assert.ok(rulesEtag);
    assert.equal((await runtime.dispatchFetch("https://worker.test/geosite/demo", {
      method: "HEAD", headers: { "if-none-match": `W/${rulesEtag}` }
    })).status, 304);

    const scheduled = await (await runtime.getWorker()).scheduled({ cron: "*/5 * * * *" });
    assert.equal(scheduled.outcome, "ok");
    const bucket = await runtime.getR2Bucket("GEOSITE_BUCKET");
    const state = JSON.parse(await (await bucket.get("state/latest.json")).text());
    assert.equal(state.upstream.etag, "runtime-v2");
    assert.equal(state.previousCacheKey, "runtime-v1");

    const refreshedIndex = await runtime.dispatchFetch("https://worker.test/geosite", { headers: { "if-none-match": indexEtag } });
    assert.equal(refreshedIndex.status, 200);
    assert.notEqual(refreshedIndex.headers.get("etag"), indexEtag);
    const refreshedRules = await runtime.dispatchFetch("https://worker.test/geosite/strict/demo@cn");
    assert.equal(refreshedRules.status, 200);
    assert.equal(await refreshedRules.text(), "DOMAIN-SUFFIX,v2.example\n");

    const binary = await runtime.dispatchFetch("https://worker.test/geosite-srs/demo");
    assert.equal(binary.status, 200);
    assert.equal(await binary.text(), "runtime-srs");
    assert.equal((await runtime.dispatchFetch("https://worker.test/geosite-srs/demo", {
      headers: { "if-none-match": binary.headers.get("etag") }
    })).status, 304);
    const binaryObject = await bucket.get("remote-cache/geosite-srs/blob/geosite-demo.srs");
    assert.equal(JSON.parse(binaryObject.customMetadata.geositeCache).version, 2);
    fetchMock.assertNoPendingInterceptors();
  } finally {
    await runtime?.dispose();
    await fetchMock.close();
    await rm(output, { recursive: true, force: true });
  }
});
