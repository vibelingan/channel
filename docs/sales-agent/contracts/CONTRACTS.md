# 接口与数据规则 v0.1

2026-10-23 · 以下内部路由和数据结构均为待实施合同，不是现有 API。官方服务的实际接口见 [能力依据](../evidence/PROVIDER-CAPABILITIES.md)。字段由 SG0 先冻结；运行机制依 [状态规则](STATE-AND-CONCURRENCY.md)。

## 1. 身份与范围

`client_id` 指购买我们服务的公司，`business_line` 指该公司授权处理的业务，`source_record_id` 指原业务记录，`contact_id` 指终端买家。三者不能靠邮件域名、群名称或模型猜测推导。

服务端根据已认证连接查固定的 `ClientBinding`。调用携带的 client_id 只用于一致性校验，不能获得权限。陌生连接、已撤销连接、越权业务和不匹配 inbox 均拒绝。公开官网客服不能调用私有 Sales 资料或发送工具。

```ts
// 目标数据形状；不是当前实现。
type ClientBinding = {
  client_id: string;
  business_lines: string[];
  source_installation_id: string;
  runtime_id: string;
  knowledge_scope_ref: string;
  credential_refs: { channel: string; resend: string; apollo?: string };
  allowed_sender_ids: string[];
  permitted_operator_ids: string[];
  automation_mode: 'disabled' | 'draft_only' | 'test_sending' | 'approval_required';
  test_recipient_allowlist: string[]; // test_sending下所有受控外发强制执行
  environment: 'test' | 'production';
  control_epoch: number;
};
```

凭据引用由服务端解析。密钥不写入模型上下文、群消息、附件、链接或普通日志。Partner Seat、Apollo OAuth、Resend Team 成员、企微操作人和 Channel 管理员是不同授权，分别绑定、撤销。

## 2. 正式询盘事件

运行schema及生成类型见packages/sales-contracts；此处原有schema/样例相对链接指向唯一包来源。以下形状目前只完成SG0.1离线校验，不代表接口或授权已实现。

统一事件由 Channel 适配器从已保存业务记录产生；`inquiry.schema.json` 及 [样例](inquiry.example.json) 给出最小可校验形状。事件带事实及有限摘要，不携带完整聊天。不同原表保留自己的 ID。

```ts
type InquirySubmitted = {
  schema_version: '1.0';
  event_id: string;
  client_id: string;             // 发送端认证绑定确定
  business_line: string;
  source_installation_id: string;
  source: 'website_oem' | 'website_product' | 'website_assistant';
  source_record_id: string;
  source_revision: string;
  submitted_at: string;
  contact: { email: string; name?: string; company?: string };
  requirements: { confirmed_summary: string; quantity?: number };
  product_snapshot_refs: string[];
  attachment_refs: string[];     // 授权对象引用，不是永久公开URL
};
```

事件身份以客户＋安装＋原记录＋`inquiry.submitted` 为准；修订事件另起类型，不能因后台写备注或状态增加而再触发一封确认。`event_id` 由发送端持久保存或从稳定业务键推导，重试不换 ID。业务修订可使未发稿失效，不重复确认或创建全新根任务。

来源仍按 OEM/单品区分；客服来源需要表单确认的 `initiated_by_assistant` 标记才能可靠统计，不能根据模型文案猜。若原系统暂不提供该标记，先记实际表单来源，保留后续扩展。

## 3. 目标 API

| 提供方及路由 | 输入/输出 | 身份和重试规则 |
|---|---|---|
| Channel `GET /integrations/sales/inquiries?cursor=...` | 有权限的已提交记录及游标 | 后端固定客户/安装；分页快照、重叠窗口及周期补扫 |
| Channel `GET /integrations/sales/inquiries/:kind/:id` | 需求、提交快照、记录版本、允许的附件引用及可执行状态 | 只返回绑定业务，`kind` 枚举，未知/越权不能读出存在性 |
| Channel `POST /integrations/sales/products/query` | 限长检索/ID → 批准字段、版本、可用资料 | 参数白名单；默认公开资料，私有资料另授权 |
| Channel `GET /integrations/sales/assets/:ref` | 检查询盘/产品归属后返回文件 bytes | 限大小/MIME；不接受任意URL、不返回桶密钥 |
| Hermes `POST /integrations/channel/inquiries/events` | InquirySubmitted → `202 {receipt_id, task_id}` | 持久化成功才确认；相同业务事件返回稳定任务；不等模型运行 |
| Hermes `GET /sales/tasks/:id` | 状态、当前版本、成果/来源关联 | 客户范围检查；不返回其他客户、密钥或未经授权全文 |
| Hermes `POST /sales/tasks/:id/commands` | ControlCommand → 审计回执/异步操作ID | 认证操作人＋预期版本＋幂等键；重复批准返回同一结果 |
| Hermes `GET /sales/tasks/:id/versions/:version/preview` | 固定 HTML/文本、附件清单及依据 | 需登录及任务权限；不将链接当批准令牌 |
| Hermes `GET /sales/tasks/:id/versions/:version/assets/:asset` | 固定审核文件 bytes | 同一任务/版本授权；短期下载，避免公共缓存 |
| Hermes `POST /sales/tasks/:id/artifacts` | 有范围的运行身份提交成果清单 | customer/task/run 绑定；manifest/hash 校验，不信模型自报归属 |
| Channel `POST /integrations/sales/inquiries/:kind/:id/receipts` | 少量任务/成果/执行引用 | SG8可选；稳定 event_id、单调 revision；失败独立重试 |
| 邮件适配层 `POST /webhooks/resend/:connection_id` | 原始provider事件 | secret验签＋inbox映射＋svix-id去重；快速落盘后入队 |
| Apollo适配层 `POST /webhooks/apollo/:connection_id` | 配置的Workflow事件 | 连接级认证、防重放；不假设具备Resend/Svix签名机制 |

GET读取可安全重试；POST 持久状态以业务幂等键去重。429按官方响应等待，5xx/网络错误退避。401/403/撤权不无限重试。来源永久缺失或格式错误进入隔离队列，通知负责人。响应不含凭据；日志只记录身份、散列、引用及结果。

## 4. Sales 输入和产物

```ts
type SalesRunContext = {
  schema_version: '1.0';
  client_id: string; business_line: string;
  task_id: string; run_id: string; runtime_id: string;
  source_ref: { installation_id: string; kind: string; id: string; revision: string };
  control_epoch: number; inquiry_snapshot_ref: string;
  output_dir_ref: string; allowed_tools: string[];
};
type MailSnapshot = {
  schema_version: '1.0';
  task_id: string; client_id: string; business_line: string;
  logical_message_id: string; // 一封邮件的稳定身份，改稿不变
  version: number; source_revision: string; context_epoch: number;
  sender_id: string; from: string; reply_to: string[]; to: string[]; cc: string[]; bcc: string[];
  approved_headers: Record<string, string>; // 只允许白名单，不可覆盖地址/身份头
  subject: string; html_ref: string; text_ref: string;
  attachments: { artifact_id: string; filename: string; mime: string; size: number; sha256: string }[];
  evidence_refs: string[]; unresolved_items: string[];
  reply_target?: { inbox_id: string; thread_id: string; email_id: string };
  content_sha256: string; resend_draft_id?: string;
};
```

快照由程序固定：地址trim、domain转小写但保留local-part，拒绝CR/LF及类别冲突，保持To/CC/BCC类别与展示顺序。HTML先校验并完成安全处理，再固定实际HTML/文本及附件bytes；预览和发送读取同一份已固定内容。Reply-To、允许的固定headers及实际发件身份也进入审核对象。摘要使用UTF-8、字典键按Unicode序稳定排序、无额外空白的JSON；此合同只允许字符串、整数、布尔、数组、对象及null，不使用浮点。正文/附件以实际bytes的SHA-256引用参与摘要，数组保留顺序。SG0.1为TS/Python提供同一canonicalization向量，未通过不计算跨语言批准hash。相同hash对应同一份精确内容，不是“意思差不多”。不得在发送前替换附件URL对应文件或再让模型润色。

来源是提示材料，不是可执行指令。客户邮件、附件、产品描述不能授予新工具权限或变更发件身份。价格/交期/MOQ等必须关联获批事实；缺项生成问题和内部提醒，不把未经确认的承诺写进可批准稿。结构校验与事实核验由程序/规则完成，skill负责工作方法，两者配合。

## 5. 人工控制和发送凭据

```ts
type ControlCommand = {
  schema_version: '1.0';
  command_id: string;
  action: 'revise' | 'approve' | 'reject' | 'pause' | 'takeover' | 'resume';
  expected_task_revision?: number; // approve/revise/reject/resume必填；pause/takeover对最新状态生效
  target_version?: number;
  target_content_sha256?: string;
  instruction?: string;
};
// actor、client、角色从已验证会话/企微绑定注入，不接受模型自报。
type Approval = {
  schema_version: '1.0';
  approval_id: string; client_id: string; task_id: string; logical_message_id: string;
  operator_id: string; channel: 'wecom' | 'web';
  snapshot_version: number; content_sha256: string;
  sender_id: string; recipients_sha256: string;
  control_epoch: number; context_epoch: number;
  approved_at: string; expires_at: string;
};
```

测试阶段由服务器固定test_recipient_allowlist和测试身份；确认信、回复、维护及Apollo测试活动统一约束实际To/CC/BCC与发件连接。采用独立合成测试任务，不把真实买家To改成测试邮箱而继续沿用真实业务归档。原生平台手动操作不受我方网关控制，测试使用隔离测试环境/明确操作限制。

`approve` 必须绑定 snapshot 和主体权限；scope包含该业务及允许发件邮箱。网关由 Approval 读取真正 payload，模型不得向 send 动作另外传 to/html/attachments。reject必须指定目标版本；revise必须有非空指令；这些只校验数据形状，是否获权仍由后续控制后端判断。

首期建议审批有效期24小时（产品默认建议，非官方要求，可按客户规则调整）；新来信/改稿/暂停等即使未过期也撤销批准。

批准/恢复/改稿需要严格匹配预期revision。暂停/接管由有权操作人针对同一任务最新状态原子执行，即便页面revision已旧也不拒绝安全停止；返回在途发送范围及结果。任务身份/客户授权仍不可省略。

企微自然语言只产生候选命令。已明确任务和版本且操作人有权限时可以执行；对象不明时返回任务选择/确认卡片，不默认取最新。审批页及企微卡片均引用同一版本。一个人的两个入口、两个人重复批准，均只能生成一个逻辑发送操作。

## 6. 审计和联系人

事件包括 `client_id/task_id/run_id?`、本地单调序号、event_id、发生/接收时间、actor、原因、对象版本、操作结果及provider ID。`received_at` 与provider时间分别保存；乱序回调不按时间直接覆盖状态。任务、快照、批准、发送由各后端程序记档，不依赖模型主动调用归档。

联系人以 `(client_id, provider_contact_id)` 关联，email归并限定客户并保留业务/source多值。`marketing_permission` 为 unknown/allowed/denied，证据、目的/Topic与时间独立保存。维护发送要求对应许可；普通询盘回复也要遵守拒绝联系等规则。人工批准内容不等于替联系人授予营销许可。

`ChannelReceipt` 只存来源引用、task_id、artifact_ref、send_operation_id/provider_id、状态与 revision/时间。它是已同步事实，显示同步时间；不声称实时Agent状态。第一期即使不回写，Hermes留档仍为必需，不能只靠群消息或临时文件。

## SG0.1共同格式

数据合同1.0要求邮箱为ASCII addr-spec/DNS域名并拒绝CR/LF；时间为0001至9999年、UTC大写T/Z、秒00至59和最多6位小数。JSON安全整数、根值深度0至64、原始输入/固定JSON最多262144字节。改稿空白字符集合由schema明确列出，避免两种语言的`\S`差异。该包只校验元数据；真实正文/附件的hash、地址类别冲突和授权在后续冻结/发送层验收。
