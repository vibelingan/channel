# Sales Agent 分模块设计与执行入口

2026-10-23 · SG0.1共同合同与假服务已通过离线验证及远端CI；SG1.0询盘源码核对已完成，详见[复用结论](evidence/SG1.0-BASELINE.md)。其余21个单元尚未实现。未连接客户账号、未接通真实发送。

推荐先完成一条官网询盘闭环：保存正式询盘后自动准备需求摘要、邮件和附件，销售在企微或网页审核，系统通过 Resend 发送。Apollo 获客、其他渠道同步和维护活动在同一套客户边界、工具与审批能力上分别接入。

## 阅读顺序

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
- 分支：`feat/sales-agent-modular-design`
- 起点：Channel `03be923c0d7f8cf0f8bfa86a9f8224ba07315f17`
- 这是独立的销售模块工作区。SG1.0选定main的`404d1a25`为后续Channel实现参考，Phase 2的`a7e16aa2`用于客服设计参考。正式单品询盘已同时存在于两者；这些产品代码尚未整合到本worktree，不能把旧起点缺少代码误判成需要重写。
- 原工作区及旧讨论文件保持原样。`reference/` 是有来源清单的历史设计副本，不是新的规范入口。

本目录规定的是新增销售自动化范围。官网客服原有架构及 Phase 2 继续管理公开接待能力；HermesInfra 的跨项目改动在其独立工作区实施，不在本仓库伪造平台代码。客户方案是否签定不由本轮代替决定；未获客户授权前可做契约、假服务和测试，真实账号连接及对外动作仍需相应授权。
