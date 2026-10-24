# AI 驱动供应链平台：架构、工作拆分与实施路线图

> **项目：** Diversity Technology Limited 官方网站 2.0  
> **版本：** v1.0（架构研究版）  
> **日期：** 2026-07-21  
> **范围：** 悬浮式 AI 客服、AI 成本矩阵、趋势洞察、供应商优化、敏捷物流控制，以及共用的线索、数据与 AI 控制平面  
> **状态：** 设计与排期；尚未批准实施、未创建生产云资源

---

## 1. 结论先行

### 1.1 这不是一个聊天按钮，而是六个本次深度设计域

PRD 中的“AI 驱动”至少包含以下六个可独立验收的产品任务：

1. **悬浮式 AI 客服**：24/7 回答 MOQ、Price、Lead Time、Certificate、OEM Available；会话同步销售；真人接管后 AI 立即停止。
2. **AI 智能估价器**：多步骤输入，确定性计算 BOM/开模费区间，Email 解锁 PDF，并写入销售线索。
3. **AI 趋势洞察**：在合法且获授权的数据源上持续采集、归类、评分，提出蓝海品类候选。
4. **AI 供应商优化**：在已审核供应商池中按工艺、认证、产能、质量、价格、交期等约束给出可解释的候选排序。
5. **敏捷物流控制**：根据自有订单和获授权的承运商/货代数据比较方案、跟踪事件，并在条件变化时提出重规划建议。
6. **共用控制平面**：身份、线索、会话、人工接管、审计、权限、配置、成本、可观测性和数据治理。

不能用“一个 Agent + 一个 Prompt”代替这些领域系统。趋势、报价、供应商与物流首先是**数据和规则系统**；大模型只负责自然语言交互、非结构化信息提取、归类与解释。

本文件是用户本次点名的五项 AI 能力加共用控制平面的深度设计，**不是整个 10 页 PRD 的全部网站 backlog**。PRD 中另外三项仍是正式范围，但本次明确排入后续 Release：

- Teardown Lab/CMS 与每周拆解内容。
- Newsletter capture、双重确认订阅及 Mailchimp/HubSpot 选择。
- Concept Incubator、合作层级、`.glb/.gltf` 3D viewer 与移动端 AR 可行性。

它们的基础页面/内容在当前主工作区并不存在；必须单独实施，不能因为本文件聚焦 AI 平台而消失。

#### PRD 可追溯矩阵

| PRD 要求 | 本文件处理 | 状态/发布 |
|---|---|---|
| §3/§4.5 悬浮 AI 客服、销售同步、真人停止 | §4 + ADR-001 | Release A / Phase 1–1B |
| §4.5 AI Instant Estimator、Email/PDF/Lead | §5 | Release B / Phase 2 |
| §4.1 AI 趋势洞察 | §6 | Release C / Phase 3 |
| §4.1 AI 供应商优化 | §7 | Release C / Phase 4 |
| §4.1 敏捷物流控制 | §8 | Release C / Phase 5 |
| §4.3 Teardown Lab + BOM 内容 CMS | 仅作为趋势输出/Lead 来源；网站内容功能未深拆 | Release E；独立规划 |
| §4.3 Newsletter capture | Lead source 已预留；ESP/双重确认未深拆 | Release E；独立规划 |
| §4.4 Concept Incubator + 3D/AR + partnership tiers | 未纳入本次人周合计 | Release F；独立规划 |
| §4.6 Client Portal | §13 只定义隔离边界 | Release D；独立安全/多租户设计 |

**优先级决定：** 虽然原 PRD 将 Estimator 称为核心转换工具，本路线将已有可运行 PoC 的客服 Pilot 提前，以 4–8 周验证知识、线索和销售工作流；Estimator 同时在第三周启动，不代表其商业优先级被取消。该调整需要产品负责人批准。

### 1.2 悬浮客服与 Hermes 已经被验证，不再是待猜测项

本地原型已实际跑通以下链路：

```text
网页悬浮组件
  → Hermes Agent OpenAI-compatible REST API (/v1/chat/completions)
  → DeepSeek
  → 腾讯乐享 MCP 知识库
```

已核实：

- `Hermes Agent` 是 Nous Research 的公开 MIT 项目，不是内部代号。
- 官方 API Server 支持 Chat Completions、SSE、Responses、Runs、停止运行、Sessions、健康检查、MCP 与 Docker。
- 腾讯乐享提供公开的 MCP、AI 问答 API、AI 搜索 API、SSE、匿名公开知识问答、多轮会话和引用来源。
- 因此，“ADP 约一周 PoC；Hermes + 乐享 + REST API 约一个月做出 MVP”的判断有技术基础。

但“本地跑通”与“公网生产客服”仍有明确差距：密钥不能放浏览器、Hermes 默认全工具必须裁掉、CORS 不能为 `*`、Markdown 必须消毒、会话与接管必须持久化、销售后台必须落地，并且需要限流、监控、审计和竞态测试。

### 1.3 推荐技术路线

**推荐：保留已经验证的 Hermes + 腾讯乐享路线，增加 CloudBase 控制平面。**

```text
Astro 悬浮客服 Island
    ↓ HTTPS / SSE（无供应商密钥）
CloudBase/CloudRun Chat BFF
    ├─ 会话、消息、线索、同意、限流、接管状态
    ├─ 销售后台与通知
    └─ 私网/受控调用
         ↓
Hermes Agent 专用客服 Profile（CloudRun 容器）
    ├─ 仅允许只读乐享 MCP 工具
    └─ DeepSeek / 获批腾讯模型端点
         ↓
腾讯乐享“公开客服知识库”
```

关键分工：

| 组件 | 只负责什么 | 明确不负责什么 |
|---|---|---|
| 浏览器 Widget | 展示、输入、流式渲染、无障碍、收集同意 | 不保存长期密钥；不直接调用 Hermes/乐享 |
| Chat BFF | 公开 API、安全、会话所有权、状态机、限流、销售接管、事件过滤 | 不决定供应商/价格；不执行任意 Agent 工具 |
| Hermes | 受限的对话编排、调用获批知识工具、生成答案 | 不做身份/权限真相源；不持有销售状态；不运行终端/文件/浏览器工具 |
| 腾讯乐享 | 经过审核的知识内容、搜索与引用 | 不保存客户线索；不读取内部成本/供应商合同 |
| CloudBase 数据层 | 业务记录、审计、线索、接管、配置版本 | 不把原始 PII/秘密暴露给浏览器或模型 |

### 1.4 时间判断

在已有本地 PoC 的前提下：

- **1 周**：可完成 ADP 或 Hermes 的展示型 PoC；不能称生产客服。
- **4 周**：3 人小组可交付“知识库 only”的受控试运行版本；前提是知识内容、乐享只读凭证、域名和云环境已准备好。
- **6–8 周**：加入销售会话队列、真人接管硬停止、持久化、同意/保留、监控、竞态与安全验收后，可进入生产试点。
- **9–12 个月**：5–7 人跨职能团队并行，交付六个领域的 MVP 组合。
- **12–18 个月**：形成多数据源、可审计、可运营、持续校准的 V1 平台。

如果只有 1 名工程师串行实施，按去重后的规划范围 **111–186 人周**、约 42 个有效工程周/年，理论下限约 **32–53 个月**；按未去重原始工作量则是更保守的 35–59 个月。现实还要加外部审批与 SME 等待。单人方案必须削减范围，不能把完整组合压进 18–24 个月。

---

## 2. 已验证事实、架构判断与待确认项

### 2.1 已验证事实

- 当前仓库是 Astro + React Admin + CloudBase NoSQL/函数的 monorepo。
- 当前 test 环境是 CloudBase NoSQL 模式；已有公开限流、`429 + Retry-After`、健康/release 标识、OEM 询盘、邮件和 RBAC。
- 当前正式仓库尚无 AI Widget、Hermes 服务、知识库适配、会话、消息、线索或销售接管实现。
- 本地原型已经验证浏览器、Hermes、DeepSeek、乐享 MCP 的基本互通。
- Hermes API Server 默认工具面非常大，包含终端、文件、浏览器、代码执行、记忆、技能、委派和 cron；不能按默认设置暴露给公网客户。
- 乐享 AI 问答支持 `system-bot` 匿名身份，但只能访问“全公司成员均可访问”的公开知识；这正适合单独维护的公开客服知识空间。
- Google Trends 官方 API 截至已验证资料仍属于有限 alpha；数据是搜索兴趣，不是绝对销量。
- eBay Browse API 是合法的 listing 信号，但不是完整成交数据。
- Amazon API 需要特定资格和用途授权；不能当作无限制全球市场数据库。
- DHL 等物流 API 需要客户账户/审批，并对费率、追踪数据的保存、比较、披露和使用有合同限制。

### 2.2 架构判断

- 公网客服不能直接从浏览器调用 Hermes 或乐享，因为任何前端 Bearer/API Key 都可被复制滥用。
- “知识库 only”仍然需要 BFF：它承担匿名身份、会话隔离、限流、接管、审计和密钥边界。
- 报价数字必须由版本化规则引擎产生；大模型不能生成或修改价格数字。
- “最佳供应商”只能表示“在给定硬约束与权重下，已审核池中的候选排序”。
- “实时物流”只能表示“在已接入数据源的刷新/事件频率内重新计算”，不代表拥有全球实时数据。
- 供应商选择、正式报价、物流改订均是商业承诺；MVP 只能“建议 + 人工批准”，不能让 Agent 自动执行。

### 2.3 启动前必须确认

| 编号 | 决策 | 为什么重要 | 阻塞范围 |
|---|---|---|---|
| D1 | 生产模型：DeepSeek 直连、腾讯模型端点，还是双供应商 fallback | 成本、数据流向、SLA、Hermes provider 配置 | 客服上线 |
| D2 | 乐享建立独立“公开客服知识库”，只读 Token/MCP 工具清单 | 防止内部文档和写工具进入公网 Agent | 客服上线 |
| D3 | 真人在哪里接管：现有 React Admin、企业微信、腾讯企点或 CRM | 决定消息通道与销售工作流 | 接管功能 |
| D4 | 英文 only、英文/中文、还是自动识别 | 知识内容、评测集、UI 和销售排班 | 客服验收 |
| D5 | 聊天记录、PII、线索的保留期与删除流程 | GDPR、跨境传输、存储成本 | 生产上线 |
| D6 | 生产区域与数据驻留；现有上海 test 环境不能自动等同生产 | 欧美访客数据可能涉及跨境处理 | 生产架构 |
| D7 | 成本矩阵负责人、更新频率、批准流程和可公开字段 | 决定估价是否可信和可审计 | 估价器 |
| D8 | 众筹/电商数据的授权来源与预算 | 没有合同就不能承诺自动全球监测 | 趋势洞察 |
| D9 | 供应商主数据、历史报价、质量/交付数据是否可获得 | 没有数据就只能做目录筛选，不能优化 | 供应商模块 |
| D10 | 承运商/货代账号、API/EDI、费率使用条款 | 决定能否比较、缓存、分析和重规划 | 物流模块 |
| D11 | AI Operational PostgreSQL 实例/网络/连接池/RPC 路径 | 真人接管需要可验证的条件更新与事务 | 客服接管上线 |

---

## 3. 总体架构

### 3.1 系统上下文

参见：

- [HLD 系统上下文图](../../.claude/diagrams/hld-context-ai-supply-chain-platform.excalidraw)
- [HLD 服务架构图](../../.claude/diagrams/hld-services-ai-supply-chain-platform.excalidraw)
- [HLD 部署图](../../.claude/diagrams/hld-deployment-ai-supply-chain-platform.excalidraw)

### 3.2 容器与服务

#### Trust-boundary legend

| Boundary | 信任级别 | 可调用范围 |
|---|---|---|
| Anonymous browser | 不可信公网 | 仅 `/api/ai/*`；没有供应商密钥 |
| Authenticated admin browser | 经过 JWT 身份但输入仍不可信 | 既有 `/api/admin/*`；AI 销售功能只走 `/api/admin/ai/*` |
| Tencent edge | 基础网络控制 | TLS/WAF/routing；不替代业务授权 |
| Chat BFF + AI PG | 项目业务信任域 | 会话/Lead/接管；可回查 NoSQL 用户，可调用私有 Hermes |
| Existing Admin + NoSQL | 既有业务信任域 | CMS/auth/OEM/media；不访问 AI PG/Hermes |
| Private Hermes profile | 高权限但最小工具域 | 仅 Public Lexiang read tools + approved model |
| AI workers | 内部批处理域 | 各自获批 market/carrier/model adapter；默认无 Lexiang |
| External vendors | 各自独立第三方域 | Lexiang、model、market feed、carrier、CRM/SMTP 使用不同凭证、配额与 adapter；不可共享通配凭证 |

HLD 图为控制元素数而合并显示外部服务；上表是实际安全边界。实施 LLD 必须为每类 vendor 单独画 data flow 和 credential scope。

| 服务/数据域 | 推荐运行位置 | 技术方向 | 说明 |
|---|---|---|---|
| Public Site | 现有 CloudBase Web App/CDN | Astro | 继续静态优先；AI Widget 使用客户端 Island |
| Chat BFF | CloudRun 容器 | Node.js/TypeScript | 唯一公网聊天入口；SSE、状态机、限流、身份、线索 |
| Hermes Customer Service | CloudRun 容器 | 固定版本 Hermes Agent | 专用 profile；单一职责；只读乐享 MCP |
| AI Jobs/Orchestrator | CloudRun + timer function | Node/Python | 报告、采集、分类、批处理、重试和工作流状态 |
| Optimization Service | CloudRun | Python + 成熟优化库 | 供应商/物流多目标评分和约束求解；不使用 LLM 算数 |
| Existing Admin API | 现有 Cloud Function | TypeScript | 保留既有 CMS/auth/OEM CRUD；不直接访问 AI PG 或承载长 SSE |
| AI Sales API | Chat BFF 的认证子路由 | Node.js/TypeScript | 唯一 `/api/admin/ai/*` owner；复用 JWT 并逐请求回查 NoSQL `users` 状态，再做 PG 行级业务授权 |
| Existing NoSQL Store | 现有 CloudBase NoSQL | 文档库 | 保留 CMS、用户、OEM、媒体与现有业务；不承担未经验证的接管 CAS |
| AI Operational Store | CloudBase PG/TencentDB PG，需预检 | PostgreSQL（BFF 使用 `pg` 协议） | 会话、消息、run、线索、接管、审计；条件 `UPDATE ... WHERE status/version` 是一致性边界 |
| Analytical Store | 同一 PG 的独立 schema 起步；规模化后可拆分 | PostgreSQL | 时间序列、成本版本、供应商、物流、趋势事实表 |
| Raw/Object Store | CloudBase Storage/COS | 对象存储 | 原始数据快照、导入文件、PDF 报告、模型工件 |
| Knowledge Source | 腾讯乐享 | 公共客服知识空间 | 内容审核、权限、版本；与内部知识物理/权限隔离 |
| Model Provider | 可配置 | DeepSeek/获批腾讯端点 | 由 Hermes provider adapter 隔离，不写死业务层 |
| Notifications/CRM | SMTP/企微/企点/CRM，待选 | Adapter | 销售提醒、线索同步、人工消息；必须可观测 |
| Monitoring | CloudBase/TCOP/CLS + OTel | 指标/日志/追踪 | 不记录密钥；默认不记录完整聊天内容 |

### 3.3 数据分层

#### Existing NoSQL（继续保留）

- 现有 CMS/auth/OEM/media 数据。
- 现有公开限流 primitive 可复用其算法与 HTTP 合同，但聊天状态不应依赖尚未 live-verified 的 NoSQL 条件更新。

#### AI Operational PostgreSQL（新建；实施前预检）

- `conversations`
- `conversationMessages`
- `aiRuns`
- `leads`
- `knowledgeFeedback`
- `rateLimitHits` / token buckets

CloudBase PostgreSQL SDK 本身不直接提供完整 transaction API；官方建议通过数据库函数/RPC 封装，或使用 PostgreSQL `pg` 协议直接连接以获得完整事务控制。本设计选择 BFF 通过受控连接池使用 `pg` 协议，并以单条条件 `UPDATE ... WHERE status IN (...) AND mode_version = ... RETURNING ...` 或事务作为接管 CAS。若生产环境无法提供该连接边界，则必须先设计并 live-verify 等价的存储层 CAS，不能退化为 NoSQL “先读后写”。

#### Analytical PostgreSQL（数据智能模块）

- `source_connectors`, `ingestion_runs`, `raw_assets`
- `market_signals`, `products_normalized`, `trend_scores`
- `cost_matrix_versions`, `bom_components`, `tooling_rules`, `quote_snapshots`
- `suppliers`, `supplier_capabilities`, `supplier_certifications`, `supplier_quotes`, `supplier_performance`
- `carriers`, `lanes`, `rate_quotes`, `shipments`, `shipment_events`, `route_options`
- `model_evaluations`, `decision_audits`

#### Object Storage

- `raw/trends/<source>/<date>/...`
- `imports/suppliers/...`
- `imports/logistics/...`
- `reports/estimates/<lead-id>/<revision>.pdf`
- `quarantine/...`

### 3.4 数据分类与模型可见性

| 等级 | 示例 | Hermes 客服可见？ | 规则 |
|---|---|---:|---|
| Public | 官网内容、公开 MOQ 政策、公开证书摘要、OEM 能力 | 是 | 仅来自已批准乐享空间，带来源 |
| Internal | 标准流程、销售 playbook、非公开 FAQ | 默认否 | 如需开放，先做字段/文档级审核 |
| Confidential | BOM 成本、margin、供应商评分、合同价、客户项目 | 否 | 只能由内部服务按最小字段访问 |
| Restricted | API Key、密码、身份证明、完整 PII、合同文件 | 否 | KMS/Secret Manager；禁止进入 Prompt/日志 |

**公共 Agent 的乐享 Token 必须只覆盖 Public 空间。** 不能依赖 Prompt 告诉模型“不要看内部资料”；权限边界必须在 Token 和工具层成立。

---

## 4. 悬浮式 AI 客服

### 4.1 产品范围

首版必须支持：

- 获批公开页面上的悬浮入口；默认不在 admin/account/auth 页面出现。
- 匿名访客可先问公开 FAQ；“匿名会话”不是 Lead。只有访客明确请求人工/估价、提交联系方式并同意跟进后才创建 Lead。
- 英文优先，后续可启用中文/自动识别。
- 快捷问题：MOQ、Price、Lead Time、Certificate、OEM Available。
- 回答附公开知识来源或明确的知识范围提示。
- 没有可靠答案时拒答并引导询盘/人工。
- 访客可留下 Email、公司、姓名、WhatsApp（在获得同意后）。
- 会话与线索同步到销售后台。
- 销售认领后，AI 停止自动回复；所有旧运行结果均不得落库或继续显示。
- 服务失败时退化为联系/询盘表单，不能无限 spinner 或编造答案。

销售可在未留联系方式前看到待接管的匿名 conversation ID、公开问题和最小必要 transcript；不能看到不存在的身份信息。Estimator 继续保持 Email gate，这一决定正式取代早期“每个聊天都先收 Email/自动建 Lead”的假设。

### 4.2 回答政策

| 主题 | 可以回答 | 不可以回答 |
|---|---|---|
| MOQ | 已发布的品类/产品 MOQ 或条件范围 | 未经批准的例外承诺 |
| Price | 解释价格影响因素、引导估价器/询盘 | 编造单价、泄露成本/margin、形成正式报价 |
| Lead Time | 已批准的典型区间与前置条件 | 保证交付日期 |
| Certificate | 引用已审核证书/能力摘要 | 宣称不存在或过期认证 |
| OEM Available | 已批准工艺、品类和合作流程 | 承诺未验证工艺/产能 |
| 订单/项目状态 | 首版不回答 | 访问任意客户项目或文件 |

### 4.3 API 边界

#### 公开 API（建议）

| 方法 | 路径 | 作用 |
|---|---|---|
| `POST` | `/api/ai/conversations` | 创建匿名会话，返回短期会话凭证和 consent 要求 |
| `POST` | `/api/ai/conversations/:id/messages` | 写用户消息并创建 AI run；使用 Idempotency-Key |
| `GET` | `/api/ai/conversations/:id/events` | SSE：消息、token、引用、handoff、错误 |
| `POST` | `/api/ai/conversations/:id/handoff` | 访客请求人工；可附线索字段 |
| `POST` | `/api/ai/conversations/:id/close` | 关闭与触发保留策略 |
| `POST` | `/api/ai/runs/:id/cancel` | 用户取消当前回答 |

#### 销售 API（建议）

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET` | `/api/admin/ai/conversations` | 按状态、分配、时间查询队列 |
| `POST` | `/api/admin/ai/conversations/:id/takeover` | 原子认领并停止 AI |
| `POST` | `/api/admin/ai/conversations/:id/messages` | 真人发送消息 |
| `POST` | `/api/admin/ai/conversations/:id/return-to-ai` | 显式恢复 AI；生成新 modeVersion |
| `PATCH` | `/api/admin/ai/conversations/:id/assignment` | 分配业务员 |
| `POST` | `/api/admin/ai/conversations/:id/close` | 关闭并记录结果 |

上述 `/api/admin/ai/*` 全部由 Chat BFF 提供，不走现有 generic Admin `COLLECTIONS` CRUD。BFF 验证现有 JWT 后，必须按当前 admin handler 的安全语义逐请求读取 NoSQL `users` 行：删除/`suspended` 立即失效，角色升降立即生效。`users._id` 作为跨存储 actor ID 写入 PG 审计。MVP 不建立 team 模型：`sales` 可认领未分配会话，之后只能访问 `assignedTo = self`；`admin` 可查看/重新分配全部。

### 4.4 人工接管状态机

参见 [会话控制状态机](../../.claude/diagrams/lld-state-conversation-control.excalidraw) 与 [真人接管竞态顺序图](../../.claude/diagrams/lld-sequence-human-takeover.excalidraw)。

`conversation.status`：

```text
BOT_ACTIVE
  ├─ user requests human / confidence too low → HANDOFF_REQUESTED
  ├─ sales takes directly                    → HUMAN_ACTIVE
  └─ user closes / retention action          → CLOSED

HANDOFF_REQUESTED
  ├─ sales takes                              → HUMAN_ACTIVE
  └─ user closes                              → CLOSED

HUMAN_ACTIVE
  ├─ authorized sales explicitly returns AI   → BOT_ACTIVE (modeVersion + 1)
  └─ sales/user closes                        → CLOSED

CLOSED → terminal
```

每次改变 AI/人工控制权时，原子增加 `modeVersion`。

#### 接管竞态处理

1. 用户消息事务读取当前 `modeVersion`，写用户消息、内部 `aiRun(status=CREATING, operationId, version)` 与 `start_run` outbox；公网请求线程不直接创建 Hermes run。
2. worker 认领 outbox 后再次确认 `BOT_ACTIVE`、version 未变、run 仍 `CREATING`，再以稳定的 `Idempotency-Key = operationId` 调用 Hermes `POST /v1/runs`。上线前必须在固定 Hermes 版本 contract-test：相同 key 重试返回同一 `run_id`；若该版本不保证，则在 Hermes 前增加持久化 operation-ID mapping adapter。
3. 收到 `run_id` 后，worker 以条件更新登记 `engineRunId` 并转 `ACTIVE`。若此时已接管/version 改变，登记为 `CANCEL_REQUESTED` 并立即 stop。进程若在外部创建后、登记前崩溃，reconciler 重放相同 operation ID 取回同一 `run_id`，随后登记或停止，消除 orphan run 窗口。
4. Hermes event **不能直接 `res.write()`**。每个 AI event 必须在 PG 事务中锁定 conversation row，只有 `BOT_ACTIVE`、version 相同、run active 时才增加 `nextEventSequence` 并 append 到 `conversationEvents`；失败则丢弃。
5. 销售接管获取同一 conversation row lock，以 CAS 改为 `HUMAN_ACTIVE`、`modeVersion + 1`，标记所有 `CREATING/ACTIVE` run 为 cancel requested，append `handoff.started` 的下一个 sequence，并写 cancellation outbox。
6. SSE dispatcher 只按已提交 `conversationEvents.sequence` 顺序发送。已在接管前线性化的 AI event 排在 handoff 之前；`handoff.started` 之后，旧 version AI event 无法 append，因此也无法越过公网流。客户端 version 过滤只是第二道防线。
7. cancellation worker 对已知 `engineRunId` 幂等调用 `POST /v1/runs/:runId/stop`；对仍 `CREATING` 的 run 等待 operation-ID reconciliation 后立即停止。
8. 最终 assistant message 也走同一个条件 append，而不是独立 check-then-write；不满足条件则 run 标记 `DISCARDED/CANCELLED`。
9. 并发测试必须覆盖 takeover 发生在外部 create 前、create 与 run-ID 登记之间、token append 前后、final commit 前后；验收合同是：客户端看到 `handoff.started(sequence=N)` 后，不会看到任何旧 AI event `sequence>N`。

这比“Prompt 中写真人来了请停止”可靠，因为 Prompt 无法关闭已经在运行的请求。

### 4.5 Hermes 生产 Profile

本地配置中的以下值仅适用于开发：

- `API_SERVER_CORS_ORIGINS=*`
- `GATEWAY_ALLOW_ALL_USERS=true`
- `approvals.mode=off` 搭配全工具
- `platform_toolsets.api_server` 包含 `hermes-api-server`
- 浏览器内 `AI_API_KEY`

本地 PoC 的 `/v1/chat/completions` 只用于证明连通性。生产客服统一使用 Hermes Runs API（create/status/events/stop），以获得明确的 `run_id`、可重连事件流和可验证取消语义。

生产要求：

1. 固定 Hermes release 和容器 digest，不跟随 `main/latest`。
2. Hermes API 只监听内网/loopback，由 BFF 调用；浏览器没有 Hermes Key。
3. 为客服建立独立 profile 和独立数据目录。
4. `platform_toolsets.api_server` 只列乐享 MCP；乐享 `tools.include` 只列获批的只读搜索/读取工具。
5. 不启用 `hermes-api-server` 默认完整工具集。
6. 启动后调用受保护的 `/v1/toolsets` 做负向验收：不得出现 `terminal`, `process`, `read_file`, `write_file`, `patch`, `browser_*`, `execute_code`, `delegate_task`, `cronjob`, `memory`, `skill_manage`, `messaging`。
7. 使用只读乐享 Token；Token 放 Secret Manager/服务端 env，支持轮换。
8. BFF 设置并验证并发、超时、每会话 token/turn 上限；达到上限时返回人工/询盘选项。
9. `/health` 用于 liveness；认证的 `/health/detailed` 用于 readiness，并检查模型、MCP、磁盘和运行数。
10. Hermes 本地 SQLite 只作为 Agent 运行辅助；业务会话、接管与线索以 CloudBase 为真相源。

> Hermes 的工具选择行为在快速迭代中变化较快。配置文件只是意图；**`GET /v1/toolsets` 的实际负向断言才是上线合同。**

### 4.6 Widget 生产化

- 从单文件脚本改为 Astro/React client island，与站点 token/样式统一。
- 小屏全高抽屉；桌面浮层；不遮 Cookie/表单/导航。
- 键盘可打开/关闭；焦点陷阱；`Escape`；ARIA live；reduced motion。
- 使用 SSE；提供 Stop/Retry；断线重连以 last event ID 或 run status 对账。
- Markdown 经 sanitizer 后渲染；外链加安全属性；禁止任意 HTML/script/style/iframe。
- 快捷问题不直接硬编码业务答案，只发送问题模板。
- 明示“AI assistant”、能力边界、隐私说明和人工入口。
- 只在批准 route scope 挂载。

### 4.7 客服验收指标（建议目标，需批准）

| 指标 | Pilot 目标 |
|---|---:|
| 获批 FAQ grounded answer rate | ≥ 90% |
| 引用覆盖率 | ≥ 95%（需要知识回答时） |
| 内部成本/秘密泄露 | 0 |
| 人工接管后可见 AI 消息 | 0 |
| Handoff stop propagation p95 | < 2 秒 |
| 首 token p95 | < 3 秒（供应商正常时） |
| 普通 FAQ 完整回复 p95 | < 20 秒 |
| 服务月可用性 | 99.5% pilot；稳定后评估 99.9% |
| 会话串线 | 0 |
| 无答案时正确拒答/转人工 | ≥ 95% |

评测集至少覆盖：

- 每类 FAQ 的正常问法、同义问法、拼写错误和多语言问法。
- 要求泄露系统 Prompt、Token、成本、供应商、客户数据。
- 知识库里的 prompt injection 文本。
- 无答案、矛盾答案、过期证书、价格承诺。
- 并发、超时、429、模型断线、MCP 断线、浏览器刷新。
- 人工接管与 AI 回答完成的竞态。

### 4.8 客服工作包与估时

| ID | 工作包 | 主要产出 | 独立验收 | 依赖 | 人周 |
|---|---|---|---|---|---:|
| C0 | PoC 基线固化 | 固定 Hermes 版本、配置快照、冒烟脚本 | 本地链路可重复，版本/工具面已记录 | 无 | 1–2 |
| C1 | 公开知识治理 | 独立乐享空间、FAQ、内容 owner/expiry | 100+ 基线问题有获批来源；内部文档不可见 | D2/D4 | 2–4 |
| C2 | Chat BFF + PG 控制合同 | migration、会话/消息/run API、匿名凭证、CAS、幂等、限流 | 未持有服务端 Key 的浏览器完成一次对话；条件更新竞态测试通过 | C0/D11 | 4–6 |
| C3 | Hermes CloudRun | 固定镜像、私网、只读 MCP、健康/回滚 | `/v1/toolsets` 负向断言全过；故障可回滚 | C0/C1 | 3–5 |
| C4 | Widget Island | 响应式、SSE、消毒、无障碍、断线恢复 | 390/768/1440、键盘、XSS、重连 E2E 通过 | C2/C3 | 2–4 |
| C5 | 会话/线索 | PG tables、加密/保留、sales 队列 | 刷新后会话可恢复；线索不丢且不串访客 | C2/D5 | 3–5 |
| C6 | 人工接管 | sales role、takeover CAS、stop、真人消息 | 竞态测试证明接管后 AI 输出为 0 | C5/D3 | 4–7 |
| C7 | 安全/运营 | WAF/限流、指标、告警、评测、runbook | 配额/模型/MCP/部署故障演练通过 | C2–C6 | 3–5 |

**增量总量：22–38 人周。** 其中 C1、C3、C4 可并行。已有 PoC 可节省约 2–4 人周探索时间。

---

## 5. AI 智能估价器与成本矩阵

### 5.1 正确边界

价格引擎必须是**确定性、版本化、可审计**的纯业务逻辑：

```text
估算区间 = 基础 BOM
         + 功能增量
         + 工艺/材料增量
         + 工装/模具摊提
         + 组装测试
         + 良率/损耗
         + 数量阶梯
         + 时程加急
         + FX/有效期规则
```

大模型只能：

- 从描述/文件中提取候选参数，等待用户确认。
- 生成解释、假设、风险和下一步文案。
- 翻译和整理 PDF。

大模型不能：

- 产生单价、开模费或 margin。
- 修改成本矩阵。
- 把内部成本字段返回浏览器。
- 形成正式报价或合同承诺。

### 5.2 数据与版本

每次估算必须保存：

- `matrixVersion`
- 标准化输入
- 每个规则项的内部计算明细
- 对外投影的区间/假设
- 置信度与缺失参数
- 货币、FX 版本、有效期
- 生成报告版本
- 请求者/线索与审计时间

成本版本发布流程：`DRAFT → REVIEWED → ACTIVE → RETIRED`。同一品类/区域/货币只能有一个 ACTIVE 版本；发布需要授权人员并保留旧版本，不覆盖历史估算。

### 5.3 用户流程

1. 品类。
2. 功能特征。
3. 数量、时程、目标市场。
4. 系统先计算但不向浏览器返回内部明细。
5. Email/公司/姓名同意后创建 Lead。
6. 异步生成 PDF 并发送邮件。
7. 销售后台看到输入、估算区间、假设和推荐跟进。
8. 工程/销售可将其转为人工正式报价；正式报价是另一状态与审批流程。

### 5.4 工作包与估时

| ID | 工作包 | 主要产出 | 独立验收 | 依赖 | 人周 |
|---|---|---|---|---|---:|
| E0 | 成本数据工作坊 | 字段字典、责任人、样本、公开/内部投影 | 20–50 个历史案例可重算；误差定义已签字 | D7 | 2–4 |
| E1 | 成本引擎 | 纯函数、规则版本、区间与置信度 | Golden cases 与人工表格一致；边界/属性测试通过 | E0 | 3–5 |
| E2 | 配置与发布 | 矩阵 CRUD、四态审批、审计 | 并发发布仅一个 ACTIVE；旧估算可重放 | E1 | 3–5 |
| E3 | 多步表单 | 响应式 wizard、验证、保存恢复 | 手机无溢出；无 Email 前不泄露价格/矩阵 | E1 | 3–4 |
| E4 | Lead/PDF/Email | 异步任务、模板、COS 链接、邮件 delivery ledger | Lead/报告幂等；邮件按已声明 delivery policy 发送，失败可重跑 | E1/C5 | 4–6 |
| E5 | 内部转报价 | 销售/工程审核与正式报价边界 | AI 估算与正式报价明确区分；审批审计完整 | E2/E4 | 2–4 |
| E6 | 校准与监控 | 估算 vs 实际偏差 dashboard | 按品类/版本显示误差，不自动改矩阵 | E0–E5 | 2–4 |

邮件基础包当前是 best-effort SMTP、失败返回 `false`，且不支持 attachment/idempotency。E4 必须升级为生产 worker：启动时验证 SMTP/Provider 为 LIVE，PDF 默认存私有 COS 并邮件发送短期授权下载链接（不是大附件），delivery ledger 使用 `PENDING → SUBMITTING → ACCEPTED/FAILED`。`ACCEPTED` 只表示 SMTP/provider 接受提交，不等于收件人收到；`DELIVERED/BOUNCED` 仅在供应商提供回执时使用。普通 SMTP 无法保证 exactly-once；本方案承诺 **Lead/报告幂等 + 至少一次提交尝试（可能极少重复）**，若业务要求 exactly-once，必须选择有幂等合同的供应商并另行验证。

**MVP：19–32 人周，8–12 日历周（并行团队）。** 最大变量不是代码，而是历史数据和业务负责人能否提供可靠规则。

---

## 6. AI 趋势洞察

### 6.1 对“自动监测全球数据”的重新定义

可信承诺应写为：

> 在已授权的数据源、获批人工导入和公司自有数据范围内，按固定频率采集并标准化市场信号，计算可解释的机会分数，交由分析员审核后形成蓝海候选。

不应承诺：

- 未获许可地抓取所有 Kickstarter、Indiegogo、Amazon 数据。
- 把搜索热度当销量。
- 由大模型直接判断“必定爆款”。
- 不显示来源、数据时间和置信度。

### 6.2 数据源阶梯

| 阶段 | 数据源 | 合法性/可控性 | 用途 |
|---|---|---|---|
| MVP | 分析员 CSV/URL、公司历史项目、公开 RSS/报告 | 高；人工审核 | 快速建立 taxonomy 与评分闭环 |
| MVP+ | eBay Browse API、获批 Google Trends alpha | 官方 API；需凭证/资格 | listing、搜索兴趣、地区/时间信号 |
| V1 | 商业市场数据供应商、获批平台/合作伙伴 feed | 合同决定 | 跨平台规模化监测 |
| V2 | 客户自有店铺/广告/销量数据 | 客户授权 | 校准“兴趣 → 转化/销量” |

### 6.3 数据流水线

```text
Scheduler
  → Connector（每源一个 adapter）
  → Raw snapshot 到 COS（带 license/retention 元数据）
  → Quarantine/validation
  → Normalize taxonomy + dedupe + currency/time normalization
  → Feature calculation
  → Deterministic opportunity score + confidence
  → LLM summary（只解释已计算事实）
  → Analyst review/publish/alert
```

机会分数应由可见权重组成，例如：

- 需求增长/加速度。
- 跨地区一致性。
- 竞争密度反向分。
- 可制造性与现有能力匹配。
- 成本/目标零售价空间。
- 认证、供应、质量、知识产权风险反向分。
- 数据新鲜度与覆盖置信度。

### 6.4 工作包与估时

| ID | 工作包 | 主要产出 | 独立验收 | 依赖 | 人周 |
|---|---|---|---|---|---:|
| T0 | 数据合同与许可 | source matrix、允许用途、保留、配额 | 每个 connector 有书面授权和禁止事项 | D8 | 3–6 + 外部等待 |
| T1 | Ingestion framework | connector SDK、run ledger、raw COS、幂等 | 重跑不重复；原始快照可追踪到 source | T0 | 4–6 |
| T2 | 分类与标准化 | taxonomy、去重、货币/地区/时间规范 | 人工标注集达到批准准确率 | T1 | 3–5 |
| T3 | 机会评分 | 版本化权重、confidence、解释 | 同输入同输出；缺失源降低置信度 | T2/E1 | 3–5 |
| T4 | 分析后台 | 候选列表、来源、趋势图、审核/发布 | 无来源/过期数据不可发布 | T2/T3 | 4–6 |
| T5 | AI 摘要与周报 | 事实受限摘要、引用、邮件/通知 | 数字与来源一致；幻觉测试通过 | T3/T4 | 3–5 |
| T6 | 校准 | 结果回填、precision/recall、权重评审 | 能比较候选与真实后续表现 | T4 | 2–4 |

**MVP：22–37 人周，10–16 日历周；不含平台审批/商业数据合同等待。**

---

## 7. AI 供应商优化

### 7.1 必要主数据

没有以下数据，系统只能是“供应商通讯录”，不能称优化：

- 公司主体、地点、联系人、合约状态。
- 工艺能力：精密切割、模具、打样、PCBA、SMT、注塑、组装等。
- 材料、设备、尺寸/公差、产量区间、MOQ。
- 认证与有效期；审核报告。
- 当前/预测产能与停产窗口。
- 历史报价、交期、回复速度。
- 良率、缺陷、退货、OTIF、审厂评分。
- IP/保密、地缘/单一来源、财务/合规风险。

### 7.2 匹配算法

1. **硬约束过滤**：工艺、认证、地区、材料、最小/最大数量、保密/黑名单、产能。
2. **多目标评分**：质量、交期、成本、产能、距离、响应、风险；权重按项目版本化。
3. **约束求解**：需要多供应商/产能拆分时，使用成熟优化库求可行组合。
4. **解释**：大模型将已计算结果转成可读说明；不得改分或补数据。
5. **人工批准**：采购/工程选择并记录原因；结果回填用于校准权重。

输出不是“东莞最佳工厂”，而是：

> 对项目 X、数量 Y、交期 Z、认证 C、权重版本 V，在已审核供应商池中，A/B/C 是前三个可行候选；以下字段缺失，因此置信度为中等。

### 7.3 工作包与估时

| ID | 工作包 | 主要产出 | 独立验收 | 依赖 | 人周 |
|---|---|---|---|---|---:|
| S0 | 主数据清洗 | supplier master、字段字典、证书/能力导入 | 目标供应商 ≥80% 核心字段完整 | D9 | 6–12（SME 密集） |
| S1 | 供应商管理 | schema、文档/证书、权限、变更审计 | 过期证书自动降级；敏感报价不可公开 | S0 | 4–6 |
| S2 | 约束与评分 | hard filters、权重版本、top-N | Golden projects 的可行候选不被过滤掉 | S0/S1 | 4–6 |
| S3 | 绩效/产能/报价 | 导入、时间有效性、异常/缺失处理 | 数据过期时不显示为当前能力 | S1 | 5–8 |
| S4 | 推荐与解释 UI | 项目输入、候选比较、why/why-not | 每个分数可追溯到字段和权重 | S2/S3 | 3–5 |
| S5 | 审批与反馈 | 采购选择、例外原因、结果回填 | 推荐不会自动下单；审批记录不可覆盖 | S4 | 3–5 |
| S6 | 试点校准 | 10–20 个真实项目回测 | 与采购专家差异被分类并签字处理 | S0–S5 | 4–7 |

**MVP：29–49 人周，14–22 日历周。** 数据清洗通常是关键路径。

---

## 8. 敏捷物流控制

### 8.1 首版业务边界

- 输入：起运地、目的地、货物/HS Code、重量体积、危险品、Incoterm、ready date、承诺日期、成本/时效权重。
- 连接：公司自有货代报价、获批承运商 API/EDI、历史运输表现。
- 输出：可行路线、预估成本、ETA、风险、数据时间、置信度和推荐理由。
- 执行：人工批准后才可订舱/改订；MVP 不允许 Agent 自动形成运输合同。
- 在途：接收 tracking/milestone，条件变化时重算“建议”；不是自动改道。

### 8.2 法务与数据限制

承运商 API 条款可能限制：

- 费率/时效数据存储。
- 用于竞争比较或派生分析。
- 向第三方披露。
- 追踪数据的保留时间。
- 仅可用于自身/客户的合法实际货件。

例如 DHL 官方条款明确指出费率/时效为指示值而非保证，并限制存储、修改、竞争分析和第三方披露。因此，设计 connector 前必须为每个承运商建立 `licensePolicy`；缓存 TTL、字段落库和 dashboard 显示均由合同驱动。

### 8.3 优化模型

- 硬约束：服务可用性、禁运/危险品、截单、容量、清关、交付 deadline。
- 成本：运输、燃油/附加费、保险、仓储、关税估算（仅在条款允许时）。
- 时间：承运商 ETA + 历史 lane 偏差。
- 风险：准时率、波动、转运节点、海关、天气/港口事件（有合法源时）。
- 目标：加权成本/时间/风险或 Pareto 候选，不伪造单一“最优”。

### 8.4 工作包与估时

| ID | 工作包 | 主要产出 | 独立验收 | 依赖 | 人周 |
|---|---|---|---|---|---:|
| L0 | 商务/API 准备 | carrier matrix、账号、条款、sandbox | 每个源明确可存/可比/可展示字段 | D10 | 4–8 + 外部等待 |
| L1 | 物流领域模型 | lane/rate/shipment/event/constraint schemas | 单位、时区、币种、Incoterm/HS 可验证 | L0 | 4–6 |
| L2 | Connector v1 | 手工货代表 + 1 个承运商 adapter | sandbox contract tests、幂等、429/重试通过 | L0/L1 | 5–8 |
| L3 | 路线/评分器 | 可行性过滤、多目标候选、confidence | Golden shipments 与人工方案可解释对比 | L1/L2 | 5–8 |
| L4 | Tracking/Replan | event ingest、ETA 更新、异常、重算 | 乱序/重复事件不破坏状态；不过度告警 | L2/L3 | 5–8 |
| L5 | 决策 UI/审批 | 方案比较、来源时间、批准/拒绝 | 不经审批不订舱；每次决策可审计 | L3/L4 | 4–6 |
| L6 | 运营/合规 | retention、数据删除、SLA、告警 | 条款 TTL 自动执行；故障演练通过 | L0–L5 | 4–7 |
| L7 | 多承运商扩展 | 第 2/3 源与统一 adapter | 新源不改变领域模型；回归测试通过 | L2–L6 | 每源 3–6 |

**单源 MVP：31–51 人周，16–24 日历周；商业 onboarding 可能更长。**

---

## 9. 共用控制平面

### 9.1 Leads

统一来源：

- `chat`
- `estimator`
- `newsletter`
- `teardown`
- `concept-partnership`

建议字段：

- source/sourceRef
- company/name/email/WhatsApp（应用层加密或受控字段）
- consent/version/timestamp
- language/country（仅必要时）
- category/quantity/timeline
- assignedTo/status/priority
- lastContactAt/outcome
- createdAt/updatedAt

状态建议：`NEW → QUALIFIED → ASSIGNED → CONTACTED → WON/LOST/ARCHIVED`。状态变化需要审计与权限，不允许内容角色查看所有 PII。

Lead 创建触发器是：用户提交 estimator gate、chat handoff/contact form、newsletter consent 或其它明确 conversion；普通匿名 FAQ conversation 不自动成为 Lead。

### 9.2 角色

现有角色没有 `sales`。新增角色会影响：

- shared role union。
- JWT/session revalidation。
- admin navigation。
- collection read/edit policy。
- tests/factories。
- E2E credentials。
- deploy/runbook。

建议权限：

| 角色 | Leads | Conversations | Cost config | Supplier/Logistics | Users |
|---|---|---|---|---|---|
| sales | 仅分配给自己（team 为 post-MVP） | 认领未分配、回复自己的、关闭自己的 | 只读公开估算 | 无或摘要 | 无 |
| contributor | 无 PII | 无 | 内容型字段 | 无 | 无 |
| procurement | 无客户 PII | 无 | 只读 | 供应商/物流审批 | 无 |
| engineer | 项目需要范围 | 无 | 维护成本草稿 | 技术能力审核 | 无 |
| admin | 全部 | 全部 | 发布 | 配置/权限 | 全部 |

首版至少实现 `sales`，并同步修改 `ROLES`、`canAccessAdmin()`、session/navigation、seed、typed test factories 和 E2E。AI 销售接口逐请求回查当前 NoSQL 用户状态；Lead/Conversation 使用专用 PG 查询强制 `assignedTo = currentUserId`，不接入 generic collection CRUD。只有 `admin` 可重新分配；team scope 明确为 post-MVP。后续角色应在各模块落地时再引入，不一次性扩大权限面。

### 9.3 Audit/Outbox

- 线索创建、估算生成、人工接管、供应商推荐批准、物流方案批准均写审计记录。
- 外部通知/CRM 同步通过 outbox/job，使用幂等键；业务事务成功但外部调用失败时可重试。对普通 SMTP 只承诺至少一次提交尝试；`ACCEPTED` 不代表收件人已投递。
- 不采用完整 Event Sourcing；业务当前值仍是主模型，审计是不可变附加记录。

---

## 10. 非功能性要求

### 10.1 安全

- 公网只暴露 BFF；Hermes、乐享、模型密钥均留在服务端。
- CORS 精确列出站点 origin，不使用 `*`。
- API Gateway/WAF + per-IP/per-session/global 限流；返回 `429` 与 `Retry-After`。
- 所有输入 Zod/JSON Schema 验证；长度、消息数、token、频率有上限。
- 受限 Hermes profile；实际工具列表做正/负合同测试。
- Prompt injection 不能获得写/执行能力；检索内容以不可信数据处理。
- Markdown 消毒 + CSP + `nosniff`。
- PII 与 transcript 分离；日志默认只记录 ID、状态、耗时、token 和错误类别。
- Secret 轮换、启动时配置验证、LIVE/DISABLED 日志、依赖和镜像扫描。
- 生产区域、跨境传输、DPA、隐私声明与删除入口在上线前批准。

### 10.2 可靠性

- BFF 与 Hermes `/health`/`/ready` 分离。
- SIGTERM 时停止接收新 run、等待/取消进行中 run、刷新状态后退出。
- 外部调用设置 timeout、bounded retry、jitter；只有幂等操作自动重试。
- 写操作使用 Idempotency-Key/outbox；客户端重试不重复创建 Lead/报告。邮件遵循已声明的 delivery policy，并以 delivery ledger 检测/解释可能重复。
- 外部依赖按 bulkhead 隔离；聊天、报告、采集不共享无限并发池。
- 模型/知识服务故障时 fail closed：展示联系表单，不生成无来源答案。
- 数据采集使用 raw snapshot + run ledger，可重放、可定位部分失败。

### 10.3 可观测性

建议指标：

- chat requests / active sessions / handoffs / completion rate。
- TTFT、完整响应延迟、MCP latency、model latency。
- token/会话、成本/来源、配额余量。
- grounded/拒答/反馈/低置信度比例。
- lead created/delivered/sync failure。
- ingestion lag、source errors、queue depth、dead letters。
- estimate error by category/version。
- supplier recommendation acceptance/override。
- route recommendation acceptance、ETA error、event lag。

每个外部调用携带 requestId/traceId；不把秘密和完整 Prompt 写入日志。

### 10.4 测试层次

1. **纯函数单测**：成本、评分、约束、状态机、projection。
2. **Adapter contract**：Hermes、乐享、模型、数据源、承运商 sandbox。
3. **集成测试**：BFF + 数据库 + fake external services。
4. **并发测试**：takeover/run completion、矩阵发布、任务认领、幂等。
5. **AI evaluation**：固定问题集、引用、拒答、泄露、prompt injection。
6. **E2E**：Widget、表单、销售接管、PDF、dashboard。
7. **部署 smoke**：固定 releaseId、健康、工具负向列表、secret 未进入静态产物。
8. **故障演练**：Hermes/乐享/模型/SMTP/DB/队列不可用、超时、429、重启。

---

## 11. 架构模式摘要

详细决策见 [ADR-001](./ADR-001-HERMES-LEXIANG-CONTROL-PLANE.md)。核心模式：

- BFF：浏览器只面对项目自有合同。
- Anti-Corruption Layer：Hermes、乐享、模型、数据源、承运商 payload 不进入领域模型。
- Gateway Offloading：TLS、WAF、认证、基础限流在入口；业务授权仍在服务内。
- Bulkhead/Throttling：聊天、采集、报告、优化相互隔离并有配额。
- Async Request-Reply：PDF、采集、复杂优化通过 job 状态完成。
- Queue-Based Load Leveling + Competing Consumers：平滑外部 API 与模型调用。
- Pipes and Filters + Claim Check：原始大文件放 COS，消息只传引用；每步可重试。
- Quarantine：外部文件/数据未验证前不进入发布/评分集。
- External Configuration Store：模型、权重、阈值版本化；秘密放 Secret Manager。
- Health Endpoint Monitoring + Static Content Hosting。

首版明确不使用：完整 Event Sourcing、CQRS、分片、Multi-Agent 自动采购/物流、自动下单。

---

## 12. 组合排期

### 12.1 团队假设

- Tech Lead/Architect：0.5–1 FTE。
- CloudBase/TypeScript Backend：2 FTE。
- Python/Data/Hermes：1–2 FTE。
- Frontend：1 FTE。
- QA/Automation：0.5–1 FTE。
- Data/Product Analyst：1 FTE（趋势开始后）。
- Sales、Cost Engineer、Procurement、Logistics SME：各 0.2–0.5 FTE。

有效工程产能按 4–5 FTE 计算，已考虑会议、评审、部署、缺陷和外部 onboarding。

### 12.2 最早情形时间线（假设 2026-07-27 启动）

以下日期是外部 Gate 按时关闭的 earliest-case，不是合同承诺。Trend 只有在数据使用条款、凭证和 sandbox ready 后进入 T1；Logistics 只有在 carrier/forwarder onboarding 和字段使用条款签字后进入 L1/L2。工程持续时间与不可控外部 lead time 分开跟踪。

| 阶段 | 日期 | 交付 | 并行条件 |
|---|---|---|---|
| Phase 0 架构/数据 Gate | 2026-07-27 ～ 08-07 | D1–D11、数据分类、Hermes pin、公开 KB、PG/CAS preflight、生产区域决定 | 所有后续基础 |
| Phase 1 Chat Pilot | 2026-08-10 ～ 09-04 | 受控 BFF、Hermes CloudRun、Widget SSE、公开 FAQ | C1/C3/C4 并行 |
| Phase 1B Handoff Production | 2026-09-07 ～ 09-25 | conversations/leads/sales queue/CAS hard stop/监控 | D3/D5 必须完成 |
| Phase 2 Estimator MVP | 2026-08-31 ～ 11-06 | 成本矩阵、Wizard、Lead、PDF、Email、校准 | 与 Chat 后半并行；D7 |
| Phase 3 Trend MVP | 最早 2026-09-14 起，10–16 周 | 手工 + 1–2 获批源、评分、审核、周报 | D8/数据合同/sandbox ready |
| Phase 4 Supplier MVP | 2026-10-05 ～ 2027-02-19 | 主数据、硬约束、多目标排序、采购审批 | S0 可提前开始 |
| Phase 5 Logistics MVP | 最早 2027-01-04 起，16–24 周 | 手工货代 + 1 carrier、方案、tracking/replan、审批 | D10/条款/账号/sandbox ready |
| Phase 6 综合硬化 | 所有 MVP 后 6 周 | SLO、成本、灾备、权限审计、跨模块 E2E、运营 handover | 所有 MVP |

### 12.3 总量

| 范围 | 工程人周（估算） | 日历时间 |
|---|---:|---:|
| 共用基础/控制平面 | 12–20 | 分散在各阶段 |
| 客服（已有 PoC 后增量） | 22–38 | 6–8 周 |
| 估价器 | 19–32 | 8–12 周 |
| 趋势 MVP | 22–37 | 10–16 周 + 合同等待 |
| 供应商 MVP | 29–49 | 14–22 周 |
| 物流单源 MVP | 31–51 | 16–24 周 + onboarding |
| **五项能力原始相加（客服+估价+趋势+供应商+物流）** | **123–207** | 非串行日历和 |
| **规划组合范围（扣除已在各模块重复计算的 shared auth/lead/ops 约 10%；待 MIU 预算确认）** | **111–186** | **最早 9–12 个月并行 + 外部等待** |
| V1 多源/规模化/持续校准 | 额外 45–80 | 总计 12–18 个月 |

`共用基础/控制平面 12–20` 是对重复预算的可见性说明，**不再额外加到组合总量**；它已经分摊在 C/E/T/S/L 工作包中。10% 扣除只是 roadmap 级假设，进入实施前必须由技术 MIU bottom-up 预算替换。估算区间的最大风险来自**数据准备与外部审批**，而不是大模型接线。

### 12.4 关键路径

1. 公共知识库内容与权限。
2. Hermes 工具面收窄和 BFF 密钥边界。
3. 人工接管状态机与销售工作位置。
4. 成本规则/历史案例准备。
5. 众筹/电商数据许可。
6. 供应商主数据完整度。
7. 物流合同/API onboarding 与数据使用条款。

---

## 13. 发布策略

### Release A：AI 客服 Pilot

- 仅获批公开页面。
- 仅公开知识库。
- 无内部工具、无自动报价。
- 灰度 10% → 50% → 100%。
- 每日查看未知问题/低评价，知识 owner 修正。

### Release B：Estimator + Leads

- 先仅一个品类和一个货币。
- 标明非正式报价、版本、假设与有效期。
- 每周对比人工报价，达到误差门槛后再扩品类。

### Release C：Internal Intelligence

- 趋势、供应商、物流先仅内部用户。
- 所有推荐都需要人工批准。
- 达到数据质量和采纳率后，才选择性向客户 Portal 暴露摘要。

### Release D：Client Portal

- 只公开客户自己的项目/文件/进度。
- 与公共客服知识域严格分离。
- 另行进行 tenant/RLS、认证、审计和数据驻留设计，不能从公开 Widget 直接扩展。

### Release E：Teardown Lab + Newsletter

- CMS、BOM/风险/SEO 字段、列表/详情页和编辑审批。
- Newsletter 双重确认、退订、ESP adapter、consent audit。
- 趋势系统可提供草稿信号，但发布内容必须人工审核。
- 本次 123–207 人周合计不包含该 Release；需独立估算。

### Release F：Concept Incubator + 3D/AR

- Concept CMS、Target Retail/Ex-work/MOQ 与 partnership tiers。
- `.glb/.gltf` 存储、lazy viewer、性能预算与移动端 AR feasibility spike。
- 本次 123–207 人周合计不包含该 Release；需独立估算。

---

## 14. 不应写进合同的表述

| 原营销表述 | 可验收改写 |
|---|---|
| 自动监测全球众筹与电商数据 | 按已授权数据源和配置频率采集；每条洞察显示来源、时间与覆盖 |
| 秒级生成精准 BOM | 在已支持品类和参数范围内，以版本化成本矩阵秒级生成非约束区间及假设 |
| 自动匹配东莞最优供应商 | 在已审核供应商池中，根据项目约束和批准权重生成可解释候选排序 |
| 即时优化全球物流 | 在已接入承运商/货代数据新鲜度范围内重算路线建议，执行前人工批准 |
| 24/7 AI 客服 | 系统 24/7 可用目标；只回答获批知识，未知问题拒答/转人工 |

---

## 15. 下一步 Gate

### 可立即开始，不需要再研究产品名

1. 固化本地 Hermes PoC 的版本和 smoke。
2. 建立独立的乐享公开客服知识空间和只读 Token。
3. 决定生产区域、数据保留和销售接管位置。
4. 设计 Chat BFF API 与状态机测试。
5. 把现有 Widget 迁为站点 Island，但先连接 mock BFF，不把 Key 写前端。

### 在 Gate 前不要开始

- 未确定公开/内部知识隔离前，不部署公网 Hermes。
- 未完成工具负向验收前，不开放 Hermes API。
- 未批准成本矩阵前，不向客户显示任何估价。
- 未签数据源合同前，不开发平台 scraping。
- 未确认物流条款前，不保存或比较承运商费率。
- 未实现 CAS 与竞态测试前，不宣称真人接管会自动停止 AI。

---

## 16. 主要来源（检索于 2026-07-16 ～ 2026-07-21）

### Hermes / 本地实现

- Nous Research Hermes Agent：https://github.com/NousResearch/hermes-agent
- Hermes API Server：https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server
- Hermes releases：https://github.com/NousResearch/hermes-agent/releases
- 本地已运行原型：用户提供的 `ai-floating-widget` 包（`SKILL.md`, `widget.js`, `.env.example`, `config.yaml.example`）。

### 腾讯

- Tencent Cloud ADP 产品概述：https://cloud.tencent.com/document/product/1759/104193
- ADP HTTP SSE：https://cloud.tencent.com/document/product/1759/129202
- ADP 应用运营：https://cloud.tencent.com/document/product/1759/104210
- 腾讯乐享：https://lexiang.tencent.com/
- 乐享开放 API：https://lexiang.tencent.com/wiki/api/
- 乐享 AI 问答：https://lexiang.tencent.com/wiki/api/40000.html
- 乐享 AI 搜索：https://lexiang.tencent.com/wiki/api/40004.html
- CloudBase：https://docs.cloudbase.net/
- CloudBase PostgreSQL transaction FAQ：https://docs.cloudbase.net/database/configuration/db/postgresql/faq

### 市场/物流数据

- Google Trends API alpha：https://developers.google.com/search/blog/2025/07/trends-api
- eBay Browse API：https://developer.ebay.com/api-docs/buy/browse/overview.html
- Amazon Product Advertising API（已公告 2026-05-15 弃用并迁移 Creators API）：https://webservices.amazon.com/paapi5/documentation/
- DHL MyDHL API：https://developer.dhl.com/api-reference/mydhl-api-dhl-express
- DHL Unified Tracking：https://developer.dhl.com/api-reference/shipment-tracking
- Maersk Integration Hub：https://integration.maersk.com/apis

---

## 17. 最强反对意见与回答

### “乐享本身已经有 AI 问答，为什么还需要 Hermes？”

如果永远只做知识问答，`Widget → BFF → 乐享 AI 问答` 的确更简单、攻击面更小。选择 Hermes 的理由是本地 PoC 已验证，且未来需要受控工具、模型替换、工作流与统一 Agent 层。为避免无谓锁定，BFF 应定义 `ConversationEngine` 接口，Hermes 为首个实现，保留直接乐享/ADP adapter 的替换能力。

### “为什么不把 BFF 去掉，浏览器直接打 Hermes？”

因为浏览器无法保守长期 Bearer Key，也无法可靠实施销售接管、会话所有权、PII、限流和审计。直接调用只适合本地 PoC。

### “Hermes 是第三方开源，是否增加风险？”

是。缓解方法是固定 release/digest、最小工具面、私网、负向工具合同、依赖/镜像扫描、可回滚，并让业务状态留在 CloudBase。若风险不可接受，可切换 ADP 或直接乐享，而不改变 Widget/BFF/业务数据合同。

### “能否更快？”

客服 Pilot 可以；完整平台不能靠删测试压缩。最快安全路线是：先交付知识库客服与 Lead，估价器聚焦一个品类，趋势先用人工导入 + 一个合法源，供应商/物流先内部试点。数据合同和主数据清洗不能被代码并行度替代。
