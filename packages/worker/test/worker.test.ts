import { createHash } from "node:crypto";

import { describe, expect, test } from "vitest";

import {
  createWorker,
  refreshGeositeRun,
  type ExecutionContextLike,
  type R2BucketLike,
  type R2ObjectBodyLike,
  type R2ObjectLike,
  type R2PutOptionsLike,
  type WorkerEnv
} from "../src/index.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

class MemoryR2Object implements R2ObjectBodyLike {
  constructor(
    private readonly data: Uint8Array,
    readonly etag: string,
    readonly customMetadata: Record<string, string> = {}
  ) {}

  async text(): Promise<string> {
    return new TextDecoder().decode(this.data);
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.data.buffer.slice(this.data.byteOffset, this.data.byteOffset + this.data.byteLength);
  }
}

class MemoryR2Bucket implements R2BucketLike {
  private readonly store = new Map<string, MemoryR2Object>();

  async head(key: string): Promise<R2ObjectLike | null> {
    return this.store.get(key) ?? null;
  }

  async get(key: string): Promise<R2ObjectBodyLike | null> {
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string | ArrayBuffer | Uint8Array, options?: R2PutOptionsLike): Promise<R2ObjectLike | null> {
    const current = this.store.get(key);
    const condition = options?.onlyIf;
    if (condition?.etagMatches !== undefined && current?.etag !== condition.etagMatches) {
      return null;
    }
    if (condition?.etagDoesNotMatch === "*" ? current :
      condition?.etagDoesNotMatch !== undefined && current?.etag === condition.etagDoesNotMatch) {
      return null;
    }
    const data = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
    const object = new MemoryR2Object(data, createHash("md5").update(data).digest("hex"), { ...options?.customMetadata });
    this.store.set(key, object);
    return object;
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async putJson(key: string, value: unknown): Promise<void> {
    await this.put(key, `${JSON.stringify(value)}\n`);
  }
}

class TestContext implements ExecutionContextLike {
  private readonly pending: Promise<unknown>[] = [];

  waitUntil(promise: Promise<unknown>): void {
    this.pending.push(promise);
  }

  async drain(): Promise<void> {
    await Promise.allSettled(this.pending);
  }
}

const DEFAULT_YAML_URL = "https://example.com/dlc.dat_plain.yml";
const textEncoder = new TextEncoder();

function makeLatestState(
  cacheKey: string,
  options: { listCount?: number; previousCacheKey?: string | null } = {}
): unknown {
  return {
    upstream: {
      yamlUrl: DEFAULT_YAML_URL,
      etag: cacheKey,
      cacheKey
    },
    snapshot: {
      sourceKey: `snapshots/${cacheKey}/sources.json`,
      indexKey: `snapshots/${cacheKey}/index/geosite.json`,
      listCount: options.listCount ?? 1,
      generatedAt: "2026-02-15T00:00:00.000Z"
    },
    previousCacheKey: options.previousCacheKey ?? null,
    checkedAt: "2026-02-15T00:00:00.000Z"
  };
}

function makeSnapshotPayload(cacheKey: string, lists: Record<string, string>): string {
  return `${JSON.stringify({
    version: 2,
    etag: cacheKey,
    yamlUrl: DEFAULT_YAML_URL,
    cacheKey,
    generatedAt: "2026-02-15T00:00:00.000Z",
    lists
  })}\n`;
}

function strToU8(input: string): Uint8Array {
  return textEncoder.encode(input);
}

function makeDlcYaml(lists: Record<string, string[]>): string {
  const lines = ["lists:"];
  for (const [name, rules] of Object.entries(lists)) {
    lines.push(`  - name: ${name}`);
    lines.push(`    length: ${rules.length}`);
    lines.push("    rules:");
    for (const rule of rules) {
      lines.push(`      - ${JSON.stringify(rule)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

describe("refreshGeositeRun", () => {
  test("updates snapshot when etag changes", async () => {
    const bucket = new MemoryR2Bucket();
    const env: WorkerEnv = { GEOSITE_BUCKET: bucket, UPSTREAM_YAML_URL: DEFAULT_YAML_URL };

    const yamlText = makeDlcYaml({
      google: ["domain:google.com:@cn", "full:mail.google.com:@us"],
      github: ["domain:github.com"]
    });

    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push(method);
      if (method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: {
            etag: '"etag-refresh-v1"'
          }
        });
      }
      return new Response(yamlText, {
        status: 200,
        headers: {
          etag: '"etag-refresh-v1"'
        }
      });
    };

    const result = await refreshGeositeRun(env, {
      now: () => Date.parse("2026-02-15T01:00:00.000Z"),
      fetchImpl
    });

    expect(result.updated).toBe(true);
    expect(result.etag).toBe("etag-refresh-v1");
    expect(result.listCount).toBe(2);
    expect(calls).toEqual(["HEAD", "GET"]);

    const latestRaw = await bucket.get("state/latest.json");
    expect(latestRaw).not.toBeNull();

    const latest = JSON.parse(await latestRaw!.text()) as {
      upstream: { etag: string; cacheKey: string; yamlUrl: string };
      snapshot: { sourceKey: string; indexKey: string };
    };

    expect(latest.upstream.etag).toBe("etag-refresh-v1");
    expect(latest.upstream.cacheKey).toBe("etag-refresh-v1");
    expect(latest.upstream.yamlUrl).toBe(DEFAULT_YAML_URL);
    expect(await bucket.get(latest.snapshot.sourceKey)).not.toBeNull();
    const indexRaw = await bucket.get(latest.snapshot.indexKey);
    expect(indexRaw).not.toBeNull();
    expect(JSON.parse(await indexRaw!.text())).toEqual({
      github: [],
      google: ["cn", "us"]
    });
  });

  test("returns unchanged when head etag matches current", async () => {
    const bucket = new MemoryR2Bucket();
    const env: WorkerEnv = { GEOSITE_BUCKET: bucket, UPSTREAM_YAML_URL: DEFAULT_YAML_URL };

    await bucket.putJson("state/latest.json", makeLatestState("etag-unchanged-v1"));
    await bucket.put("snapshots/etag-unchanged-v1/sources.json", makeSnapshotPayload("etag-unchanged-v1", { google: "domain:google.com" }));
    await bucket.putJson("snapshots/etag-unchanged-v1/index/geosite.json", { google: [] });

    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls.push((init?.method ?? "GET").toUpperCase());
      return new Response(null, {
        status: 200,
        headers: {
          etag: '"etag-unchanged-v1"'
        }
      });
    };

    const result = await refreshGeositeRun(env, {
      now: () => Date.parse("2026-02-15T01:30:00.000Z"),
      fetchImpl
    });

    expect(result.updated).toBe(false);
    expect(result.reason).toBe("etag-unchanged");
    expect(calls).toEqual(["HEAD"]);
  });

  test("does not overwrite newer latest state when concurrent refresh already advanced", async () => {
    const bucket = new MemoryR2Bucket();
    const env: WorkerEnv = { GEOSITE_BUCKET: bucket, UPSTREAM_YAML_URL: DEFAULT_YAML_URL };

    await bucket.putJson("state/latest.json", makeLatestState("etag-base-v1"));

    const yamlText = makeDlcYaml({
      google: ["domain:google.com"]
    });

    const fetchImpl: typeof fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: {
            etag: '"etag-race-v2"'
          }
        });
      }

      await bucket.putJson("state/latest.json", makeLatestState("etag-other-v3", { previousCacheKey: "etag-base-v1" }));

      return new Response(yamlText, {
        status: 200,
        headers: {
          etag: '"etag-race-v2"'
        }
      });
    };

    const result = await refreshGeositeRun(env, {
      now: () => Date.parse("2026-02-15T01:45:00.000Z"),
      fetchImpl
    });

    expect(result.updated).toBe(false);
    expect(result.etag).toBe("etag-other-v3");

    const latestRaw = await bucket.get("state/latest.json");
    expect(latestRaw).not.toBeNull();
    const latest = JSON.parse(await latestRaw!.text()) as { upstream: { etag: string } };
    expect(latest.upstream.etag).toBe("etag-other-v3");
  });

  test.each(["head-unchanged", "get-unchanged", "updated", "initialization"] as const)(
    "conditionally publishes latest during a concurrent %s refresh",
    async (scenario) => {
      const entered = deferred<void>();
      const release = deferred<void>();
      class InterleavedBucket extends MemoryR2Bucket {
        armed = false;
        override async put(key: string, value: string | ArrayBuffer | Uint8Array, options?: R2PutOptionsLike) {
          if (this.armed && key === "state/latest.json") {
            this.armed = false;
            entered.resolve();
            await release.promise;
          }
          return super.put(key, value, options);
        }
      }
      const bucket = new InterleavedBucket();
      const env: WorkerEnv = { GEOSITE_BUCKET: bucket, UPSTREAM_YAML_URL: DEFAULT_YAML_URL };
      if (scenario !== "initialization") {
        await bucket.putJson("state/latest.json", makeLatestState("cas-v1"));
        await bucket.put("snapshots/cas-v1/sources.json", makeSnapshotPayload("cas-v1", { google: "domain:google.com" }));
        await bucket.putJson("snapshots/cas-v1/index/geosite.json", { google: [] });
      }
      const slowEtag = scenario.endsWith("unchanged") ? "cas-v1" : "cas-v2";
      const slowFetch: typeof fetch = async (_input, init) => {
        if (init?.method === "HEAD") {
          return new Response(null, scenario === "get-unchanged" ? { status: 405 } : { headers: { etag: slowEtag } });
        }
        return new Response(makeDlcYaml({ google: ["domain:slow.example"] }), { headers: { etag: slowEtag } });
      };
      bucket.armed = true;
      const slow = refreshGeositeRun(env, { fetchImpl: slowFetch });
      await entered.promise;
      const fast = await refreshGeositeRun(env, {
        fetchImpl: async (_input, init) => new Response(
          init?.method === "HEAD" ? null : makeDlcYaml({ google: ["domain:fast.example"] }),
          { headers: { etag: "cas-v3" } }
        )
      });
      expect(fast.updated).toBe(true);
      release.resolve();
      expect(await slow).toMatchObject({ updated: false, reason: "superseded", etag: "cas-v3" });
      const latest = JSON.parse(await (await bucket.get("state/latest.json"))!.text());
      expect(latest.upstream.etag).toBe("cas-v3");
      expect(latest.previousCacheKey).toBe(scenario === "initialization" ? null : "cas-v1");
    }
  );

  test.each(["source", "index", "both"] as const)("repairs missing %s objects even when upstream etag is unchanged", async (missing) => {
    const bucket = new MemoryR2Bucket();
    const key = `repair-${missing}`;
    const env: WorkerEnv = { GEOSITE_BUCKET: bucket, UPSTREAM_YAML_URL: DEFAULT_YAML_URL };
    await bucket.putJson("state/latest.json", makeLatestState(key, { previousCacheKey: "retained-previous" }));
    if (missing !== "source" && missing !== "both") {
      await bucket.put(`snapshots/${key}/sources.json`, makeSnapshotPayload(key, { google: "domain:google.com" }));
    }
    if (missing !== "index" && missing !== "both") {
      await bucket.putJson(`snapshots/${key}/index/geosite.json`, { google: [] });
    }
    const methods: string[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      methods.push(init?.method ?? "GET");
      return new Response(init?.method === "HEAD" ? null : makeDlcYaml({ google: ["domain:google.com:@cn"] }), {
        headers: { etag: key }
      });
    };
    expect(await refreshGeositeRun(env, { fetchImpl })).toMatchObject({ updated: true, reason: "snapshot-repaired" });
    expect(methods).toEqual(["HEAD", "GET"]);
    expect(await bucket.get(`snapshots/${key}/sources.json`)).not.toBeNull();
    expect(JSON.parse(await (await bucket.get(`snapshots/${key}/index/geosite.json`))!.text())).toEqual({ google: ["cn"] });
    expect(JSON.parse(await (await bucket.get("state/latest.json"))!.text()).previousCacheKey).toBe("retained-previous");
  });

  test("refuses to publish invalid snapshot payload", async () => {
    const bucket = new MemoryR2Bucket();
    const env: WorkerEnv = { GEOSITE_BUCKET: bucket, UPSTREAM_YAML_URL: DEFAULT_YAML_URL };

    await bucket.putJson("state/latest.json", makeLatestState("etag-stable-v1"));

    const yamlText = makeDlcYaml({
      google: ["domain:google.com:@?"]
    });

    const fetchImpl: typeof fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if ((init?.method ?? "GET").toUpperCase() === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: {
            etag: '"etag-bad-v2"'
          }
        });
      }
      return new Response(yamlText, {
        status: 200,
        headers: {
          etag: '"etag-bad-v2"'
        }
      });
    };

    await expect(
      refreshGeositeRun(env, {
        now: () => Date.parse("2026-02-15T02:00:00.000Z"),
        fetchImpl
      })
    ).rejects.toThrow();

    const latestRaw = await bucket.get("state/latest.json");
    expect(latestRaw).not.toBeNull();
    const latest = JSON.parse(await latestRaw!.text()) as { upstream: { etag: string } };
    expect(latest.upstream.etag).toBe("etag-stable-v1");
    expect(await bucket.get("snapshots/etag-bad-v2/sources.json")).toBeNull();
  });

  test("falls back to GET when upstream HEAD has no usable etag", async () => {
    const bucket = new MemoryR2Bucket();
    const env: WorkerEnv = { GEOSITE_BUCKET: bucket, UPSTREAM_YAML_URL: DEFAULT_YAML_URL };
    const yamlText = makeDlcYaml({
      google: ["domain:google.com"]
    });
    const calls: string[] = [];

    const fetchImpl: typeof fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push(method);
      if (method === "HEAD") {
        return new Response(null, { status: 405 });
      }
      return new Response(yamlText, {
        status: 200,
        headers: {
          etag: '"etag-head-fallback-v1"'
        }
      });
    };

    const result = await refreshGeositeRun(env, {
      now: () => Date.parse("2026-02-15T02:30:00.000Z"),
      fetchImpl
    });

    expect(result.updated).toBe(true);
    expect(result.etag).toBe("etag-head-fallback-v1");
    expect(calls).toEqual(["HEAD", "GET"]);
  });

  test("converts yaml attrs and regexp rules before building index", async () => {
    const bucket = new MemoryR2Bucket();
    const env: WorkerEnv = { GEOSITE_BUCKET: bucket, UPSTREAM_YAML_URL: DEFAULT_YAML_URL };
    const yamlText = makeDlcYaml({
      google: ["domain:google.com:@!cn,@ads", "regexp:^https?:\\/\\/[^/]+\\.google\\.com:@cn"]
    });

    const fetchImpl: typeof fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if ((init?.method ?? "GET").toUpperCase() === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: {
            etag: '"etag-yaml-attrs-v1"'
          }
        });
      }
      return new Response(yamlText, {
        status: 200,
        headers: {
          etag: '"etag-yaml-attrs-v1"'
        }
      });
    };

    await refreshGeositeRun(env, {
      now: () => Date.parse("2026-02-15T02:45:00.000Z"),
      fetchImpl
    });

    const indexRaw = await bucket.get("snapshots/etag-yaml-attrs-v1/index/geosite.json");
    expect(indexRaw).not.toBeNull();
    expect(JSON.parse(await indexRaw!.text())).toEqual({
      google: ["!cn", "ads", "cn"]
    });
  });

  test("preserves numeric-looking yaml list names", async () => {
    const bucket = new MemoryR2Bucket();
    const env: WorkerEnv = { GEOSITE_BUCKET: bucket, UPSTREAM_YAML_URL: DEFAULT_YAML_URL };
    const yamlText = [
      "lists:",
      "  - name: 115",
      "    length: 1",
      "    rules:",
      "      - \"domain:115.com\"",
      "  - name: 0x0",
      "    length: 1",
      "    rules:",
      "      - \"domain:0x0.st\"",
      ""
    ].join("\n");

    const fetchImpl: typeof fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if ((init?.method ?? "GET").toUpperCase() === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: { etag: '"etag-numeric-names-v1"' }
        });
      }
      return new Response(yamlText, {
        status: 200,
        headers: { etag: '"etag-numeric-names-v1"' }
      });
    };

    await refreshGeositeRun(env, {
      now: () => Date.parse("2026-02-15T03:00:00.000Z"),
      fetchImpl
    });

    const indexRaw = await bucket.get("snapshots/etag-numeric-names-v1/index/geosite.json");
    expect(indexRaw).not.toBeNull();
    expect(JSON.parse(await indexRaw!.text())).toEqual({
      "0x0": [],
      "115": []
    });
  });
});

describe("worker fetch routes", () => {
  test("initializes geosite data from upstream when latest state is missing", async () => {
    const bucket = new MemoryR2Bucket();
    const env: WorkerEnv = { GEOSITE_BUCKET: bucket, UPSTREAM_YAML_URL: DEFAULT_YAML_URL };
    const yamlText = makeDlcYaml({
      google: ["domain:google.com"]
    });
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push(method);
      if (method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: { etag: '"etag-lazy-init-v1"' }
        });
      }
      return new Response(yamlText, {
        status: 200,
        headers: { etag: '"etag-lazy-init-v1"' }
      });
    };

    const worker = createWorker({ fetchImpl });
    const indexResponse = await worker.fetch(new Request("https://example.com/geosite"), env, new TestContext());
    expect(indexResponse.status).toBe(200);
    expect(indexResponse.headers.get("x-robots-tag")).toBe("noindex");
    expect(await indexResponse.json()).toEqual({ google: [] });

    const rulesResponse = await worker.fetch(new Request("https://example.com/geosite/google"), env, new TestContext());
    expect(rulesResponse.status).toBe(200);
    expect(rulesResponse.headers.get("x-robots-tag")).toBe("noindex");
    expect(await rulesResponse.text()).toContain("DOMAIN-SUFFIX,google.com");
    expect(calls).toEqual(["HEAD", "GET"]);
  });

  test("returns 503 when latest state is missing and upstream refresh fails", async () => {
    const bucket = new MemoryR2Bucket();
    const env: WorkerEnv = { GEOSITE_BUCKET: bucket, UPSTREAM_YAML_URL: DEFAULT_YAML_URL };
    const fetchImpl: typeof fetch = async (): Promise<Response> => new Response(null, { status: 500 });

    const worker = createWorker({ fetchImpl });
    const indexResponse = await worker.fetch(new Request("https://example.com/geosite"), env, new TestContext());
    expect(indexResponse.status).toBe(503);
    expect(indexResponse.headers.get("x-robots-tag")).toBe("noindex");
    expect(await indexResponse.json()).toEqual({ ok: false, error: "geosite data not ready" });
  });

  test("compiles and serves artifact on first request", async () => {
    const bucket = new MemoryR2Bucket();
    const env: WorkerEnv = { GEOSITE_BUCKET: bucket };

    await bucket.putJson("state/latest.json", {
      upstream: {
        yamlUrl: DEFAULT_YAML_URL,
        etag: "etag-fetch-v1",
        cacheKey: "etag-fetch-v1"
      },
      snapshot: {
        sourceKey: "snapshots/etag-fetch-v1/sources.json",
        indexKey: "snapshots/etag-fetch-v1/index/geosite.json",
        listCount: 1,
        generatedAt: "2026-02-15T00:00:00.000Z"
      },
      previousCacheKey: null,
      checkedAt: "2026-02-15T00:00:00.000Z"
    });

    await bucket.put(
      "snapshots/etag-fetch-v1/sources.json",
      makeSnapshotPayload("etag-fetch-v1", {
        google: "domain:google.com\nfull:mail.google.com\n"
      })
    );
    await bucket.putJson("snapshots/etag-fetch-v1/index/geosite.json", {
      google: []
    });

    const ctx = new TestContext();
    const worker = createWorker();

    const response = await worker.fetch(new Request("https://example.com/geosite/google"), env, ctx);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    const body = await response.text();
    expect(body).toContain("DOMAIN-SUFFIX,google.com");
    expect(body).not.toContain("mail.google.com");

    const cached = await bucket.get("artifacts/v2/etag-fetch-v1/balanced/google.txt");
    expect(cached).not.toBeNull();

    await ctx.drain();
  });

  test("serves compact geosite index with versioned etag", async () => {
    const bucket = new MemoryR2Bucket();
    const env: WorkerEnv = { GEOSITE_BUCKET: bucket };

    await bucket.putJson("state/latest.json", {
      upstream: {
        yamlUrl: DEFAULT_YAML_URL,
        etag: "etag-index-v1",
        cacheKey: "etag-index-v1"
      },
      snapshot: {
        sourceKey: "snapshots/etag-index-v1/sources.json",
        indexKey: "snapshots/etag-index-v1/index/geosite.json",
        listCount: 2,
        generatedAt: "2026-02-15T00:00:00.000Z"
      },
      previousCacheKey: null,
      checkedAt: "2026-02-15T00:00:00.000Z"
    });
    await bucket.putJson("snapshots/etag-index-v1/index/geosite.json", {
      apple: ["cn"],
      google: []
    });

    const worker = createWorker();
    const response = await worker.fetch(new Request("https://example.com/geosite"), env, new TestContext());
    expect(response.status).toBe(200);
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    expect(response.headers.get("etag")).toBe('"geosite-index-v2:etag-index-v1"');
    expect(await response.json()).toEqual({
      apple: ["cn"],
      google: []
    });

    const notModified = await worker.fetch(
      new Request("https://example.com/geosite", {
        headers: { "if-none-match": '"geosite-index-v2:etag-index-v1"' }
      }),
      env,
      new TestContext()
    );
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get("x-robots-tag")).toBe("noindex");
  });

  test("supports HEAD for geosite index with conditional etag", async () => {
    const bucket = new MemoryR2Bucket();
    const env: WorkerEnv = { GEOSITE_BUCKET: bucket };

    await bucket.putJson("state/latest.json", {
      upstream: {
        yamlUrl: DEFAULT_YAML_URL,
        etag: "etag-head-index-v1",
        cacheKey: "etag-head-index-v1"
      },
      snapshot: {
        sourceKey: "snapshots/etag-head-index-v1/sources.json",
        indexKey: "snapshots/etag-head-index-v1/index/geosite.json",
        listCount: 1,
        generatedAt: "2026-02-15T00:00:00.000Z"
      },
      previousCacheKey: null,
      checkedAt: "2026-02-15T00:00:00.000Z"
    });
    await bucket.putJson("snapshots/etag-head-index-v1/index/geosite.json", {
      google: []
    });

    const worker = createWorker();
    const response = await worker.fetch(
      new Request("https://example.com/geosite", {
        method: "HEAD"
      }),
      env,
      new TestContext()
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe('"geosite-index-v2:etag-head-index-v1"');
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    expect(await response.text()).toBe("");

    const notModified = await worker.fetch(
      new Request("https://example.com/geosite", {
        method: "HEAD",
        headers: { "if-none-match": '"geosite-index-v2:etag-head-index-v1"' }
      }),
      env,
      new TestContext()
    );
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get("etag")).toBe('"geosite-index-v2:etag-head-index-v1"');
    expect(notModified.headers.get("x-robots-tag")).toBe("noindex");
    expect(await notModified.text()).toBe("");
  });

  test("returns stale artifact and refreshes latest in background", async () => {
    const bucket = new MemoryR2Bucket();
    const env: WorkerEnv = { GEOSITE_BUCKET: bucket };

    await bucket.putJson("state/latest.json", {
      upstream: {
        yamlUrl: DEFAULT_YAML_URL,
        etag: "etag-stale-v2",
        cacheKey: "etag-stale-v2"
      },
      snapshot: {
        sourceKey: "snapshots/etag-stale-v2/sources.json",
        indexKey: "snapshots/etag-stale-v2/index/geosite.json",
        listCount: 1,
        generatedAt: "2026-02-15T00:00:00.000Z"
      },
      previousCacheKey: "etag-stale-v1",
      checkedAt: "2026-02-15T00:00:00.000Z"
    });

    await bucket.put(
      "snapshots/etag-stale-v2/sources.json",
      makeSnapshotPayload("etag-stale-v2", {
        google: "domain:google.com\nfull:mail.google.com\n"
      })
    );
    await bucket.putJson("snapshots/etag-stale-v2/index/geosite.json", {
      google: []
    });

    await bucket.put("artifacts/v2/etag-stale-v1/balanced/google.txt", "DOMAIN-SUFFIX,old.example\n");

    const ctx = new TestContext();
    const worker = createWorker();

    const response = await worker.fetch(new Request("https://example.com/geosite/google"), env, ctx);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("DOMAIN-SUFFIX,old.example\n");
    expect(response.headers.get("x-stale")).toBe("1");

    await ctx.drain();

    const refreshed = await bucket.get("artifacts/v2/etag-stale-v2/balanced/google.txt");
    expect(refreshed).not.toBeNull();
    expect(await refreshed!.text()).toContain("DOMAIN-SUFFIX,google.com");
  });

  test("returns 404 for deleted list even if previous artifact exists", async () => {
    const bucket = new MemoryR2Bucket();
    const env: WorkerEnv = { GEOSITE_BUCKET: bucket };

    await bucket.putJson("state/latest.json", {
      upstream: {
        yamlUrl: DEFAULT_YAML_URL,
        etag: "etag-del-v2",
        cacheKey: "etag-del-v2"
      },
      snapshot: {
        sourceKey: "snapshots/etag-del-v2/sources.json",
        indexKey: "snapshots/etag-del-v2/index/geosite.json",
        listCount: 1,
        generatedAt: "2026-02-15T00:00:00.000Z"
      },
      previousCacheKey: "etag-del-v1",
      checkedAt: "2026-02-15T00:00:00.000Z"
    });

    await bucket.put(
      "snapshots/etag-del-v2/sources.json",
      makeSnapshotPayload("etag-del-v2", {
        github: "domain:github.com\n"
      })
    );
    await bucket.putJson("snapshots/etag-del-v2/index/geosite.json", {
      github: []
    });
    await bucket.put("artifacts/v2/etag-del-v1/balanced/google.txt", "DOMAIN-SUFFIX,old-google.example\n");

    const worker = createWorker();
    const response = await worker.fetch(new Request("https://example.com/geosite/google"), env, new TestContext());
    expect(response.status).toBe(404);
    expect(response.headers.get("x-stale")).toBeNull();
  });

  test("does not serve stale artifact when index is missing", async () => {
    const bucket = new MemoryR2Bucket();
    const env: WorkerEnv = { GEOSITE_BUCKET: bucket };

    await bucket.putJson("state/latest.json", {
      upstream: {
        yamlUrl: DEFAULT_YAML_URL,
        etag: "etag-noindex-v2",
        cacheKey: "etag-noindex-v2"
      },
      snapshot: {
        sourceKey: "snapshots/etag-noindex-v2/sources.json",
        indexKey: "snapshots/etag-noindex-v2/index/geosite.json",
        listCount: 1,
        generatedAt: "2026-02-15T00:00:00.000Z"
      },
      previousCacheKey: "etag-noindex-v1",
      checkedAt: "2026-02-15T00:00:00.000Z"
    });

    await bucket.put(
      "snapshots/etag-noindex-v2/sources.json",
      makeSnapshotPayload("etag-noindex-v2", {
        github: "domain:github.com\n"
      })
    );
    await bucket.put("artifacts/v2/etag-noindex-v1/balanced/google.txt", "DOMAIN-SUFFIX,old-google.example\n");

    const worker = createWorker();
    const response = await worker.fetch(new Request("https://example.com/geosite/google"), env, new TestContext());
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("list not found: google");
    expect(response.headers.get("x-stale")).toBeNull();
  });

  test("rebuilds compact index from snapshot when index object is missing", async () => {
    const bucket = new MemoryR2Bucket();
    const env: WorkerEnv = { GEOSITE_BUCKET: bucket };

    await bucket.putJson("state/latest.json", {
      upstream: {
        yamlUrl: DEFAULT_YAML_URL,
        etag: "etag-index-missing-v1",
        cacheKey: "etag-index-missing-v1"
      },
      snapshot: {
        sourceKey: "snapshots/etag-index-missing-v1/sources.json",
        indexKey: "snapshots/etag-index-missing-v1/index/geosite.json",
        listCount: 1,
        generatedAt: "2026-02-15T00:00:00.000Z"
      },
      previousCacheKey: null,
      checkedAt: "2026-02-15T00:00:00.000Z"
    });
    await bucket.put(
      "snapshots/etag-index-missing-v1/sources.json",
      makeSnapshotPayload("etag-index-missing-v1", {
        apple: "domain:apple.com @cn\nfull:icloud.com @us\n"
      })
    );

    const ctx = new TestContext();
    const worker = createWorker();
    const response = await worker.fetch(new Request("https://example.com/geosite"), env, ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      apple: ["cn", "us"]
    });

    await ctx.drain();
    const rebuilt = await bucket.get("snapshots/etag-index-missing-v1/index/geosite.json");
    expect(rebuilt).not.toBeNull();
    expect(JSON.parse(await rebuilt!.text())).toEqual({
      apple: ["cn", "us"]
    });
  });

  test("does not cache unknown filter artifacts or mutate compact index", async () => {
    const bucket = new MemoryR2Bucket();
    const env: WorkerEnv = { GEOSITE_BUCKET: bucket };

    await bucket.putJson("state/latest.json", {
      upstream: {
        yamlUrl: DEFAULT_YAML_URL,
        etag: "etag-filter-v1",
        cacheKey: "etag-filter-v1"
      },
      snapshot: {
        sourceKey: "snapshots/etag-filter-v1/sources.json",
        indexKey: "snapshots/etag-filter-v1/index/geosite.json",
        listCount: 1,
        generatedAt: "2026-02-15T00:00:00.000Z"
      },
      previousCacheKey: null,
      checkedAt: "2026-02-15T00:00:00.000Z"
    });

    await bucket.put(
      "snapshots/etag-filter-v1/sources.json",
      makeSnapshotPayload("etag-filter-v1", {
        google: "domain:google.com @cn\n"
      })
    );
    await bucket.putJson("snapshots/etag-filter-v1/index/geosite.json", {
      google: ["cn"]
    });

    const ctx = new TestContext();
    const worker = createWorker();

    const unknownFilter = await worker.fetch(new Request("https://example.com/geosite/google@us"), env, ctx);
    expect(unknownFilter.status).toBe(200);
    expect(await unknownFilter.text()).toBe("");
    expect(await bucket.get("artifacts/v2/etag-filter-v1/balanced/google@us.txt")).toBeNull();

    const knownFilter = await worker.fetch(new Request("https://example.com/geosite/google@cn"), env, ctx);
    expect(knownFilter.status).toBe(200);
    expect(await knownFilter.text()).toContain("DOMAIN-SUFFIX,google.com");

    await ctx.drain();

    const indexRaw = await bucket.get("snapshots/etag-filter-v1/index/geosite.json");
    expect(indexRaw).not.toBeNull();
    expect(JSON.parse(await indexRaw!.text())).toEqual({
      google: ["cn"]
    });
  });

  test.each(["/geosite", "/geosite/google"])("repairs dangling snapshots on a cold request to %s", async (route) => {
    const bucket = new MemoryR2Bucket();
    const key = route === "/geosite" ? "request-repair-index" : "request-repair-rule";
    const env: WorkerEnv = { GEOSITE_BUCKET: bucket, UPSTREAM_YAML_URL: DEFAULT_YAML_URL };
    await bucket.putJson("state/latest.json", makeLatestState(key));
    let calls = 0;
    const worker = createWorker({ fetchImpl: async (_input, init) => {
      calls += 1;
      return new Response(init?.method === "HEAD" ? null : makeDlcYaml({ google: ["domain:google.com"] }), { headers: { etag: key } });
    } });
    const response = await worker.fetch(new Request(`https://example.com${route}`), env, new TestContext());
    expect(response.status).toBe(200);
    expect(calls).toBe(2);
    expect(await bucket.get(`snapshots/${key}/sources.json`)).not.toBeNull();
    expect(await bucket.get(`snapshots/${key}/index/geosite.json`)).not.toBeNull();
  });

  test("hot artifact requests do not probe or download snapshot objects", async () => {
    class CountingBucket extends MemoryR2Bucket {
      reads: string[] = [];
      override async head(key: string) { this.reads.push(`HEAD ${key}`); return super.head(key); }
      override async get(key: string) { this.reads.push(`GET ${key}`); return super.get(key); }
    }
    const bucket = new CountingBucket();
    await bucket.putJson("state/latest.json", makeLatestState("hot-artifact"));
    await bucket.put("artifacts/v2/hot-artifact/balanced/google.txt", "DOMAIN-SUFFIX,google.com\n");
    const worker = createWorker({ fetchImpl: async () => { throw new Error("unexpected upstream fetch"); } });
    const response = await worker.fetch(new Request("https://example.com/geosite/google"), { GEOSITE_BUCKET: bucket }, new TestContext());
    expect(response.status).toBe(200);
    expect(bucket.reads).toEqual(["GET state/latest.json", "GET artifacts/v2/hot-artifact/balanced/google.txt"]);
  });

  test("recovers from transient snapshot parse failure without poisoned cache", async () => {
    const bucket = new MemoryR2Bucket();
    const env: WorkerEnv = { GEOSITE_BUCKET: bucket };

    await bucket.putJson("state/latest.json", {
      upstream: {
        yamlUrl: DEFAULT_YAML_URL,
        etag: "etag-poison-v1",
        cacheKey: "etag-poison-v1"
      },
      snapshot: {
        sourceKey: "snapshots/etag-poison-v1/sources.json",
        indexKey: "snapshots/etag-poison-v1/index/geosite.json",
        listCount: 1,
        generatedAt: "2026-02-15T00:00:00.000Z"
      },
      previousCacheKey: null,
      checkedAt: "2026-02-15T00:00:00.000Z"
    });
    await bucket.put("snapshots/etag-poison-v1/sources.json", strToU8("not-gzip"));

    const worker = createWorker();
    await expect(worker.fetch(new Request("https://example.com/geosite/google"), env, new TestContext())).rejects.toThrow();

    await bucket.put(
      "snapshots/etag-poison-v1/sources.json",
      makeSnapshotPayload("etag-poison-v1", {
        google: "domain:google.com\n"
      })
    );

    const response = await worker.fetch(new Request("https://example.com/geosite/google"), env, new TestContext());
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("DOMAIN-SUFFIX,google.com");
  });

  test("caches geosite-srs payload and serves from cache without extra upstream calls", async () => {
    const bucket = new MemoryR2Bucket();
    const env: WorkerEnv = { GEOSITE_BUCKET: bucket };
    const payload = strToU8("srs-binary-payload");
    let calls = 0;

    const fetchImpl: typeof fetch = async (_input: RequestInfo | URL): Promise<Response> => {
      calls += 1;
      return new Response(payload, {
        status: 200,
        headers: {
          etag: '"srs-etag-v1"',
          "content-type": "application/octet-stream"
        }
      });
    };

    const worker = createWorker({
      now: () => Date.parse("2026-02-15T00:00:00.000Z"),
      fetchImpl
    });

    const first = await worker.fetch(new Request("https://example.com/geosite-srs/apple"), env, new TestContext());
    expect(first.status).toBe(200);
    expect(first.headers.get("x-robots-tag")).toBe("noindex");
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(payload);

    const second = await worker.fetch(new Request("https://example.com/geosite-srs/apple"), env, new TestContext());
    expect(second.status).toBe(200);
    expect(second.headers.get("x-robots-tag")).toBe("noindex");
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(payload);
    expect(calls).toBe(1);
  });

  test("keeps binary bytes and metadata together when an atomic replacement fails", async () => {
    class FailingBucket extends MemoryR2Bucket {
      fail = false;
      override async put(key: string, value: string | ArrayBuffer | Uint8Array, options?: R2PutOptionsLike) {
        if (this.fail && key.includes("/blob/")) throw new Error("injected R2 write failure");
        return super.put(key, value, options);
      }
    }
    const bucket = new FailingBucket();
    const env: WorkerEnv = { GEOSITE_BUCKET: bucket, SRS_CACHE_TTL_SECONDS: "1" };
    let now = Date.parse("2026-02-15T00:00:00Z");
    const conditionalHeaders: Array<string | null> = [];
    let calls = 0;
    const worker = createWorker({ now: () => now, fetchImpl: async (_input, init) => {
      conditionalHeaders.push(new Headers(init?.headers).get("if-none-match"));
      calls += 1;
      return new Response(calls === 1 ? "body-v1" : "body-v2", { headers: { etag: calls === 1 ? "v1" : "v2" } });
    } });
    const url = new Request("https://example.com/geosite-srs/atomic");
    await worker.fetch(url, env, new TestContext());
    now += 2000;
    bucket.fail = true;
    const failedCtx = new TestContext();
    const failed = await worker.fetch(url, env, failedCtx);
    expect(await failed.text()).toBe("body-v1");
    await failedCtx.drain();
    const object = await bucket.get("remote-cache/geosite-srs/blob/geosite-atomic.srs");
    expect(await object!.text()).toBe("body-v1");
    expect(JSON.parse(object!.customMetadata!.geositeCache!)).toMatchObject({ version: 2, sourceEtag: "v1" });
    bucket.fail = false;
    const retryCtx = new TestContext();
    await worker.fetch(url, env, retryCtx);
    await retryCtx.drain();
    expect(conditionalHeaders).toEqual([null, "v1", "v1"]);
    const repaired = await worker.fetch(url, env, new TestContext());
    expect(await repaired.text()).toBe("body-v2");
    expect(repaired.headers.get("etag")).toContain(":v2");
    expect(repaired.headers.get("x-stale")).toBeNull();
  });

  test("readers see matching binary metadata on either side of a pending write", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    class InterleavedBucket extends MemoryR2Bucket {
      armed = false;
      override async put(key: string, value: string | ArrayBuffer | Uint8Array, options?: R2PutOptionsLike) {
        if (this.armed && key.includes("/blob/")) {
          this.armed = false;
          entered.resolve();
          await release.promise;
        }
        return super.put(key, value, options);
      }
    }
    const bucket = new InterleavedBucket();
    const env: WorkerEnv = { GEOSITE_BUCKET: bucket, SRS_CACHE_TTL_SECONDS: "1" };
    let now = Date.parse("2026-02-15T00:00:00Z");
    let calls = 0;
    const worker = createWorker({ now: () => now, fetchImpl: async () => {
      calls += 1;
      return new Response(`body-v${calls}`, { headers: { etag: `v${calls}` } });
    } });
    const url = new Request("https://example.com/geosite-srs/interleaved");
    await worker.fetch(url, env, new TestContext());
    now += 2000;
    bucket.armed = true;
    const ctx = new TestContext();
    await worker.fetch(url, env, ctx);
    await entered.promise;
    const duringCtx = new TestContext();
    const during = await worker.fetch(url, env, duringCtx);
    expect(await during.text()).toBe("body-v1");
    expect(during.headers.get("etag")).toContain(":v1");
    release.resolve();
    await Promise.all([ctx.drain(), duringCtx.drain()]);
    const after = await worker.fetch(url, env, new TestContext());
    expect(await after.text()).toBe("body-v2");
    expect(after.headers.get("etag")).toContain(":v2");
  });

  test("ignores mismatched legacy binary sidecars and re-fetches without their validators", async () => {
    const bucket = new MemoryR2Bucket();
    const env: WorkerEnv = { GEOSITE_BUCKET: bucket };
    const key = "remote-cache/geosite-srs/blob/geosite-legacy.srs";
    await bucket.put(key, "legacy-body-v1");
    await bucket.putJson("remote-cache/geosite-srs/meta/geosite-legacy.srs.json", {
      version: 1, sourceEtag: "v2", responseEtag: '"incorrect-v2"',
      fetchedAt: "2026-02-15T00:00:00Z", contentType: "application/octet-stream"
    });
    const worker = createWorker({ now: () => Date.parse("2026-02-15T00:00:00Z"), fetchImpl: async (_input, init) => {
      expect(new Headers(init?.headers).has("if-none-match")).toBe(false);
      return new Response("body-v2", { headers: { etag: "v2" } });
    } });
    const url = new Request("https://example.com/geosite-srs/legacy");
    const ctx = new TestContext();
    const stale = await worker.fetch(url, env, ctx);
    expect(await stale.text()).toBe("legacy-body-v1");
    expect(stale.headers.get("etag")).toContain(createHash("sha256").update("legacy-body-v1").digest("hex"));
    expect(stale.headers.has("x-upstream-etag")).toBe(false);
    expect(stale.headers.get("x-stale")).toBe("1");
    await ctx.drain();
    const fresh = await worker.fetch(url, env, new TestContext());
    expect(await fresh.text()).toBe("body-v2");
    expect(fresh.headers.get("etag")).toContain(":v2");
  });

  test("a delayed binary 304 cannot overwrite a concurrently published body", async () => {
    const bucket = new MemoryR2Bucket();
    const env: WorkerEnv = { GEOSITE_BUCKET: bucket, SRS_CACHE_TTL_SECONDS: "1" };
    const entered = deferred<void>();
    const release = deferred<void>();
    let now = Date.parse("2026-02-15T00:00:00Z");
    let calls = 0;
    const worker = createWorker({ now: () => now, fetchImpl: async (_input, init) => {
      if (++calls === 1) return new Response("body-v1", { headers: { etag: "v1" } });
      expect(new Headers(init?.headers).get("if-none-match")).toBe("v1");
      entered.resolve();
      await release.promise;
      return new Response(null, { status: 304 });
    } });
    const url = new Request("https://example.com/geosite-srs/late304");
    await worker.fetch(url, env, new TestContext());
    now += 2000;
    const ctx = new TestContext();
    await worker.fetch(url, env, ctx);
    await entered.promise;
    await bucket.put("remote-cache/geosite-srs/blob/geosite-late304.srs", "body-v2", {
      customMetadata: { geositeCache: JSON.stringify({
        version: 2, sourceEtag: "v2", responseEtag: '"v2"',
        fetchedAt: new Date(now).toISOString(), contentType: "application/octet-stream"
      }) }
    });
    release.resolve();
    await ctx.drain();
    const fresh = await worker.fetch(url, env, new TestContext());
    expect(await fresh.text()).toBe("body-v2");
    expect(fresh.headers.get("etag")).toBe('"v2"');
  });

  test("recompiles rules after converter upgrades and rejects legacy cache validators", async () => {
    const bucket = new MemoryR2Bucket();
    const env: WorkerEnv = { GEOSITE_BUCKET: bucket };
    await bucket.putJson("state/latest.json", makeLatestState("converter-upgrade", { previousCacheKey: "converter-old" }));
    await bucket.put("snapshots/converter-upgrade/sources.json", makeSnapshotPayload("converter-upgrade", {
      google: "domain:current.example\n"
    }));
    await bucket.putJson("snapshots/converter-upgrade/index/geosite.json", { google: [] });
    await bucket.put("artifacts/converter-upgrade/balanced/google.txt", "DOMAIN,legacy-wrong.example\n");
    await bucket.put("artifacts/converter-old/balanced/google.txt", "DOMAIN,legacy-stale.example\n");
    const worker = createWorker();
    const request = new Request("https://example.com/geosite/google", {
      headers: { "if-none-match": '"converter-upgrade:balanced:google"' }
    });
    const response = await worker.fetch(request, env, new TestContext());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("DOMAIN-SUFFIX,current.example\n");
    expect(response.headers.get("x-stale")).toBeNull();
    expect(response.headers.get("etag")).toBe('"geosite-rules-v2:converter-upgrade:balanced:google"');
    expect(await bucket.get("artifacts/v2/converter-upgrade/balanced/google.txt")).not.toBeNull();
    const conditional = await worker.fetch(new Request(request.url, {
      headers: { "if-none-match": response.headers.get("etag")! }
    }), env, new TestContext());
    expect(conditional.status).toBe(304);
  });

  test("returns stale geosite-srs cache when upstream refresh fails", async () => {
    const bucket = new MemoryR2Bucket();
    const env: WorkerEnv = {
      GEOSITE_BUCKET: bucket,
      SRS_CACHE_TTL_SECONDS: "1"
    };
    const payload = strToU8("srs-old");
    let calls = 0;
    let nowMs = Date.parse("2026-02-15T00:00:00.000Z");

    const fetchImpl: typeof fetch = async (_input: RequestInfo | URL): Promise<Response> => {
      calls += 1;
      if (calls === 1) {
        return new Response(payload, {
          status: 200,
          headers: {
            etag: '"srs-etag-v1"',
            "content-type": "application/octet-stream"
          }
        });
      }

      return new Response("upstream error", {
        status: 500
      });
    };

    const worker = createWorker({
      now: () => nowMs,
      fetchImpl
    });

    const first = await worker.fetch(new Request("https://example.com/geosite-srs/apple"), env, new TestContext());
    expect(first.status).toBe(200);
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(payload);

    nowMs += 2000;
    const second = await worker.fetch(new Request("https://example.com/geosite-srs/apple"), env, new TestContext());
    expect(second.status).toBe(200);
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(payload);
    expect(second.headers.get("x-stale")).toBe("1");
    expect(calls).toBe(2);
  });

  test("HEAD revalidates expired geosite-srs cache and returns headers without body", async () => {
    const bucket = new MemoryR2Bucket();
    const env: WorkerEnv = {
      GEOSITE_BUCKET: bucket,
      SRS_CACHE_TTL_SECONDS: "1"
    };
    const payload = strToU8("srs-body");
    let calls = 0;
    let nowMs = Date.parse("2026-02-15T00:00:00.000Z");

    const fetchImpl: typeof fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls += 1;
      expect(init?.headers).toBeDefined();
      return new Response(calls === 1 ? payload : null, {
        status: calls === 1 ? 200 : 304,
        headers: {
          etag: '"srs-etag-v1"',
          "content-type": "application/octet-stream"
        }
      });
    };

    const worker = createWorker({
      now: () => nowMs,
      fetchImpl
    });

    const first = await worker.fetch(new Request("https://example.com/geosite-srs/apple"), env, new TestContext());
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag");
    expect(etag).toBe('"geosite-srs:geosite-apple.srs:srs-etag-v1"');
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(payload);

    nowMs += 2000;
    const headCtx = new TestContext();
    const head = await worker.fetch(
      new Request("https://example.com/geosite-srs/apple", {
        method: "HEAD"
      }),
      env,
      headCtx
    );
    expect(head.status).toBe(200);
    expect(head.headers.get("etag")).toBe(etag);
    expect(head.headers.get("x-robots-tag")).toBe("noindex");
    expect(head.headers.get("x-stale")).toBe("1");
    expect((await head.arrayBuffer()).byteLength).toBe(0);
    expect(calls).toBe(2);
    await headCtx.drain();

    const conditional = await worker.fetch(
      new Request("https://example.com/geosite-srs/apple", {
        method: "HEAD",
        headers: { "if-none-match": etag ?? "" }
      }),
      env,
      new TestContext()
    );
    expect(conditional.status).toBe(304);
    expect(conditional.headers.get("etag")).toBe(etag);
    expect(conditional.headers.get("x-robots-tag")).toBe("noindex");
    expect((await conditional.arrayBuffer()).byteLength).toBe(0);
    expect(calls).toBe(2);

    const fresh = await worker.fetch(
      new Request("https://example.com/geosite-srs/apple", {
        method: "HEAD"
      }),
      env,
      new TestContext()
    );
    expect(fresh.status).toBe(200);
    expect(fresh.headers.get("etag")).toBe(etag);
    expect(fresh.headers.get("x-stale")).toBeNull();
    expect((await fresh.arrayBuffer()).byteLength).toBe(0);
    expect(calls).toBe(2);
  });

  test("purges geosite-srs cache on upstream 404 after stale response", async () => {
    const bucket = new MemoryR2Bucket();
    const env: WorkerEnv = {
      GEOSITE_BUCKET: bucket,
      SRS_CACHE_TTL_SECONDS: "1"
    };
    const payload = strToU8("srs-old");
    let calls = 0;
    let nowMs = Date.parse("2026-02-15T00:00:00.000Z");

    const fetchImpl: typeof fetch = async (): Promise<Response> => {
      calls += 1;
      if (calls === 1) {
        return new Response(payload, {
          status: 200,
          headers: {
            etag: '"srs-etag-v1"',
            "content-type": "application/octet-stream"
          }
        });
      }
      return new Response(null, { status: 404 });
    };

    const worker = createWorker({
      now: () => nowMs,
      fetchImpl
    });

    const firstCtx = new TestContext();
    const first = await worker.fetch(new Request("https://example.com/geosite-srs/apple"), env, firstCtx);
    expect(first.status).toBe(200);
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(payload);

    nowMs += 2000;
    const staleCtx = new TestContext();
    const second = await worker.fetch(new Request("https://example.com/geosite-srs/apple"), env, staleCtx);
    expect(second.status).toBe(200);
    expect(second.headers.get("x-stale")).toBe("1");
    await staleCtx.drain();

    expect(await bucket.get("remote-cache/geosite-srs/blob/geosite-apple.srs")).toBeNull();
    expect(await bucket.get("remote-cache/geosite-srs/meta/geosite-apple.srs.json")).toBeNull();

    nowMs += 1000;
    const third = await worker.fetch(new Request("https://example.com/geosite-srs/apple"), env, new TestContext());
    expect(third.status).toBe(404);
    expect(await third.text()).toBe("srs not found: apple");
    expect(calls).toBe(3);
  });

  test("returns 404 when geosite-srs list does not exist upstream", async () => {
    const bucket = new MemoryR2Bucket();
    const env: WorkerEnv = { GEOSITE_BUCKET: bucket };
    const fetchImpl: typeof fetch = async (): Promise<Response> => {
      return new Response(null, { status: 404 });
    };

    const worker = createWorker({ fetchImpl });
    const response = await worker.fetch(new Request("https://example.com/geosite-srs/not-exists"), env, new TestContext());
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("srs not found: not-exists");
  });

  test("caches geosite-mrs payload and serves from cache without extra upstream calls", async () => {
    const bucket = new MemoryR2Bucket();
    const env: WorkerEnv = { GEOSITE_BUCKET: bucket };
    const payload = strToU8("mrs-binary-payload");
    let calls = 0;

    const fetchImpl: typeof fetch = async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toContain("/adblock.mrs");
      calls += 1;
      return new Response(payload, {
        status: 200,
        headers: {
          etag: '"mrs-etag-v1"',
          "content-type": "application/octet-stream"
        }
      });
    };

    const worker = createWorker({
      now: () => Date.parse("2026-02-15T00:00:00.000Z"),
      fetchImpl
    });

    const first = await worker.fetch(new Request("https://example.com/geosite-mrs/adblock"), env, new TestContext());
    expect(first.status).toBe(200);
    expect(first.headers.get("x-robots-tag")).toBe("noindex");
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(payload);

    const second = await worker.fetch(new Request("https://example.com/geosite-mrs/adblock"), env, new TestContext());
    expect(second.status).toBe(200);
    expect(second.headers.get("x-robots-tag")).toBe("noindex");
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(payload);
    expect(calls).toBe(1);

    expect(await bucket.get("remote-cache/geosite-mrs/blob/adblock.mrs")).not.toBeNull();
  });

  test("returns 400 for invalid URL encoding", async () => {
    const bucket = new MemoryR2Bucket();
    const env: WorkerEnv = { GEOSITE_BUCKET: bucket };
    const worker = createWorker();

    const response = await worker.fetch(new Request("https://example.com/geosite/%E0%A4%A"), env, new TestContext());
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("invalid path encoding");
  });

  test("serves panel assets on non-api routes", async () => {
    const bucket = new MemoryR2Bucket();
    const worker = createWorker();
    const env: WorkerEnv = {
      GEOSITE_BUCKET: bucket,
      ASSETS: {
        async fetch(): Promise<Response> {
          return new Response("<html>panel</html>", {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" }
          });
        }
      }
    };

    const response = await worker.fetch(new Request("https://example.com/"), env, new TestContext());
    expect(response.status).toBe(200);
    expect(response.headers.get("x-robots-tag")).toBeNull();
    expect(await response.text()).toContain("panel");
  });
});
