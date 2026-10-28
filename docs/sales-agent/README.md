# Sales Agent 分模块设计与执行入口

2026-10-28：D1首批SG0.3共同协议与SG1.3强制任务门禁已完成本地和对应代码提交的远端验证，见[协议记录](evidence/SG0.3-VALIDATION.md)与[门禁记录](evidence/SG1.3-VALIDATION.md)。仅Sales新流程采用，其他Agent不变；线上仍未启用。

2026-10-28：用户已授权继续D1实现。先按[权限补齐计划](evidence/D1-IMPLEMENTATION-PLAN.md)逐项实施；下文2026-10-26暂停状态保留为历史，不能视作当前暂停。其他Agent、真实账号及外发保持原边界。

2026-10-26 · **设计复核中，开发暂停。** 当前以[权限与真实工具接入修订 D1](SECURITY-AND-TOOLS-DESIGN.md)为准；待确认后才调整实施单元和继续代码。

既有验证：2026-10-24 · SG0.1、SG0.2、SG1.0、SG1.1已完成共同合同、授权、源码核对和读取接口；SG2.1、SG2.2已在独立Hermes工作区完成客户执行边界及可靠接收，隔离Docker/MySQL CI通过，见[验证记录](evidence/SG2.1-SG2.2-VALIDATION.md)。其余17个单元未实现。没有部署、连接客户账号或发送邮件。[上两步白话解释](evidence/SG0.2-SG1.1-EXPLAINED.md)与[线上验收计划](evidence/LIVE-TEST-PLAN.md)分别说明用途和后续验证。

推荐先完成一条官网询盘闭环：保存正式询盘后自动准备需求摘要、邮件和附件，销售在企微或网页审核，系统通过 Resend 发送。Apollo 获客、其他渠道同步和维护活动在同一套客户边界、工具与审批能力上分别接入。

## 阅读顺序

0. [本次设计修订](SECURITY-AND-TOOLS-DESIGN.md)：两端门禁、任务授权、真实接线、实时产品及复用清单。
1. [整体设计](HIGH-LEVEL.md)：模块职责、业务流程、数据归属与第一期范围。
2. [已有设计与缺口](GAP-AND-REUSE.md)：哪些直接复用，哪些补充，哪些旧方向不再实施。
3. [详细执行方案](EXECUTION-PLAN.md)：模块顺序、可独立验证的实施单元、验收与上线条件。
4. [接口与数据规则](contracts/CONTRACTS.md)、[邮件状态与竞争处理](contracts/STATE-AND-CONCURRENCY.md)：程序交接的共同约定。
5. [模块设计](modules/SG0-boundary.md)：SG0 开始，各文件的依赖以执行方案及 `plan.json` 为准。
6. [实施交接说明](handoff/START-HERE.md)：下一步从哪个模块开始、哪些文件可写、怎样交付。
7. [可查看的模块图](diagrams/modules.html) · [核对依据](evidence/BASELINE.md) · [文档检查记录](evidence/VERIFICATION.md)。

结构检查可运行`python3 docs/sales-agent/check_design.py`。完整schema验证先在临时venv安装本目录`requirements-design.txt`，再加`--schema`；它只核对设计样例，不能证明服务端授权。

SG1.0源码核对可运行`python3 docs/sales-agent/check_source_snapshot.py`，检查固定提交的44份文件、80处标记及分支关系，不执行产品代码。完整路径和哈希见[源码清单](evidence/SG1.0-source-inventory.json)。

## 工作区

- 新 worktree：`${SALES_WORKTREE}`
- 内置盘反复ENOSPC后，当前在外置盘的独立销售检出继续同一分支；原设计worktree保留为备份。后续以当前检出及远端为准，不从旧副本继续编辑/推送。
- 当前集成分支：`feat/sales-agent-integration`；原`feat/sales-agent-modular-design`保留在远端，包含SG0.2的原始提交。
- 当前起点：main `404d1a257722175dcd70916e3f92ec6763fa0243`，仅带入我们自己的销售提交。原设计分支起点为`03be923c`。
- 主线已有询盘、产品快照和后台代码已直接复用，逐字节保持main原内容；Phase 2的`a7e16aa2`仍用于客服设计参考。直接merge曾被仓库绝对路径检查拦住，改从main建立集成分支并带入销售提交，没有绕过检查或改主线历史文档。
- 原工作区及旧讨论文件保持原样。`reference/` 是有来源清单的历史设计副本，不是新的规范入口。

本目录规定的是新增销售自动化范围。官网客服原有架构及 Phase 2 继续管理公开接待能力；HermesInfra 的跨项目改动在其独立工作区实施，不在本仓库伪造平台代码。客户方案是否签定不由本轮代替决定；未获客户授权前可做契约、假服务和测试，真实账号连接及对外动作仍需相应授权。

10/26的图与PDF保留为设计快照；最新代码进度及未接线项以本轮验证记录为准。
