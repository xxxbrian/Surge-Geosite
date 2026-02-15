# Surge Geosite

Geosite 数据集到 Surge Ruleset 的边缘转换服务。

在线服务地址：`https://surge.bojin.co`

这个项目的目标很简单：以 `v2fly/domain-list-community` 为上游源，持续产出 Surge 可直接使用的规则，并通过同域名 API + 面板提供查询与预览。

## 在线使用

- 面板：首页 `https://surge.bojin.co/`
- 数据集索引：`https://surge.bojin.co/geosite`
- 默认模式（balanced）：`https://surge.bojin.co/geosite/apple@cn`
- 指定模式：`https://surge.bojin.co/geosite/strict/apple@cn`
- 指定模式：`https://surge.bojin.co/geosite/balanced/apple@cn`
- 指定模式：`https://surge.bojin.co/geosite/full/apple@cn`

## API

- `GET /geosite`
- `GET /geosite/:name_with_filter`（默认 `balanced`）
- `GET /geosite/:mode/:name_with_filter`，其中 `mode = strict | balanced | full`

Surge 引用示例：

```ini
[Rule]
RULE-SET,https://surge.bojin.co/geosite/apple@cn,DIRECT
RULE-SET,https://surge.bojin.co/geosite/strict/category-ads-all,REJECT
```

`name_with_filter` 语义：

- `apple`：返回完整数据集转换结果
- `apple@cn`：仅返回带 `@cn` 属性的规则

## 模式说明

- `strict`：仅接受无损 regex 转换，不能无损的直接跳过
- `balanced`：可控降级（默认服务模式）
- `full`：最宽松转换，覆盖率最高，也最可能放宽匹配边界

## 当前架构（v2）

Cloudflare Worker 同时承担 API、面板静态资源托管和定时刷新。

- API：`/geosite*`
- 面板：非 API 路径通过 `ASSETS` 返回
- 定时刷新：Cron 每 5 分钟执行

刷新流程：

1. `HEAD` 上游 ZIP 检查 ETag
2. ETag 未变化时只更新检查时间
3. ETag 变化时下载 ZIP，提取 `data/*`，写入 R2 快照与索引，最后更新 `state/latest.json`

请求流程：

1. 优先命中 `artifacts/{etag}/{mode}/{name[@filter]}.txt`
2. 未命中时按需构建并写回 artifact
3. 非过滤请求在条件满足时可先回旧 artifact（stale）并后台刷新

## R2 存储布局

- `state/latest.json`
- `snapshots/{etag}/sources.json.gz`
- `snapshots/{etag}/index/geosite.json`
- `artifacts/{etag}/{mode}/{name[@filter]}.txt`

建议在 Cloudflare R2 后台给 `snapshots/` 与 `artifacts/` 配置 Lifecycle 清理策略（例如 7-30 天）。

## 仓库结构

- `packages/core`：纯转换核心库（parser / resolver / regex / surge emitter）
- `packages/worker`：Cloudflare Worker API + cron + R2 读写
- `packages/panel`：Astro 面板（同域托管）
- `packages/cli`：本地调试构建工具（非生产依赖）

## 本地开发

前置：Node.js 24+、pnpm。

```bash
pnpm install
pnpm build
pnpm test
```

面板开发：

```bash
pnpm panel:dev
```

Worker 本地开发（同域 API + panel）：

```bash
pnpm worker:dev
```

Worker 本地开发（含 cron 模拟）：

```bash
pnpm worker:dev:cron
```

## 部署（Cloudflare）

```bash
pnpm worker:login
pnpm worker:r2:create
pnpm worker:deploy
```

`wrangler.toml` 已包含：

- `name = "surge-geosite"`
- `assets.directory = "../panel/dist"`
- `triggers.crons = ["*/5 * * * *"]`
- `GEOSITE_BUCKET` R2 绑定
