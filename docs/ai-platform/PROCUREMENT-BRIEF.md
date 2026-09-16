# AI Assistant — What to buy, and why

**For:** the architect / whoever approves spend
**Last updated:** 2026-08-25 (live environment and runtime health rechecked)
**Environment inspected:** `diversity-123-d9grnqfux221323bb` (ap-shanghai), plan
标准版 `baas_pf_standard`, prepaid to 2027-07-31

Live-resource status and the SSE result were measured against the environment.
Pricing and platform capabilities are reported from Tencent's current official
documentation. Future usage, account eligibility and production sizing remain
explicit assumptions or open decisions.

## Status at a glance

| # | Item | Status | Spend |
|---|---|---|---|
| 1 | CloudRun (云托管) | Platform activated; SSE was proven 2026-08-17, but `ai-probe` returned 503 on 2026-08-25; production services not deployed | Usage-based; existing-point coverage is unknown until load and bill measurement |
| 2 | Database | PostgreSQL design retained; **no long-term instance purchased during local development** | Docker/CI now; temporary pay-as-you-go TencentDB for cloud integration; long-term instance at pilot gate |
| 3 | Lexiang public space + scoped MCP serving credential | Outstanding | Confirm current licence and K1-K5 contract; do not assume zero cost |
| 4 | Hermes HTTP API, restricted + pinned | Outstanding | Hosting and operations cost depends on isolation decision |
| 5 | zenmux key + spend cap | Outstanding | Usage-based |

**No long-term infrastructure purchase is required for local development.** The
next commercial action is a pay-as-you-go TencentDB integration window, followed
by a production quote only after measured sizing. Hermes hosting and model usage
remain separate operating-cost decisions.

---

## What we already have and pay for

| Thing | State |
|---|---|
| CloudBase environment | 标准版, paid, prepaid to 2027-07-31, credits deduction, QPS quota 500 |
| Cloud functions | 3 live: `admin`, `public-api`, `alibaba-catalog-sync` |
| Databases enabled | NoSQL ✅ · PostgreSQL ❌ · MySQL ❌ |
| CloudRun (云托管) | Activated 2026-08-16; historical SSE proof retained; current `ai-probe` health failed with HTTP 503 on 2026-08-25 |
| Storage + static hosting | Active |

---

## Item 1 — Somewhere to run the assistant's server

**Status: platform capability proved historically; current probe unhealthy.**
Activated by the owner on 2026-08-16 and verified then by deploying a throwaway
service end to end. A read-only recheck on 2026-08-25 found the control plane
still reporting `normal`, while the public HTTPS endpoint timed out once and
then returned HTTP 503 after scale-from-zero. Production BFF/worker deployment
and current runtime health therefore remain open.

**Why this runtime was selected.** The website's three existing services are
Event Functions and cannot be reused in place as the assistant BFF/worker. A new
CloudBase Web/HTTP Function can technically stream in supported runtimes, and
the platform documents function timeouts up to 900 seconds. Therefore CloudRun
is not the only possible Tencent runtime.

CloudRun is the selected runtime for the full design because it gives the
BFF and long-lived engine workers independent deployment, container parity,
streaming lifecycle control, VPC TCP access to PostgreSQL, resource limits,
scaling and failure isolation without changing the existing functions. This
decision is closed for implementation: future agents use local Docker Compose
as the development substitute and do not reopen runtime selection. Any proposed
replacement requires a new architecture decision with equivalent evidence.

### What was measured, not assumed

A throwaway service (`ai-probe`) was deployed to the real environment and tested:

| Check | Result |
|---|---|
| Deploy succeeds | ✅ Service live at `https://ai-probe-298020-11-1443560658.sh.run.tcloudbase.com` |
| Time to first response | ~120s (the service object exists before its first version builds; a 404 in that window is normal) |
| Plain HTTP | ✅ `HTTP 200` |
| **Streaming (server-sent events)** | ✅ **Works.** `content-type: text/event-stream`, `transfer-encoding: chunked`, `cache-control: no-cache`; events arrived incrementally with multi-line frames and UTF-8 intact |

The table above is dated 2026-08-17 evidence. On 2026-08-25 the same service was
still configured as function mode, 1 CPU / 2 GiB, min 0 / max 5, with no
VPC/subnet attachment and public egress enabled; its public endpoint returned
503. Keep the historical gateway/SSE capability result, but do not cite this
service as currently healthy until its runtime failure is diagnosed or it is
replaced by the real BFF.

**Why the streaming result matters most.** It was the riskiest unproven
assumption in the entire design — streaming that dies quietly behind a proxy
looks fine in development and fails in production. It is now settled by
measurement rather than hope.

### Cost model

The published resource-point table currently shows:

- CPU: `0.055 yuan / core-hour` (`55 points / core-hour`).
- Memory: `0.032 yuan / GiB-hour` (`32 points / GiB-hour`).
- Internet egress: `0.8 yuan / GB`.

At 730 hours/month, compute-only examples are:

| Configuration | If one instance runs continuously | Resource points/month |
|---|---:|---:|
| 0.25 core + 0.5 GiB | about `21.72 yuan/month` | about `21,718` |
| 0.5 core + 1 GiB | about `43.44 yuan/month` | about `43,435` |
| 1 core + 2 GiB | about `86.87 yuan/month` | about `86,870` |

This does **not** imply a fixed monthly bill. CloudRun supports `minNum=0`, so a
low-traffic service can scale to zero and consume less compute, at the cost of a
cold start. A continuously warm production instance uses the full monthly
amount. Logs, outbound traffic, multiple services/replicas, and other resources
are additional. The Standard plan publishes a shared compute-resource allowance,
but this project must confirm on the actual bill whether these CloudRun points
deduct from that allowance and how much the existing workloads already consume.

**Ask Tencent:** confirm resource-point deduction, scale-to-zero billing, log and
egress charges, and whether a minimum warm instance is required for the target
latency. Remove the throwaway `ai-probe` service after evidence is retained.

---

## Item 2 — The database · **PostgreSQL retained; purchase staged**

The assistant must make several writes happen as **one indivisible step** —
mark the chat human-controlled, revoke the AI's permission to write, record the
event. If those can happen separately, a stray AI sentence reaches the customer
after a salesperson has taken over. That is the single hardest requirement in
the system and it drives this choice.

### Option A — Use the CloudBase NoSQL database we already have · **¥0 new spend**

The existing `@cloudbase/node-sdk` supports `runTransaction`, which
**re-executes its callback on write conflict**. This codebase already uses that
to build a fenced lease for the Alibaba catalogue sync
(`packages/db/src/cloudbase-adapter.ts`, tested in
`packages/db/src/alibaba-lease.test.ts`). The same pattern can carry the
takeover fence.

- **Cost:** nothing. Same environment, same plan.
- **Work:** the low-level design is currently written entirely in PostgreSQL
  terms — conditional `UPDATE … RETURNING`, partial unique indexes, and so on.
  It would need rewriting for a document database and re-reviewing. That is
  design effort, not purchase.
- **Risk:** the team has done this exact kind of fencing here before, and it
  survived review. That is meaningful evidence.
- **Unknown:** query patterns the assistant needs — a sales queue, replaying a
  conversation's events in order — are natural in SQL and need deliberate index
  design in a document store.

### Option B — A standalone 云数据库 PostgreSQL instance · **production target**

A normal PostgreSQL server in ap-shanghai. It is not on CloudRun's private
network merely because the region matches; `VpcConf`, a compatible VPC/subnet,
the private endpoint, TLS and network rules must be configured and tested.

- **Cost:** pay-as-you-go or a monthly instance charge. Price it at
  <https://buy.cloud.tencent.com/price/pgsql>. Do not claim the smallest instance
  is sufficient until traffic, connection, retention, storage, RPO and RTO
  envelopes are approved.
- **Work:** none beyond what is designed. The low-level design already targets
  this exactly.
- **Risk:** lowest. We have a 30-second script that answers PASS/FAIL on whether
  a given database supports the required behaviour, and it has been verified to
  give the right answer on both a good database and a deliberately broken one.
  We can prove it before committing.

### Option C — A second CloudBase environment in PostgreSQL mode · **optional sandbox, not the primary path**

CloudBase does offer PostgreSQL, but Tencent's documentation states PG mode is
chosen **when an environment is created** and *"legacy environments cannot be
upgraded in place"*. Our environment reports `postgresql: false`. So this means
a second environment.

- **Cost:** another environment plan unless this Tencent account is eligible for
  its one free-experience environment. Eligibility is not assumed: an account
  already using an earlier free package may not receive another. The free offer
  publishes 3,000 resource points per month and renewal constraints; it does not
  guarantee enough capacity for this workload.
- **Work:** a new PG-mode environment can coexist with the existing NoSQL
  environment, which remains untouched. If the new environment supplies a
  normal server-side PostgreSQL connection and passes `S0-S11`, the existing
  `pg` store can be reused. If it exposes the required multi-statement work only
  through HTTP/RPC, the transaction boundary moves into database functions and
  requires a store implementation and review.
- **Use:** acceptable as an optional shared development sandbox if it is free,
  contains no real customer data, and passes the relevant probes. It does not
  prove the final CloudRun-to-TencentDB VPC path and is not a reason to rewrite
  the production design.

### Staged decision — revised 2026-08-17

Keep one PostgreSQL implementation across environments; do not build a temporary
NoSQL AI store merely to avoid a development bill:

1. **Local development:** MIU 2a creates Docker Compose for the BFF, workers and PostgreSQL 16.
2. **CI:** MIU 2a adds a PostgreSQL service for the same migrations and race tests.
3. **Cloud integration:** create a short-lived pay-as-you-go TencentDB instance
  in ap-shanghai, attach CloudRun explicitly to its VPC/subnet, run `S0-S11`
  and end-to-end tests, then release the instance if the test window is over.
4. **Customer pilot:** obtain a production quote using measured traffic and
  retention. Continue pay-as-you-go for uncertain load or convert to a monthly
  plan when usage stabilizes.

Same region does not automatically create a private route. CloudRun must receive
a real `VpcConf` using the database VPC and subnet, the database must expose its
private endpoint, and TLS/network rules must be tested from the deployed runtime.

**Confirmed 2026-08-17:** Tencent support confirmed that CloudRun and the
independent TencentDB must use the same VPC. Implementation is no longer an open
question: create/select the Shanghai VPC; reserve a dedicated CloudRun subnet;
bind both BFF and worker to it; create TencentDB in the same VPC (a separate
database subnet is acceptable and preferred); use the private endpoint on
`5432`; and allow only the CloudRun subnet/approved network boundary at the
database. CloudRun instance IPs are dynamic, so do not maintain a fixed-IP
allowlist. See `evidence/P3-runtime-and-routing.md` R4.

Keep CloudRun public egress enabled initially because Hermes, Lexiang MCP and the
model endpoint are public dependencies. Disabling it requires NAT gateway and
route configuration. TencentDB's current pricing page says network traffic is
currently free, but confirm that statement again at purchase.

Credentials are provisioned directly into the approved secret manager. Return
only non-secret identifiers and secret names; never send a database password or
connection string through chat or email. Use a disposable probe role/schema,
then a separate least-privilege runtime role.

---

## Where the assistant will actually live (measured, and it changes the design)

The original architecture put the assistant at `/api/ai/*` on the website's API
domain. **That path is already taken, and CloudRun does not use that domain
anyway.** Both facts were measured, not assumed.

### Why `/api/ai/*` is taken

The deploy manifest maps three prefixes, and the gateway matches the longest one:

| Prefix | Function |
|---|---|
| `/api/admin` | `admin` |
| `/api/alibaba-catalog-sync` | `alibaba-catalog-sync` |
| `/api` | `public-api` |

`/api/ai/healthz` matches no specific prefix, so it falls through to `/api` and
lands in **`public-api`**, which walks its own routes, matches none, and returns
its own error envelope from `apps/functions/public-api/src/http-adapter.ts:280`.

Measured:

| Request | Result |
|---|---|
| `GET /api/products?pageSize=1` | `HTTP 200` — `public-api` |
| `POST /api/admin` | `HTTP 401` — `admin`, auth required, correct |
| `GET /api/ai/healthz` | `{"ok":false,"error":{"code":"NOT_FOUND","message":"Route not found"}}` — **`public-api` answering** |
| `GET /ai-probe/` on the same domain | `HTTP 404` — CloudRun is not mounted there |

**Nothing was changed to fix this, and nothing needs to be.**

### Because CloudRun gives the service its own hostname

A CloudRun service is reachable at `<service>-<id>.sh.run.tcloudbase.com`, not as
a path under the environment's API domain. So the assistant never touches `/api`
and the collision cannot occur.

### The consequence the architect should know

The widget will call a **different origin** from the website. That makes two
things real requirements rather than formalities:

1. **CORS** — the assistant's service must allow the website's origin explicitly.
2. **The short-lived conversation credential travels cross-origin**, which
   affects how it is carried and stored.

Three design documents are being updated to match: the architecture's route
table, the deployment unit (MIU 2a), and the security trust-zone diagram.

---

## Item 3 — A new Lexiang (腾讯乐享) knowledge space + read-only token

**Buy/create:** a new, separate space in Lexiang, plus a token scoped to read
only that space.

**Why separate.** Lexiang's anonymous `system-bot` identity can read anything
visible to all staff. That is internal company knowledge. A stranger typing into
a chat box on the public website causes a search against whatever that token can
reach. If it can reach supplier contracts, costs, or customer projects, one day
it will surface them.

Making it a folder or a permission subset inside the existing space is not
sufficient — the token must be incapable of reaching internal material, not
merely trusted not to.

**Cost:** likely nothing if Lexiang is already licensed; a space is a container.
**Confirm with whoever administers Lexiang.**

### How development and production connect

The selected serving path is **Hermes -> Lexiang MCP**, matching the proven
local artifact. The BFF and browser do not call Lexiang REST directly.

| Stage | Knowledge dependency |
|---|---|
| Unit/store/race tests | `FakeEngine` fixtures; no Lexiang account or network |
| BFF/worker integration today | Existing `FakeEngine` + real PostgreSQL design; successful streams/citations and transport failure/timeout fixtures |
| BFF/worker integration after MIU 5a | Adds `knowledge_empty`, `unavailable` and answer-policy fixtures |
| Hermes adapter transport tests after MIU 4 | Local stub Hermes HTTP server with sanitized recorded event frames; no Lexiang |
| Optional developer manual test | Pinned local Hermes container + test-only public MCP credential |
| Shared staging and release evaluation | Real pinned Hermes + exact scoped Lexiang MCP credential + approved public corpus |
| Production | Same as staging, with production secret reference and standing scope probes |

Lexiang is managed SaaS; developers do not install its database, index or MCP
server locally. The Lexiang administrator must:

1. Create the dedicated public customer-service space and publish only approved
  public FAQ/content.
2. Create the serving MCP credential and record its non-secret credential id,
  MCP URL and space id. REST AppKey/interface/knowledge-scope settings are
  administrative evidence only; they do not substitute for probing the actual
  `lxmcp_...` credential used by Hermes.
3. Store the secret in the approved Secret Manager; provide deployment only the
  secret reference.
4. Provide one known public document and one current internal document id for
  the positive/negative controls.
5. Re-run the scope probe whenever the credential, space, MCP preset, Hermes
  profile or MCP tool list changes.

Hermes receives the MCP URL and bearer credential through its private profile,
with only approved read/search tools included. Missing or unreachable MCP turns
readiness red and the website falls back to inquiry/human contact. If the real
MCP credential cannot be proven public-only and read-only across search, query,
list, get and attachment surfaces, production remains blocked.

---

## Item 4 — Hermes with its HTTP API enabled

**Not a new purchase — a configuration change**, plus a decision about where it
runs.

The existing 智能小助手 is a message-channel bot (WeCom / 元宝 / LightClaw) run
by `hermes-gateway.service`. Per our own operations manual it has **no HTTP API
server**; serving a website widget requires explicitly setting
`API_SERVER_HOST` and `API_SERVER_KEY`.

Two things matter:

1. **A separate restricted profile.** Hermes ships tools that can run commands,
   read files and browse the web. Those are acceptable for an internal bot and
   are a remote-code-execution path on a service anonymous visitors can reach.
   The website profile must expose only read-only knowledge lookup.
2. **Pin the version.** Not `latest`. We check the exact tool list once and
   freeze it, so a routine upgrade cannot quietly add a dangerous capability.

**Decision for the architect:** run the website's Hermes as a second instance,
or as a second profile on the existing host? A second instance is safer — the
internal bot and the public one then cannot share configuration by accident.

**Cost:** a small server if it is a separate instance.

---

## Item 5 — A zenmux key and spend cap for the website

The existing bot already uses zenmux. Reuse the account, but issue a
**separate key** for the website with its own monthly cap, so public traffic
cannot exhaust the internal bot's budget and so spend is attributable.

**Cost:** usage-based, and genuinely unknown until we size it — see the gap
below.

---

## What we cannot tell you yet, honestly

**No traffic or cost sizing exists.** Nobody has written down expected
conversations per day, peak concurrency, tokens per conversation, or storage
growth. That is why we cannot select a long-term database SKU, a CloudRun warm
instance count, or a monthly model budget yet. Local Docker and a bounded
pay-as-you-go integration window let development continue without pretending
these inputs exist.

**We do not have Tencent's prices.** The console shows them at the point of
activation. The two questions worth asking directly:

1. Do CloudRun CPU/memory points deduct from the existing Standard-plan pool,
  and what are the log, egress and minimum-instance charges?
2. What are the pay-as-you-go and monthly prices for the entry and next practical
  TencentDB PostgreSQL configurations in ap-shanghai?
3. Is this account currently eligible for one free CloudBase PG experience
  environment, and what PG workload consumes its 3,000 monthly points?

---

## Summary for the purchase conversation

| # | Item | Status | Spend |
|---|---|---|---|
| 1 | CloudRun platform | ✅ Activated and streaming proven; production BFF/worker not deployed | No activation purchase; confirm point usage, logs and egress |
| 2 | Local + CI PostgreSQL 16 | Development baseline | No cloud purchase |
| 3 | Temporary TencentDB PostgreSQL, ap-shanghai | Purchase only for bounded cloud integration | Pay-as-you-go; release after tests |
| 4 | Long-term TencentDB PostgreSQL | Purchase at customer-pilot gate after sizing | Pay-as-you-go or monthly |
| 5 | New Lexiang space + scoped MCP serving credential | Outstanding | Confirm existing licence and K1-K5 isolation contract; REST AppKey is supporting evidence only |
| 6 | Hermes: restricted, pinned website instance/profile | Outstanding | Host/operations cost if isolated instance required |
| 7 | Model provider key + cap | Outstanding | Usage-based; legal approval required |

**Immediate purchase: none for local development.** The first bounded spend is
the temporary pay-as-you-go TencentDB integration window. Before public traffic,
the architect approves the complete 12-month operating envelope: database,
CloudRun, Hermes, model, Lexiang if chargeable, logs/monitoring, WAF, network and
notification services.

---

## 给架构师的中文审批摘要

### 已有资源和已完成证明

- 继续保留现有 CloudBase NoSQL 环境、三个 Event Functions、存储和静态托管；AI 项目不迁移或替换这些业务。
- CloudRun 已开通；`ai-probe` 在 2026-08-17 证明过普通 HTTP 和 SSE 增量流式输出，但 2026-08-25 复查公网端点返回 503。正式 BFF 和 Worker 尚未部署，不能把控制台 `normal` 当作当前运行健康。
- 本地 Hermes + 模型 + 乐享链路只证明技术可行，不代表公网生产安全门已关闭。

### 开发阶段：暂不购买长期云资源

1. MIU 2a 将创建本地 Docker Compose，运行 `ai-bff`、独立 `ai-worker` 和 PostgreSQL 16；当前尚未创建。
2. MIU 2a 将给 CI 增加 PostgreSQL service，执行同一套 migrations、`S0-S11`、集成测试和并发竞态测试；当前尚未创建。
3. 本地 Docker 可验证容器进程、端口、SSE、健康检查、优雅退出和 PostgreSQL 事务；不能代替 CloudRun 网关、CORS、缩容冷启动、VPC、TLS、配额和计费验证。
4. 不为开发期临时实现 NoSQL AI Store。那会产生第二套接管、事件顺序、outbox、索引和并发测试，未来仍需删除。

### CloudRun 成本判断

本项目的生产 runtime 已确定为 CloudRun，不再把 HTTP Function 保留为实施阶段候选。原因是 BFF、长时间 engine stream、后台 Worker、VPC TCP PostgreSQL、独立扩缩容和故障隔离与现有 LLD 匹配，而且真实 CloudRun 网关已通过 SSE 证明。本地开发使用 Docker Compose 模拟 BFF/Worker 容器；任何生产 runtime 替换必须另开 ADR，不由后续 Agent 在 MIU 中重复调查。

按当前公开单价，单个实例连续运行 730 小时的计算费示例：

| 规格 | 计算费/月，不含日志与流量 |
|---|---:|
| 0.25 核 + 0.5 GiB | 约 21.72 元 |
| 0.5 核 + 1 GiB | 约 43.44 元 |
| 1 核 + 2 GiB | 约 86.87 元 |

`minNum=0` 可在无请求时缩容到零，适合开发和低流量试用，但有冷启动。常驻实例、多服务、多副本、日志和外网出流量会增加成本。请腾讯确认这些点数是否从现有标准版资源池扣除，以及当前环境还剩多少资源点；不能直接断言每月几百，也不能断言免费。

### PostgreSQL 阶段策略

| 阶段 | 方案 | 采购 |
|---|---|---|
| 本地开发 | Docker PostgreSQL 16 | 无 |
| CI | PostgreSQL service | 无持续云费用 |
| 云端集成 | 上海按量 TencentDB PostgreSQL；CloudRun 显式配置同 VPC/subnet | 只购买限定测试窗口，用完可释放 |
| 客户试运行 | 根据真实会话量、连接数、数据保留、RPO/RTO 选择规格 | 按量或包年包月 |

现有传统 NoSQL 环境不能原地升级为 PG 模式。可以新建第二个 CloudBase PG 环境，而且 PG 环境可同时使用 NoSQL；但账号是否还具备一个每月 3,000 点的免费体验环境必须由控制台确认，不能假设。即使免费，它只作为无真实 PII 的可选开发 sandbox：若提供正常服务端 PostgreSQL 连接并通过 `S0-S11`，可以复用当前 `pg` 实现；若关键事务只能走 HTTP/RPC，就需要将事务封装为数据库函数并重新评审。它也不能替代最终 CloudRun 到 TencentDB 私网链路的验证。

### 第一次需要付费的时点

当 BFF 准备进入云联调时：

1. 开一个上海按量 TencentDB PostgreSQL 测试实例；不要先买长期套餐。
2. 为 BFF 和 Worker 配置真实 `VpcConf`，绑定上海同一 VPC 中的 CloudRun 专用子网；TencentDB 可放在同 VPC 的独立数据库子网，使用私网 endpoint `:5432`。
3. 配置 TLS、最小网络权限、临时 probe role 和独立 runtime role。
4. 从正式 CloudRun 路径运行 `S0-S11`、migrations、集成与竞态测试。
5. 测试窗口结束且不需共享测试库时释放实例。
6. 客户 pilot 前根据监控数据决定继续按量还是转包年包月。

所有密码、连接串、AppSecret 和 API Key 直接写入获批 Secret Manager；聊天和邮件只回传实例 ID、私网 host、port、database、VPC/subnet ID 和 Secret 名称。

腾讯支持已于 2026-08-17 书面确认 CloudRun 与独立 TencentDB 需要位于同一 VPC。实施时不再重复询问：CloudRun 使用专用子网，TencentDB 可使用同 VPC 的其他子网；数据库只开放私网 `5432` 给 CloudRun 子网/批准的网络边界，不依赖动态实例 IP。当前 Hermes、乐享 MCP、模型均需公网，因此先保持 CloudRun 公网出访开启；若以后关闭，先配置 NAT 网关与路由。腾讯数据库当前计费说明称流量费暂免，但购买时再核对现行计费。

### 试运行前需要采购或批准的完整清单

| 项目 | 当前动作 | 可能费用 |
|---|---|---|
| CloudRun BFF + Worker | 确认规格、`minNum`、点数扣减、日志、流量和告警 | 使用量计费；不等于固定几百元 |
| TencentDB PostgreSQL | 云联调先按量；pilot 再定长期规格 | 规格、磁盘、超额备份、审计 |
| Lexiang 公开知识空间 | 建专用公开 space 和 scoped MCP serving credential；对实际 `lxmcp_...` 凭证做 K1-K5 probe。REST AppKey 只作管理证据 | 先确认现有 licence，不能假设 0 元 |
| Hermes 官网实例/profile | 固定版本/digest、私网、只读工具；优先与内部 bot 隔离 | 主机、磁盘、日志、补丁和运维 |
| 模型供应商 | 批准 provider/model、DPA、地域、保留/训练条款；官网独立 key 和日/月 cap | Token 使用量 |
| 安全与运营 | WAF、监控、告警、通知/CRM/email、备份和恢复演练 | 依选型与用量 |

### 架构师需要作出的决定

1. 批准“本地/CI 免费开发 -> 按量云联调 -> pilot 再定长期资源”的时点策略。
2. 确认 CloudRun 资源点、缩容到零、日志和流量的真实账单规则。
3. 确认账号是否仍有免费 CloudBase PG 体验资格；只作为可选 sandbox。
4. 到云联调阶段批准按量 TencentDB 的预算窗口和 VPC 配置。
5. 决定 Hermes 独立实例还是接受共享主机 profile 的隔离风险。
6. 确认 Lexiang licence、公开知识 owner 和 scoped MCP serving credential；REST AppKey 不作为上线凭证证明。
7. 批准模型供应商、法律条款和预算上限。
8. 在客户流量前审批完整 12 个月运行成本，而不只审批数据库。

### 乐享接入实施路径

生产链路固定为：`Chat BFF -> Hermes -> 乐享 MCP -> 专用公开知识空间`。浏览器和 BFF 不直接调用乐享 REST。REST AppKey 的接口权限和知识授权范围只能作为管理侧证据，不能代替对 Hermes 实际使用的 `lxmcp_...` MCP credential 做隔离证明。

开发阶段不需要在本地安装乐享，也不需要每个工程师持有真实乐享凭证：

1. 已有 `FakeEngine` 可提供确定性的成功、引用、transport failure、timeout 和 overlong-output 基础能力。MIU 5a/后续集成测试将补齐 `knowledge_empty`、`unavailable` 和回答策略 fixture；这些场景目前尚未全部实现。
2. MIU 4 将创建本地 stub Hermes，供 adapter HTTP transport 测试回放脱敏事件；该 stub 当前尚未实现，也不会连接乐享。
3. 仅手工端到端联调可选用本地 pinned Hermes + 测试专用公开 MCP credential；不得使用内部空间或真实客户数据。
4. 共享 staging、golden-set evaluation 和 production 才必须连接真实专用乐享空间。

乐享由管理员在 SaaS 控制台创建公开空间和 MCP 凭证，不存在需要本地部署的乐享数据库、索引或 MCP server。管理员把 MCP secret 直接写入 Secret Manager，只回传 MCP URL、space id、credential id 和 Secret 名称。Hermes profile 配置 MCP URL、Bearer secret reference、timeout 及只读 tool allowlist。

上线前，对实际 serving credential 的每一个 MCP surface 分别执行：公开文档正向成功、内部文档拒绝、公开文档写入拒绝、故意 over-scoped credential 能让 probe 变红。MCP credential、space、preset、profile 或 tools 任何一项变化都重新运行。若乐享无法提供通过该合同的 scoped MCP credential，生产 gate 2 继续阻塞，不允许自动改用 REST 或放宽权限。

### 本轮核对的官方资料

- CloudBase 价格与资源点：<https://cloud.tencent.com/document/product/876/75213>
- CloudBase PG 模式概述：<https://docs.cloudbase.net/quick-start/pg-overview>
- CloudBase 环境模式：<https://docs.cloudbase.net/quick-start/env-overview#modes>
- CloudBase PostgreSQL 多语句事务与 HTTP API：<https://docs.cloudbase.net/database/postgresql/transactions#relationship-with-http-api>
- TencentDB PostgreSQL 计费概述：<https://cloud.tencent.com/document/product/409/4993>
- TencentDB PostgreSQL 价格：<https://buy.cloud.tencent.com/price/pgsql>
- 腾讯乐享接口凭证与知识授权范围：<https://lexiang.tencent.com/wiki/api/>
- 腾讯乐享 AI 问答：<https://lexiang.tencent.com/wiki/api/40000.html>
- 腾讯乐享 AI 搜索：<https://lexiang.tencent.com/wiki/api/40004.html>
- CloudRun 内网互联：<https://docs.cloudbase.net/run/deploy/networking/internal-link>
- CloudRun VPC 配置：<https://docs.cloudbase.net/run/deploy/networking/vpc>
- CloudRun 公网出访：<https://docs.cloudbase.net/run/deploy/networking/egress>
