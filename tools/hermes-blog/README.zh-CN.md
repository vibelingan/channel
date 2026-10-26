# 本地内容助手的草稿工具

本工具只有“保存草稿”和“查询自己的导入结果”两个能力。不能发布、撤回、删文、列出他人的草稿或读商品价格。它调用网站的独立article-import接口；不修改HermesInfra代码或生产配置。

在仓库中运行`npm ci --prefix tools/hermes-blog`安装锁定的MIT开源MCP SDK，再用Node22启动`tools/hermes-blog/server.mjs`。HTTP读取复用仓库已测试的限时、限量读取器，因此需要保留完整仓库，不是单独复制server.mjs。

隔离运行配置需要以下环境变量；实际凭证只放在本机权限受限的文件或部署密钥管理中，不提交仓库，不发聊天：

- CHANNEL_BLOG_API_ORIGIN：固定为当前CloudBase服务域名。
- CHANNEL_BLOG_SITE_ORIGIN：固定为https://supplychainsai.com。
- CHANNEL_BLOG_CREDENTIAL：keyId.secret形式的受限凭证，只有草稿权限。
- CHANNEL_BLOG_INTEGRATION_ID：与服务端凭证记录相同的集成编号。
- 本次隔离模拟另固定CHANNEL_BLOG_TASK_ID和CHANNEL_BLOG_DRAFT_KEY，两者一起配置。运行控制程序在生成开始前保存它们，模型不能换号创建第二篇。

每次请求最多15秒，整个正文最多32KiB响应；只对明确的临时网络错误及502/503/504有限重试三次。复用相同正文和业务编号；409、权限错误、过大响应或不合法回复不换号、不自动放宽。编辑链接、文章号及操作号必须同时符合本次任务，确认成功才交给助手。

接入本地Hermes时新建独立HERMES_HOME，只启用这两个MCP工具，不复制全局工具配置或接入企业微信群。现有HermesInfra、生产Agent、用户正常会话和账号配置都保持原状。真实模型调用、网站存储、人工预览/发布与公开HTML要分别验收；npm test通过只证明离线合同和MCP协议测试。

服务端入口尚未部署时，不将工具配置成“已连接”。轮换或停用凭证不会删除客户草稿。网络失败时先用原操作号查结果，不能通过修改编号来绕过去重。

本机 Hermes 0.20 的真实初始化已验证：隔离目录使用 `~/.hermes/profiles/<本次名称>`，让它按原生规则读取已有登录；任意 output 临时目录会被当成新的根目录，没有这项认证回退。不要复制认证文件。此配置只适用于已核对的本机版本，云端需重新核对认证方式。

本次 MCP 配置只包含 channelblog；`tools.include` 明确列出上述两个工具、`sampling.enabled=false`、`tools.tool_search.enabled=off`。自己审查过的该 MCP 使用 `trust: full`；`trusted` 不是有效值。初始化后还要断言实际工具名恰好两项，才允许调用模型；不能只相信配置文件。全局配置不改，凭证不交给模型。初始化通过不代表模型创作或真实保存通过。
