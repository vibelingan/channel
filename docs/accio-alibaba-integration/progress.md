# Accio + Alibaba.com + TCB Agent 调研进度

## 2026-07-28

- 已读取本项目 AI 平台设计与 CloudBase Agent 约束。
- 已确认研究必须分别验证商品知识、商品导入、价格分层、询盘回传，不能以“Agent 可以聊天”替代系统集成合同。
- Google 搜索入口被 429 阻断；Bing 搜索页已加载但导航工具超时，后续从现有页面读取结果并直达官方来源。
- 已从 Accio 官方首页确认经典 Accio 与 Accio Work 是两种不同能力面；后者是桌面 MCP Client/Agent 平台。
- 已确认 Accio Work 的 schedule 本地运行、Channels 面向 IM、Webhook 当前是出站结果通知；不能承担网站 24/7 后端。
- 已确认 Accio Work 存在 Alibaba.com Connector、Publish Skill 与 storefront/editor 能力名，但公开文档尚无字段与权限合同。
- 已发现 Connector 指南把 Alibaba 列为 Coming Soon，与 release notes 的“已加入授权”冲突；必须在目标账户做资格/工具清单实测。
- 已确认已登录 Chrome 的本地浏览器提取可作为人工监督迁移 PoC，但不具备持续同步合同。
- 已确认 Alibaba.com 国际站存在官方 Open Platform，支持商家自研和商用 ISV 两种开发者；API 目录含商品、RFQ、交易、物流及 push mechanism。
- 已通过官方 JSON handler 枚举 12 类 235 个 API，并核验商品 list/get/schema render/update 的参数与输出。
- 商品目录读取、增量同步、完整详情、SKU/价格/MOQ/交期/图片字段均有官方合同；普通店铺询盘消息 API 在公开树中未发现。
- 已核验商家/服务商权限包、OAuth2 authorization-code、token 刷新与商用 ISV 服务市场边界。
- 已核验平台禁止爬取、目的限制、自动化决策/转委托、加密审计、用户权利与删除义务；浏览器抓取从候选生产路线中移除。
- 已核验开发者服务协议与入驻规则：App key 不可转借；数据只限特定应用与同一卖家，不得跨店聚合；退订/终止需删除。
- 已定位本仓库 `products/overstock`、三档价格、公开投影、Admin CRUD 与媒体生命周期；确认需要独立 import draft/sync job/connection 数据域。
- 已生成 `REPORT.md`：结论、场景矩阵、部署/通信方式、目标架构、同步算法、价格规则、合规边界、PoC 和供应商问题清单。
- 验证：`git diff --check` 通过；自动覆盖检查通过，包含 16 个官方/来源 URL 与全部核心场景。
- 两轮独立 assumption audit 已完成并最终 APPROVE；修正了目标账户权限措辞、tenant 存储约束、撤权未知合同、字段级冲突、价格授权和既有 Hermes + 乐享运行时边界。
- 增量同步最终合同：固定上界、递归拆分到 `total_item <= 30` 的单页时间桶；单秒超过 30 且无稳定游标/快照/排序时 `BLOCKED_UNSTABLE_TIE`，不得推进 watermark。
- 仓库强制验证通过：`npx --no-install tsc --noEmit`；`pnpm exec biome check .`（166 files，0 errors）。
