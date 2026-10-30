# Resend 接入：请按这条顺序操作

这次不需要邀请技术人员账号，也不用提供账号密码。请创建一把接入专用 API Key，加密后交给 Sean：

1. 登录 Resend，点左上角公司名称，选贵公司自己的工作空间。
2. 打开左侧 **API Keys**（也可直接进入 [resend.com/api-keys](https://resend.com/api-keys)），点 **Create API Key**。
3. 名称填 **Channel Sales Agent**，**Permission 选 Full access**，然后创建。这项权限允许程序读取来信、修改草稿和发送邮件，范围覆盖该公司空间，请使用专用 Key。
4. 复制刚显示的 `re_` 开头密钥。双击 Sean 提供的 **Resend安全交接.html** 文件，保持选择 **Resend API Key**，粘贴密钥，点 **生成加密交接文件**。密钥只在创建时显示一次，不要发送明文或截图。
5. 把下载的 **RESEND_API_KEY-encrypted.json** 文件发给 Sean，即完成本次资料交接。

官网目前公布的邮箱是 **sales@supplychainsai.com**，本次拟沿用它作为对客发件／回复地址。后续由技术侧检查 Resend 的发件域名、该邮箱收信接入和 Webhook；需要调整 DNS 或邮箱转发时，我们会给出具体操作，老板现在不用自行修改。

依据：[官网邮箱](https://supplychainsai.com/)、[Resend 密钥管理](https://resend.com/docs/dashboard/api-keys/introduction)、[权限说明](https://resend.com/docs/api-reference/api-keys/create-api-key)。
