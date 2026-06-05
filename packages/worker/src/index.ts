import {
  emitSurgeRuleset,
  parseListsFromText,
  resolveAllLists,
  type DomainRule,
  type RegexMode,
  type ResolvedList
} from "@surge-geosite/core";
import { gunzipSync, gzipSync, strFromU8, strToU8, unzipSync } from "fflate";

const DEFAULT_UPSTREAM_ZIP_URL = "https://github.com/v2fly/domain-list-community/archive/refs/heads/master.zip";
const DEFAULT_UPSTREAM_USER_AGENT = "surge-geosite-worker/2";
const DEFAULT_SRS_UPSTREAM_BASE_URL = "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set";
const DEFAULT_SRS_UPSTREAM_USER_AGENT = "surge-geosite-worker/2";
const DEFAULT_SRS_CACHE_TTL_SECONDS = 86400;
const DEFAULT_MRS_UPSTREAM_BASE_URL = "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geosite";
const DEFAULT_MRS_UPSTREAM_USER_AGENT = "surge-geosite-worker/2";
const DEFAULT_MRS_CACHE_TTL_SECONDS = 86400;
const LATEST_STATE_KEY = "state/latest.json";
const GEOSITE_INDEX_SCHEMA_VERSION = 2;
const SNAPSHOT_CACHE_LIMIT = 2;
const RESOLVED_CACHE_LIMIT = 2;

const VALID_LIST_NAME = /^[a-z0-9!-]+$/;
const VALID_ATTR_NAME = /^[a-z0-9!-]+$/;

const snapshotCache = new Map<string, Promise<SnapshotPayload>>();
const resolvedCache = new Map<string, Promise<Record<string, ResolvedList>>>();
const artifactBuildLocks = new Map<string, Promise<ArtifactBuildResult>>();
const remoteBinaryCacheLocks = new Map<string, Promise<ReadThroughRemoteBinaryResult>>();

export interface R2ObjectBodyLike {
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface R2PutOptionsLike {
  httpMetadata?: {
    contentType?: string;
    cacheControl?: string;
  };
}

export interface R2BucketLike {
  get(key: string): Promise<R2ObjectBodyLike | null>;
  put(key: string, value: string | ArrayBuffer | Uint8Array, options?: R2PutOptionsLike): Promise<void>;
  delete?(key: string): Promise<void>;
}

export interface AssetsBindingLike {
  fetch(request: Request): Promise<Response>;
}

export interface WorkerEnv {
  GEOSITE_BUCKET: R2BucketLike;
  ASSETS?: AssetsBindingLike;
  UPSTREAM_ZIP_URL?: string;
  UPSTREAM_USER_AGENT?: string;
  SRS_UPSTREAM_BASE_URL?: string;
  SRS_UPSTREAM_USER_AGENT?: string;
  SRS_CACHE_TTL_SECONDS?: string;
  MRS_UPSTREAM_BASE_URL?: string;
  MRS_UPSTREAM_USER_AGENT?: string;
  MRS_CACHE_TTL_SECONDS?: string;
}

export interface ScheduledEventLike {
  cron: string;
  scheduledTime: number;
}

export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

interface WorkerDeps {
  now?: () => number;
  fetchImpl?: typeof fetch;
}

interface LatestState {
  upstream: {
    zipUrl: string;
    etag: string;
  };
  snapshot: {
    sourceKey: string;
    indexKey: string;
    listCount: number;
    generatedAt: string;
  };
  previousEtag: string | null;
  checkedAt: string;
}

interface SnapshotPayload {
  version: 1;
  etag: string;
  zipUrl: string;
  generatedAt: string;
  lists: Record<string, string>;
}

type GeositeIndex = Record<string, string[]>;

interface RefreshResult {
  updated: boolean;
  reason: "etag-unchanged" | "etag-updated";
  checkedAt: string;
  etag: string;
  listCount: number;
}

interface ArtifactBuildResult {
  listFound: boolean;
  output: string;
  availableFilters: string[];
}

interface RemoteBinaryCacheMeta {
  version: 1;
  sourceEtag: string | null;
  responseEtag: string;
  fetchedAt: string;
  contentType: string;
}

interface ReadThroughRemoteBinaryOptions {
  namespace: string;
  cacheKey: string;
  upstreamUrl: string;
  userAgent: string;
  ttlSeconds: number;
  fallbackContentType: string;
  now: () => number;
  fetchImpl: typeof fetch;
  serveStaleWhileRevalidate?: boolean;
  onRevalidate?: (promise: Promise<unknown>) => void;
}

type ReadThroughRemoteBinaryResult =
  | { found: false }
  | {
      found: true;
      body: Uint8Array;
      responseEtag: string;
      sourceEtag: string | null;
      contentType: string;
      stale: boolean;
    };

type RemoteBinaryFoundResult = Extract<ReadThroughRemoteBinaryResult, { found: true }>;

export function createWorker(deps: WorkerDeps = {}): {
  fetch(request: Request, env: WorkerEnv, ctx: ExecutionContextLike): Promise<Response>;
  scheduled(event: ScheduledEventLike, env: WorkerEnv, ctx: ExecutionContextLike): Promise<void>;
} {
  const now = deps.now ?? (() => Date.now());
  const fetchImpl = resolveFetchImpl(deps.fetchImpl);

  return {
    async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContextLike): Promise<Response> {
      return handleFetch(request, env, ctx, { now, fetchImpl });
    },

    async scheduled(_event: ScheduledEventLike, env: WorkerEnv, _ctx: ExecutionContextLike): Promise<void> {
      await refreshGeositeRun(env, { now, fetchImpl });
    }
  };
}

export async function refreshGeositeRun(env: WorkerEnv, deps: WorkerDeps = {}): Promise<RefreshResult> {
  const now = deps.now ?? (() => Date.now());
  const fetchImpl = resolveFetchImpl(deps.fetchImpl);
  const checkedAt = new Date(now()).toISOString();
  const zipUrl = env.UPSTREAM_ZIP_URL ?? DEFAULT_UPSTREAM_ZIP_URL;
  const userAgent = env.UPSTREAM_USER_AGENT ?? DEFAULT_UPSTREAM_USER_AGENT;

  const current = await readJson<LatestState>(env.GEOSITE_BUCKET, LATEST_STATE_KEY);

  const headResponse = await fetchImpl(zipUrl, {
    method: "HEAD",
    headers: {
      "user-agent": userAgent
    }
  });
  if (!headResponse.ok) {
    throw new Error(`failed to check upstream zip: ${headResponse.status} ${headResponse.statusText}`);
  }

  const observedHeadEtag = normalizeEtag(headResponse.headers.get("etag"));
  if (observedHeadEtag && current?.upstream.etag === observedHeadEtag) {
    const unchangedState: LatestState = {
      ...current,
      checkedAt
    };
    await writeJson(env.GEOSITE_BUCKET, LATEST_STATE_KEY, unchangedState);

    return {
      updated: false,
      reason: "etag-unchanged",
      checkedAt,
      etag: observedHeadEtag,
      listCount: current.snapshot.listCount
    };
  }

  const downloadResponse = await fetchImpl(zipUrl, {
    headers: {
      "user-agent": userAgent
    }
  });
  if (!downloadResponse.ok) {
    throw new Error(`failed to download upstream zip: ${downloadResponse.status} ${downloadResponse.statusText}`);
  }

  const zipBytes = new Uint8Array(await downloadResponse.arrayBuffer());
  const downloadedEtag = normalizeEtag(downloadResponse.headers.get("etag"));
  const computedEtag = downloadedEtag ?? observedHeadEtag ?? (await sha256Hex(zipBytes));

  if (current?.upstream.etag === computedEtag) {
    const unchangedState: LatestState = {
      ...current,
      checkedAt
    };
    await writeJson(env.GEOSITE_BUCKET, LATEST_STATE_KEY, unchangedState);

    return {
      updated: false,
      reason: "etag-unchanged",
      checkedAt,
      etag: computedEtag,
      listCount: current.snapshot.listCount
    };
  }

  const sources = extractSourcesFromZip(zipBytes);
  const listCount = Object.keys(sources).length;
  if (listCount === 0) {
    throw new Error("no geosite data files found in upstream zip");
  }
  // Validate snapshot can be parsed and resolved before publishing it as latest.
  const parsed = parseListsFromText(sources);
  const resolved = resolveAllLists(parsed);

  const generatedAt = new Date(now()).toISOString();
  const sourceKey = snapshotSourceKey(computedEtag);
  const indexKey = snapshotIndexKey(computedEtag);

  const snapshotPayload: SnapshotPayload = {
    version: 1,
    etag: computedEtag,
    zipUrl,
    generatedAt,
    lists: sources
  };

  const compressedSnapshot = gzipSync(strToU8(JSON.stringify(snapshotPayload)));
  const index = buildIndexFromSources(sources, resolved);

  await writeBinary(env.GEOSITE_BUCKET, sourceKey, compressedSnapshot, {
    contentType: "application/json",
    cacheControl: "public, max-age=31536000, immutable"
  });
  await writeJson(env.GEOSITE_BUCKET, indexKey, index);

  const nextState: LatestState = {
    upstream: {
      zipUrl,
      etag: computedEtag
    },
    snapshot: {
      sourceKey,
      indexKey,
      listCount,
      generatedAt
    },
    previousEtag: current?.upstream.etag ?? null,
    checkedAt
  };

  const latestBeforeWrite = await readJson<LatestState>(env.GEOSITE_BUCKET, LATEST_STATE_KEY);
  if (latestBeforeWrite && latestBeforeWrite.upstream.etag !== current?.upstream.etag) {
    return {
      updated: false,
      reason: "etag-unchanged",
      checkedAt,
      etag: latestBeforeWrite.upstream.etag,
      listCount: latestBeforeWrite.snapshot.listCount
    };
  }

  await writeJson(env.GEOSITE_BUCKET, LATEST_STATE_KEY, nextState);

  snapshotCache.clear();
  resolvedCache.clear();

  return {
    updated: true,
    reason: "etag-updated",
    checkedAt,
    etag: computedEtag,
    listCount
  };
}

async function handleFetch(
  request: Request,
  env: WorkerEnv,
  ctx: ExecutionContextLike,
  deps: { now: () => number; fetchImpl: typeof fetch }
): Promise<Response> {
  if (request.method !== "GET") {
    return text(405, "method not allowed");
  }

  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/geosite") {
    return handleGeositeIndex(request, env, ctx);
  }

  if (path === "/geosite-srs") {
    return text(400, "missing list name");
  }

  if (path.startsWith("/geosite-srs/")) {
    const suffix = path.slice("/geosite-srs/".length);
    const decoded = safeDecodeURIComponent(suffix);
    if (decoded === null) {
      return text(400, "invalid path encoding");
    }

    return handleGeositeSrs(request, decoded, env, deps, ctx);
  }

  if (path === "/geosite-mrs") {
    return text(400, "missing list name");
  }

  if (path.startsWith("/geosite-mrs/")) {
    const suffix = path.slice("/geosite-mrs/".length);
    const decoded = safeDecodeURIComponent(suffix);
    if (decoded === null) {
      return text(400, "invalid path encoding");
    }

    return handleGeositeMrs(request, decoded, env, deps, ctx);
  }

  if (!path.startsWith("/geosite/")) {
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return text(404, "not found");
  }

  const suffix = path.slice("/geosite/".length);
  const segments = suffix.split("/").filter((item) => item.length > 0);
  if (segments.length === 0) {
    return text(404, "not found");
  }

  let mode: RegexMode = "balanced";
  let nameWithFilter: string;

  if (segments.length >= 2 && isRegexMode(segments[0]!)) {
    mode = segments[0]!;
    const decoded = safeDecodeURIComponent(segments.slice(1).join("/"));
    if (decoded === null) {
      return text(400, "invalid path encoding");
    }
    nameWithFilter = decoded;
  } else {
    const decoded = safeDecodeURIComponent(segments.join("/"));
    if (decoded === null) {
      return text(400, "invalid path encoding");
    }
    nameWithFilter = decoded;
  }

  return handleGeositeRules(request, mode, nameWithFilter, env, ctx);
}

async function handleGeositeSrs(
  request: Request,
  listNameRaw: string,
  env: WorkerEnv,
  deps: { now: () => number; fetchImpl: typeof fetch },
  ctx: ExecutionContextLike
): Promise<Response> {
  const listName = listNameRaw.trim().toLowerCase();
  if (!isValidListName(listName)) {
    return text(400, "invalid name");
  }

  const fileName = `geosite-${listName}.srs`;
  const baseUrl = trimTrailingSlash(env.SRS_UPSTREAM_BASE_URL ?? DEFAULT_SRS_UPSTREAM_BASE_URL);
  const upstreamUrl = `${baseUrl}/${fileName}`;
  const ttlSeconds = parsePositiveInt(env.SRS_CACHE_TTL_SECONDS, DEFAULT_SRS_CACHE_TTL_SECONDS);
  const userAgent = env.SRS_UPSTREAM_USER_AGENT ?? DEFAULT_SRS_UPSTREAM_USER_AGENT;

  const result = await readThroughRemoteBinaryCache(env, {
    namespace: "geosite-srs",
    cacheKey: fileName,
    upstreamUrl,
    userAgent,
    ttlSeconds,
    fallbackContentType: "application/octet-stream",
    now: deps.now,
    fetchImpl: deps.fetchImpl,
    serveStaleWhileRevalidate: true,
    onRevalidate: (promise) => {
      ctx.waitUntil(promise);
    }
  });

  if (!result.found) {
    return text(404, `srs not found: ${listName}`);
  }

  const headers = srsResponseHeaders(result, listName);
  if (matchesIfNoneMatch(request.headers.get("if-none-match"), result.responseEtag)) {
    return notModified(headers);
  }

  return new Response(asResponseBody(result.body), {
    status: 200,
    headers
  });
}

async function handleGeositeMrs(
  request: Request,
  listNameRaw: string,
  env: WorkerEnv,
  deps: { now: () => number; fetchImpl: typeof fetch },
  ctx: ExecutionContextLike
): Promise<Response> {
  const listName = listNameRaw.trim().toLowerCase();
  if (!isValidListName(listName)) {
    return text(400, "invalid name");
  }

  const fileName = `${listName}.mrs`;
  const baseUrl = trimTrailingSlash(env.MRS_UPSTREAM_BASE_URL ?? DEFAULT_MRS_UPSTREAM_BASE_URL);
  const upstreamUrl = `${baseUrl}/${fileName}`;
  const ttlSeconds = parsePositiveInt(env.MRS_CACHE_TTL_SECONDS, DEFAULT_MRS_CACHE_TTL_SECONDS);
  const userAgent = env.MRS_UPSTREAM_USER_AGENT ?? DEFAULT_MRS_UPSTREAM_USER_AGENT;

  const result = await readThroughRemoteBinaryCache(env, {
    namespace: "geosite-mrs",
    cacheKey: fileName,
    upstreamUrl,
    userAgent,
    ttlSeconds,
    fallbackContentType: "application/octet-stream",
    now: deps.now,
    fetchImpl: deps.fetchImpl,
    serveStaleWhileRevalidate: true,
    onRevalidate: (promise) => {
      ctx.waitUntil(promise);
    }
  });

  if (!result.found) {
    return text(404, `mrs not found: ${listName}`);
  }

  const headers = srsResponseHeaders(result, listName);
  if (matchesIfNoneMatch(request.headers.get("if-none-match"), result.responseEtag)) {
    return notModified(headers);
  }

  return new Response(asResponseBody(result.body), {
    status: 200,
    headers
  });
}

async function handleGeositeIndex(request: Request, env: WorkerEnv, ctx: ExecutionContextLike): Promise<Response> {
  const latest = await ensureLatestState(env);
  if (!latest) {
    return json(503, { ok: false, error: "geosite data not ready" });
  }

  const indexEtag = buildIndexEtag(latest.upstream.etag);
  const indexHeaders = {
    "cache-control": "public, max-age=60, s-maxage=300, stale-while-revalidate=900",
    etag: indexEtag,
    "x-upstream-etag": latest.upstream.etag,
    "x-generated-at": latest.snapshot.generatedAt,
    "x-checked-at": latest.checkedAt
  };

  if (matchesIfNoneMatch(request.headers.get("if-none-match"), indexEtag)) {
    return notModified(indexHeaders);
  }

  const index = await readJson<GeositeIndex>(env.GEOSITE_BUCKET, latest.snapshot.indexKey);
  if (index) {
    return json(200, index, indexHeaders);
  }

  const snapshot = await loadSnapshotPayload(env, latest);
  const builtIndex = buildIndexFromSnapshot(snapshot.lists);
  ctx.waitUntil(writeJson(env.GEOSITE_BUCKET, latest.snapshot.indexKey, builtIndex));

  return json(200, builtIndex, indexHeaders);
}

async function handleGeositeRules(
  request: Request,
  mode: RegexMode,
  nameWithFilter: string,
  env: WorkerEnv,
  ctx: ExecutionContextLike
): Promise<Response> {
  const { name, filter } = splitNameFilter(nameWithFilter);
  if (!isValidListName(name) || (filter !== null && !isValidAttr(filter))) {
    return text(400, "invalid name");
  }

  const latest = await ensureLatestState(env);
  if (!latest) {
    return text(503, "geosite data not ready");
  }

  const latestKey = artifactKey(latest.upstream.etag, mode, name, filter);
  const latestArtifact = await readText(env.GEOSITE_BUCKET, latestKey);
  if (latestArtifact !== null) {
    const responseEtag = buildRulesEtag(latest.upstream.etag, mode, name, filter);
    const headers = responseHeaders(latest.upstream.etag, mode, name, filter, false);
    if (matchesIfNoneMatch(request.headers.get("if-none-match"), responseEtag)) {
      return notModified(headers);
    }
    return text(200, latestArtifact, headers);
  }

  const index = await readJson<GeositeIndex>(env.GEOSITE_BUCKET, latest.snapshot.indexKey);
  if (index && !hasOwn(index, name)) {
    return text(404, `list not found: ${name}`);
  }

  const compilePromise = ensureArtifactForLatest(env, latest, mode, name, filter);

  if (!filter && latest.previousEtag && index && hasOwn(index, name)) {
    const staleKey = artifactKey(latest.previousEtag, mode, name, filter);
    const staleArtifact = await readText(env.GEOSITE_BUCKET, staleKey);
    if (staleArtifact !== null) {
      const responseEtag = buildRulesEtag(latest.previousEtag, mode, name, filter);
      const headers = responseHeaders(latest.previousEtag, mode, name, filter, true);
      ctx.waitUntil(compilePromise.catch(() => undefined));

      if (matchesIfNoneMatch(request.headers.get("if-none-match"), responseEtag)) {
        return notModified(headers);
      }
      return text(200, staleArtifact, headers);
    }
  }

  const build = await compilePromise;
  if (!build.listFound) {
    return text(404, `list not found: ${name}`);
  }

  const responseEtag = buildRulesEtag(latest.upstream.etag, mode, name, filter);
  const headers = responseHeaders(latest.upstream.etag, mode, name, filter, false);
  if (matchesIfNoneMatch(request.headers.get("if-none-match"), responseEtag)) {
    return notModified(headers);
  }
  return text(200, build.output, headers);
}

function splitNameFilter(input: string): { name: string; filter: string | null } {
  const normalized = input.trim().toLowerCase();
  const at = normalized.indexOf("@");
  if (at === -1) {
    return { name: normalized, filter: null };
  }

  const name = normalized.slice(0, at);
  const filter = normalized.slice(at + 1);
  return {
    name,
    filter: filter.length === 0 ? null : filter
  };
}

function responseHeaders(
  etag: string,
  mode: RegexMode,
  name: string,
  filter: string | null,
  stale: boolean
): Record<string, string> {
  const responseEtag = buildRulesEtag(etag, mode, name, filter);
  return {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": stale
      ? "public, max-age=60, s-maxage=120, stale-while-revalidate=900"
      : "public, max-age=300, s-maxage=1800, stale-while-revalidate=86400",
    etag: responseEtag,
    "x-upstream-etag": etag,
    "x-mode": mode,
    "x-list": name.toLowerCase(),
    ...(filter ? { "x-filter": filter } : {}),
    ...(stale ? { "x-stale": "1" } : {})
  };
}

function srsResponseHeaders(
  result: Extract<ReadThroughRemoteBinaryResult, { found: true }>,
  listName: string
): Record<string, string> {
  return {
    "content-type": result.contentType,
    "cache-control": result.stale
      ? "public, max-age=60, s-maxage=120, stale-while-revalidate=900"
      : "public, max-age=300, s-maxage=1800, stale-while-revalidate=86400",
    etag: result.responseEtag,
    "x-list": listName,
    ...(result.sourceEtag ? { "x-upstream-etag": result.sourceEtag } : {}),
    ...(result.stale ? { "x-stale": "1" } : {})
  };
}

async function readThroughRemoteBinaryCache(
  env: WorkerEnv,
  options: ReadThroughRemoteBinaryOptions
): Promise<ReadThroughRemoteBinaryResult> {
  const blobKey = remoteBlobKey(options.namespace, options.cacheKey);
  const metaKey = remoteMetaKey(options.namespace, options.cacheKey);

  const [cachedObject, cachedMetaRaw] = await Promise.all([
    env.GEOSITE_BUCKET.get(blobKey),
    readJson<RemoteBinaryCacheMeta>(env.GEOSITE_BUCKET, metaKey)
  ]);

  const cachedBody = cachedObject ? new Uint8Array(await cachedObject.arrayBuffer()) : null;
  const cachedMeta = await normalizeRemoteBinaryCacheMeta(
    cachedMetaRaw,
    options.namespace,
    options.cacheKey,
    cachedBody,
    options.fallbackContentType
  );
  const cached = cachedBody && cachedMeta ? { body: cachedBody, meta: cachedMeta } : null;

  const nowMs = options.now();
  const ttlMs = options.ttlSeconds * 1000;
  if (cached && isFreshAt(cached.meta.fetchedAt, ttlMs, nowMs)) {
    return remoteBinaryFound({
      body: cached.body,
      responseEtag: cached.meta.responseEtag,
      sourceEtag: cached.meta.sourceEtag,
      contentType: cached.meta.contentType,
      stale: false
    });
  }

  if (cached && options.serveStaleWhileRevalidate) {
    const refresh = ensureRemoteBinaryRevalidated(env, options, cached, blobKey, metaKey)
      .then(() => undefined)
      .catch(() => undefined);
    options.onRevalidate?.(refresh);

    return remoteBinaryFound({
      body: cached.body,
      responseEtag: cached.meta.responseEtag,
      sourceEtag: cached.meta.sourceEtag,
      contentType: cached.meta.contentType,
      stale: true
    });
  }

  return ensureRemoteBinaryRevalidated(env, options, cached, blobKey, metaKey);
}

async function ensureRemoteBinaryRevalidated(
  env: WorkerEnv,
  options: ReadThroughRemoteBinaryOptions,
  cached: { body: Uint8Array; meta: RemoteBinaryCacheMeta } | null,
  blobKey: string,
  metaKey: string
): Promise<ReadThroughRemoteBinaryResult> {
  const lockKey = `${options.namespace}:${options.cacheKey}`;
  const existingLock = remoteBinaryCacheLocks.get(lockKey);
  if (existingLock) {
    return existingLock;
  }

  const lock: Promise<ReadThroughRemoteBinaryResult> = revalidateRemoteBinaryFromUpstream(
    env,
    options,
    cached,
    blobKey,
    metaKey
  ).finally(() => {
    remoteBinaryCacheLocks.delete(lockKey);
  });

  remoteBinaryCacheLocks.set(lockKey, lock);
  return lock;
}

async function revalidateRemoteBinaryFromUpstream(
  env: WorkerEnv,
  options: ReadThroughRemoteBinaryOptions,
  cached: { body: Uint8Array; meta: RemoteBinaryCacheMeta } | null,
  blobKey: string,
  metaKey: string
): Promise<ReadThroughRemoteBinaryResult> {
  const requestHeaders: Record<string, string> = {
    "user-agent": options.userAgent
  };
  if (cached?.meta.sourceEtag) {
    requestHeaders["if-none-match"] = cached.meta.sourceEtag;
  }

  const nowIso = new Date(options.now()).toISOString();

  try {
    const upstreamResponse = await options.fetchImpl(options.upstreamUrl, {
      headers: requestHeaders
    });

    if (upstreamResponse.status === 304 && cached) {
      const refreshedMeta: RemoteBinaryCacheMeta = {
        ...cached.meta,
        fetchedAt: nowIso
      };
      await writeJson(env.GEOSITE_BUCKET, metaKey, refreshedMeta);
      return remoteBinaryFound({
        body: cached.body,
        responseEtag: refreshedMeta.responseEtag,
        sourceEtag: refreshedMeta.sourceEtag,
        contentType: refreshedMeta.contentType,
        stale: false
      });
    }

    if (upstreamResponse.status === 404) {
      await deleteRemoteCacheEntry(env.GEOSITE_BUCKET, blobKey, metaKey);
      return remoteBinaryNotFound();
    }

    if (!upstreamResponse.ok) {
      if (cached) {
        return remoteBinaryFound({
          body: cached.body,
          responseEtag: cached.meta.responseEtag,
          sourceEtag: cached.meta.sourceEtag,
          contentType: cached.meta.contentType,
          stale: true
        });
      }
      throw new Error(`failed to fetch remote binary: ${upstreamResponse.status} ${upstreamResponse.statusText}`);
    }

    const contentType = upstreamResponse.headers.get("content-type") ?? options.fallbackContentType;
    const sourceEtag = normalizeEtag(upstreamResponse.headers.get("etag"));
    const body = new Uint8Array(await upstreamResponse.arrayBuffer());
    const responseEtag = await buildRemoteBinaryEtag(options.namespace, options.cacheKey, sourceEtag, body);

    const nextMeta: RemoteBinaryCacheMeta = {
      version: 1,
      sourceEtag,
      responseEtag,
      fetchedAt: nowIso,
      contentType
    };

    await Promise.all([
      writeBinary(env.GEOSITE_BUCKET, blobKey, body, {
        contentType,
        cacheControl: "public, max-age=300, s-maxage=1800, stale-while-revalidate=86400"
      }),
      writeJson(env.GEOSITE_BUCKET, metaKey, nextMeta)
    ]);

    return remoteBinaryFound({
      body,
      responseEtag,
      sourceEtag,
      contentType,
      stale: false
    });
  } catch (error) {
    if (cached) {
      return remoteBinaryFound({
        body: cached.body,
        responseEtag: cached.meta.responseEtag,
        sourceEtag: cached.meta.sourceEtag,
        contentType: cached.meta.contentType,
        stale: true
      });
    }
    throw error;
  }
}

function buildIndexEtag(upstreamEtag: string): string {
  return `"geosite-index-v${GEOSITE_INDEX_SCHEMA_VERSION}:${upstreamEtag}"`;
}

function buildRulesEtag(upstreamEtag: string, mode: RegexMode, name: string, filter: string | null): string {
  return `"${upstreamEtag}:${mode}:${name.toLowerCase()}${filter ? `@${filter}` : ""}"`;
}

function matchesIfNoneMatch(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) {
    return false;
  }

  if (ifNoneMatch.trim() === "*") {
    return true;
  }

  return ifNoneMatch
    .split(",")
    .map((item) => item.trim())
    .some((item) => item === etag);
}

function notModified(headers: Record<string, string>): Response {
  const nextHeaders = { ...headers };
  delete nextHeaders["content-type"];
  return new Response(null, {
    status: 304,
    headers: nextHeaders
  });
}

async function ensureArtifactForLatest(
  env: WorkerEnv,
  latest: LatestState,
  mode: RegexMode,
  name: string,
  filter: string | null
): Promise<ArtifactBuildResult> {
  const lockKey = `${latest.upstream.etag}:${mode}:${artifactName(name, filter)}`;
  const existingLock = artifactBuildLocks.get(lockKey);
  if (existingLock) {
    return existingLock;
  }

  const lock = (async () => {
    const outputKey = artifactKey(latest.upstream.etag, mode, name, filter);
    const existing = await readText(env.GEOSITE_BUCKET, outputKey);
    if (existing !== null) {
      return {
        listFound: true,
        output: existing,
        availableFilters: []
      };
    }

    const resolved = await loadResolvedLists(env, latest);
    const target = resolved[name.toUpperCase()];
    if (!target) {
      return {
        listFound: false,
        output: "",
        availableFilters: []
      };
    }

    const availableFilters = collectFilters(target.entries);
    if (filter && !availableFilters.includes(filter)) {
      return {
        listFound: true,
        output: "",
        availableFilters
      };
    }

    const entries = filter ? target.entries.filter((entry) => entry.attrs.includes(filter)) : target.entries;

    const emitted = emitSurgeRuleset(
      {
        name: target.name,
        entries
      },
      {
        regexMode: mode,
        onUnsupportedRegex: "skip"
      }
    );

    const output = emitted.text.length > 0 ? `${emitted.text}\n` : "";
    await writeText(env.GEOSITE_BUCKET, outputKey, output, {
      cacheControl: "public, max-age=31536000, immutable"
    });
    return {
      listFound: true,
      output,
      availableFilters
    };
  })().finally(() => {
    artifactBuildLocks.delete(lockKey);
  });

  artifactBuildLocks.set(lockKey, lock);
  return lock;
}

async function loadResolvedLists(env: WorkerEnv, latest: LatestState): Promise<Record<string, ResolvedList>> {
  const cacheKey = latest.upstream.etag;
  const cached = resolvedCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const pending = (async () => {
    const snapshot = await loadSnapshotPayload(env, latest);
    const parsed = parseListsFromText(snapshot.lists);
    return resolveAllLists(parsed);
  })();

  resolvedCache.set(cacheKey, pending);
  pruneMap(resolvedCache, RESOLVED_CACHE_LIMIT);
  return pending.catch((error) => {
    resolvedCache.delete(cacheKey);
    throw error;
  });
}

async function loadSnapshotPayload(env: WorkerEnv, latest: LatestState): Promise<SnapshotPayload> {
  const cacheKey = latest.snapshot.sourceKey;
  const cached = snapshotCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const pending = (async () => {
    const object = await env.GEOSITE_BUCKET.get(latest.snapshot.sourceKey);
    if (!object) {
      throw new Error(`snapshot not found: ${latest.snapshot.sourceKey}`);
    }

    const compressed = new Uint8Array(await object.arrayBuffer());
    const payloadText = strFromU8(gunzipSync(compressed));
    return JSON.parse(payloadText) as SnapshotPayload;
  })();

  snapshotCache.set(cacheKey, pending);
  pruneMap(snapshotCache, SNAPSHOT_CACHE_LIMIT);
  return pending.catch((error) => {
    snapshotCache.delete(cacheKey);
    throw error;
  });
}

async function ensureLatestState(env: WorkerEnv): Promise<LatestState | null> {
  return readJson<LatestState>(env.GEOSITE_BUCKET, LATEST_STATE_KEY);
}

function buildIndexFromSnapshot(sources: Record<string, string>): GeositeIndex {
  const parsed = parseListsFromText(sources);
  const resolved = resolveAllLists(parsed);
  return buildIndexFromSources(sources, resolved);
}

function buildIndexFromSources(sources: Record<string, string>, resolved: Record<string, ResolvedList>): GeositeIndex {
  const names = Object.keys(sources).sort();
  const index: GeositeIndex = {};

  for (const listName of names) {
    index[listName] = collectFilters(resolved[listName.toUpperCase()]?.entries ?? []);
  }

  return index;
}

function hasOwn<T extends object>(object: T, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function collectFilters(entries: DomainRule[]): string[] {
  const attrs = new Set<string>();

  for (const entry of entries) {
    for (const attr of entry.attrs) {
      attrs.add(attr);
    }
  }

  return Array.from(attrs).sort();
}

function extractSourcesFromZip(zipData: Uint8Array): Record<string, string> {
  const files = unzipSync(zipData);
  const sources: Record<string, string> = {};

  for (const [filePath, content] of Object.entries(files)) {
    const match = /\/data\/([^/]+)$/.exec(filePath);
    if (!match) {
      continue;
    }

    const listName = match[1]!.toLowerCase();
    if (!VALID_LIST_NAME.test(listName)) {
      continue;
    }

    sources[listName] = strFromU8(content);
  }

  return sources;
}

function normalizeEtag(raw: string | null): string | null {
  if (!raw) {
    return null;
  }
  return raw.replace(/^W\//, "").replace(/^"/, "").replace(/"$/, "").trim() || null;
}

async function sha256Hex(input: Uint8Array): Promise<string> {
  const copied = Uint8Array.from(input);
  const digest = await crypto.subtle.digest("SHA-256", copied.buffer);
  return Array.from(new Uint8Array(digest))
    .map((item) => item.toString(16).padStart(2, "0"))
    .join("");
}

function artifactName(name: string, filter: string | null): string {
  return filter ? `${name}@${filter}` : name;
}

function artifactKey(etag: string, mode: RegexMode, name: string, filter: string | null): string {
  return `artifacts/${etag}/${mode}/${artifactName(name, filter)}.txt`;
}

function snapshotSourceKey(etag: string): string {
  return `snapshots/${etag}/sources.json.gz`;
}

function snapshotIndexKey(etag: string): string {
  return `snapshots/${etag}/index/geosite.json`;
}

function remoteBlobKey(namespace: string, cacheKey: string): string {
  return `remote-cache/${namespace}/blob/${cacheKey}`;
}

function remoteMetaKey(namespace: string, cacheKey: string): string {
  return `remote-cache/${namespace}/meta/${cacheKey}.json`;
}

async function normalizeRemoteBinaryCacheMeta(
  input: RemoteBinaryCacheMeta | null,
  namespace: string,
  cacheKey: string,
  cachedBody: Uint8Array | null,
  fallbackContentType: string
): Promise<RemoteBinaryCacheMeta | null> {
  if (
    input &&
    typeof input === "object" &&
    input.version === 1 &&
    typeof input.fetchedAt === "string" &&
    typeof input.responseEtag === "string" &&
    typeof input.contentType === "string"
  ) {
    return {
      version: 1,
      sourceEtag: typeof input.sourceEtag === "string" ? input.sourceEtag : null,
      responseEtag: input.responseEtag,
      fetchedAt: input.fetchedAt,
      contentType: input.contentType
    };
  }

  if (!cachedBody) {
    return null;
  }

  return {
    version: 1,
    sourceEtag: null,
    responseEtag: await buildRemoteBinaryEtag(namespace, cacheKey, null, cachedBody),
    fetchedAt: new Date(0).toISOString(),
    contentType: fallbackContentType
  };
}

function isFreshAt(fetchedAt: string, ttlMs: number, nowMs: number): boolean {
  if (ttlMs <= 0) {
    return false;
  }
  const fetchedAtMs = Date.parse(fetchedAt);
  if (!Number.isFinite(fetchedAtMs)) {
    return false;
  }
  return nowMs - fetchedAtMs < ttlMs;
}

async function buildRemoteBinaryEtag(
  namespace: string,
  cacheKey: string,
  sourceEtag: string | null,
  body: Uint8Array
): Promise<string> {
  const stableToken = sourceEtag ?? (await sha256Hex(body));
  const safeToken = stableToken.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `"${namespace}:${cacheKey}:${safeToken}"`;
}

function trimTrailingSlash(input: string): string {
  return input.replace(/\/+$/, "");
}

function parsePositiveInt(input: string | undefined, fallback: number): number {
  if (!input) {
    return fallback;
  }

  const parsed = Number.parseInt(input, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function remoteBinaryNotFound(): ReadThroughRemoteBinaryResult {
  return { found: false };
}

function remoteBinaryFound(
  input: Omit<RemoteBinaryFoundResult, "found">
): RemoteBinaryFoundResult {
  return {
    found: true,
    ...input
  };
}

function asResponseBody(input: Uint8Array): BodyInit {
  return input as unknown as BodyInit;
}

function isRegexMode(input: string): input is RegexMode {
  return input === "strict" || input === "balanced" || input === "full";
}

function isValidListName(input: string): boolean {
  return VALID_LIST_NAME.test(input);
}

function isValidAttr(input: string): boolean {
  return VALID_ATTR_NAME.test(input);
}

function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

async function readText(bucket: R2BucketLike, key: string): Promise<string | null> {
  const object = await bucket.get(key);
  if (!object) {
    return null;
  }
  return object.text();
}

async function readJson<T>(bucket: R2BucketLike, key: string): Promise<T | null> {
  const content = await readText(bucket, key);
  if (content === null) {
    return null;
  }
  return JSON.parse(content) as T;
}

async function writeText(
  bucket: R2BucketLike,
  key: string,
  content: string,
  options: { contentType?: string; cacheControl?: string } = {}
): Promise<void> {
  const metadata: NonNullable<R2PutOptionsLike["httpMetadata"]> = {
    contentType: options.contentType ?? "text/plain; charset=utf-8"
  };
  if (options.cacheControl) {
    metadata.cacheControl = options.cacheControl;
  }

  await bucket.put(key, content, {
    httpMetadata: metadata
  });
}

async function writeJson(bucket: R2BucketLike, key: string, value: unknown): Promise<void> {
  await bucket.put(key, `${JSON.stringify(value)}\n`, {
    httpMetadata: {
      contentType: "application/json; charset=utf-8"
    }
  });
}

async function writeBinary(
  bucket: R2BucketLike,
  key: string,
  value: Uint8Array,
  options: { contentType: string; cacheControl?: string }
): Promise<void> {
  const metadata: NonNullable<R2PutOptionsLike["httpMetadata"]> = {
    contentType: options.contentType
  };
  if (options.cacheControl) {
    metadata.cacheControl = options.cacheControl;
  }

  await bucket.put(key, value, {
    httpMetadata: metadata
  });
}

async function deleteRemoteCacheEntry(bucket: R2BucketLike, blobKey: string, metaKey: string): Promise<void> {
  if (!bucket.delete) {
    return;
  }

  const deleteFromBucket = bucket.delete.bind(bucket);
  await Promise.all([deleteFromBucket(blobKey), deleteFromBucket(metaKey)]);
}

function resolveFetchImpl(input?: typeof fetch): typeof fetch {
  if (input) {
    return input;
  }

  return (request: RequestInfo | URL, init?: RequestInit): Promise<Response> => fetch(request, init);
}

function pruneMap<T>(map: Map<string, T>, keep: number): void {
  while (map.size > keep) {
    const first = map.keys().next();
    if (first.done) {
      return;
    }
    map.delete(first.value);
  }
}

function isSameStringArray(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers
    }
  });
}

function text(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers
  });
}

const worker = createWorker();

export default {
  fetch(request: Request, env: WorkerEnv, ctx: ExecutionContextLike): Promise<Response> {
    return worker.fetch(request, env, ctx);
  },

  scheduled(event: ScheduledEventLike, env: WorkerEnv, ctx: ExecutionContextLike): Promise<void> {
    return worker.scheduled(event, env, ctx);
  }
};
