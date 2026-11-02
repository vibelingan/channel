# SG3.2：准备模块本地交接

2026-10-29。可调用准备模块已实现、分轮独立审查并通过本地验收；未上线。

系统从受控 Channel API 取得询盘和实时批准产品，经有限轮次内容准备和系统校验，固定邮件身份、正文、附件、证据和来源，并在同一事务保存审核版本。重复执行恢复同一成果；改稿保留旧快照和文件。并发 worker 有数据库单执行保护，失锁执行不能提交或终结新执行。

验证：50 项相关单元测试、14 项实际 Channel/Hermes HTTP+MySQL 模块端到端、15 项旧归档回归通过，均无跳过；19 项定向缺陷全部被测试抓住，初期漏检与修正记录保留。真实组件数据均为合成；内容与邮件平台为假适配器，没有发邮件。根 agent 独立复验了 50 项和相同 19 项，不累加重复执行数量。

代码在 Hermes `feat/sales-agent-runtime` 工作区，HEAD `5b7645275e97808f53b1ab8138a683d853e7468b`，新增实现未提交。Channel 当前 `feat/sales-agent-integration`，HEAD `a69b4989802397fffc54ad1403ac581e67c38c7b`，本轮只补交接和状态文档，没有修改产品、pricing、SEO、客服或企微 UI。

[完整交付报告](/Volumes/Lexar-Mac/Projects/hermesinfra-sales-agent/docs/sales-agent/SG3.2-DELIVERY-REPORT.md)

[分轮审查](/Volumes/Lexar-Mac/Projects/hermesinfra-sales-agent/docs/sales-agent/SG3.2-REVIEW-ROUNDS.md)

[端到端和缺陷注入](/Volumes/Lexar-Mac/Projects/hermesinfra-sales-agent/docs/sales-agent/SG3.2-E2E-AND-DEFECT-INJECTION.md)

后续工程仍包括来源自动核验／授权签发、可信任务加载、私有真实模型适配、自动触发、真实邮件适配及个人审批发送。它们不是“只差配置”，也没有要求用户手工修改 source_verified。当前无需用户操作；不因此停下其他已授权工程。
