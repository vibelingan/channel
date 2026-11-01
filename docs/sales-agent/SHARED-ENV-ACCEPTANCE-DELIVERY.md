# SG1.2：现有云库中的询盘保存验收

2026-11-01。用户已授权在当前 Channel 环境写入明确标记的新功能测试数据，本轮不再以独立云环境为前置条件。

## 已完成

目标为上海 `diversity-123-d9grnqfux221323bb`，与官网共用环境。新增三个仅服务器可访问的集合：`channelSalesInstallations`（安装归属）、`channelSalesSourceRegistrations`（已确认询盘来源）及 `channelSalesSourceDeliveries`（待派发记录）。原询盘仍在 `oemProjects`，未创建第二套询盘业务库。

专用 Event Function `sales-assistant-acceptance-20261101` 复用正式 `createAssistantInquiryStore` → `saveFinalizedOemInCloud` → node-sdk 事务，接受固定请求、固定测试身份和固定合成内容，不能指定其他客户或地址。不调用模型、产品服务或邮件服务。客户端调用关闭，无 HTTP 网关和定时触发器；管理端调用可以执行。函数权限配置保留原通配规则，仅增加该函数的禁止客户端调用规则，并读回确认。

真实数据库第一次执行 4,584 ms，通过以下检查：

- 正常保存，以及相同提交 key 重试返回原回执。
- 相同 key 修改需求被拒绝。
- 三次并发提交只有一个询盘 ID。
- 包裹本次事务，故意在最后一笔待派发写入前抛错；询盘、来源和待派发三份记录均不存在，证明实际事务已回滚；随后原 key 重试成功。
- 正式来源读取能读到完整需求，配套来源登记和待派发记录一致。

首次请求 ID `59624397-392b-47d9-b815-eaecec01e21c`。再次执行请求 `10ecf5fa-331a-47cd-90a0-410bf79d8941` 返回原回执，保留原 ID；重试报告将回滚标为“先前已恢复”，没有冒充又做了一次故障注入。

使用另一管理端查询通道回读，确认 3 条合成询盘、3 条来源和 3 条 pending。加上 1 条安装登记，共 10 条新记录。公司名均为 `[TEST sales acceptance 20261101]`，邮箱为不能投递的 `acceptance@example.invalid`。完整 ID 清单、返回值、包哈希和独立回读见 [证据](evidence/assistant-cloud-acceptance-20261101.json)。本轮保留这些标记记录供验收；后续清理只能按清单和归属核对，不能清空集合。

## 检查和部署范围

新增探针的本地回归纳入原 Sales 套件，112 项通过；类型检查、独立打包和冷加载通过。SDK 合同门禁通过；原助手保存的 4 处缺陷注入全部被测试抓到。格式化后重建包的 SHA-256 与云端验收使用的包相同。3 项新增测试分别检查完整验收及重复执行、已有登记归属冲突不写入、管理请求额外字段被拒绝。原保存代码、SDK 和原事务没有修改。SDK 实际返回形状与安装的 node-sdk 3.17.2／database 1.4.3 一致，真实云端执行再次验证了这一点。

两轮自查分别核对操作范围／事务与测试可信度：固定测试身份；已有登记只读核对，不覆盖；回滚在真实事务内注入；成功回执不代替独立读回；无真实收件地址和发送调用。构建复用现有 tsup 配置，单独输出到 `dist/acceptance`，不覆盖原 Sales 运行包。

没有部署或更新现有 admin、public-api、SEO、blog、官网静态文件，也没有启动 Sales 派发器、改 Hermes 进程或现有机器人。新增函数创建前记录了原 6 个函数状态。新增集合权限读回为 ADMINONLY，专用函数没有触发器。

## 已验证与仍未验证

本次是**正式保存代码对真实 CloudBase 的验收**。前轮已有浏览器组件 → BFF/PostgreSQL → Channel 事务替身 → Hermes/MySQL → 待审核成果的本地和 CI 端到端证据；两者不能拼称为“浏览器到真实云库再到线上 Hermes”的一次完整验收。

接下来仍需完成真实模型与 VibeKB 公开检索接线，以及新助手服务到实际 Channel 询盘接口的部署联通。当前官网聊天 worker 只支持 fake／旧 AnythingLLM；VibeKB MCP 不能通过改名或填 API Key 自动接上。Resend／Apollo 账号并非本轮不发邮件验收的前置要求。相关步骤见 UI 分支 `docs/ai-platform/assistant-ui/REAL-CHAT-SETUP.zh-CN.md`。

文字复核读取本报告、原保存／事务／来源代码、验收探针、旧环境核对文档及 worker 的 engineFromEnvironment。将“缺独立云环境”修正为“现有环境已完成标记数据验收”；将“真实聊天只缺账号”修正为“还缺 VibeKB／模型适配与实际部署联通”，以实际代码和云端读回为准。


## 远端交付

实现与云库证据已推送 `feat/sales-agent-integration`，代码提交 `9dd50534a44895895c4876e37f89687c3454017f`。[该 SHA 的 Sales CI](https://github.com/vibelingan/channel/actions/runs/41303276847) 全部通过，耗时 4 分 23 秒，包含原 DB／admin／public-api／local-server 回归、合同互通、缺陷注入、SDK 门禁和新验收包冷加载。后续本文件的补充只记录 CI 结果，不改变运行代码。UI 账号步骤与环境说明已推送 `feat/website-assistant-ui-foundation` 的文档提交 `fad0b8da8d8c79009b21bc352c3ec6aa7fc57ef6`。
