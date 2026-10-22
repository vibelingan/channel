# 外部服务能力与接入验收

2026-10-23，按官方公开文档核对。客户全功能开通按既定背景规划，不重新向客户追问套餐。下面的接入验收是实现工作，不是把技术选型交还给客户。

## Resend

| 官方能力与来源 | 设计决定/未证明边界 |
|---|---|
| [发送邮件](https://resend.com/docs/api-reference/emails/send-email)：显式正文/收件人/附件及24小时幂等键 | 固定审核内容发送；本地发送账长期保存，超过幂等窗未知不盲目重发 |
| [线程回复](https://resend.com/docs/api-reference/inboxes/reply-thread-email)：指定目标邮件、正文/附件/CC/BCC | 主To由目标邮件Reply-To/sender或原To决定；预览绑定实际收件人，不能随意覆盖 |
| [创建草稿](https://resend.com/docs/api-reference/inboxes/create-draft)、[更新草稿](https://resend.com/docs/api-reference/inboxes/update-draft) | 可保存HTML/正文/附件；同目标reply draft create并非完整upsert |
| [发送草稿](https://resend.com/docs/api-reference/inboxes/send-draft) | 没有公开expected_version/If-Match合同；不能用get→hash→send证明原子版本审批 |
| [草稿变化事件](https://resend.com/docs/webhooks/inboxes/draft-updated)、[草稿发送事件](https://resend.com/docs/webhooks/inboxes/draft-sent) | 可得对象身份和source；需要补GET详情，source不是具体批准人身份 |
| [验签](https://resend.com/docs/webhooks/verify-webhooks-requests)、[重试重放](https://resend.com/docs/webhooks/retries-and-replays) | 原始body验签、svix-id去重、持久接收；回调不能充当分布式锁 |
| [Team](https://resend.com/docs/dashboard/settings/team) | 复用客户独立Team及连接；Apollo代管授权不涵盖Resend |
| [联系人](https://resend.com/docs/dashboard/contacts/introduction)、[许可说明](https://resend.com/docs/knowledge-base/what-counts-as-email-consent) | 来源/业务/订阅分开。人工批准邮件不等同收件人同意营销 |
| [原生Inbox Agent设置](https://resend.com/docs/api-reference/inboxes/update-agent) | 有原生Agent动作；接入时登记，避免与Hermes同任务双执行，不说Resend没有Agent能力 |

本轮没有确认普通`POST /emails`邮件在客户原生Inbox里的完整展示与线程自动归属，也没有登入验证原生草稿直达链接/附件预览。审核主路径因此使用需鉴权的固定预览；保留Resend工作副本和人工接管。基础接口可实现，不等于全部原生界面行为已验收。

## Apollo

| 官方能力与来源 | 设计决定/未证明边界 |
|---|---|
| [Partner Seat](https://knowledge.apollo.io/hc/en-us/articles/44815591985421-Access-Client-Accounts-as-an-Apollo-Partner) | 客户独立公司空间＋获授权人工代管；不是发给客户的沙箱，不自动给Agent连接授权 |
| [认证](https://docs.apollo.io/reference/authentication)、[MCP](https://docs.apollo.io/docs/apollo-mcp)、[OAuth](https://docs.apollo.io/docs/use-oauth-20-authorization-flow-to-access-apollo-user-information-partners) | key按workspace执行，OAuth按授权用户；master key需受控，不能多客户一起暴露模型 |
| [Workflow](https://knowledge.apollo.io/hc/en-us/articles/4413804036109-Create-a-Workflow) | Email replied事件及webhook可用；并未证明webhook含完整回复正文 |
| [Sequence活动](https://docs.apollo.io/reference/get-contact-sequence-activity) | 有replied等事件，但近期数量有限，无历史分页；不当完整历史来源 |
| [获取邮件内容](https://docs.apollo.io/reference/get-email-content) | 只返回己方已发邮件，不返回inbound/replies；正文另从授权邮箱/Resend/人工取得 |
| [更新联系人序列状态](https://docs.apollo.io/reference/update-contact-status-sequence)、[Sequence规则](https://knowledge.apollo.io/hc/en-us/articles/4409396858509-Manage-Sequence-Rulesets) | 原生reply/OOO/退订策略先设置，API检查/补偿停止；停发失败不继续交接外发 |

Apollo获客与网站询盘可以独立实现。客户服务许可、Partner资格、具体授权及其现有共享账号的资产归属仍需开户/接入窗口处理；不以旧代理商子账号文章或普通名单分组作为隔离证据。此轮不复述历史价格，避免把2026-10-15价格当成今天的报价。

## 不以真实账号阻塞的开发范围

schemas、fake provider、Source adapter合同、任务/文件隔离、固定审核、控制/发送竞争测试都能离线开始。真实Resend投递/Inbox体验、Apollo回复正文来源、实际部署身份及跨客户负向测试必须各自有证据才打开对应功能。
