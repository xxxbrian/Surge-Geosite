import {
  emitSurgeRuleset,
  parseListsFromText,
  resolveAllLists,
  type DomainRule,
  type RegexMode,
  type ResolvedList
} from "@surge-geosite/core";
import { parse as parseYaml } from "yaml";

const DEFAULT_UPSTREAM_YAML_URL =
  "https://github.com/v2fly/domain-list-community/releases/latest/download/dlc.dat_plain.yml";
const DEFAULT_UPSTREAM_USER_AGENT = "surge-geosite-worker/2";
const DEFAULT_SRS_UPSTREAM_BASE_URL = "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set";
const DEFAULT_SRS_UPSTREAM_USER_AGENT = "surge-geosite-worker/2";
const DEFAULT_SRS_CACHE_TTL_SECONDS = 86400;
const DEFAULT_MRS_UPSTREAM_BASE_URL = "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geosite";
const DEFAULT_MRS_UPSTREAM_USER_AGENT = "surge-geosite-worker/2";
const DEFAULT_MRS_CACHE_TTL_SECONDS = 86400;
const LATEST_STATE_KEY = "state/latest.json";
// Bump whenever parsing, resolution, or rule emission semantics change.
const CONVERTER_VERSION = 2;
const GEOSITE_INDEX_SCHEMA_VERSION = 2;
const SNAPSHOT_CACHE_LIMIT = 2;
const RESOLVED_CACHE_LIMIT = 2;
const GEOSITE_ROBOTS_TAG = "noindex";

const VALID_LIST_NAME = /^[a-z0-9!-]+$/;
const VALID_ATTR_NAME = /^[a-z0-9!-]+$/;

const snapshotCache = new Map<string, Promise<SnapshotPayload>>();
const resolvedCache = new Map<string, Promise<Record<string, ResolvedList>>>();
const artifactBuildLocks = new Map<string, Promise<ArtifactBuildResult>>();
const remoteBinaryCacheLocks = new Map<string, Promise<ReadThroughRemoteBinaryResult>>();
const geositeRefreshLocks = new WeakMap<R2BucketLike, Promise<RefreshResult>>();

// Narrow adapter matching the R2 Workers API; put returns null when onlyIf fails.
export interface R2ObjectLike {
  etag: string;
  customMetadata?: Record<string, string>;
}

export interface R2ObjectBodyLike extends R2ObjectLike {
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface R2PutOptionsLike {
  onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string };
  customMetadata?: Record<string, string>;
  httpMetadata?: {
    contentType?: string;
    cacheControl?: string;
  };
}

export interface R2BucketLike {
  head(key: string): Promise<R2ObjectLike | null>;
  get(key: string): Promise<R2ObjectBodyLike | null>;
  put(key: string, value: string | ArrayBuffer | Uint8Array, options?: R2PutOptionsLike): Promise<R2ObjectLike | null>;
  delete?(key: string): Promise<void>;
}

export interface AssetsBindingLike {
  fetch(request: Request): Promise<Response>;
}

export interface WorkerEnv {
  GEOSITE_BUCKET: R2BucketLike;
  ASSETS?: AssetsBindingLike;
  UPSTREAM_YAML_URL?: string;
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
    yamlUrl: string;
    etag: string;
    cacheKey: string;
  };
  snapshot: {
    sourceKey: string;
    indexKey: string;
    listCount: number;
    generatedAt: string;
  };
  previousCacheKey: string | null;
  checkedAt: string;
}

interface SnapshotPayload {
  version: 2;
  etag: string;
  yamlUrl: string;
  cacheKey: string;
  generatedAt: string;
  lists: Record<string, string>;
}

interface DlcPlainYamlList {
  name: unknown;
  length?: unknown;
  rules: unknown;
}

type GeositeIndex = Record<string, string[]>;

interface RefreshResult {
  updated: boolean;
  reason: "etag-unchanged" | "etag-updated" | "snapshot-repaired" | "superseded";
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
  version: 2;
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
      let response: Response;
      try {
        try {
          response = await handleFetch(request, env, ctx, { now, fetchImpl });
        } catch (error) {
          if (!(error instanceof SnapshotUnavailableError)) throw error;
          // Retry once after an actual missing snapshot. Hot artifact requests
          // never load the full snapshot or probe both snapshot objects.
          await ensureGeositeRefresh(env, { now, fetchImpl });
          response = await handleFetch(request, env, ctx, { now, fetchImpl });
        }
      } catch (error) {
        logFailure("request.failed", error, { path: new URL(request.url).pathname, method: request.method });
        if (!(error instanceof ServiceUnavailableError)) throw error;
        const retryHeaders = { "retry-after": "30", "cache-control": "no-store" };
        response = new URL(request.url).pathname === "/geosite"
          ? json(503, { ok: false, error: "geosite data not ready" }, retryHeaders)
          : text(503, "geosite temporarily unavailable", retryHeaders);
      }
      const tagged = withGeositeRobotsTag(request, response);
      return withoutBodyForHead(request, tagged);
    },

    async scheduled(_event: ScheduledEventLike, env: WorkerEnv, _ctx: ExecutionContextLike): Promise<void> {
      await refreshGeositeRun(env, { now, fetchImpl });
    }
  };
}

function withGeositeRobotsTag(request: Request, response: Response): Response {
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith("/geosite")) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set("x-robots-tag", GEOSITE_ROBOTS_TAG);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function withoutBodyForHead(request: Request, response: Response): Response {
  if (request.method !== "HEAD") {
    return response;
  }

  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}

export async function refreshGeositeRun(env: WorkerEnv, deps: WorkerDeps = {}): Promise<RefreshResult> {
  const started = Date.now();
  try {
    const result = await refreshGeositeSnapshot(env, deps);
    console.log(JSON.stringify({ event: "geosite.refresh", ...result, durationMs: Date.now() - started }));
    return result;
  } catch (error) {
    logFailure("geosite.refresh_failed", error, { durationMs: Date.now() - started });
    throw new ServiceUnavailableError("geosite refresh failed", { cause: error });
  }
}

async function refreshGeositeSnapshot(env: WorkerEnv, deps: WorkerDeps): Promise<RefreshResult> {
  const now = deps.now ?? (() => Date.now());
  const fetchImpl = resolveFetchImpl(deps.fetchImpl);
  const checkedAt = new Date(now()).toISOString();
  const yamlUrl = env.UPSTREAM_YAML_URL ?? DEFAULT_UPSTREAM_YAML_URL;
  const userAgent = env.UPSTREAM_USER_AGENT ?? DEFAULT_UPSTREAM_USER_AGENT;

  const currentObject = await getObject(env.GEOSITE_BUCKET, LATEST_STATE_KEY);
  const current = currentObject ? JSON.parse(await currentObject.text()) as LatestState : null;
  const expectedEtag = currentObject?.etag ?? null;
  // Cron checks metadata only: lifecycle deletion must not be hidden by a
  // stable upstream ETag or by an isolate's in-memory snapshot cache.
  const currentSnapshotReady = current ? await hasSnapshotObjects(env.GEOSITE_BUCKET, current) : false;

  const observedHeadEtag = await checkUpstreamYamlEtag(yamlUrl, userAgent, fetchImpl);
  if (currentSnapshotReady && observedHeadEtag && current?.upstream.yamlUrl === yamlUrl && current.upstream.etag === observedHeadEtag) {
    const unchangedState: LatestState = {
      ...current,
      checkedAt
    };
    return publishLatestState(env.GEOSITE_BUCKET, unchangedState, expectedEtag, false);
  }

  const downloadResponse = await fetchImpl(yamlUrl, {
    headers: {
      "user-agent": userAgent
    }
  });
  if (!downloadResponse.ok) {
    throw new Error(`failed to download upstream yaml: ${downloadResponse.status} ${downloadResponse.statusText}`);
  }

  const yamlBytes = new Uint8Array(await downloadResponse.arrayBuffer());
  const downloadedEtag = normalizeEtag(downloadResponse.headers.get("etag"));
  const computedEtag = downloadedEtag ?? observedHeadEtag ?? (await sha256Hex(yamlBytes));
  const cacheKey = safeCacheKey(computedEtag);

  if (currentSnapshotReady && current?.upstream.yamlUrl === yamlUrl && current.upstream.cacheKey === cacheKey) {
    const unchangedState: LatestState = {
      ...current,
      checkedAt
    };
    return publishLatestState(env.GEOSITE_BUCKET, unchangedState, expectedEtag, false);
  }

  const sources = parseSourcesFromDlcPlainYaml(new TextDecoder().decode(yamlBytes));
  const listCount = Object.keys(sources).length;
  if (listCount === 0) {
    throw new Error("no geosite data found in upstream yaml");
  }
  // Validate snapshot can be parsed and resolved before publishing it as latest.
  const parsed = parseListsFromText(sources);
  const resolved = resolveAllLists(parsed);

  const generatedAt = new Date(now()).toISOString();
  const sourceKey = snapshotSourceKey(cacheKey);
  const indexKey = snapshotIndexKey(cacheKey);

  const snapshotPayload: SnapshotPayload = {
    version: 2,
    etag: computedEtag,
    yamlUrl,
    cacheKey,
    generatedAt,
    lists: sources
  };

  const index = buildIndexFromSources(sources, resolved);

  await writeJson(env.GEOSITE_BUCKET, sourceKey, snapshotPayload, {
    cacheControl: "public, max-age=31536000, immutable"
  });
  await writeJson(env.GEOSITE_BUCKET, indexKey, index);

  const nextState: LatestState = {
    upstream: {
      yamlUrl,
      etag: computedEtag,
      cacheKey
    },
    snapshot: {
      sourceKey,
      indexKey,
      listCount,
      generatedAt
    },
    previousCacheKey: current?.upstream.cacheKey === cacheKey
      ? current.previousCacheKey
      : current?.upstream.cacheKey ?? null,
    checkedAt
  };

  const result = await publishLatestState(env.GEOSITE_BUCKET, nextState, expectedEtag, true);
  if (result.updated) {
    if (current?.upstream.cacheKey === cacheKey) result.reason = "snapshot-repaired";
    snapshotCache.clear();
    resolvedCache.clear();
  }
  return result;
}

async function publishLatestState(
  bucket: R2BucketLike,
  next: LatestState,
  expectedEtag: string | null,
  updated: boolean
): Promise<RefreshResult> {
  // Compare the object read before any upstream work, including first initialization.
  const written = await bucket.put(LATEST_STATE_KEY, `${JSON.stringify(next)}\n`, {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    onlyIf: expectedEtag === null ? { etagDoesNotMatch: "*" } : { etagMatches: expectedEtag }
  });
  const state = written ? next : await readJson<LatestState>(bucket, LATEST_STATE_KEY);
  if (!state) {
    throw new Error("latest state disappeared during publication");
  }
  return {
    updated: written !== null && updated,
    reason: written === null ? "superseded" : updated ? "etag-updated" : "etag-unchanged",
    checkedAt: state.checkedAt,
    etag: state.upstream.etag,
    listCount: state.snapshot.listCount
  };
}

async function handleFetch(
  request: Request,
  env: WorkerEnv,
  ctx: ExecutionContextLike,
  deps: { now: () => number; fetchImpl: typeof fetch }
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return text(405, "method not allowed");
  }

  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/geosite") {
    return handleGeositeIndex(request, env, ctx, deps);
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

  return handleGeositeRules(request, mode, nameWithFilter, env, ctx, deps);
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

async function handleGeositeIndex(
  request: Request,
  env: WorkerEnv,
  ctx: ExecutionContextLike,
  deps: WorkerDeps
): Promise<Response> {
  const latest = await ensureLatestStateReady(env, deps);
  if (!latest) {
    return json(503, { ok: false, error: "geosite data not ready" });
  }

  const indexEtag = buildIndexEtag(latest.upstream.cacheKey);
  const indexHeaders = {
    "cache-control": "public, max-age=60, s-maxage=300, stale-while-revalidate=900",
    etag: indexEtag,
    "x-upstream-etag": latest.upstream.etag,
    "x-upstream-format": "yaml",
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
  ctx.waitUntil(writeJson(env.GEOSITE_BUCKET, latest.snapshot.indexKey, builtIndex).catch((error) => {
    logFailure("index.persist_failed", error, { cacheKey: latest.upstream.cacheKey });
  }));

  return json(200, builtIndex, indexHeaders);
}

async function handleGeositeRules(
  request: Request,
  mode: RegexMode,
  nameWithFilter: string,
  env: WorkerEnv,
  ctx: ExecutionContextLike,
  deps: WorkerDeps
): Promise<Response> {
  const { name, filter } = splitNameFilter(nameWithFilter);
  if (!isValidListName(name) || (filter !== null && !isValidAttr(filter))) {
    return text(400, "invalid name");
  }

  const latest = await ensureLatestStateReady(env, deps);
  if (!latest) {
    return text(503, "geosite data not ready");
  }

  const latestKey = artifactKey(latest.upstream.cacheKey, mode, name, filter);
  const latestArtifact = await readText(env.GEOSITE_BUCKET, latestKey);
  if (latestArtifact !== null) {
    const responseEtag = buildRulesEtag(latest.upstream.cacheKey, mode, name, filter);
    const headers = responseHeaders(latest, mode, name, filter, false);
    if (matchesIfNoneMatch(request.headers.get("if-none-match"), responseEtag)) {
      return notModified(headers);
    }
    return text(200, latestArtifact, headers);
  }

  const index = await readJson<GeositeIndex>(env.GEOSITE_BUCKET, latest.snapshot.indexKey);
  if (index && !hasOwn(index, name)) {
    return text(404, `list not found: ${name}`);
  }

  if (!filter && latest.previousCacheKey && index && hasOwn(index, name)) {
    const staleKey = artifactKey(latest.previousCacheKey, mode, name, filter);
    const staleArtifact = await readText(env.GEOSITE_BUCKET, staleKey);
    if (staleArtifact !== null) {
      const responseEtag = buildRulesEtag(latest.previousCacheKey, mode, name, filter);
      const headers = responseHeaders(latest, mode, name, filter, true, latest.previousCacheKey);
      ctx.waitUntil(ensureArtifactForLatest(env, latest, mode, name, filter).catch((error) => {
        logFailure("artifact.build_failed", error, { cacheKey: latest.upstream.cacheKey, mode, name });
      }));

      if (matchesIfNoneMatch(request.headers.get("if-none-match"), responseEtag)) {
        return notModified(headers);
      }
      return text(200, staleArtifact, headers);
    }
  }

  const build = await ensureArtifactForLatest(env, latest, mode, name, filter);
  if (!build.listFound) {
    return text(404, `list not found: ${name}`);
  }

  const responseEtag = buildRulesEtag(latest.upstream.cacheKey, mode, name, filter);
  const headers = responseHeaders(latest, mode, name, filter, false);
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
  latest: LatestState,
  mode: RegexMode,
  name: string,
  filter: string | null,
  stale: boolean,
  responseCacheKey = latest.upstream.cacheKey
): Record<string, string> {
  const responseEtag = buildRulesEtag(responseCacheKey, mode, name, filter);
  return {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": stale
      ? "public, max-age=60, s-maxage=120, stale-while-revalidate=900"
      : "public, max-age=300, s-maxage=1800, stale-while-revalidate=86400",
    etag: responseEtag,
    "x-upstream-etag": latest.upstream.etag,
    "x-upstream-format": "yaml",
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

  const cachedObject = await getObject(env.GEOSITE_BUCKET, blobKey);
  const cachedBody = cachedObject ? new Uint8Array(await cachedObject.arrayBuffer()) : null;
  const cachedMeta = await normalizeRemoteBinaryCacheMeta(
    cachedObject?.customMetadata?.geositeCache,
    options.namespace,
    options.cacheKey,
    cachedBody,
    options.fallbackContentType
  );
  const cached = cachedBody && cachedMeta && cachedObject
    ? { body: cachedBody, meta: cachedMeta, objectEtag: cachedObject.etag }
    : null;

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
      .catch((error) => {
        logFailure("binary.revalidate_failed", error, { namespace: options.namespace, cacheKey: options.cacheKey });
      });
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
  cached: { body: Uint8Array; meta: RemoteBinaryCacheMeta; objectEtag: string } | null,
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
  cached: { body: Uint8Array; meta: RemoteBinaryCacheMeta; objectEtag: string } | null,
  blobKey: string,
  metaKey: string
): Promise<ReadThroughRemoteBinaryResult> {
  const requestHeaders: Record<string, string> = {
    "user-agent": options.userAgent
  };
  if (cached?.meta.sourceEtag) {
    requestHeaders["if-none-match"] = `"${cached.meta.sourceEtag}"`;
  }

  const nowIso = new Date(options.now()).toISOString();

  try {
    const upstreamResponse = await options.fetchImpl(options.upstreamUrl, {
      headers: requestHeaders
    });

    if (upstreamResponse.status === 304 && cached?.meta.sourceEtag) {
      const refreshedMeta: RemoteBinaryCacheMeta = {
        ...cached.meta,
        fetchedAt: nowIso
      };
      await writeRemoteBinary(env.GEOSITE_BUCKET, blobKey, cached.body, refreshedMeta, cached.objectEtag);
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
      throw new Error(`failed to fetch remote binary: ${upstreamResponse.status} ${upstreamResponse.statusText}`);
    }

    const contentType = upstreamResponse.headers.get("content-type") ?? options.fallbackContentType;
    const sourceEtag = normalizeEtag(upstreamResponse.headers.get("etag"));
    const body = new Uint8Array(await upstreamResponse.arrayBuffer());
    const responseEtag = await buildRemoteBinaryEtag(options.namespace, options.cacheKey, sourceEtag, body);

    const nextMeta: RemoteBinaryCacheMeta = {
      version: 2,
      sourceEtag,
      responseEtag,
      fetchedAt: nowIso,
      contentType
    };

    await writeRemoteBinary(env.GEOSITE_BUCKET, blobKey, body, nextMeta, cached?.objectEtag ?? null);

    return remoteBinaryFound({
      body,
      responseEtag,
      sourceEtag,
      contentType,
      stale: false
    });
  } catch (error) {
    logFailure("binary.refresh_failed", error, { namespace: options.namespace, cacheKey: options.cacheKey, stale: cached !== null });
    if (cached) {
      return remoteBinaryFound({
        body: cached.body,
        responseEtag: cached.meta.responseEtag,
        sourceEtag: cached.meta.sourceEtag,
        contentType: cached.meta.contentType,
        stale: true
      });
    }
    throw new ServiceUnavailableError("remote binary unavailable", { cause: error });
  }
}

function buildIndexEtag(upstreamEtag: string): string {
  return `"geosite-index-v${GEOSITE_INDEX_SCHEMA_VERSION}:${upstreamEtag}"`;
}

function buildRulesEtag(upstreamEtag: string, mode: RegexMode, name: string, filter: string | null): string {
  return `"geosite-rules-v${CONVERTER_VERSION}:${upstreamEtag}:${mode}:${name.toLowerCase()}${filter ? `@${filter}` : ""}"`;
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
    // If-None-Match uses weak comparison for the supported GET/HEAD methods.
    .map((item) => item.trim().replace(/^W\//, ""))
    .some((item) => item === etag.replace(/^W\//, ""));
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
  const lockKey = artifactKey(latest.upstream.cacheKey, mode, name, filter);
  const existingLock = artifactBuildLocks.get(lockKey);
  if (existingLock) {
    return existingLock;
  }

  const lock = (async () => {
    const outputKey = artifactKey(latest.upstream.cacheKey, mode, name, filter);
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
  const cacheKey = latest.upstream.cacheKey;
  const cached = resolvedCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const pending = (async () => {
    const snapshot = await loadSnapshotPayload(env, latest);
    try {
      const parsed = parseListsFromText(snapshot.lists);
      return resolveAllLists(parsed);
    } catch (error) {
      throw new ServiceUnavailableError("invalid geosite snapshot rules", { cause: error });
    }
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
    const payload = await readJson<SnapshotPayload>(env.GEOSITE_BUCKET, latest.snapshot.sourceKey);
    if (!payload) {
      throw new SnapshotUnavailableError(`snapshot not found: ${latest.snapshot.sourceKey}`);
    }

    return payload;
  })();

  snapshotCache.set(cacheKey, pending);
  pruneMap(snapshotCache, SNAPSHOT_CACHE_LIMIT);
  return pending.catch((error) => {
    snapshotCache.delete(cacheKey);
    throw error;
  });
}

class ServiceUnavailableError extends Error {}
class SnapshotUnavailableError extends ServiceUnavailableError {}

async function hasSnapshotObjects(bucket: R2BucketLike, latest: LatestState): Promise<boolean> {
  const [source, index] = await Promise.all([
    bucket.head(latest.snapshot.sourceKey),
    bucket.head(latest.snapshot.indexKey)
  ]);
  return source !== null && index !== null;
}

async function ensureLatestState(env: WorkerEnv): Promise<LatestState | null> {
  return readJson<LatestState>(env.GEOSITE_BUCKET, LATEST_STATE_KEY);
}

async function ensureLatestStateReady(env: WorkerEnv, deps: WorkerDeps): Promise<LatestState | null> {
  const latest = await ensureLatestState(env);
  if (latest) {
    return latest;
  }

  await ensureGeositeRefresh(env, deps);
  return ensureLatestState(env);
}

async function ensureGeositeRefresh(env: WorkerEnv, deps: WorkerDeps): Promise<RefreshResult> {
  const existing = geositeRefreshLocks.get(env.GEOSITE_BUCKET);
  if (existing) {
    return existing;
  }

  const refresh = refreshGeositeRun(env, deps).finally(() => {
    geositeRefreshLocks.delete(env.GEOSITE_BUCKET);
  });
  geositeRefreshLocks.set(env.GEOSITE_BUCKET, refresh);
  return refresh;
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

async function checkUpstreamYamlEtag(yamlUrl: string, userAgent: string, fetchImpl: typeof fetch): Promise<string | null> {
  const response = await fetchImpl(yamlUrl, {
    method: "HEAD",
    headers: {
      "user-agent": userAgent
    }
  });

  if (!response.ok) {
    if (response.status === 403 || response.status === 404 || response.status === 405) {
      return null;
    }
    throw new Error(`failed to check upstream yaml: ${response.status} ${response.statusText}`);
  }

  return normalizeEtag(response.headers.get("etag"));
}

function parseSourcesFromDlcPlainYaml(yamlText: string): Record<string, string> {
  const parsed = parseYaml(yamlText, { schema: "failsafe" }) as unknown;
  if (!isObjectRecord(parsed) || !Array.isArray(parsed.lists)) {
    throw new Error("invalid upstream yaml: missing lists array");
  }

  const sources: Record<string, string> = {};

  for (const item of parsed.lists) {
    if (!isObjectRecord(item)) {
      throw new Error("invalid upstream yaml: list entry must be an object");
    }

    const list = item as unknown as DlcPlainYamlList;
    if (typeof list.name !== "string") {
      throw new Error("invalid upstream yaml: list name must be a string");
    }

    const listName = list.name.trim().toLowerCase();
    if (!VALID_LIST_NAME.test(listName)) {
      throw new Error(`invalid upstream yaml list name: ${JSON.stringify(list.name)}`);
    }
    if (hasOwn(sources, listName)) {
      throw new Error(`duplicate upstream yaml list: ${listName}`);
    }
    if (!Array.isArray(list.rules) || !list.rules.every((rule) => typeof rule === "string")) {
      throw new Error(`invalid upstream yaml rules for list: ${listName}`);
    }
    const declaredLength = parseYamlListLength(list.length);
    if (declaredLength !== null && declaredLength !== list.rules.length) {
      throw new Error(`invalid upstream yaml length for list: ${listName}`);
    }

    sources[listName] = list.rules.map((rule) => normalizeDlcPlainYamlRuleToSourceLine(rule)).join("\n");
    if (sources[listName].length > 0) {
      sources[listName] += "\n";
    }
  }

  return sources;
}

function parseYamlListLength(input: unknown): number | null {
  if (input === undefined) {
    return null;
  }
  if (typeof input === "number" && Number.isInteger(input)) {
    return input;
  }
  if (typeof input === "string" && /^[0-9]+$/.test(input)) {
    return Number.parseInt(input, 10);
  }
  return -1;
}

function normalizeDlcPlainYamlRuleToSourceLine(rule: string): string {
  const match = /:(@[a-z0-9!-]+(?:,@[a-z0-9!-]+)*)$/.exec(rule);
  if (!match) {
    return rule;
  }

  const attrs = match[1]!.split(",").join(" ");
  return `${rule.slice(0, match.index)} ${attrs}`;
}

function isObjectRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function normalizeEtag(raw: string | null): string | null {
  if (!raw) {
    return null;
  }
  return raw.replace(/^W\//, "").replace(/^"/, "").replace(/"$/, "").trim() || null;
}

function safeCacheKey(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]/g, "_");
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
  return `artifacts/v${CONVERTER_VERSION}/${etag}/${mode}/${artifactName(name, filter)}.txt`;
}

function snapshotSourceKey(etag: string): string {
  return `snapshots/${etag}/sources.json`;
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
  serialized: string | undefined,
  namespace: string,
  cacheKey: string,
  cachedBody: Uint8Array | null,
  fallbackContentType: string
): Promise<RemoteBinaryCacheMeta | null> {
  let input: unknown;
  try {
    input = serialized ? JSON.parse(serialized) : null;
  } catch {
    input = null;
  }
  if (
    isObjectRecord(input) &&
    input.version === 2 &&
    typeof input.fetchedAt === "string" &&
    typeof input.responseEtag === "string" &&
    typeof input.contentType === "string"
  ) {
    return {
      version: 2,
      sourceEtag: typeof input.sourceEtag === "string" ? input.sourceEtag : null,
      responseEtag: input.responseEtag,
      fetchedAt: input.fetchedAt,
      contentType: input.contentType
    };
  }

  if (!cachedBody) {
    return null;
  }

  // The old sidecar may describe different bytes. Serve only a content-derived
  // identity and re-fetch unconditionally before promoting this legacy object.
  return {
    version: 2,
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

async function getObject(bucket: R2BucketLike, key: string): Promise<R2ObjectBodyLike | null> {
  try {
    return await bucket.get(key);
  } catch (error) {
    throw new ServiceUnavailableError(`failed to read R2 object: ${key}`, { cause: error });
  }
}

async function readText(bucket: R2BucketLike, key: string): Promise<string | null> {
  try {
    const object = await getObject(bucket, key);
    return object ? await object.text() : null;
  } catch (error) {
    if (error instanceof ServiceUnavailableError) throw error;
    throw new ServiceUnavailableError(`failed to read R2 text: ${key}`, { cause: error });
  }
}

async function readJson<T>(bucket: R2BucketLike, key: string): Promise<T | null> {
  const content = await readText(bucket, key);
  if (content === null) return null;
  try {
    return JSON.parse(content) as T;
  } catch (error) {
    throw new ServiceUnavailableError(`invalid R2 JSON: ${key}`, { cause: error });
  }
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

  try {
    await bucket.put(key, content, { httpMetadata: metadata });
  } catch (error) {
    throw new ServiceUnavailableError(`failed to write R2 text: ${key}`, { cause: error });
  }
}

async function writeJson(
  bucket: R2BucketLike,
  key: string,
  value: unknown,
  options: { cacheControl?: string } = {}
): Promise<void> {
  const metadata: NonNullable<R2PutOptionsLike["httpMetadata"]> = {
    contentType: "application/json; charset=utf-8"
  };
  if (options.cacheControl) {
    metadata.cacheControl = options.cacheControl;
  }

  try {
    await bucket.put(key, `${JSON.stringify(value)}\n`, { httpMetadata: metadata });
  } catch (error) {
    throw new ServiceUnavailableError(`failed to write R2 JSON: ${key}`, { cause: error });
  }
}

async function writeRemoteBinary(
  bucket: R2BucketLike,
  key: string,
  body: Uint8Array,
  meta: RemoteBinaryCacheMeta,
  expectedEtag: string | null
): Promise<void> {
  // Bytes and their identity become visible in one R2 write. A delayed 304 or
  // download must not replace a newer object published by another isolate.
  await bucket.put(key, body, {
    httpMetadata: {
      contentType: meta.contentType,
      cacheControl: "public, max-age=300, s-maxage=1800, stale-while-revalidate=86400"
    },
    customMetadata: { geositeCache: JSON.stringify(meta) },
    onlyIf: expectedEtag === null ? { etagDoesNotMatch: "*" } : { etagMatches: expectedEtag }
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

function logFailure(event: string, error: unknown, fields: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({
    event,
    ...fields,
    error: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error && error.cause instanceof Error ? { cause: error.cause.message } : {})
  }));
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
