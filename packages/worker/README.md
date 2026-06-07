# @surge-geosite/worker

Cloudflare Worker runtime for geosite API serving with built-in cron refresh.

## Endpoints

- `GET /geosite` returns `{ [listName]: filters[] }`
- `GET /geosite/:name_with_filter` (default mode: `balanced`)
- `GET /geosite/:mode/:name_with_filter` where mode is `strict|balanced|full`

## Runtime Model

- `scheduled`:
  - HEAD upstream YAML release asset to check ETag, falling back to GET when HEAD has no usable ETag.
  - If ETag unchanged: update check timestamp only.
  - If ETag changed: download `dlc.dat_plain.yml`, normalize rules, resolve lists, write snapshot + compact filter index to R2, then update `state/latest.json`.
- `fetch`:
  - Route `/geosite*` requests to API handlers.
  - API handlers read latest state from R2.
  - Serve prebuilt artifact from `artifacts/{cacheKey}/{mode}/{name[@filter]}.txt` when available.
  - On miss, compile on-demand from snapshot and cache artifact.
  - Unknown filters are served as empty output but are not persisted as artifacts.
  - If previous cache artifact exists, return stale artifact immediately and refresh latest artifact in background (`waitUntil`).
  - The public index is built completely during refresh and is not mutated by ruleset requests.

## R2 Layout

- `state/latest.json`
- `snapshots/{cacheKey}/sources.json`
- `snapshots/{cacheKey}/index/geosite.json`
- `artifacts/{cacheKey}/{mode}/{name[@filter]}.txt`

Retention:

- Configure R2 Lifecycle rules for `snapshots/` and `artifacts/` prefixes in Cloudflare dashboard.
- Recommended: keep a short retention window (for example 7-30 days) based on your traffic and rollback needs.

## Wrangler

`packages/worker/wrangler.toml` includes:

- `[triggers] crons = ["*/5 * * * *"]`
- `[vars]` for `UPSTREAM_YAML_URL` and `UPSTREAM_USER_AGENT`
- `[[r2_buckets]]` binding `GEOSITE_BUCKET`

## Scripts

- `pnpm run worker:dev`
- `pnpm run worker:dev:cron` (local cron simulation)
- `pnpm run worker:deploy`

## Deploy

```bash
pnpm run worker:login
pnpm run worker:r2:create
pnpm run worker:deploy
```
