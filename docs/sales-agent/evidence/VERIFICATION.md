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

## SG0.2、SG1.1继续实施

SG0.2原提交bf8e429b已推送并通过远端检查，随后才开始SG1.1。当前实际进度以plan.json为准：4项完成各自离线/源码范围，19项未实现；均未启用live。SG1.1私有HTTP、归属、bytes、流式上限、打包及相关回归见[验证记录](SG1.1-VALIDATION.md)。业务流程与模块职责未改变，未修改原模块图。后续按[真实测试计划](LIVE-TEST-PLAN.md)核对线上Infra，不能把当前结果当作部署/投递证据。

2026-10-24：当前6个单元完成各自范围，其余17个单元未实现。SG2.1/SG2.2的[独立运行和接收证据](SG2.1-SG2.2-VALIDATION.md)包含71个不同用例的本地/隔离CI分层结果及33项原dispatcher自检；线上Hermes和邮件验收仍未执行。上文历史数量保留为当轮快照。


## 2026-10-26 权限设计复核 D1

本轮只修改销售设计资料、计划的暂停标记及图文，未修改运行代码、共同schema、测试、CI或部署配置。既有六个单元的完成状态及历史证据保留；新增安全验收尚未执行。

- [完整修订](../SECURITY-AND-TOOLS-DESIGN.md)明确Hermes通用门禁、Channel业务门禁、任务授权、可信来源核验和真实工具接线；产品实时查询，提交事实和审核依据留档。
- 读取Channel access.ts、sales-integration handler/sources/index、run-context/approval/control-command schema，及Hermes Boundary/Intake/service、相关tests；发现客户级scope没有任务资源限制、旧行缺字段放行、客户HOME挂载及真实工具循环未接入等缺口。
- 状态文档已区分客户control_epoch与任务task_revision。新协议和Approval的必填字段升级仍待确认后实施，没有修改schema来假装完成。
- 用humanizer核对正文和PDF摘要，把“已完成客户隔离”收紧为“已有客户边界的隔离测试；任务授权和真实接线待补”。事实分别对照两个检出的固定提交与实际调用位置。
- 两张architecture图均通过9/9 showcase、0错误、0警告。真实浏览器1440×900、1600×1000、1920×1080、2048×1320测量通过，并查看浅／深色截图；另有图像作者视觉复核，未冒充独立评审。
- PDF为六页设计摘要，已提取文字并逐页查看渲染；完整规范以主文档为准。图源、HTML、PNG、PDF的身份见[本轮回执](SECURITY-DESIGN-REVIEW.json)。
- 文档检查通过23个单元无循环、历史副本和四份受保护原稿hash一致；schema样例1个接受、2个拒绝，仍不是授权测试。最新数量见design-check.json。
- Hermes检出保持2fbc50c且干净；原讨论reference、公开客服、pricing和SEO代码未改。本轮不运行产品测试，不连接客户账号或发信。

模块图本轮回执见diagram-delivery.json；新增权限图回执见security-diagram-delivery.json。自动浏览器JSON里的visualReview继续保留pending，作者视觉结论另记在本轮回执，二者含义分开。以上检查只验证设计资料，不能证明尚未实现的安全规则已经生效。
