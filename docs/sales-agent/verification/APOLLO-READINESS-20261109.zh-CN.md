# Apollo 试用接入核对与下一步

2026-11-09。结论：Apollo 账号认证可用，真实获客搜索尚不可用；与官网欠费不是同一个问题。不能将 Resend 草稿验收当作 Apollo 全流程验收。

## 本次独立核对

- Chrome 的供货公司空间显示 Professional trial，剩余 11 天；用量周期显示 2026-11-06 至 2026-11-20；该周期不作为已确认的自动扣款承诺。85 credits 尚未使用。本轮未购买、续费或更改试用。
- 使用仓库外已交接的专用 Key，经现有 `ApolloReadClient` 读取 `users/api_profile`：200，team_id 与服务器配置的预期空间一致。
- 同一连接分别只查询一页、每页最多 5 条：`mixed_companies/search` 和 `mixed_people/api_search` 都返回 403，安全错误类别为 API_INACCESSIBLE，并提示升级。此前三次请求合计 1.61 秒；本次进一步读取并核对了供应商完整错误字段，没有自动重试或真实结果名单。
- 在开发者页面只查看创建 Key 表单，两个新客户搜索接口均 disabled；people/match、people/bulk_match 等补全接口也 disabled。随后取消表单，没有创建或扩大凭据权限。这说明搜索受到账号可授权能力限制，不应声称仅换 Key 就可修好；Apollo 已明确拒绝当前试用套餐；能否人工开放试用例外仍须其确认。
- Hub SSH 可达，`hermes-sales-serve@channel-test.service` 和 nginx 均 active。本机直接调用 Apollo 已得到其自身 403，因此此次搜索失败并非 Channel 页面/COS 欠费错误。可达不等于获客岗位已部署。
- 本地 Apollo 适配器 12 项测试通过，包括真实 loopback HTTP、客户空间匹配、调用次数、响应校验和权限拒绝。首次沙箱禁止本机监听端口；允许本机测试端口后原测试通过，没有改代码绕过断言。测试通过不替代真实候选名单验收。

## 403 的具体原因（本轮补充，不再推测）

| 接口 | 当前账号返回的依据 | 请求号 |
|---|---|---|
| 公司搜索 `mixed_companies/search` | 不包含在 **Professional (Trial)** 套餐，`API_INACCESSIBLE`／`AUTH.AUTHORIZATION.ENDPOINT_ACCESS_DENIED` | `3cf4e1eb-3d87-4449-8854-b487c4c23528` |
| 人员搜索 `mixed_people/api_search` | 同一套餐拒绝，结构化上下文明确指向该人员搜索端点 | `45c8fad6-52a6-4d5e-ac47-09fb32fad18e` |

公开文档允许企业邮箱账号在满足额外资格后调用，不能据此反推这个空间必然开放；本次依据是该空间的实际套餐拒绝。另一个独立条件是 Key 本身须勾选端点，未选也可能 403。Master Key 不超出账号本来允许的能力。因此当前先解决空间权限，恢复后再核对专用 Key 的端点范围，不反复换 Key 或无限重试。

## 实现范围

| 环节 | 当前事实 |
|---|---|
| 指定空间认证、公司和人员查询、限制翻页和调用次数 | 复用原适配器，已加入 Hermes `feat/apollo-prospecting-flow-20261109@41523e4` |
| 真实候选返回 | 未通过，Apollo 403；不能提供虚构名单 |
| 目标、独立任务、模型调用、成果保存 | CLI／官方 MCP stdio 入口已实现；模型／客户库复用原实现。尚未注册到企微／定海线上入口，不伪造网站询盘授权 |
| 匹配理由、未发送文案、预览 | 已实现受限模型协议、Sales 客户库和私有 HTML 预览；联系人补全和审批发送仍未实施，不套用网站报价 |
| 冷开发发信、自动序列、回复交接 | 尚未实施或启用；本轮不发信 |

官网询盘线仍独立：客户主动提交需求 → Channel 保存 → Hermes Sales 准备 → Resend 草稿。Apollo 不应成为这条线的必经依赖。

## 建议的最小获客闭环

```text
客户在企微提出目标（地区、买家类型、产品方向、数量）
  → Hermes 绑定该客户与独立获客任务
  → Agent 将目标转为可核对的查询条件
  → Apollo 返回一小批真实候选
  → Agent 给出匹配理由、依据、未确认项和排除项
  → 客户确认候选，再按额度补全必要联系方式
  → Agent 生成针对该候选的开发文案与预览
  → 人审核指定受众和文案版本
  → 后续另接获准的冷开发发送渠道（目前不发送）
```

首轮先证明前半段：一条目标 → 一页真实名单 → 推荐依据 → 可查看成果。每个短任务复用现有有界查询；不新增 Channel 任务中心、全量同步库或频繁轮询。身份/授权由宿主固定，模型不能选择其他客户 Key。重复任务复用已有成果，不重复补全消耗 credits。岗位代码已通过独立 review；真实 MySQL、模型协议、官方 MCP 客户端与原询盘回归的 [CI 42559600164](https://github.com/vibelingan/hermesinfra/actions/runs/42559600164) 通过（36 项获客／SQL 与 30 项原流程检查，无跳过；两项缺陷注入抓到预期断言）。仍须真实账号返回候选后验收内容质量，并单独接入在线群聊，不改现有定海或文章任务。

### 本轮实际完成的验收

实现提交为 Hermes `41523e43fa75cef7a49a62d6022d6202db87d58f`，最终测试提交为 `e1f112b7378f2277f5bc90b9ba15c878c398ca08`，均已推送到 `feat/apollo-prospecting-flow-20261109`。最终 [CI 42560758323](https://github.com/vibelingan/hermesinfra/actions/runs/42560758323) 通过 **67 项**，没有跳过，含官方 MCP `prepare → CLI → SQL → 模型子进程 → Apollo HTTP → 保存 → get → 重放` 的正向整链；供应商响应在 CI 中仍是合成数据。两项定向缺陷注入抓到了预期失败。

Hub 实际用专属 `hermes-sales-channel-test` 身份、既有真实模型和 TLS 的 Sales 测试库验收：

- 真实模型 → 真实 Apollo → 真实数据库：7.62 秒，准确保存当前套餐拒绝；模型一次，Apollo 身份／查询各一次。
- 明确标注的合成候选 → 真实模型 → 真实数据库／HTML 预览：32.78 秒，生成一份匹配理由、未确认项和未发送文案；模型两次。
- 新 store 实例读回一致；重复任务没有新增模型或 Apollo 调用。原服务进程及 Hub 20 项未提交改动的内容摘要保持一致，没有注册到定海或重启现有 Agent。

运行账号没有 CREATE 权限。新任务表经既有专属数据库的本机安装通道显式建立，未给常驻账号放权、未放开 root 远程登录，未操作共享 Hub 数据库。真实 Apollo 返回候选仍未验收，不能把上述合成候选当成真实获客成功。完整记录见 [Hermes 实施说明](https://github.com/vibelingan/hermesinfra/blob/feat/apollo-prospecting-flow-20261109/docs/sales-agent/IMPLEMENTATION.md)。

### 当前必须解决的外部能力

先向 Apollo 确认此试用空间是否能开放以下 API 的试用权限，而不是先付款或重建 Key：

1. `api/v1/mixed_people/api_search`
2. `api/v1/mixed_companies/search`
3. 若要实际取得收件邮箱，再确认 `api/v1/people/match` 的权限和 credits。

给 Apollo 支持的申请内容：

> Our workspace is on a Professional trial ending November 20, with 85 unused credits. The existing private API key authenticates successfully through users/api_profile, and its team_id matches this workspace. Both mixed_people/api_search and mixed_companies/search return HTTP 403 / API_INACCESSIBLE with an upgrade prompt; both endpoints are also disabled in the API-key creation screen. Can you enable prospect-search API access for this trial, or confirm which paid plan or additional approval is required? We only need a small read-only evaluation and do not want to start a paid subscription yet. Please also clarify whether people/match email enrichment can be evaluated using the trial credits.

不发送 Key、密码、密文或客户数据给支持。浏览器中的搜索可用性不能替代这些 API 的可用性；不改走未获批的内部接口绕过限制。

### 用户授权后的官方支持申请与公开案例

用户明确允许联系 Apollo 后，已在登录账户的 **Help → Talk to support → Send us a message → technical question** 提交两项接口、当前套餐、身份匹配检查及请求号，申请小额度、限时、只读评估；没有提交 Key 或客户名单，也没有授权付费。客服机器人明确回复人工不在线，并明确表示**无法替人工排队建单**；当前没有人工工单号，不能称为人工已受理。

官方[备用支持页](https://www.apollo.io/submit-a-request)列出 `support@apollo.io`。也准备了同内容支持邮件，但 Gmail 页面与新打开的验证页均连接中断，发送停在“仍在发送”；已取消待发送并实际确认恢复为撰写草稿，没有将其算作已发送。草稿保留在用户原 Gmail 页面，未清除。人工开放或邮件连接恢复后继续此申请，不反复请求付费或扩大 Key。

公开资料找到的是同类拒绝经历，而非已证实的特批成功：

- [Reddit：Professional trial 的 People Search 被拒](https://www.reddit.com/r/UseApolloIo/comments/1ttvc1h/api_is_not_accessible_with_this_access_token_on_a/)：回复者 `AndyFromApollo` 建议核对 workspace，再由 Support 查账号授权；回复者身份未独立认证，帖子没有最终开通成功结果。
- [Make Community，2024-02-21](https://community.make.com/t/apollo-api-403-error/28133)：同样是试用期间 403，社区建议升级；没有客服豁免成功的回报。

因此可以说“联系官方核对是有依据的排查办法”，不能说“客服通常会为试用开通”。官方 [Developer FAQs](https://docs.apollo.io/docs/developer-faqs)承认额外账号资格条件，[支持指南](https://knowledge.apollo.io/hc/en-us/articles/25851069527693-Reach-out-to-Apollo-Support)说明支持渠道；两者都没有保证试用例外必定获批。

### 发信渠道的业务边界

Resend 明确不允许 cold outreach、购买或抓取名单等未经请求的通信。因此不能将 Apollo 陌生名单直接交给官网询盘的 Resend 发送逻辑。发送渠道可后续讨论 Apollo 连接的专用业务邮箱等方案；当前只准备候选与文案，不连接邮箱、不发信。客户真实回复后，须按原文分类并明确允许的跟进范围，再交给询盘/客户维护流程；拒绝、退订和自动回复不能直接变成营销订阅。

## 现有询盘邮件的内容建议

当前已验收的 Resend 草稿能复述“采购 500 个耳机”并列出澄清问题，但仍偏通用模板。下一轮调 Agent 时：

- 先准确复述已知需求，不重复询问已提供的数量、目的地或时间。
- 首封优先追问影响选品/报价最大的 1–2 个缺口，避免一次罗列所有字段。
- 有真实产品依据时说明推荐型号与匹配理由；尚未确认的价格、MOQ、交期不自行承诺。
- 正文给出明确下一步；语言跟随客户，附件仅来自获准资料并在预览中可核对。

本次补齐获客的专属模型协议及工具代码；没有更改原 Agent 提示词、在线定海注册或网站询盘逻辑。

## 依据和复核

- [人员搜索](https://docs.apollo.io/reference/people-api-search)：搜索不返回邮箱/电话；按当前文档为 0 credits。
- [公司搜索](https://docs.apollo.io/reference/organization-search)：按当前文档每页 1 credit；是否可调用以该账号实测为准。
- [Key 权限](https://docs.apollo.io/docs/create-api-key)：scoped Key 仅可用所选端点；Master Key 不能超越账号能力。
- [结构化错误](https://docs.apollo.io/reference/status-codes)：读取 error_details，而不是只看 HTTP 状态码。
- [API 计费](https://docs.apollo.io/docs/api-pricing)：补全和搜索分别计量，不能将页面剩余额度等同接口已开放。
- [Resend 使用规则](https://resend.com/legal/acceptable-use)：限制 cold outreach 与未获同意的名单发送。

实际复核：`sales_flow/apollo.py`、`test_sales_apollo.py`、Hermes 实施记录、SG6 设计、现有 Sales 部署记录、远端分支 SHA、试用与 API 创建页面。将“试用已开所以 Apollo 已打通”更正为“试用已开，身份通过，两个真实搜索仍被拒绝”。凭据和供应商完整响应未进入文档。
