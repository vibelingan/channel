# 真实聊天与询盘：当前接线和操作顺序

2026-11-02。当前交付见 [真实模型与 VibeKB](REAL-CHAT-DELIVERY.md)。不需要你再开云账号或给 Resend／Apollo Key 来测试官网聊天。

1. 腾讯云授权已完成，沿用上海现有 `diversity-123-d9grnqfux221323bb`。仅写本轮带 TEST 标记的合成询盘。
2. 已核对 Hermes 的实际配置：腾讯 TokenHub `deepseek/deepseek-v4-pro`；VibeKB 为官方 Streamable HTTP MCP，workspace 2。新官网代码已新增 VibeKB adapter，旧兼容路径不参与本轮新聊天。
3. 本地验收通过 SSH 调用现有模型和 MCP，原有密钥保留在原服务器；不改现有机器人和服务配置。公开知识只允许明确登记且带公开标签的文档，目前启用最终品牌文档 12。其余内部资料、未确认版本和博客草稿不提供给模型。
4. 原 BFF、worker、PostgreSQL 和 React 组件在本机运行；实时产品来自原公开 HTTP 接口，询盘通过原 Channel 保存事务写入云库。聊天建议不等于正式提交，必须由访客核对并勾选同意。
5. 验收入口、问题脚本、逐项结果与截图见交付文档。官网原开关仍保持原值；本地通过不代表已经替换正式网站。

后续部署由开发安排服务身份、固定 MCP 通道、私有运行数据库、公开目录来源和入口开关，不能直接把本机 SSH 验收脚本当长期运行方案。生产模型应使用获准的独立服务凭据。若需要负责人提供新的授权，会给具体操作步骤；当前本地工作不需要你操作。

邮件草稿、审批与 Resend 发送属于后续邮件模块。确认询盘的本轮验收不需要邮件发送权限，也不发送确认信。

正式进程直接复用原 worker 的 `engineFromEnvironment()`。使用 `.env.ai-runtime.example` 中的 VibeKB 配置段，并显式配置 BFF 的 `AI_INQUIRY_ENABLED`、固定 `AI_INQUIRY_BASE_URL` 和专用 `AI_INQUIRY_TOKEN`。原 `docker-compose.ai.yml` 与 `dev:ai:full` 仍是早期兼容环境，不会自动透传这组新参数；本轮真实本地验收使用 `scripts/assistant-real-browser.mts`，不能把启动旧 Compose 当成启动新助手。
