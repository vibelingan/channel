# 向客户收集 Resend 接入资料

官网助手的前后端开发可继续，不依赖 Resend 账号。本轮不连接客户 Resend，不发真实邮件。

现在请客户准备：

1. 客户自己的 Resend Team 下，专为本次集成创建一把 API Key，使用安全的密钥配置渠道交付，不贴进聊天或群。完整流程涉及读取邮件、更新草稿、联系人和 Webhook，需 Full access；仅创建／发送 Inbox 草稿可以用 Sending access，但不能完成完整的读取和修改流程。
2. 确定接入哪个 Team、哪个 Inbox；提供名称和 Inbox ID，区分官网询盘、维护与其他渠道的业务归属。完整 Key 可以访问所属 Team 的其他资源，新建 Key 本身不是业务隔离。
3. 使用的已验证域名、发件地址、显示名称、Reply-To；收信是 Resend 直接接收，还是现有企业邮箱转发。已有配置先保留，实施时再核对接口和切换。
4. 一个明确获准的测试收件地址。审批人员及发信范围沿用已批准业务方案，尚未确定的人员由客户补充。

Webhook URL 和签名密钥等回调接口准备好后再配置。程序验证签名使用原始请求体；API Key 与 Webhook signing secret 是不同的凭据。客户可邀请受权开发人员协作，也可自己配置；不需要向我们提供账户密码。

后端保存 Team／Inbox／业务绑定并决定可用操作，模型不能拿到原始 Full access Key，也不能自己选其他客户的连接。即便 Key 具备发送能力，应用仍要按审批门禁决定是否发送。

官方资料，2026-10-30 阅读：

- [API Key 权限](https://resend.com/docs/api-reference/api-keys/create-api-key)：Sending access 支持回复、转发、创建草稿和发送草稿；Full access 可操作其他资源。域名限制针对 Sending access。
- [Inbox 草稿](https://resend.com/docs/api-reference/inboxes/create-draft)：操作归属于 Inbox ID。
- [Webhook 验签](https://resend.com/docs/webhooks/verify-webhooks-requests)：签名密钥属于回调端点，使用原始请求体验签。
- [域名](https://resend.com/docs/dashboard/domains/introduction)：外发域名需要验证，已有域名／地址可复用。
