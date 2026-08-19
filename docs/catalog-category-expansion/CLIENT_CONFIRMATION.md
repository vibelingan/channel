# Electronics & Toys — 客户确认清单

> 日期：2026-08-19
> 使用方式：无异议可直接确认；有异议只需在对应项目后写修改意见。

## 建议确认项

| # | 需要确认 | 推荐默认 | 客户意见 |
|---|---|---|---|
| 1 | `Electronics & Toys` 是否需要独立总览页 | 需要，URL 为 `/electronics-toys/` | |
| 2 | 四个二级产品族 | Headphones / AI Gadgets / Toys / Misc | |
| 3 | `Misc` 的公开英文名称 | 建议改为 `Other Electronics & Toys`；内部 key 仍为 `misc` | |
| 4 | 首期 SKU 模型 | 一条商品记录 = 一个 SKU；颜色/尺寸多规格后续再做 | |
| 5 | Headphones 现有分类 | Office / Bluetooth / Wired 保留为 Headphones 内部筛选 | |
| 6 | SKU URL | `/products/{slug}/`，改产品族时 URL 不变 | |
| 7 | `/headphones/` | 保留现有 URL 与 canonical，不迁移 | |
| 8 | 后台结构 | 一个 Products 工作区，含 All + 四产品族 Tab | |
| 9 | 新商品发布 | 默认草稿，人工确认后发布；Alibaba 不能自动发布 | |
| 10 | 发布权限 | 暂时沿用 admin / contributor 的现有权限 | |
| 11 | 已发布商品移除 | 先下架/归档；永久删除后的页面处理另行确认 | |
| 12 | 价格展示 | 显示允许公开的价格；没有公开价格时显示 `Request a quote`。本期前台不显示 VIP 价格，后台不再录入 VIP Price；旧字段仅临时兼容历史数据 | |
| 13 | Alibaba 未映射类目 | 不创建商品，绝不自动归入 Misc | |
| 14 | 暂无商品的产品族 | 页面可先存在，但 `noindex,follow` 且不进 sitemap | |
| 15 | 页面语言 | 本期只做英文；中文与 hreflang 后续单独确认 | |

## 明确不在本期

- Alibaba API 接入与真实同步。
- 购物车、支付、订单、库存。
- SKU 多规格/变体。
- 评论、评分、收藏、商品比较。
- 自动生成/翻译商品文案。
- VIP 申请、审批、会员升级和 VIP 价格展示。

## 确认

```text
客户姓名：________________________

确认日期：________________________

结论：  [ ] 按推荐方案确认    [ ] 按上表意见修改后确认
```
