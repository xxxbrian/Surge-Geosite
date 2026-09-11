// Run with: node packages/worker/test/r2-runtime.mjs
// Reuse Wrangler's installed Miniflare; all storage and execution stay local.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve("wrangler/package.json"));
const { Miniflare } = wranglerRequire("miniflare");

test("R2 enforces publication preconditions and returns matching binary bytes and metadata", async () => {
  const runtime = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("local R2 contract"); } };',
    compatibilityDate: "2026-02-15",
    r2Buckets: ["GEOSITE_BUCKET"]
  });

  try {
    const bucket = await runtime.getR2Bucket("GEOSITE_BUCKET");
    const initial = await bucket.put("latest", "v1", { onlyIf: { etagDoesNotMatch: "*" } });
    assert.ok(initial);
    assert.equal(await bucket.put("latest", "other-initializer", { onlyIf: { etagDoesNotMatch: "*" } }), null);
    const advanced = await bucket.put("latest", "v2", { onlyIf: { etagMatches: initial.etag } });
    assert.ok(advanced);
    assert.equal(await bucket.put("latest", "late-v1", { onlyIf: { etagMatches: initial.etag } }), null);
    assert.equal(await (await bucket.get("latest")).text(), "v2");

    const first = await bucket.put("binary", "body-v1", { customMetadata: { identity: "v1" } });
    const before = await bucket.get("binary");
    const second = await bucket.put("binary", "body-v2", {
      customMetadata: { identity: "v2" },
      onlyIf: { etagMatches: first.etag }
    });
    assert.ok(second);
    assert.equal(await before.text(), "body-v1");
    assert.equal(before.customMetadata.identity, "v1");

    // A delayed revalidation of v1 must not restore its bytes after v2 wins.
    assert.equal(await bucket.put("binary", "body-v1", {
      customMetadata: { identity: "v1-revalidated" },
      onlyIf: { etagMatches: first.etag }
    }), null);
    const after = await bucket.get("binary");
    assert.equal(await after.text(), "body-v2");
    assert.equal(after.customMetadata.identity, "v2");
    assert.equal((await bucket.head("binary")).etag, second.etag);
  } finally {
    await runtime.dispose();
  }
});
