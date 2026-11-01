# 助手询盘与 Hermes 自动任务：前轮交付

2026-11-02 更新：真实模型、VibeKB、公开产品与云端保存的最新状态见 [本轮交付](REAL-CHAT-DELIVERY.md)。下文保留前轮验收范围，不能用其当时的待办代替当前状态。

2026-11-01。SG1.2／SG3.2 延续原编号。前轮补齐跨系统接缝；本轮追加现有云库真实验收，仅新增专用验收函数和 Sales 私有集合，未发送邮件。

## 现在验证到哪里

实际助手核对组件 → 实际 BFF 与会话 PostgreSQL → Channel 内部询盘接口／原保存事务 → 原通知器 → Hermes 接收与 dispatcher → 自动消费者 → 一份待审核成果。

浏览器测试从原 Prepare inquiry 按钮进入，核对客户需求与同意后提交；不是伪造 Hermes 事件。测试后台先启动轮询，不需要按每条询盘下销售启动命令。故意丢失第一份成功回执，核对原提交后仍只有一个询盘 reference、一个 task/run 和一份归档。

这是实际组件与服务代码的隔离验收。Channel 文档库仍是事务替身，产品与模型为本地样例；BFF PostgreSQL 与 Hermes MySQL 为本次创建的真实独立数据库。此前这轮本地／CI 结果没有证明真实模型、VibeKB MCP、线上调度或真实 CloudBase。2026-11-01 已另行完成真实 CloudBase 保存／去重／回滚／回读；真实模型与完整线上串联仍未验收。

## 发现并修正了什么

Hermes 原严格 OEM 读取只认识老字段，会拒绝已保存的助手询盘；模型输入和邮件模板还会丢失助手完整需求。已在 Hermes Sales 分支增加明确的助手字段分支、产品留档一致性检查，以及完整需求的传递与安全转义。旧 OEM／单品规则继续保留，未新增模型工具或发送权限。

UI 分支新增的 `scripts/assistant-sales-browser.mts` 只用于本地／CI：启动独立端口、使用实际 BFF，拒绝外部地址与非专用测试数据库；复用现有 `waitForDatabase` 等待临时数据库就绪，并阻断浏览器外部请求。没有再开发一套聊天界面。

本地助手 E2E 4 项、原自动消费回归 33 项通过；新增字段与转义 3 项通过；新增 3 处及相关旧流程 28 处缺陷注入均被断言抓到。原 dispatcher 自检 33 项通过。Hub 普通发现 371 项中 249 项通过、122 项依赖未启用而跳过，真实数据库测试另行执行，不把跳过算通过。

## 云环境与部署影响

已登录 Channel 的 CloudBase 管理账号。上海／广州／新加坡环境清单只找到正在服务官网的 `diversity-123-d9grnqfux221323bb`，与 GitHub `test` 的正式站点配置一致。用户随后明确授权使用现有环境写入标记测试数据，不再要求独立环境。已新增三个 Sales 私有集合与一个无触发器的管理端验收函数；实际保存 3 条 TEST 询盘，重试、并发去重、最终写入失败回滚及独立回读均通过。见 [环境核对结果](INQUIRY-ENVIRONMENT-VERIFICATION.json)。无需换成 Hermes 云账号来解决 Channel 云库隔离。

SSH 权限已经配置，两台助手主机均可登录；所查主机未发现预期 Hub 服务，不能据此确定当前 Hermes 云账号与部署。当前测试使用本机独立资源，没有借用线上 Agent 的任务库或私有目录。

Hermes 的运行修改只涉及 Sales 读取协议、模型资料整理与邮件正文构造。共享 Hub、dispatcher、Compose、systemd、定海／内容工厂／发布助手均未修改。未来上线仍需独立数据库账号、服务身份、目录、端口及资源限额，先更新兼容读取端，再开放新的询盘入口；不能仅凭代码模块分开就声称线上绝对隔离。

完整自查、最小数据库权限和任务不受影响的证据在 Hermes 分支 [本轮报告](https://github.com/vibelingan/hermesinfra/blob/feat/sales-agent-runtime/docs/sales-agent/ASSISTANT-HANDOFF-REVIEW.md)。本地图片和逐项日志在该工作树 `docs/sales-agent/evidence/assistant-handoff-reviewed-final/`；远端 CI 会上传同流程 artifact。

本 checkout 未提供 `.agents/skills/dev-pipeline` 与 `engineering-craft` 适配器；本轮复用了现有计划、仓库 `ENGINEERING_CRAFT.md` 和全局 Agentic Delivery Loop，没有声称调用缺失的适配器。

代码提交：Channel `ad01506b1246baeb24caa2ce897f1353df54e911`；Hermes 运行代码 `3f9eda354665266a0be3f1321df7fa63fb08b8a2`，CI 安装修正 `d8be659673ff2bc940f16d086d17423c504665ce`。Channel 最新代码的 [CI](https://github.com/vibelingan/channel/actions/runs/41295738066) 已通过；Hermes 修正后 `d8be659` 的 [CI](https://github.com/vibelingan/hermesinfra/actions/runs/41296244682) 两个 job 均通过，包含实际助手入口 4 项与 A/B 容器隔离。本次最终文档提交不改变运行代码。

文字复核读取本文件、执行计划、环境 JSON、Hermes 读取／整理／渲染代码与 E2E。将“模拟入口”改成“实际组件，云库／模型仍为替身”，并核对前轮云端只读、自动轮询先启动及成果发送权限为 none；本轮新增的真实云写入单独记录在更新说明和证据中。

2026-11-01 更新：真实云执行请求 `59624397-392b-47d9-b815-eaecec01e21c`；完整证据在 Sales 分支 `docs/sales-agent/SHARED-ENV-ACCEPTANCE-DELIVERY.md`。账号与真实聊天接线步骤见 [从账号开始的操作顺序](REAL-CHAT-SETUP.zh-CN.md)。该前轮没有修改聊天运行代码；VibeKB MCP adapter 已在 2026-11-02 的新一轮补齐并另行验收。
