# Resend 接入：给负责人照着操作的说明

这次是在客户自己的 Resend 中接邮件能力。官网问答和产品查询可以继续开发，不需要等这些账号资料。我们不会索要客户账号密码，不会现在就发送真实邮件。

## 老板现在需要准备什么

先给普通资料：负责接入的联系人；公司准备使用的发件地址（如 sales@公司域名）、显示名、回复地址；现有官网邮箱由谁提供（如腾讯企业邮）；仅用于验收的收件地址。以上邮箱是例子，不要求另开一个发件地址。

再按下面步骤确认正确的 Team、Inbox 和 API Key。Team 是 Resend 里一整套公司的工作空间，里面有域名、邮件、联系人、API Key 和独立的用量／账单；Inbox 是这套空间里管理一个邮箱地址的收件箱，包含邮件线程、草稿和附件。它们不是额外的“接入参数暗号”。客户只需告诉我们选了哪个公司空间、哪个邮箱，技术人员再读取对应 ID。不要把其他客户的空间选过来。

官方说明：[Team 与成员](https://resend.com/docs/dashboard/settings/team)、[Inbox](https://resend.com/docs/dashboard/inboxes/introduction)。菜单可能随产品版本微调；下文依据官方文档，不代表已进入该客户控制台操作。

## 1. 选对公司空间和邮箱

1. 登录 Resend，点左上角的公司／Team 名称，选客户自己的 Team。如果这里还有其他公司的空间，先核对名称再继续。新建一把 API Key 并不等于新建隔离环境。
2. 左侧打开 **Inboxes**，选准备服务官网客户的邮箱，记录邮箱地址和收件箱名称；已有邮箱就复用。若要新建，点 **Create inbox**，填写地址并选已验证域名。
3. 左侧 **Domains** 核对发件域名为已验证状态。现有腾讯企业邮先保留，后续按已确定的转发方案接收进 Inbox；本步骤不要求老板修改 MX 或迁移全公司邮箱。

我们需要完整的“读来信 → 写草稿 → 修改 → 审批后发信”，不是只发一封通知邮件。客户已开通 Inbox 等能力作为本次设计前提。[域名文档](https://resend.com/docs/dashboard/domains/introduction)

## 2. 选一种安全交接方式

**优先方式：邀请我们自己的账号协作。** 在 **Team Settings → Invite**，填负责接入的技术人员邮箱，选择 **Member**。我们用自己的账号进入客户授权的空间，不共享老板密码。Member 可管理邮件、域名和 Webhook；Admin 还包含成员、账单和删除 Team 等更大权限，接入不应默认要 Admin。官方成员文档没有明确写 Member 能否创建 API Key：如果账号里看不到该菜单，由老板自己完成下一节，再用加密文件交接。合作结束可撤销成员及专用 Key。[成员权限](https://resend.com/docs/dashboard/settings/team)

**无需邀请账号的方式：本机加密后交文件。** Sean 提供单独的 `Resend安全交接.html` 文件，老板双击打开，选择 API Key／Webhook 签名密钥，粘贴相应值，点“生成加密交接文件”，把下载的 `RESEND_API_KEY-encrypted.json`（或对应签名密钥文件）交给 Sean 即可。可以传这个加密文件；不要发原始密钥、密钥截图或账号密码。页面无外部脚本、不联网、不保存输入；只有 Sean 本机的对应私钥能解密。请使用 Sean 直接提供的文件，不使用陌生在线加密网站。

这不是让老板自己找一个密码管理工具。交接页面已经准备好，技术侧用配套命令直接解密到权限为 0600 的私有配置文件，终端不显示明文；正式接入时再写到服务器的密钥配置。此轮只用假密钥测试了这条路径，没有收到客户真实密钥。

## 3. 创建这次接入专用的 API Key

1. 确认左上角仍是正确的客户 Team，打开左侧 **API Keys**，或进入 [API Keys 页面](https://resend.com/api-keys)。
2. 点 **Create API Key**，名称填 `Channel Sales Agent - integration`，方便识别和单独撤销。
3. **Permission 选 Full access**，因为本流程需要读取来信／草稿和修改草稿。**Sending access** 可发信及执行部分 Inbox 动作，但不能满足整条读取、修改流程。域名限制主要约束发送，不应理解成“只能访问某一个 Inbox”。
4. 创建后只会显示一次 `re_` 开头的密钥。直接粘到本机加密交接页，生成文件；不要粘到群聊或本会话。若当场没保存，不要找“查看原密钥”，应撤销旧 Key 后重建。
5. **More options → Edit API key** 可调整权限／发送域名。接入验证结束后按正式运行范围收紧；暂时不用可撤销这把专用 Key。

Full access 的权限较大，是这个 Team 的授权，不是仅对网站询盘的授权。系统仍需固定允许的 Inbox、客户身份和业务范围，模型不能选择其他公司的连接。需要保留别的业务在同一 Team 时，接入代码按 Inbox 和业务标识严格限制，但这不是 Resend 对该 Key 的独立沙箱。

依据：[API Key 管理](https://resend.com/docs/dashboard/api-keys/introduction)、[创建 API Key 与权限定义](https://resend.com/docs/api-reference/api-keys/create-api-key)。

## 4. Webhook 怎么配、由谁配

Webhook 是“Resend 有新邮件／草稿变化时，主动通知我们的后台”的入口。**API Key 不会自动配置收信转发或 Webhook，也不能代替 Webhook 的签名密钥。** API Key 让我们的程序调用 Resend；`whsec_` 签名密钥让我们的程序确认收到的通知确实来自 Resend。

我们先部署并验证公开 HTTPS 接收地址，再在 Resend 注册；当前文档不虚构一个可用地址。老板现在不必填写 localhost 或随手填官网首页。优先由技术人员在授权账号／API 下创建 Webhook，签名密钥直接进入私有配置，无需老板再转交。

需要老板手动配时：

1. 左侧 **Webhooks**，或打开 [Webhooks 页面](https://resend.com/webhooks)，点 **Add Webhook**。
2. **Endpoint URL** 填技术人员正式交付的 HTTPS 地址，核对客户与测试／正式环境；没有地址就先不创建。
3. 选择事件：Inbox 来信用 `inbox.email.received`；监测人工／Agent 改稿与已发送用 `inbox.draft.updated`、`inbox.draft.sent`、`inbox.draft.deleted`、`inbox.email.sent`；投递状态用 `email.delivered`、`email.bounced`、`email.complained`、`email.failed`。按实际用到的动作选，不需要一开始全选。
4. 点创建；在 Webhook 详情保存 `whsec_` 开头的签名密钥。若由老板配，用同一个本机加密页选择“Webhook 签名密钥”交接。
5. 技术人员发合成事件验证签名、重复投递去重、错误租户／Inbox 拒绝、处理结果回执，再单独约真实邮箱验收；老板创建成功不等于系统接入成功。

这里区分了 **Inbox 事件** 与普通域名接收事件 `email.received`，后者不能直接代替 Inbox 的完整线程和草稿事件。通知里没有完整正文／HTML 时，由服务器根据固定 Inbox 身份读取当前内容。审批绑定任务、收件人和版本；来信或改稿后重新核对，不能拿旧批准发新草稿。

依据：[创建 Webhook](https://resend.com/docs/webhooks/create-webhook)、[事件类型](https://resend.com/docs/webhooks/event-types)、[签名校验](https://resend.com/docs/webhooks/verify-webhooks-requests)。

## 技术侧交接命令

配套工具：`scripts/resend-secret-handoff.mjs`。私钥只保存在 Git 工作树之外，目录 0700、文件 0600。重新生成交接页会对应一把新私钥，旧文件要用旧私钥；不要提前删除。接收命令从文件读取密钥，不从命令参数或终端回显中传明文。

```sh
node scripts/resend-secret-handoff.mjs prepare /安全私有目录/private.pem /交付目录/Resend安全交接.html
node scripts/resend-secret-handoff.mjs receive /收到的/RESEND_API_KEY-encrypted.json /安全私有目录/private.pem /安全私有目录/resend-api.env
```

接入后把私有 env 文件通过服务器密钥配置流程导入，禁止提交 Git；可按客户撤销这把专用 Key。Owner 页面与接收脚本均须使用同一版本。实际 API 权限、Inbox 连接、HTML 草稿预览与邮件发送仍需账号到位后的集成验收，本说明不把文档能力当成客户环境已验收。
