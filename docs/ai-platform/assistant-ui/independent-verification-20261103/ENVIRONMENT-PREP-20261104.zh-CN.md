# AI 上线环境准备：2026-11-04

本轮按负责人要求准备环境和密钥交接，不处理数据库，不合并或部署。

已完成：

- 核对远端 Hermes 的现有模型配置：腾讯 TokenHub，deepseek/deepseek-v4-pro；与 GitHub test 环境的非秘密变量一致。
- 将缺失的 AI_MODEL_API_KEY 和 VIBEKB_MCP_API_KEY 写入 vibelingan/channel 的 GitHub test 环境。只添加这两项，读回名称和更新时间确认存在。未读取或修改原 DATABASE_URL。
- 生成 Git 外的跨电脑交接包：服务配置用 age 公钥加密；配套解密身份另用随机口令加密。原始平台凭据没有写入明文交付文件、终端输出或仓库。
- 验证身份口令加解密、服务配置解密及原文一致；检查压缩包不含明文身份或口令。口令经程序写入负责人本机剪贴板，未显示在聊天。

待办：

- 负责人明天处理 PostgreSQL 和新的 DATABASE_URL。
- 等 Claude 电脑的 SSH 公钥，再将该公钥加入 Hermes 的获准登录用户。当前未用其他电脑的公钥代替。
- Claude 负责 nginx /mcp 转发到现有 127.0.0.1:9021、真实联测、部署前确认和后续发布。本轮未修改 nginx、SSH 授权或 Agent 配置。

配套 README 提供另一台电脑解密步骤。现有 GitHub 工作流可直接读取上述 Secret，一般无需让 Claude 把密钥正文放入聊天。交付密文及解锁材料均不进 Git。

本轮实际读取：secure-key-handoff 技能及 age 备用说明、远端现有 relay 配置、最新 ROADMAP、CloudRun 变量定义和 GitHub Secret 名称清单。将“准备好了上线环境”收窄为“密钥已配好，数据库、SSH 公钥和 MCP 转发仍有待办”，避免把交接完成说成已上线。
