# SEO 交付时序图核对记录

本轮只细化图文。工作目录仍是 `seo-foundation`，分支仍是 `feat/seo-foundation`，实现基线为 `14e8ad8b`。原总流程图保留，新增发布、备份、恢复三张 Archify sequence 图及读图说明。没有修改业务代码、workflow 或 pricing，没有发起云端部署、改缓存、执行恢复，也没有新建分支/worktree。

实际复核了 `deploy-test.yml`、`capture-hosting-backup.mjs`、`hosting-recovery.mjs` 的当前 Git 对象，以及上一轮已经核对的 deployment、hosting-contract、integrity 与发布输入边界。源文件位置集中记录在 `docs/seo/diagrams/README.zh-CN.md`。读取 Archify 的 sequence/common schema、async-job-roundtrip 示例及 delivery contract，使用 showcase 质量档；没有修改 Skill 或其渲染器。

具体事实核对：发布前必须归档新产物与已核验旧站备份；缓存前检早于云端业务写入；函数/网关先于静态站更新；目录下载 success 不能替代完整性检查；备份前后比较两份清单与配置；恢复的公开路径/所有权信息目前由调用方提供；执行内核逐项上传后读回，再精确删除、配置与验收。云端适配器、可信产物获取和锁内恢复 job 均标为待接入。共享锁不冻结后台发布，静态恢复不回滚函数/数据库，图中不承诺原子切换、自动回滚或恢复耗时。

图形校验先发现节点上下文太小，缩小了画布横向范围而保留字号；浏览器检查发现纵向溢出，压紧消息间距。截图审阅又发现阶段标签会提前出现在上一个阶段内部，因此去掉了与消息文字重复的阶段框，保留全部请求、返回与失败条件，没有调整渲染器。恢复图对齐了相邻消息间距。最终三张图均通过 9/9 artifact checks，composition 0 errors / 0 warnings，随后冻结规格。

最终浏览器证据分别覆盖 1440×900、1600×1000、1920×1080、2048×1320，无横纵溢出。已实际查看三张最终 1440 浅色和 2048 深色截图，核对参与方、消息先后、箭头方向、文字遮挡和底部状态卡片；机器检查和图像审阅分别记录为 passed。完整规格/HTML SHA-256 与交付收据在 `output/hosting-2026-10-20/sequence-delivery-receipts.json`，最终浏览器/视觉状态在 `sequence-handoff.json`；没有把自动 receipt 的 visualReview: pending 改成已审阅。

文字复核使用 humanizer 的 plain-technical-writing：将“产物返回时完成本地校验”改成“返回文件与 manifest，供任务全量核验”，避免把调用方的工作画到存储服务上；将异步虚线的误用改成普通调用，并用标题、括号与卡片明确待实现状态，避免把“待接入”误读成“异步”。读图说明区分逻辑职责与独立部署服务，亦区分当前代码流程、目标接入和真实线上证据。三个 JSON 通过仓库 Biome 检查。本轮没有运行与图文无关的业务测试，也没有把之前的 458 项结果作为新增图形的验证。
