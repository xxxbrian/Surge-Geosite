import { gzipSync, strToU8, zipSync } from "fflate";
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

function makeSnapshotPayload(etag: string, lists: Record<string, string>): Uint8Array {
  return gzipSync(
    strToU8(
      JSON.stringify({
        version: 1,
        etag,
        zipUrl: "https://example.com/master.zip",
        generatedAt: "2026-02-15T00:00:00.000Z",
        lists
      })
    )
  );
}

describe("refreshGeositeRun", () => {
  test("updates snapshot when etag changes", async () => {
    const bucket = new MemoryR2Bucket();
    const env: WorkerEnv = { GEOSITE_BUCKET: bucket };

    const zipBytes = zipSync({
      "domain-list-community-master/data/google": strToU8("domain:google.com\n"),
      "domain-list-community-master/data/github": strToU8("domain:github.com\n")
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
      return new Response(zipBytes, {
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
      upstream: { etag: string };
      snapshot: { sourceKey: string; indexKey: string };
    };

    expect(latest.upstream.etag).toBe("etag-refresh-v1");
    expect(await bucket.get(latest.snapshot.sourceKey)).not.toBeNull();
    expect(await bucket.get(latest.snapshot.indexKey)).not.toBeNull();
  });

  test("returns unchanged when head etag matches current", async () => {
    const bucket = new MemoryR2Bucket();
    const env: WorkerEnv = { GEOSITE_BUCKET: bucket };

    await bucket.putJson("state/latest.json", {
      upstream: {
        zipUrl: "https://example.com/master.zip",
        etag: "etag-unchanged-v1"
      },
      snapshot: {
        sourceKey: "snapshots/etag-unchanged-v1/sources.json.gz",
        indexKey: "snapshots/etag-unchanged-v1/index/geosite.json",
        listCount: 1,
        generatedAt: "2026-02-15T00:00:00.000Z"
      },
      previousEtag: null,
      checkedAt: "2026-02-15T00:00:00.000Z"
    });

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
    const env: WorkerEnv = { GEOSITE_BUCKET: bucket };

    await bucket.putJson("state/latest.json", {
      upstream: {
        zipUrl: "https://example.com/master.zip",
        etag: "etag-base-v1"
      },
      snapshot: {
        sourceKey: "snapshots/etag-base-v1/sources.json.gz",
        indexKey: "snapshots/etag-base-v1/index/geosite.json",
        listCount: 1,
        generatedAt: "2026-02-15T00:00:00.000Z"
      },
      previousEtag: null,
      checkedAt: "2026-02-15T00:00:00.000Z"
    });

    const zipBytes = zipSync({
      "domain-list-community-master/data/google": strToU8("domain:google.com\n")
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

      await bucket.putJson("state/latest.json", {
        upstream: {
          zipUrl: "https://example.com/master.zip",
          etag: "etag-other-v3"
        },
        snapshot: {
          sourceKey: "snapshots/etag-other-v3/sources.json.gz",
          indexKey: "snapshots/etag-other-v3/index/geosite.json",
          listCount: 1,
          generatedAt: "2026-02-15T00:00:00.000Z"
        },
        previousEtag: "etag-base-v1",
        checkedAt: "2026-02-15T00:00:00.000Z"
      });

      return new Response(zipBytes, {
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
    const env: WorkerEnv = { GEOSITE_BUCKET: bucket };

    await bucket.putJson("state/latest.json", {
      upstream: {
        zipUrl: "https://example.com/master.zip",
        etag: "etag-stable-v1"
      },
      snapshot: {
        sourceKey: "snapshots/etag-stable-v1/sources.json.gz",
        indexKey: "snapshots/etag-stable-v1/index/geosite.json",
        listCount: 1,
        generatedAt: "2026-02-15T00:00:00.000Z"
      },
      previousEtag: null,
      checkedAt: "2026-02-15T00:00:00.000Z"
    });

    const zipBytes = zipSync({
      "domain-list-community-master/data/google": strToU8("domain:google.com @?\n")
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
      return new Response(zipBytes, {
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
    expect(await bucket.get("snapshots/etag-bad-v2/sources.json.gz")).toBeNull();
  });
});

describe("worker fetch routes", () => {
  test("returns 503 when latest state is missing and does not hit upstream", async () => {
    const bucket = new MemoryR2Bucket();
    const env: WorkerEnv = { GEOSITE_BUCKET: bucket };
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls.push((init?.method ?? "GET").toUpperCase());
      return new Response(null, { status: 500 });
    };

    const worker = createWorker({ fetchImpl });
    const indexResponse = await worker.fetch(new Request("https://example.com/geosite"), env, new TestContext());
    expect(indexResponse.status).toBe(503);
    expect(await indexResponse.json()).toEqual({ ok: false, error: "geosite data not ready" });

    const rulesResponse = await worker.fetch(new Request("https://example.com/geosite/google"), env, new TestContext());
    expect(rulesResponse.status).toBe(503);
    expect(await rulesResponse.text()).toBe("geosite data not ready");
    expect(calls).toEqual([]);
  });

  test("compiles and serves artifact on first request", async () => {
    const bucket = new MemoryR2Bucket();
    const env: WorkerEnv = { GEOSITE_BUCKET: bucket };

    await bucket.putJson("state/latest.json", {
      upstream: {
        zipUrl: "https://example.com/master.zip",
        etag: "etag-fetch-v1"
      },
      snapshot: {
        sourceKey: "snapshots/etag-fetch-v1/sources.json.gz",
        indexKey: "snapshots/etag-fetch-v1/index/geosite.json",
        listCount: 1,
        generatedAt: "2026-02-15T00:00:00.000Z"
      },
      previousEtag: null,
      checkedAt: "2026-02-15T00:00:00.000Z"
    });

    await bucket.put(
      "snapshots/etag-fetch-v1/sources.json.gz",
      makeSnapshotPayload("etag-fetch-v1", {
        google: "domain:google.com\nfull:mail.google.com\n"
      })
    );
    await bucket.putJson("snapshots/etag-fetch-v1/index/geosite.json", {
      google: { name: "GOOGLE", sourceFile: "google", filters: [], modes: {} }
    });

    const ctx = new TestContext();
    const worker = createWorker();

    const response = await worker.fetch(new Request("https://example.com/geosite/google"), env, ctx);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("DOMAIN-SUFFIX,google.com");
    expect(body).not.toContain("mail.google.com");

    const cached = await bucket.get("artifacts/etag-fetch-v1/balanced/google.txt");
    expect(cached).not.toBeNull();

    await ctx.drain();
  });

  test("returns stale artifact and refreshes latest in background", async () => {
    const bucket = new MemoryR2Bucket();
    const env: WorkerEnv = { GEOSITE_BUCKET: bucket };

    await bucket.putJson("state/latest.json", {
      upstream: {
        zipUrl: "https://example.com/master.zip",
        etag: "etag-stale-v2"
      },
      snapshot: {
        sourceKey: "snapshots/etag-stale-v2/sources.json.gz",
        indexKey: "snapshots/etag-stale-v2/index/geosite.json",
        listCount: 1,
        generatedAt: "2026-02-15T00:00:00.000Z"
      },
      previousEtag: "etag-stale-v1",
      checkedAt: "2026-02-15T00:00:00.000Z"
    });

    await bucket.put(
      "snapshots/etag-stale-v2/sources.json.gz",
      makeSnapshotPayload("etag-stale-v2", {
        google: "domain:google.com\nfull:mail.google.com\n"
      })
    );
    await bucket.putJson("snapshots/etag-stale-v2/index/geosite.json", {
      google: {
        name: "GOOGLE",
        sourceFile: "google",
        filters: [],
        modes: {
          strict: "rules/strict/google.txt",
          balanced: "rules/balanced/google.txt",
          full: "rules/full/google.txt"
        }
      }
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
        zipUrl: "https://example.com/master.zip",
        etag: "etag-del-v2"
      },
      snapshot: {
        sourceKey: "snapshots/etag-del-v2/sources.json.gz",
        indexKey: "snapshots/etag-del-v2/index/geosite.json",
        listCount: 1,
        generatedAt: "2026-02-15T00:00:00.000Z"
      },
      previousEtag: "etag-del-v1",
      checkedAt: "2026-02-15T00:00:00.000Z"
    });

    await bucket.put(
      "snapshots/etag-del-v2/sources.json.gz",
      makeSnapshotPayload("etag-del-v2", {
        github: "domain:github.com\n"
      })
    );
    await bucket.putJson("snapshots/etag-del-v2/index/geosite.json", {
      github: {
        name: "GITHUB",
        sourceFile: "github",
        filters: [],
        modes: {
          strict: "rules/strict/github.txt",
          balanced: "rules/balanced/github.txt",
          full: "rules/full/github.txt"
        }
      }
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
        zipUrl: "https://example.com/master.zip",
        etag: "etag-noindex-v2"
      },
      snapshot: {
        sourceKey: "snapshots/etag-noindex-v2/sources.json.gz",
        indexKey: "snapshots/etag-noindex-v2/index/geosite.json",
        listCount: 1,
        generatedAt: "2026-02-15T00:00:00.000Z"
      },
      previousEtag: "etag-noindex-v1",
      checkedAt: "2026-02-15T00:00:00.000Z"
    });

    await bucket.put(
      "snapshots/etag-noindex-v2/sources.json.gz",
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

  test("does not cache unknown filter artifacts and lazily enriches index filters", async () => {
    const bucket = new MemoryR2Bucket();
    const env: WorkerEnv = { GEOSITE_BUCKET: bucket };

    await bucket.putJson("state/latest.json", {
      upstream: {
        zipUrl: "https://example.com/master.zip",
        etag: "etag-filter-v1"
      },
      snapshot: {
        sourceKey: "snapshots/etag-filter-v1/sources.json.gz",
        indexKey: "snapshots/etag-filter-v1/index/geosite.json",
        listCount: 1,
        generatedAt: "2026-02-15T00:00:00.000Z"
      },
      previousEtag: null,
      checkedAt: "2026-02-15T00:00:00.000Z"
    });

    await bucket.put(
      "snapshots/etag-filter-v1/sources.json.gz",
      makeSnapshotPayload("etag-filter-v1", {
        google: "domain:google.com @cn\n"
      })
    );
    await bucket.putJson("snapshots/etag-filter-v1/index/geosite.json", {
      google: {
        name: "GOOGLE",
        sourceFile: "google",
        filters: [],
        modes: {
          strict: "rules/strict/google.txt",
          balanced: "rules/balanced/google.txt",
          full: "rules/full/google.txt"
        }
      }
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
    const index = JSON.parse(await indexRaw!.text()) as {
      google: { filters: string[] };
    };
    expect(index.google.filters).toEqual(["cn"]);
  });

  test("recovers from transient snapshot parse failure without poisoned cache", async () => {
    const bucket = new MemoryR2Bucket();
    const env: WorkerEnv = { GEOSITE_BUCKET: bucket };

    await bucket.putJson("state/latest.json", {
      upstream: {
        zipUrl: "https://example.com/master.zip",
        etag: "etag-poison-v1"
      },
      snapshot: {
        sourceKey: "snapshots/etag-poison-v1/sources.json.gz",
        indexKey: "snapshots/etag-poison-v1/index/geosite.json",
        listCount: 1,
        generatedAt: "2026-02-15T00:00:00.000Z"
      },
      previousEtag: null,
      checkedAt: "2026-02-15T00:00:00.000Z"
    });
    await bucket.put("snapshots/etag-poison-v1/sources.json.gz", strToU8("not-gzip"));

    const worker = createWorker();
    await expect(worker.fetch(new Request("https://example.com/geosite/google"), env, new TestContext())).rejects.toThrow();

    await bucket.put(
      "snapshots/etag-poison-v1/sources.json.gz",
      makeSnapshotPayload("etag-poison-v1", {
        google: "domain:google.com\n"
      })
    );

    const response = await worker.fetch(new Request("https://example.com/geosite/google"), env, new TestContext());
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("DOMAIN-SUFFIX,google.com");
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
    expect(await response.text()).toContain("panel");
  });
});
