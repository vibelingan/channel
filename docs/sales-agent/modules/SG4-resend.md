# SG4 Resend 邮件与联系人适配

实施单元：SG4.1、SG4.2、SG4.3。官方接口依据见 [PROVIDER-CAPABILITIES](../evidence/PROVIDER-CAPABILITIES.md)。

## 选定路径

Resend沿用客户自己的Team、inbox及公开业务地址。Agent通过受控适配层访问；不是把Agent迁到Resend，也不开发第二套完整邮箱。现有企业邮可继续收信再转入Resend，不要求为表单另开公开地址。域名发信验证、转发回路/重复、Reply-To及真实投递必须在接入时验收，不在本轮改MX。

适配层归发布助手可调用的工具服务。候选代码在Hermes销售流程adapter范围，不把Channel SMTP包整体替换。接口实现按原有技术栈选HTTP客户端，SDK版本在实施时固定。

## API和完整内容

- 新询盘、确认信：`POST /emails`，显式传冻结的from/to/cc/bcc/html/text/attachments/headers及稳定幂等键。
- 线程回复：固定inbox/thread/email目标，调用thread-email reply，正文与附件来自审核版本。主To按目标邮件解析，变更主To必须新审核显式发送路径。
- 草稿：保存于Resend，映射内部task/version。reply draft create可能复用已有ID但不更新全文，使用get/update确保工作副本正确，不当完整upsert。
- webhook：验签、映射客户、持久去重、排队、读详情、转内部事实。邮件received/sent、草稿变化和bounce/complaint等分别处理。

```ts
// 目标接口：Agent无权提供新的收件人或正文。
async function dispatchApproved(approvalId: string): Promise<ProviderReceipt> {
  const payload = await gateway.loadApprovedFrozenPayload(approvalId);
  return provider.sendExact(payload, payload.stableIdempotencyKey);
}
```

附件从已授权存储读取并核对hash，发送实际bytes；不让provider临时取可变的公开链接。HTML中的图片也要有稳定版本与允许的投递地址；敏感文件不能做公开图床。预览HTML经过渲染安全处理，最终邮件不带内部注释/secret。邮件客户端可能有渲染差异，审核页展示确定HTML/附件，真实测试邮箱检查主要客户端效果。

## 收信、联系人与人工工作

邮件事件关联inbox/thread/email＋source/task映射；未知线程不按email自动套用某个Channel询盘。人工补充匹配可以产生新明确关联。直接写官网邮箱的来信进入同一Resend收件层，首期通知人，可按需建立Sales任务；它没有网站询盘记录时不伪造一条表单提交。

联系人upsert保留source多值、business资格及订阅信息。只同步联系人不自动加到营销受众。退订/拒绝记录优先，重复导入不能复活资格。原生Inbox Agent能力须在接入时登记配置，避免Hermes与原生Agent同时起草/转发；不默认更改客户设置。

## 实施与切换

- SG4.1：fake与真实adapter合同，草稿get/update、显式发送、reply、附件、幂等及错误分类。最先只启draft_only；真实发送受SG5控制。
- SG4.2：事件持久接收/去重/乱序处理、联系人同步和回信通知；这些都是程序服务，不交模型定时轮询。
- SG4.3：固定确认模板及版本、cutover检查、旧OEM确认路径单独开关、一次发送账；密码重置路径不动。与SG5受控发送共用结果记录。

确认模板原来的“24小时回复”是商业承诺，重新获批才保留。模板可预批准自动发送，无须逐封人审。模板版本不变也须校验客户和原询盘收件人，不能拿固定模板绕过收件人限制。

## 验收

`draft_roundtrip_preserves_html_and_attachments`、`reply_to_resolves_actual_recipients`、`reply_create_is_not_assumed_upsert`、`wrong_inbox_webhook_rejected`、`webhook_replay_no_duplicate_action`、`send_timeout_uses_same_key`、`unsubscribe_not_restored_by_import`、`only_one_ack_path_enabled`、`password_reset_unchanged`。

真实环境还须确认`/emails`邮件在客户Inbox的展示/线程结果；未通过时保留provider发送ID和内部审计，明确展示限制，再选择可用的Inbox发送路径或人工接管。不能把基础发信成功当作整套原生工作台验收通过。
