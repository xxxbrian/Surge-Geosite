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
const LATEST_STATE_KEY = "state/latest.json";
const SNAPSHOT_CACHE_LIMIT = 2;
const RESOLVED_CACHE_LIMIT = 2;

const VALID_LIST_NAME = /^[a-z0-9!-]+$/;
const VALID_ATTR_NAME = /^[a-z0-9!-]+$/;

const snapshotCache = new Map<string, Promise<SnapshotPayload>>();
const resolvedCache = new Map<string, Promise<Record<string, ResolvedList>>>();
const artifactBuildLocks = new Map<string, Promise<ArtifactBuildResult>>();

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
}

export interface WorkerEnv {
  GEOSITE_BUCKET: R2BucketLike;
  UPSTREAM_ZIP_URL?: string;
  UPSTREAM_USER_AGENT?: string;
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

interface GeositeIndexEntry {
  name: string;
  sourceFile: string;
  filters: string[];
  modes: Record<RegexMode, string>;
}

type GeositeIndex = Record<string, GeositeIndexEntry>;

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

export function createWorker(deps: WorkerDeps = {}): {
  fetch(request: Request, env: WorkerEnv, ctx: ExecutionContextLike): Promise<Response>;
  scheduled(event: ScheduledEventLike, env: WorkerEnv, ctx: ExecutionContextLike): Promise<void>;
} {
  const now = deps.now ?? (() => Date.now());
  const fetchImpl = deps.fetchImpl ?? fetch;

  return {
    async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContextLike): Promise<Response> {
      return handleFetch(request, env, ctx);
    },

    async scheduled(_event: ScheduledEventLike, env: WorkerEnv, _ctx: ExecutionContextLike): Promise<void> {
      await refreshGeositeRun(env, { now, fetchImpl });
    }
  };
}

export async function refreshGeositeRun(env: WorkerEnv, deps: WorkerDeps = {}): Promise<RefreshResult> {
  const now = deps.now ?? (() => Date.now());
  const fetchImpl = deps.fetchImpl ?? fetch;
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
  void resolveAllLists(parsed);

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
  const index = buildIndexFromSources(sources);

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

async function handleFetch(request: Request, env: WorkerEnv, ctx: ExecutionContextLike): Promise<Response> {
  if (request.method !== "GET") {
    return text(405, "method not allowed");
  }

  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/") {
    return redirect("https://github.com/xxxbrian/Surge-Geosite");
  }

  if (path === "/geosite") {
    return handleGeositeIndex(env, ctx);
  }

  if (!path.startsWith("/geosite/")) {
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

  return handleGeositeRules(mode, nameWithFilter, env, ctx);
}

async function handleGeositeIndex(env: WorkerEnv, ctx: ExecutionContextLike): Promise<Response> {
  const latest = await readJson<LatestState>(env.GEOSITE_BUCKET, LATEST_STATE_KEY);
  if (!latest) {
    return json(503, { ok: false, error: "geosite data not ready" });
  }

  const index = await readJson<GeositeIndex>(env.GEOSITE_BUCKET, latest.snapshot.indexKey);
  if (index) {
    return json(200, index, {
      "x-upstream-etag": latest.upstream.etag,
      "x-generated-at": latest.snapshot.generatedAt,
      "x-checked-at": latest.checkedAt
    });
  }

  const snapshot = await loadSnapshotPayload(env, latest);
  const builtIndex = buildIndexFromSources(snapshot.lists);
  ctx.waitUntil(writeJson(env.GEOSITE_BUCKET, latest.snapshot.indexKey, builtIndex));

  return json(200, builtIndex, {
    "x-upstream-etag": latest.upstream.etag,
    "x-generated-at": latest.snapshot.generatedAt,
    "x-checked-at": latest.checkedAt
  });
}

async function handleGeositeRules(
  mode: RegexMode,
  nameWithFilter: string,
  env: WorkerEnv,
  ctx: ExecutionContextLike
): Promise<Response> {
  const { name, filter } = splitNameFilter(nameWithFilter);
  if (!isValidListName(name) || (filter !== null && !isValidAttr(filter))) {
    return text(400, "invalid name");
  }

  const latest = await readJson<LatestState>(env.GEOSITE_BUCKET, LATEST_STATE_KEY);
  if (!latest) {
    return text(503, "geosite data not ready");
  }

  const latestKey = artifactKey(latest.upstream.etag, mode, name, filter);
  const latestArtifact = await readText(env.GEOSITE_BUCKET, latestKey);
  if (latestArtifact !== null) {
    return text(200, latestArtifact, responseHeaders(latest.upstream.etag, mode, name, filter, false));
  }

  const index = await readJson<GeositeIndex>(env.GEOSITE_BUCKET, latest.snapshot.indexKey);
  if (index && !index[name]) {
    return text(404, `list not found: ${name}`);
  }

  const compilePromise = ensureArtifactForLatest(env, latest, mode, name, filter);

  if (!filter && latest.previousEtag) {
    const staleKey = artifactKey(latest.previousEtag, mode, name, filter);
    const staleArtifact = await readText(env.GEOSITE_BUCKET, staleKey);
    if (staleArtifact !== null) {
      ctx.waitUntil(
        compilePromise
          .then((result) => maybeEnrichIndexFilters(env, latest, name, result.availableFilters))
          .catch(() => undefined)
      );

      return text(200, staleArtifact, responseHeaders(latest.previousEtag, mode, name, filter, true));
    }
  }

  const build = await compilePromise;
  if (!build.listFound) {
    return text(404, `list not found: ${name}`);
  }

  if (build.availableFilters.length > 0) {
    ctx.waitUntil(maybeEnrichIndexFilters(env, latest, name, build.availableFilters));
  }

  return text(200, build.output, responseHeaders(latest.upstream.etag, mode, name, filter, false));
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
  return {
    "content-type": "text/plain; charset=utf-8",
    "x-upstream-etag": etag,
    "x-mode": mode,
    "x-list": name.toLowerCase(),
    ...(filter ? { "x-filter": filter } : {}),
    ...(stale ? { "x-stale": "1" } : {})
  };
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

async function maybeEnrichIndexFilters(
  env: WorkerEnv,
  latest: LatestState,
  listName: string,
  filters: string[]
): Promise<void> {
  if (filters.length === 0) {
    return;
  }

  const normalizedFilters = [...new Set(filters)].sort();
  const index = await readJson<GeositeIndex>(env.GEOSITE_BUCKET, latest.snapshot.indexKey);
  if (!index) {
    return;
  }

  const lookupName = listName.toLowerCase();
  const current = index[lookupName];
  if (!current) {
    return;
  }

  if (isSameStringArray(current.filters, normalizedFilters)) {
    return;
  }

  const nextIndex: GeositeIndex = {
    ...index,
    [lookupName]: {
      ...current,
      filters: normalizedFilters
    }
  };

  await writeJson(env.GEOSITE_BUCKET, latest.snapshot.indexKey, nextIndex);
}

function buildIndexFromSources(sources: Record<string, string>): GeositeIndex {
  const names = Object.keys(sources).sort();
  const index: GeositeIndex = {};

  for (const listName of names) {
    index[listName] = {
      name: listName.toUpperCase(),
      sourceFile: listName,
      filters: [],
      modes: {
        strict: `rules/strict/${listName}.txt`,
        balanced: `rules/balanced/${listName}.txt`,
        full: `rules/full/${listName}.txt`
      }
    };
  }

  return index;
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

function redirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      location
    }
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
