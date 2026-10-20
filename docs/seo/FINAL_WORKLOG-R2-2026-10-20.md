# 第二轮设计收口记录

2026-10-20，`feat/seo-foundation`。审阅源提交 `b3c5f3a89b44b6ff6f99e62a24fbfa413bfd9e8c`。本轮仅更新设计、图源和交付材料，没有部署、改云端配置、执行数据库迁移或恢复，也没有改 pricing。

## 实际核对的内容

- 在固定源提交中核对 `packages/db/package.json`、`src/adapter.ts`、`src/cloudbase-adapter.ts`，确认商品主库的文档数据库适配、patch 与整份/嵌套替换的区别。
- 核对 `packages/ai-store/package.json`、`src/migrations.ts`、`src/migrate-cli.ts`，以及 001/002 的 up/down SQL，确认使用 pg 与自写迁移、全量逆序 down 和实际删字段/删表行为。按 Git 路径清单检索未发现 Prisma schema。
- 阅读 `docs/CLOUDBASE_SDK_CONTRACT_VERIFICATION.md` 及相应 CloudBase 指南；本轮没有修改 SDK 或类型声明，也未假定已具备 PG 备份/PITR 能力。
- 复核 `FINAL_REVIEW.zh-CN.md` 中 R1–R9，`FINAL_DELIVERY.zh-CN.md`、`SSG_DELIVERY_DESIGN.zh-CN.md`、`CURRENT_EXECUTION.md`、图表说明与两张新图源；历史 41 项测试不作为本轮新增测试结果。
- 阅读 Google sitemap、ping 废弃与 HTTP 状态官方文档、IndexNow FAQ、PostgreSQL ALTER TABLE 及 Prisma 迁移模式文档。引用集中在实现设计，不套用 Prisma 的分支/CLI 操作。

当前项目未提供 Context7 工具，本轮使用官方资料与固定源提交中的实现。此次是兼容性设计复核，不是生产数据库状态审计。

## 实际修订

将“本期不自动恢复”改为按失败阶段和兼容证据选择一次自动恢复；补齐函数包/配置/数据库的范围，禁止把静态恢复扩大成全库倒退。将 prior P1 审查项纳入实现设计 §7，并保留为待实现阻断项。

另外收紧两个顺序问题：验收后先封存候选恢复包，再条件提交 active 与成功基线；已提交成功后的搜索通知失败不触发站点恢复。搜索事件增加合并、稳定窗和发送前复核，也明确爬虫自主访问不受通知控制。

图的最终依赖复核还将兼容迁移的上游明确绑定到“备份与成功版本核验”，并加入 requiredEdges/requiredPaths 检查。迁移本身已是线上写入，不能从产物准备节点提前执行；修订图源后重新生成并验收。

新演练计划以正常发布、人工恢复、一次 canary 自动恢复为主；数据库测试使用条件补偿并证明新增记录不会丢失。保留三组本地低成本拒绝错误恢复的检查，没有扩大成线上大规模故障矩阵。

## 图表与验证

使用 Archify 生成一张完整流程 SVG 和一张完整端到端时序 SVG，各自是可离线查看的 HTML，不通过 iframe 组合旧图。两图分别保留 source/artifact SHA-256、九项结构验收、真实浏览器四种尺寸与浅深色截图。图像审阅记录与自动检查分开保存于输出目录。

首次浏览器启动在沙箱内 SIGABRT，改用隔离无界面 Chrome 完成验收，不使用常用 Chrome 的用户数据或标签页。中途一次自动权限审查超时，重试成功；没有因此跳过最终验证。初版存在纵向首屏超出，经外层宽高比和重复说明的整理后重验，未隐藏溢出或缩小字体。

实际查看流程图与时序图的浅色 1440×900 和深色 2048×1320 截图；最终时序语义修改后重新交付和读取截图。主视图用于整体关系，详细消息可用查看器缩放。自动浏览器检查不代表生产 E2E。

## 文字复核

按 humanizer 的 plain-technical-writing 复核 `AUTOMATED_RECOVERY_DESIGN.zh-CN.md`、`RECOVERY_DRILL_PLAN.zh-CN.md`、`FINAL_DELIVERY.zh-CN.md`、本记录及图注。具体修正：“数据库回滚”拆成“兼容代码恢复、保留 schema/业务写入、必要记录单独补偿”；“搜索引擎马上更新”拆成“sitemap 文件保持真实、主动通知等待稳定、抓取仍可独立发生”。

事实分别对照现有迁移、数据库 adapter、原审阅反例和官方搜索协议；没有把目标设计写成已实现能力。设计可交给后续实施，运行代码中的缺口仍需修复并按受控计划验收。

## 按模块的实施规划补充

在 `139308f9` 上读取当前恢复内核、部署/备份脚本、函数状态与 manifest、Deploy Test、db adapter、SDK 合同规则和总体设计，整理 `execution/` 的六模块/十 MIU。当前代码事实包括：恢复回调 false 未被断言；正常发布是目录上传；已有 Alibaba 事务 guard；函数和托管 API 不识别站点 fence。没有检出或修改其他 worktree。

文字复核覆盖 execution 的入口与六个模块、总体设计和当前交付索引。具体把“最后延迟删除/默认扩展后收缩”改成“默认保留，删除另行论证”；没有把商品撤回路径处理误改成永久保留。还核对了 artifact envelope 不自引用 hash、局部发布按组件绑定基线、canary 与整站共用环境互斥但分开激活状态、未接全内容写入方不开放商品恢复。

官方事务/管理文档通过 CloudBase 文档工具和官网查询；Context7 不可用。已确认当前依赖 symlink 指向 node-sdk 3.17.2 / wx-server-sdk 4.0.2；无网络 runtime probe 在本地依赖文件读取时出现 ETIMEDOUT，未完成，因此不宣称本轮 SDK 运行检查通过。实施时仍须运行各模块规定的 SDK/真实资源合同验收。此次只检查文档链接、MIU/依赖覆盖和 Git 写入范围，没有运行尚不存在的测试或生产演练。
