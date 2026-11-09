# Sales Agent 设计与实施

## 当前状态（2026-11-09）

**正式官网到 Sales 的完整闭环尚未验收。** 充值后官网及 AI 后端已恢复；新界面发布在安装包检查处停止，修复已推 fix 分支，尚未重新发布。Channel Sales 函数及正式来源已创建，但安全入口和合法 SDK 数据读取还没有完成实际验收。

Hermes 新 `channel-website` 执行单元已独立安装。确认没有任务后，仅其 dispatch／consume 已停止并取消自启，等待安全入口验证；原有 Agent、pilot 和工作目录保持。当前 Sales 是结构化模型决策加模板草稿，尚未接入定海共享调度／管理，也未实现自由邮件文案或 Sales 直接查 VibeKB。

最新推荐、调用成本、实际缺口及验收顺序见 [生产接入安全复核及整改设计](verification/PRODUCTION-AUTH-REVIEW-20261109.zh-CN.md)。当前不开放匿名入口、不发买家邮件；正式询盘新接线的四项发布开关已关闭，待真实验收后启用，原有表单保持。正常流程拟统一在 Hermes 受理和草稿准备完成后各通知一次企微。Test only「Sales 询盘通知」已创建，Webhook 保存在仓库外；尚未启用真实通知。

## 2026-11-08 受控试运行记录

- 官网助手与 SEO 已汇入 `release/assistant-seo-20261104`；本次 Sales 事务读取修复从其 `dcffdff6` 建立独立分支 `fix/sales-live-wiring-20261108`，代码 `3310f34e` 已推送，未修改其他人的工作目录。Hermes 继续使用 `feat/sales-agent-runtime`，运行代码 `cfc7bf6`。
- 已用现有 CloudBase 中真实保存的两条合成询盘，验证 Hermes 来源授权、读取、真实模型、成果归档和 Resend 未发送草稿；重复导出复用原草稿。第二条在完整受限服务配置下一次完成，107.204 秒、模型 1 次、内存峰值约 101 MiB。任务进度与草稿编号保存在 Hermes 专库，Channel 只保存询盘、来源和可靠投递回执。
- 这仍是受控试运行：新 Channel 云函数创建被账户余额不足拒绝，本轮通过本机服务和 SSH 回环隧道验收；Hub 的两个固定 HTTPS 入口已配置并验证，没有启用正式客户自动消费、企微审批、真实发送或回信处理。官网发布按负责人要求等待充值。实际部署与剩余条件见 [Hermes 实施记录](https://github.com/vibelingan/hermesinfra/blob/feat/sales-agent-runtime/docs/sales-agent/IMPLEMENTATION.md)，本次性能修复与测试见 [事务读取核对](verification/LIVE-TRANSACTION-READS-20261108.zh-CN.md)。
- 当晚线上巡检：官网首页／OEM 页面已返回明确的账号欠费 451，AI BFF 返回资源隔离 503；数据库仍可读，两份既有草稿重新读回通过。普通表单的正式 Sales 接线未启用。[当前可用性及恢复后的首轮验收](verification/LIVE-FIRST-ROUND-20261108.zh-CN.md) 区分了真实通过、仅接口响应和尚未执行的项目。
- 逐轮的计划、交付、验收记录、证据 JSON 与截图已于 2026-11-02 归档到 tag [`archive/process-evidence-2026-11-02`](https://github.com/vibelingan/channel/tree/archive/process-evidence-2026-11-02/docs/sales-agent)，本目录只保留设计、合同与模块文档。取回单个文件：`git show archive/process-evidence-2026-11-02:docs/sales-agent/<path>`。
- 文档一致性检查脚本 `check_design.py`、`check_source_snapshot.py` 检查的是归档快照，一并归档。

推荐先完成一条官网询盘闭环：保存正式询盘后自动准备需求摘要、邮件和附件，销售在企微或网页审核，系统通过 Resend 发送。Apollo 获客、其他渠道同步和维护活动在同一套客户边界、工具与审批能力上分别接入。

## 阅读顺序

0. [本次设计修订](SECURITY-AND-TOOLS-DESIGN.md)：两端门禁、任务授权、真实接线、实时产品及复用清单。
1. [整体设计](HIGH-LEVEL.md)：模块职责、业务流程、数据归属与第一期范围。
2. [已有设计与缺口](GAP-AND-REUSE.md)：哪些直接复用，哪些补充，哪些旧方向不再实施。
3. [详细执行方案](EXECUTION-PLAN.md)：模块顺序、可独立验证的实施单元、验收与上线条件。
4. [接口与数据规则](contracts/CONTRACTS.md)、[邮件状态与竞争处理](contracts/STATE-AND-CONCURRENCY.md)：程序交接的共同约定。
5. [模块设计](modules/SG0-boundary.md)：SG0 开始，各文件的依赖以执行方案及 `plan.json` 为准。
6. [实施交接说明](handoff/START-HERE.md)：下一步从哪个模块开始、哪些文件可写、怎样交付。
7. [可查看的模块图](diagrams/modules.html) · [核对依据](https://github.com/vibelingan/channel/blob/archive/process-evidence-2026-11-02/docs/sales-agent/evidence/BASELINE.md) · [文档检查记录](https://github.com/vibelingan/channel/blob/archive/process-evidence-2026-11-02/docs/sales-agent/evidence/VERIFICATION.md)。

## 历史工作区（10 月实施记录）

- 新 worktree：`${SALES_WORKTREE}`
- 内置盘反复ENOSPC后，当前在外置盘的独立销售检出继续同一分支；原设计worktree保留为备份。后续以当前检出及远端为准，不从旧副本继续编辑/推送。
- 当前集成分支：`feat/sales-agent-integration`；原`feat/sales-agent-modular-design`保留在远端，包含SG0.2的原始提交。
- 当前起点：main `404d1a257722175dcd70916e3f92ec6763fa0243`，仅带入我们自己的销售提交。原设计分支起点为`03be923c`。
- 主线已有询盘、产品快照和后台代码已直接复用，逐字节保持main原内容；Phase 2的`a7e16aa2`仍用于客服设计参考。直接merge曾被仓库绝对路径检查拦住，改从main建立集成分支并带入销售提交，没有绕过检查或改主线历史文档。
- 原工作区及旧讨论文件保持原样。`reference/` 是有来源清单的历史设计副本，不是新的规范入口。

本目录规定的是新增销售自动化范围。官网客服原有架构及 Phase 2 继续管理公开接待能力；HermesInfra 的跨项目改动在其独立工作区实施，不在本仓库伪造平台代码。客户方案是否签定不由本轮代替决定；未获客户授权前可做契约、假服务和测试，真实账号连接及对外动作仍需相应授权。

10/26的图与PDF保留为设计快照；最新代码进度及未接线项以本轮验证记录为准。
