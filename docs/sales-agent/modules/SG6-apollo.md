# SG6 独立 Apollo 获客与回复交接

实施单元：SG6.0、SG6.1、SG6.2。可在官网MVP之后接入；不阻塞SG1-SG5离线开发。

## 客户账号和授权

每家客户拥有自己的Apollo公司空间。我们人工代管优先使用获批Partner Seat；Agent的OAuth/API连接另行授权。普通Team/名单不是客户隔离边界，父子代理商模式不作为实施前提。本轮不迁移现有共享账号的数据；先登记现有资产归属，客户另行同意后再制定迁移。

API key按workspace权限执行，不能假设低权限用户生成key就低权限；MCP无头master key范围更大。Agent只通过白名单adapter调用获准搜索/研究/活动工具，不同时拿到全部客户master key。开发序列启动、批量入列或外发均属于对外动作，受人批准的活动范围约束。

## 活动与询盘分开

活动保存ICP/目标条件、业务、排除名单、发件邮箱、受众快照/授权选择规则、内容/序列版本、额度、日历及结束条件。人批准的是这一活动范围，不是允许Agent以后任意扩大名单和改稿。重大变更重新批准。活动不附Channel询盘，不借用网站报价模板；官网主动询价的新买家也不因此进入冷开发。

## 回复交接要有原文

```text
Apollo Email replied/活动变化
 → 原生规则先finished/pause，集成核对与补偿stop
 → 从获授权收件邮箱/转入Resend的邮件取得真实回复
 → 固定规则＋Sales分类
 → 有兴趣：明确业务交接；拒绝/退订：禁止相应联系
 → 休假：暂停；缺正文/不明确：人工判断
```

Apollo活动API可发现replied，但Get Email Content只返回己方已发邮件，不提供inbound/replies。不能把该事件ID当作回复正文。reply正文来源是SG6.0的准入证据：授权邮箱转入Resend、其他明确获准接口或人工提供。拿不到时保留reply_detected/needs_human_review，禁止自动升级营销资格。

原生reply rules、OOO与退订策略先登记并测试；再用序列状态API核对停止。停止失败不继续另一边发送；交接记录标stop_pending并通知人。联系人可以入库待分类，不能以入库成功等同停发成功或邮件历史已迁移。已发邮件及Sent/Read/原始线程不自动跨平台完整同步。

```ts
// 目标逻辑
if (!handoff.apolloStopConfirmed) return markStopPending();
if (!handoff.verifiedReplyBodyRef) return requestHumanClassification();
const intent = classifyVerifiedReply(handoff.verifiedReplyBodyRef);
return routeWithinBusinessScope(intent); // 不由分类模型自行授予营销许可
```

## 切片和验收

- SG6.0：workspace/操作者/Agent授权、reply正文来源、序列规则和工具可用性证据。无客户授权时仅准备配置清单，不索要聊天中的密码。
- SG6.1：ICP/候选研究、活动固定版本和批准、受控入列/启动/暂停；保留Apollo本来就有的发送能力，不当Agent新增收益。
- SG6.2：回复事件/补偿扫描、stop确认、正文关联、意图路由和Resend交接。活动API只保留有限近期活动，不能以它作为无遗漏历史流；结合持久webhook和邮箱来源对账。

目标用例 `workspace_a_key_never_used_for_b`、`unapproved_campaign_cannot_start`、`changed_audience_requires_reapproval`、`reply_event_without_body_requests_human`、`stop_failure_blocks_handoff_send`、`ooo_is_not_marketing_optin`、`unsubscribe_not_reimported_as_allowed`、`purchase_reply_uses_authorized_business_only`。

审批例：活动批准人决定受众/文案/发送范围；具体报价批准人确认价格/交期等商务承诺。两者可同一个人，但活动批准不替代未授权的商务报价。客户实际人员分工在接入前填写，不影响先做fake合同。
