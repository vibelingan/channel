# ADR-001: Hermes + 腾讯乐享 + CloudBase 控制平面

- **日期：** 2026-07-21
- **状态：** Proposed — 需完成 G2 blockers 后批准
- **阶段：** HLD
- **作者：** Architecture research / cloud-design-patterns audit

## Context

网站需要一个覆盖公开页面的悬浮式 AI 客服，回答 MOQ、Price、Lead Time、Certificate、OEM Available 等知识问题，将对话/线索同步销售，并在真人接管时硬停止 AI。用户已经提供一套本地跑通的原型：浏览器 Widget 调用 Nous Research Hermes Agent 的 `/v1/chat/completions`，Hermes 使用 DeepSeek 并通过腾讯乐享 MCP 检索知识。

同一平台后续还要承接估价、趋势、供应商和物流能力，因此既要保留 Agent 扩展性，又不能让公共浏览器获得 Hermes/乐享密钥或 Hermes 默认的终端、文件、浏览器、代码执行等完整工具面。

## Decision

采用三层控制：

1. **CloudBase/CloudRun Chat BFF** 是唯一公网聊天入口，负责匿名身份、会话所有权、消息、限流、同意、PII、线索、销售权限、人工接管和事件过滤。
2. **Hermes Agent 专用客服服务** 运行于受控 CloudRun 容器，只接受 BFF 调用；固定 release/digest；使用独立 profile；实际工具面只允许腾讯乐享只读知识工具。
3. **腾讯乐享独立公开客服知识空间** 是知识真相源，Token 只允许读取该空间；内部成本、供应商、客户、合同和未发布内容与其物理/权限隔离。

业务会话、接管状态和线索以 AI Operational PostgreSQL 为真相源。Hermes 的 SQLite/Responses state 不作为业务一致性来源。BFF 使用受控 `pg` 连接池执行条件更新/事务；现有 NoSQL 继续承载既有 CMS/auth/OEM/media。BFF 抽象 `ConversationEngine`，保留未来切换为“直接乐享 AI 问答”或 Tencent Cloud ADP 的能力。

`/api/admin/ai/*` 也由 Chat BFF 独占，不由现有 generic Admin API 写 PG。BFF 验证共享 JWT 后逐请求回查 NoSQL `users` 行，保持删除/暂停/升降角色立即生效，再以 `users._id` 执行 PG 的 assigned-to-self/admin 授权。

### Supersedes / preserves earlier design

- 本 ADR **取代** [docs/AI_PLATFORM_DESIGN.md](../AI_PLATFORM_DESIGN.md) §2 的客服 runtime、§3.2、§3.4 的 chat Lead 规则、§4 的 chat Email gate，以及 §5 A3 客服实现路线；原因是 Hermes + 乐享 PoC 已实际跑通。
- Tencent Cloud ADP 与 CloudBase Agent SDK 是两个不同备选。本次均未选择：ADP 保留托管 fallback；CloudBase Agent/AG-UI 保留未来 adapter 选项，但没有本地 PoC 优势。
- 早期设计关于确定性估价、Lead 汇聚、PII、限流和人工接管持久状态的原则继续有效。
- Estimator/报告摘要等**非 Hermes** AI workload 仍需在 Phase 0 检查 CloudBase Token Credits/模型启用，或明确改走其它获批模型端点。

## Alternatives

| 方案 | 优点 | 缺点 | 决定 |
|---|---|---|---|
| Tencent Cloud ADP 标准模式 | 最快 PoC；内置 RAG、评测、运营、日志、发布 | 平台绑定；定制接管/现有 Admin 仍需 BFF；放弃已验证 Hermes 路线 | 保留 fallback |
| CloudBase Agent SDK + AG-UI | 腾讯 CloudBase 原生部署与 AG-UI 协议；可自定义 LangGraph/LangChain | 尚无本项目本地 PoC；仍需知识源、BFF 接管与运营能力 | 保留 adapter 备选 |
| Widget → BFF → 乐享 AI 问答 | “知识库 only”最简单；乐享已支持 SSE/引用/匿名公开知识 | Agent 工作流/模型切换/未来工具扩展较弱 | 可作为降级 adapter |
| Widget → Hermes 直连 | 与本地 PoC最接近 | 浏览器泄露 Key；无法可靠做接管/PII/限流；默认工具极危险 | 拒绝 |
| Widget → BFF → Hermes + 乐享 | 已有 PoC；控制力强；未来可扩展工具/模型 | 需要自运维 Hermes；版本变化快；工具面必须负向验收 | **选择** |
| 自建 RAG/vector stack | 完全控制 | 重复乐享能力；数据/检索/评测成本最高 | 当前拒绝 |

## Patterns Selected

| Pattern | 为什么选择 | 接受的代价/硬约束 |
|---|---|---|
| Backends for Frontends | 浏览器需要稳定的项目自有 API，不应直接依赖 Hermes/乐享协议 | BFF 不承载供应商业务逻辑；仅适配与控制 |
| Anti-Corruption Layer | Hermes、乐享、模型、承运商 payload 变化快 | 每个外部系统维护 adapter 与 contract test |
| Gateway Offloading | TLS、WAF、基础认证、CORS、边缘限流统一处理 | 业务授权仍由 BFF 执行，不能下放给 gateway |
| Bulkhead | 聊天、PDF、采集和优化不能共用无限并发 | 每类任务有独立队列/并发/配额 |
| Rate Limiting | 公网聊天和模型成本有明显滥用面 | 边缘 + BFF per-IP/per-session/global；`429 + Retry-After` |
| Throttling | 配额耗尽时应降级而非拖垮服务 | 明确向客户端展示重试/转人工状态 |
| Health Endpoint Monitoring | BFF、Hermes、MCP、模型均可能独立故障 | liveness 不鉴权；readiness 只返回安全状态 |
| Async Request-Reply | PDF、采集、优化可能超过普通 HTTP 时间 | job status/SSE/通知；不假设同步完成 |
| Queue-Based Load Leveling | 平滑模型、邮件、数据源和 carrier 限额 | 监控 queue depth/age；必须有 DLQ/replay |
| Competing Consumers | 采集/报告可水平消费 | handler 必须幂等；任何 consumer 都可重试 |
| Pipes and Filters | 采集要分 raw、validate、normalize、score、summarize | 每步独立状态/测试；不能把大 Prompt 当流水线 |
| Claim Check | 原始文件/大 payload 不进入消息队列 | COS 引用与对象 TTL/权限一致 |
| Scheduler Agent Supervisor | 多步 job 需要持久化进度与失败恢复 | 工作流状态不能仅在进程内存 |
| Cache-Aside | 公开 FAQ/只读元数据可减少外部调用 | 明确 TTL、版本和写后失效；不缓存秘密/PII |
| Retry | 外部服务存在瞬时网络错误 | 仅幂等操作；指数退避+jitter；写操作有幂等键 |
| External Configuration Store | 模型、阈值、评分权重需环境/版本化 | Secret 不进入配置库；使用 Secret Manager/env |
| Static Content Hosting | Astro 与静态素材继续 CDN | 需要缓存失效/退役文件 prune 策略 |
| Quarantine | 外部文档/数据可能恶意、损坏或未授权 | 验证失败记录 hash；未通过不可发布/评分 |
| Valet Key | 大文件继续直传对象存储 | URL 最小权限、短 TTL、用途/大小限制 |

## Patterns Considered and Rejected for MVP

| Pattern | 拒绝原因 |
|---|---|
| CQRS | MVP 读写规模未证明需要分离模型；增加同步复杂度 |
| Event Sourcing | 需要审计但不需要从事件重建全部状态；使用 append-only audit 即可 |
| Saga | 当前核心流程可用持久 job + outbox + 幂等完成；无必要引入完整分布式 saga |
| Circuit Breaker | 多实例共享 breaker state 需要 Redis/DB；MVP 先用 timeout、bulkhead、配额和 fail-closed fallback；若引入必须共享状态 |
| Leader Election | 没有必须单 leader 的任务；scheduler/job claim 在存储层完成 |
| Sharding | 数据规模未到，且 shard key 不应过早锁定 |
| Priority Queue | 首版队列量未证明；先按工作负载 bulkhead；有 SLA 分层后再引入防饥饿策略 |
| Publisher-Subscriber | 首版用 outbox/job 已足够；跨域订阅增加运维面 |
| Choreography | 关键销售/报价流程需要可见编排与恢复，不应散落隐式事件 |
| Gateway Aggregation | BFF 已有明确客户端边界；无需另一层聚合 |
| Sidecar/Ambassador | 当前流量和部署不需要独立代理；避免多一个故障点 |
| Strangler Fig | 不是遗留系统迁移；现有站点保留并增量扩展 |
| Deployment Stamps/Geode | 尚无多租户/多区域规模；先解决生产区域和数据驻留 |
| Federated Identity | 销售暂复用现有 JWT；未来接企业 SSO 时另做 ADR |
| Compute Resource Consolidation | BFF 与 Hermes 安全/运行特征不同，不合并进一个容器 |

## Human Handoff Consistency Decision

> **部分废止 / Partially superseded (2026-08-13).** 本节关于 `engineRunId`
> "条件登记" 的形状已被
> [CHANNEL_AI_ASSISTANT_ARCHITECTURE.md](./CHANNEL_AI_ASSISTANT_ARCHITECTURE.md)
> §8 与 [LLD-001](./LLD-001-HUMAN-TAKEOVER-STATE-MACHINE.md) §5 取代：`engineRunId`
> 改为 **write-once 无条件记录**，只有 run 的串流授权仍受 epoch fence 约束。
> 原因是条件登记会在最需要该指针停止外部 run 的时刻把它丢弃。本节其余内容
> （CAS、事件顺序、fence、禁止 `res.write()` 等）仍然有效。
>
> This section's *conditional registration* shape for `engineRunId` is superseded
> by architecture §8 and LLD-001 §5: the id is recorded write-once and
> unconditionally, and only the authorization to stream is fenced. Everything
> else in this section still stands.


`conversation.status` 和 `modeVersion` 是控制权真相源。接管必须在 PostgreSQL 使用单条条件更新或事务完成：

- `BOT_ACTIVE/HANDOFF_REQUESTED → HUMAN_ACTIVE`
- 同一事务 `modeVersion + 1`、记录销售与时间
- 生产通过 outbox worker 调用 Hermes Runs API；内部 run 先进入 `CREATING(operationId, version)`，再条件登记 `engineRunId`
- 外部 create 使用固定版本已验证的 operation idempotency；登记失去 version fence 时立即停止，崩溃由 reconciler 重放并登记/停止
- AI token、handoff 与最终 message 都先在持有 conversation row lock 的 PG 事务中 append 为单一 `conversationEvents.sequence`
- SSE dispatcher 只发送已提交的顺序事件；`handoff.started` 线性化后旧 version 事件无法 append，客户端过滤只是 defense-in-depth

条件形态至少包含 `SELECT ... FOR UPDATE` 或 `UPDATE ... WHERE status IN (...) AND mode_version = expected RETURNING ...`，并在同一事务写 conversation event 与 cancellation outbox。worker 幂等调用 `/v1/runs/:runId/stop`；assistant message 也使用条件 event append。禁止“先读状态、再 `res.write()`/普通 update”或只通过 Prompt 停止。CloudBase PostgreSQL SDK 不直接提供完整 transaction API，因此 BFF 使用 `pg` 协议，或将逻辑封装为数据库 RPC；具体路径必须在目标环境 live-verify。

## Security Decision

- Hermes Key、乐享 Token、模型 Key 永不进入静态产物或浏览器。
- Hermes 不公开 CORS；仅 BFF origin/内网访问。
- 生产 profile 不启用 `hermes-api-server` 默认完整工具集。
- 使用 `/v1/toolsets` 对实际工具做 allowlist + denylist 合同测试。
- 乐享只读 Token 只覆盖 Public 客服知识空间。
- Markdown 消毒、CSP、输入验证、限流、token/turn 上限。
- 日志默认不写完整 transcript/Prompt/PII/工具返回。

## Operational Decision

- 固定 Hermes release + image digest；升级先过 contract/eval/canary。
- BFF 和 Hermes 独立扩缩容。Pilot 中 Hermes 单实例，业务历史存 CloudBase。
- Hermes stop 失败时，PG conversation-event fence 仍阻止旧 token/message 在线性化的 `handoff.started` 后越过公网与落库。
- 模型/乐享不可用时 fail closed，显示询盘/人工入口。
- 每个第三方 integration 启动时输出安全的 `LIVE`/`DISABLED` 状态并进入 readiness。

## Consequences

### Positive

- 复用已跑通 PoC，最快进入业务验证。
- 公共攻击面与 Hermes 强能力隔离。
- 真人接管由存储状态保证，而不是依赖模型服从。
- 乐享继续承担知识管理；不重复建设 vector/RAG 后台。
- BFF contract 允许未来替换 ADP/直接乐享，不锁死 UI 和业务状态。

### Negative

- 自运维 Hermes 容器、版本和安全补丁。
- 多一个服务边界与网络 hop。
- 需要额外的状态/竞态/E2E/故障测试。
- Hermes 快速迭代，配置语义必须在固定版本上持续验证。

## G2 Blockers

- [ ] 固定 Hermes release/image digest，并在该版本验证实际 `/v1/toolsets` 只有获批乐享只读工具。
- [ ] 建立独立的乐享 Public 客服知识空间及 read-only MCP Token；证明内部空间不可访问。
- [ ] 确认销售接管工作位置、角色和消息通道。
- [ ] 批准聊天 consent、PII、transcript 保留/删除和生产数据区域。
- [ ] 确认模型供应商与数据处理条款、月度预算和配额告警。
- [ ] 完成人工接管 CAS 设计和并发测试计划。
- [ ] 在固定 Hermes 版本证明 Runs create 的 Idempotency-Key/operation-ID 重放语义；否则实现持久化 create mapping adapter。
- [ ] 完成 AI Operational PostgreSQL 网络/凭证/连接池 preflight，并 live-verify 条件更新与回滚。

**G2 BLOCKED: 上述八项未关闭前，不批准公网生产发布。PoC/隔离 staging 可继续。**

## Review Triggers

出现任一条件时重开 ADR：

- 放弃 Hermes 改用 ADP/直接乐享。
- Hermes 需要多实例共享运行状态。
- 公共 Agent 获得任何写工具或内部数据工具。
- 引入客户 Portal/多租户项目数据。
- 生产区域/数据驻留改变。
- 自动执行正式报价、供应商下单或物流订舱。
