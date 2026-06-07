import { describe, expect, test } from "vitest";

import {
  createWorker,
  refreshGeositeRun,
  type ExecutionContextLike,
  type R2BucketLike,
  type R2ObjectBodyLike,
  type R2PutOptionsLike,
  type WorkerEnv
} from "../src/index.js";

class MemoryR2Object implements R2ObjectBodyLike {
  constructor(private readonly data: Uint8Array) {}

  async text(): Promise<string> {
    return new TextDecoder().decode(this.data);
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.data.buffer.slice(this.data.byteOffset, this.data.byteOffset + this.data.byteLength);
  }
}

class MemoryR2Bucket implements R2BucketLike {
  private readonly store = new Map<string, Uint8Array>();

  async get(key: string): Promise<R2ObjectBodyLike | null> {
    const value = this.store.get(key);
    return value ? new MemoryR2Object(value) : null;
  }

  async put(key: string, value: string | ArrayBuffer | Uint8Array, _options?: R2PutOptionsLike): Promise<void> {
    if (typeof value === "string") {
      this.store.set(key, new TextEncoder().encode(value));
      return;
    }

    if (value instanceof Uint8Array) {
      this.store.set(key, value);
      return;
    }

    this.store.set(key, new Uint8Array(value));
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

    const cached = await bucket.get("artifacts/etag-fetch-v1/balanced/google.txt");
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

    await bucket.put("artifacts/etag-stale-v1/balanced/google.txt", "DOMAIN-SUFFIX,old.example\n");

    const ctx = new TestContext();
    const worker = createWorker();

    const response = await worker.fetch(new Request("https://example.com/geosite/google"), env, ctx);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("DOMAIN-SUFFIX,old.example\n");
    expect(response.headers.get("x-stale")).toBe("1");

    await ctx.drain();

    const refreshed = await bucket.get("artifacts/etag-stale-v2/balanced/google.txt");
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
    await bucket.put("artifacts/etag-del-v1/balanced/google.txt", "DOMAIN-SUFFIX,old-google.example\n");

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
    await bucket.put("artifacts/etag-noindex-v1/balanced/google.txt", "DOMAIN-SUFFIX,old-google.example\n");

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
    expect(await bucket.get("artifacts/etag-filter-v1/balanced/google@us.txt")).toBeNull();

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
