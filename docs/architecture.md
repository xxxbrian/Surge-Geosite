# Surge Geosite Architecture

This document keeps the technical runtime/ops details for maintainers and contributors.

## Runtime Topology

Production uses two Cloudflare Workers on the same domain:

- API Worker (`packages/worker`)
  - Serves `/geosite*`
  - Runs scheduled upstream refresh
- Panel Worker (`packages/panel`)
  - Serves dashboard pages (`/`, `/zh`, `/en`, etc.)
  - Proxies panel-side API calls to geosite endpoints

Recommended route priority:

1. `surge.bojin.co/geosite*` -> API Worker
2. `surge.bojin.co/*` -> Panel Worker

## Refresh Pipeline

1. Cron runs every 5 minutes.
2. Worker sends `HEAD` to the upstream YAML release asset (`dlc.dat_plain.yml`).
3. If ETag is unchanged: only update the check timestamp when the snapshot and index exist; rebuild missing data.
4. If ETag changed:
   - Download YAML once.
   - Normalize YAML rules into source text.
   - Validate parse/resolve.
   - Write snapshot and index to R2.
   - Atomically switch `state/latest.json`.

## Serve Pipeline

1. Read `state/latest.json`.
2. Try `artifacts/v{converterVersion}/{cacheKey}/{mode}/{name[@filter]}.txt`.
3. If hit: return immediately.
4. If miss:
   - Optionally return stale artifact from previous cache key (non-filter path), then rebuild latest in background.
   - Otherwise build on demand and write artifact.

## API Surface

- `GET /geosite` returns `{ [listName]: filters[] }`
- `GET /geosite/:name_with_filter` (default mode: `balanced`)
- `GET /geosite/:mode/:name_with_filter`

`name_with_filter` format:

- `apple` => full converted list
- `apple@cn` => only rules tagged with `@cn`

## Modes

- `strict`: only lossless regex conversion
- `balanced`: controlled downgrade (default)
- `full`: most permissive conversion

## R2 Storage Layout

- `state/latest.json`
- `snapshots/{cacheKey}/sources.json`
- `snapshots/{cacheKey}/index/geosite.json`
- `artifacts/v{converterVersion}/{cacheKey}/{mode}/{name[@filter]}.txt`

## Operations

- Preserve snapshots referenced by the current and previous cache keys; only artifacts may expire solely by age.
- CLI (`packages/cli`) is for local debug/verification, not required in production serving path.
