# Apollo 试用接入核对与下一步

2026-11-09。结论：Apollo 账号认证可用，真实获客搜索尚不可用；与官网欠费不是同一个问题。不能将 Resend 草稿验收当作 Apollo 全流程验收。

## 本次独立核对

- Chrome 的供货公司空间显示 Professional trial，剩余 11 天；用量周期显示 2026-11-06 至 2026-11-20；该周期不作为已确认的自动扣款承诺。85 credits 尚未使用。本轮未购买、续费或更改试用。
- 使用仓库外已交接的专用 Key，经现有 `ApolloReadClient` 读取 `users/api_profile`：200，team_id 与服务器配置的预期空间一致。
- 同一连接分别只查询一页、每页最多 5 条：`mixed_companies/search` 和 `mixed_people/api_search` 都返回 403，安全错误类别为 API_INACCESSIBLE，并提示升级。三次请求合计 1.61 秒，无自动重试，没有结果名单。
- 在开发者页面只查看创建 Key 表单，两个新客户搜索接口均 disabled；people/match、people/bulk_match 等补全接口也 disabled。随后取消表单，没有创建或扩大凭据权限。这说明搜索受到账号可授权能力限制，不应声称仅换 Key 就可修好；Apollo 对该试用账号的具体开放条件仍须其确认。
- Hub SSH 可达，`hermes-sales-serve@channel-test.service` 和 nginx 均 active。本机直接调用 Apollo 已得到其自身 403，因此此次搜索失败并非 Channel 页面/COS 欠费错误。可达不等于获客岗位已部署。
- 本地 Apollo 适配器 12 项测试通过，包括真实 loopback HTTP、客户空间匹配、调用次数、响应校验和权限拒绝。首次沙箱禁止本机监听端口；允许本机测试端口后原测试通过，没有改代码绕过断言。测试通过不替代真实候选名单验收。

## 实现范围

| 环节 | 当前事实 |
|---|---|
| 指定空间认证、公司和人员查询、限制翻页和调用次数 | 代码已有，Hermes `feat/apollo-readonly-20261106@1422083`；未包含在已部署 Sales 版本中 |
| 真实候选返回 | 未通过，Apollo 403；不能提供虚构名单 |
| 企微目标关联客户、获客任务派发、模型调用 Apollo 工具 | 尚未接线；不能用网站询盘授权伪造获客任务 |
| 匹配理由、联系人补全、开发文案、预览审批 | 尚未完成 Apollo 业务闭环；可复用既有模型、成果归档和审批合同，不能直接套用网站报价 |
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

首轮先证明前半段：一条目标 → 一页真实名单 → 推荐依据 → 可查看成果。每个短任务复用现有有界查询；不新增 Channel 任务中心、全量同步库或频繁轮询。身份/授权由宿主固定，模型不能选择其他客户 Key。重复任务复用已有成果，不重复补全消耗 credits。尚未完成的岗位接线要经过相应 review 和 E2E，再决定是否加入线上配置，不改现有定海或文章任务。

### 当前必须解决的外部能力

先向 Apollo 确认此试用空间是否能开放以下 API 的试用权限，而不是先付款或重建 Key：

1. `api/v1/mixed_people/api_search`
2. `api/v1/mixed_companies/search`
3. 若要实际取得收件邮箱，再确认 `api/v1/people/match` 的权限和 credits。

可直接发给 Apollo 支持（本轮仅准备文字，没有代发）：

> Our workspace is on a Professional trial ending November 20, with 85 unused credits. The existing private API key authenticates successfully through users/api_profile, and its team_id matches this workspace. Both mixed_people/api_search and mixed_companies/search return HTTP 403 / API_INACCESSIBLE with an upgrade prompt; both endpoints are also disabled in the API-key creation screen. Can you enable prospect-search API access for this trial, or confirm which paid plan or additional approval is required? We only need a small read-only evaluation and do not want to start a paid subscription yet. Please also clarify whether people/match email enrichment can be evaluated using the trial credits.

不发送 Key、密码、密文或客户数据给支持。浏览器中的搜索可用性不能替代这些 API 的可用性；不改走未获批的内部接口绕过限制。

### 发信渠道的业务边界

Resend 明确不允许 cold outreach、购买或抓取名单等未经请求的通信。因此不能将 Apollo 陌生名单直接交给官网询盘的 Resend 发送逻辑。发送渠道可后续讨论 Apollo 连接的专用业务邮箱等方案；当前只准备候选与文案，不连接邮箱、不发信。客户真实回复后，须按原文分类并明确允许的跟进范围，再交给询盘/客户维护流程；拒绝、退订和自动回复不能直接变成营销订阅。

## 现有询盘邮件的内容建议

当前已验收的 Resend 草稿能复述“采购 500 个耳机”并列出澄清问题，但仍偏通用模板。下一轮调 Agent 时：

- 先准确复述已知需求，不重复询问已提供的数量、目的地或时间。
- 首封优先追问影响选品/报价最大的 1–2 个缺口，避免一次罗列所有字段。
- 有真实产品依据时说明推荐型号与匹配理由；尚未确认的价格、MOQ、交期不自行承诺。
- 正文给出明确下一步；语言跟随客户，附件仅来自获准资料并在预览中可核对。

本轮为调查和验收记录，没有修改 Agent 提示词或线上业务代码。

## 依据和复核

- [人员搜索](https://docs.apollo.io/reference/people-api-search)：搜索不返回邮箱/电话；按当前文档为 0 credits。
- [公司搜索](https://docs.apollo.io/reference/organization-search)：按当前文档每页 1 credit；是否可调用以该账号实测为准。
- [API 计费](https://docs.apollo.io/docs/api-pricing)：补全和搜索分别计量，不能将页面剩余额度等同接口已开放。
- [Resend 使用规则](https://resend.com/legal/acceptable-use)：限制 cold outreach 与未获同意的名单发送。

实际复核：`sales_flow/apollo.py`、`test_sales_apollo.py`、Hermes 实施记录、SG6 设计、现有 Sales 部署记录、远端分支 SHA、试用与 API 创建页面。将“试用已开所以 Apollo 已打通”更正为“试用已开，身份通过，两个真实搜索仍被拒绝”。凭据和供应商完整响应未进入文档。
