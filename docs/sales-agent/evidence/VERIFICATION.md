# 设计检查记录

2026-10-23。本文件记录初始设计文档、依赖、来源和图的检查；后续实施状态见文末。不代表真实账号联调。

## 范围与写作核对

实际读取：原工作区AGENTS、ai-platform索引/架构/MIU/引擎接口，v1.1和v3旧设计，Phase2 PLAN/SPEC/CLIENT-ANSWERS/ADR-003及询盘源码；Hermes任务、派发、运行、归档和门户源码。精确路径/行号见[BASELINE](BASELINE.md)，官方链接见[PROVIDER-CAPABILITIES](PROVIDER-CAPABILITIES.md)。

按humanizer的plain-technical-writing规则审阅所有新文档。具体措辞修正：“客户account/workspace”写成“客户自己的Apollo公司空间”，“客户关闭询盘”明确为“客户公司的后台操作人更新业务状态”，避免与网站买家混淆。事实核对保留“草稿可修改不等于固定批准版本”“回复事件不等于回复正文”“设计检查不等于实施/联调完成”。

## 独立复核及修订

- 固定逻辑邮件身份，改稿不新建首封发送槽；已发送/结果未知不能因版本变更重发。
- 接管分为请求和生效，在途发送对账明确后移交人工发送权。
- 所有受控测试发送统一执行服务端地址白名单，使用合成任务。
- 暂停/接管由有权操作者对最新任务生效，不因旧页面revision被静默拒绝。

## 检查结果

- `check_design.py --schema`通过：23个单元无循环依赖，当前本地链接均有效；历史副本和受保护原稿哈希一致。
- JSON Schema检查：1个有效询盘样例接受，2个无效样例拒绝。依赖jsonschema 4.26.0，仅安装在临时工具目录；不是服务端授权测试。
- 模块图为architecture类型，Archify最终交付9/9 showcase检查通过，0错误、0警告；回执见[diagram-delivery.json](diagram-delivery.json)。
- 自动浏览器检查通过：1440×900、1600×1000、1920×1080、2048×1320无文档溢出；回执见[图浏览器记录](../diagrams/modules.visual-check.json)。
- 已实际查看1440和2048尺寸的浅/深两主题截图，箭头方向、标签、正文和卡片无明显重叠或截断，visual_review=passed。视觉检查后未改图，视觉修订轮数0；先前源图布局修复与最终交付记录分开。
- 原Channel工作区分支/HEAD/未提交状态与开始时一致，四份受保护文档哈希一致；Hermes分支/HEAD及原有未跟踪文件状态一致。
- 本轮只新增docs/sales-agent。`git diff --check`通过。没有运行产品测试，因为没有修改产品实现。

初始设计提交时，23个实施单元均为planned_not_implemented；后续状态以下节及plan.json为准。未连接或修改客户账号，未执行真实外发。

## 图的交付身份

```text
diagram_type: architecture
output: ${SALES_WORKTREE}/docs/sales-agent/diagrams/modules.html
specification_sha256: 1ed1982a4638a0f89214e266d617c7d28563a3d2306f2abfa6c211eb9fed0938
artifact_sha256: e274446042c7c40e6010e7cfec8a0d635105d6031280572c891f45529978e3b1
validation: 9/9 showcase, 0 errors, 0 warnings
browser_evidence: passed
visual_review: passed
correction_rounds: 0 (visual stage)
```

## 可迁移的记录

仓库提交检查要求不包含本机用户目录。提交版回执仅把本机路径换成`${SALES_WORKTREE}`等占位，保留specification/artifact的SHA-256、bytes及全部测量值；原始工具回执另保存在忽略的`evidence/local/`中，没有改动可信HTML或截图。源码清单同样使用路径占位，检查脚本从Git共同目录解析原Channel工作区。

## 后续两个单元

SG0.1的实现及具体测试见[SG0.1-VALIDATION](SG0.1-VALIDATION.md)，提交595a4849的远端contracts工作流已成功。SG1.0的源码审计见[SG1.0-BASELINE](SG1.0-BASELINE.md)；它核对代码身份及业务接线，没有运行线上业务。plan.json现有2项完成各自范围的验证、21项未实现，均live_enabled=false。模块职责及业务流程没有改变，本轮未改模块图及其既有视觉回执。
