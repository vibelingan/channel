# 代码及设计依据

核对日期2026-10-23。只读源码/本地文档与官方文档，没有登录客户账号、运行真实业务测试或确认当前WeCom部署版本。

本文件保留最初设计核对的来源。后续SG1.0已比较远端main与Phase 2并完成逐入口复核，当前实现参考及44份源码清单见[SG1.0复用结论](SG1.0-BASELINE.md)。其中正式单品询盘在main也已具备，旧模拟组件不能一概归为当前正式入口；本表不作为线上启用证明。

## 工作区和保存边界

| 对象 | 分支/提交 | 解释 |
|---|---|---|
| 原Channel工作区 | feat/ai-assistant-platform-design / 03be923c0d7f8cf0f8bfa86a9f8224ba07315f17 | 有别人的未提交文档及.cloudbase/output，保持原样 |
| 新销售worktree | feat/sales-agent-modular-design，自03be923c创建 | 初始设计后已新增独立sales-contracts及其CI；无合并/搬运产品代码 |
| 较新Phase2参考 | origin/feat/ai-assistant-phase2 / a7e16aa2c89792cbb3fe49f9330848aea0b05405 | 用git show读取；不是当前worktree中已有的全部功能 |
| Hermes本地参考 | /Volumes/Lexar-Mac/Projects/hermesinfra，feat/react-router-scaffold / ff066b12a52fbc435478bf6d1de3cfba68933e20 | 有现成任务基础；未证明与运行部署相同 |

原稿副本及哈希见[source-manifest.json](source-manifest.json)。历史产品价格不在这轮重新报价，不作为2026-10-23承诺。

## Channel核对

下表Phase2路径/行号均针对a7e16aa2，可用`git show a7e16aa2:<path>`读取，不能套用03be923c行号。

| 证据 | 观察与判断 |
|---|---|
| Phase2 `docs/ai-assistant-phase2/SPEC.md:24-30`、`PLAN.md:170-173,286-289` | 客服准备，访客确认提交；不附conversation id、不自动串联完整对话 |
| Phase2 `apps/site/src/pages/products/item.astro:26` → `SkuDetailPage.tsx:40-49` → `SharedDetailPreview.tsx:88-89` | 新产品页普通模式接真实提交transport；DEV preview才本地模拟 |
| Phase2 `apps/site/src/catalog/application/public-quote-transport.ts:7-18` | POST /api/catalog-quote-requests |
| Phase2 `apps/functions/public-api/src/catalog-quote-http.ts:24-68` | enable/Origin/大小/JSON等入口保护 |
| Phase2 `packages/db/src/catalog-inquiry-cloud.ts:26-73`、`catalog-quote.ts:37-82` | 事务/幂等/限流、批准revision/variant及服务端产品快照；不重写 |
| Phase2 `apps/site/src/islands/shop/InquiryForm.tsx:30-35`及其cart/legacy/overstock调用 | 旧模拟路径残留；应逐路由盘点，不能统称已全部连通 |
| Phase2 `apps/functions/admin/src/handler.ts:570-572,614-629`及`InquiryDetailPanel.tsx:193-195` | 后台跟进记录不发邮件；notification disabled |
| Phase2 `packages/db/src/catalog-inquiry.ts:134-178` | 业务status/备注/操作历史及并发版本控制已存在；后台操作人可completed/closed |
| SG1.0主线 `apps/functions/admin/src/handler.ts:1088-1226` | OEM保存、附件激活/失败补偿、best-effort确认信；按固定main提交校正定位，详细失败窗口见SG1.0 |
| `packages/email/src/index.ts:20-75,116-121` | SMTP缺配置不发送；失败返回false。未见询盘邮件持久发送账、收信/审批；模板含24小时回复承诺 |
| Phase2 `packages/ai-store/src/migrations/001_ai_assistant.up.sql:114-141`及`apps/ai-worker/src/worker.ts:263-268` | 有leads/部分outbox枚举不代表已实现销售处理；worker只处理start/cancel，其他handler未配置 |
| Phase2 `CLIENT-ANSWERS-2026-10-12.md:89-107,177-189`，`PLAN.md:298-303` | IMAP/SMTP/Channel审阅及“销售脑留Channel”是旧建议；被本轮Resend/Hermes业务方向替代 |

以上测试文件存在且本轮只读过，不报告为本轮执行通过。没有改变公开客服架构规范或其他人未提交的设计。

## Hermes核对

| ff066b12 路径/行号 | 观察及设计含义 |
|---|---|
| `deploy/hub/hub_server.py:1303-1352` | 定海规划/任务和子任务派发可复用 |
| `deploy/hub/hub/assignments.py:55,110,148`及`hubkit/outbox.py:21` | assignment状态、派发及事务outbox可复用 |
| `deploy/hub/hub/dispatcher.py:104,158,211,252` | 租约、退避、死信可复用；至少一次不等于外发一次 |
| `deploy/hub/hub/registry.py:77`、`hubkit/messaging.py:27` | 能力/全局定海查找未按客户收敛；Sales需客户固定路由 |
| `deploy/docker-compose.yml:43,93,138` | 卷按角色声明，不证明多客户运行隔离 |
| `deploy/agent/agent_server.py:557,1011-1023,1597` | 知识workspace存在提示词/分支路径，不能替代服务端授权 |
| `deploy/agent/agent_server.py:1553-1583` | 共享目录按时间窗收成果，不直接用于敏感报价；未实测复现泄漏 |
| `deploy/hub/hub_server.py:2982-3015` | 当前文章确认词选择最新pending_review，没有邮件收件人/版本绑定；保留其他文章业务 |
| `deploy/hub/hub/state_machine.py:35`、`hubkit/taskqueue.py:125,157` | 取消排队/状态不证明能撤回已发出的provider请求 |
| `deploy/hub/hub_server.py:3177,3212,3294,3371` | 当前门户有客户归属检查，不能沿用历史审查称SSE校验完全没修 |
| `web/app/routes.ts`、`layouts/portal-layout.tsx`、`styles/tokens.css`、`adapters/hermes/session.ts` | 现有SPA服务客户门户，运营台仍旧界面；审核页应复用portal壳，补个人操作人身份 |

不复用公开托管社媒素材的预览路径来暴露私有询盘附件。没有读取真实env、secret文件或客户数据。

## 本轮新增与状态

新增的是9个模块的设计、接口与状态合同、执行DAG和交接、可校验样例及模块图。文档与图的检查结果单独记录；不等于实现、测试部署或客户环境联调完成。原始工作区受保护文件哈希会在结束前再次比较。
