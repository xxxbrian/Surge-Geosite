# Surge Geosite

Edge service that converts geosite datasets into Surge rulesets.

Production URL: `https://surge.bojin.co`

The goal is simple: use `v2fly/domain-list-community` as the source of truth, continuously produce Surge-compatible rules, and provide lookup/preview through same-domain API + panel.

## Online Usage

- Panel home: `https://surge.bojin.co/`
- Dataset index: `https://surge.bojin.co/geosite`
- Default mode (balanced): `https://surge.bojin.co/geosite/apple@cn`
- Specific mode: `https://surge.bojin.co/geosite/strict/apple@cn`
- Specific mode: `https://surge.bojin.co/geosite/balanced/apple@cn`
- Specific mode: `https://surge.bojin.co/geosite/full/apple@cn`

## API

- `GET /geosite`
- `GET /geosite/:name_with_filter` (default: `balanced`)
- `GET /geosite/:mode/:name_with_filter`, where `mode = strict | balanced | full`

Surge usage example:

```ini
[Rule]
RULE-SET,https://surge.bojin.co/geosite/apple@cn,DIRECT
RULE-SET,https://surge.bojin.co/geosite/strict/category-ads-all,REJECT
```

`name_with_filter` semantics:

- `apple`: return the full converted dataset
- `apple@cn`: return only rules with `@cn`

## Mode Semantics

- `strict`: only lossless regex conversion; unsupported cases are skipped
- `balanced`: controlled downgrade (default serving mode)
- `full`: most permissive conversion; widest coverage and highest over-match risk

## Current Architecture (v2)

Cloudflare Worker handles API serving, panel static hosting, and scheduled refresh.

- API: `/geosite*`
- Panel: non-API paths are served via `ASSETS`
- Refresh: cron runs every 5 minutes

Refresh flow:

1. `HEAD` upstream ZIP to check ETag
2. If ETag unchanged, only update check timestamp
3. If ETag changed, download ZIP, extract `data/*`, write snapshot/index to R2, then update `state/latest.json`

Request flow:

1. Try `artifacts/{etag}/{mode}/{name[@filter]}.txt` first
2. Build on demand and cache artifact on miss
3. For non-filter requests, stale artifact may be returned first (when applicable), then refreshed in background

## R2 Storage Layout

- `state/latest.json`
- `snapshots/{etag}/sources.json.gz`
- `snapshots/{etag}/index/geosite.json`
- `artifacts/{etag}/{mode}/{name[@filter]}.txt`

Recommended: configure R2 Lifecycle policies for `snapshots/` and `artifacts/` (for example, 7-30 days).

## Repository Structure

- `packages/core`: pure conversion core (parser / resolver / regex / surge emitter)
- `packages/worker`: Cloudflare Worker API + cron + R2 IO
- `packages/panel`: Astro panel (same-domain hosting)
- `packages/cli`: local debug tool (not required for production serving)

## Local Development

Prerequisites: Node.js 24+, pnpm.

```bash
pnpm install
pnpm build
pnpm test
```

Panel dev:

```bash
pnpm panel:dev
```

Worker dev (same-domain API + panel):

```bash
pnpm worker:dev
```

Worker dev with cron simulation:

```bash
pnpm worker:dev:cron
```

## Deployment (Cloudflare)

```bash
pnpm worker:login
pnpm worker:r2:create
pnpm worker:deploy
```

`wrangler.toml` includes:

- `name = "surge-geosite"`
- `assets.directory = "../panel/dist"`
- `triggers.crons = ["*/5 * * * *"]`
- `GEOSITE_BUCKET` R2 binding

---

Chinese doc: [`README.zh-CN.md`](./README.zh-CN.md)
