<div align="center">
  <h1>Surge Geosite</h1>
  <p>
    中文 | <a href="./README.md">English</a>
  </p>
  <p>自动转换 <code>v2fly/domain-list-community</code> 数据集为 Surge 可直接使用的规则。</p>
  <p>
    <a href="https://surge.bojin.co"><strong>打开可视化面板</strong></a>
  </p>
</div>

<p align="center">
  <img src="./docs/assets/panel-dashboard.png" alt="Surge Geosite 面板" width="600" />
</p>

## 直接使用

1. 打开可视化面板：https://surge.bojin.co。
2. 搜索并选择数据集。
3. 复制页面给出的原始链接。
4. 粘贴到 Surge 规则中。

如果你要直接使用规则链接，格式是：

- 规则路径：`https://surge.bojin.co/geosite/:name_with_filter`

`name_with_filter` 有两种：

- 不带 filter：`apple`
  返回 `apple` 这个数据集的完整规则。
- 带 filter：`apple@cn`
  只返回带 `@cn` 标签的规则。

Surge 引用示例：

```ini
[Rule]
RULE-SET,https://surge.bojin.co/geosite/apple@cn,DIRECT
RULE-SET,https://surge.bojin.co/geosite/strict/category-ads-all,REJECT
```

## 高级使用

### API

- `GET /geosite` 返回 `{ [listName]: filters[] }`
- `GET /geosite/:name_with_filter`（默认模式：`balanced`）
- `GET /geosite/:mode/:name_with_filter`

### 模式说明

- `strict`：仅接受无损 regex 转换
- `balanced`：保守转换，优先避免误匹配，允许遗漏部分规则（默认）
- `full`：最宽松转换（覆盖范围最大，误匹配风险也最高）

## 维护者说明

本地开发：

```bash
pnpm install
pnpm build
pnpm test
pnpm panel:dev
pnpm worker:dev
```

部署：

```bash
pnpm panel:deploy
pnpm worker:deploy
```

技术架构文档：[docs/architecture.md](./docs/architecture.md)
