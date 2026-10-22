# 详细执行方案

2026-10-23 · 23个实施单元，全部为planned，尚未实施。模块说明规定设计；本文件与`plan.json`规定单元依赖，二者由检查脚本核对。

## 实施顺序

先做SG0.1共同合同及SG1.0代码基线盘点。再以fake provider完成资料接口、客户runtime、任务归档、Sales内容、邮件适配、控制及审核页，最后打开受控测试发送。真实客户数据读取依赖授权和隔离负向测试；真实外发依赖客户同意及SG8.2中对应上线检查。

官网闭环完成后接Apollo，再扩其他渠道与维护。SG6.0/SG7.1的文档和fake合同可提前准备，但不得绕过客户授权或官网外发验收去启动活动。一个模块做完一个可验证结果，再继续下一个；不一次派发全部工作。

```mermaid
flowchart LR
 C[SG0 合同与绑定] --> I[SG1 资料与正式事件]
 C --> R[SG2 客户执行与任务]
 I --> S[SG3 销售正文附件]
 R --> S
 C --> M[SG4 邮件与回调]
 S --> A[SG5 预览批准与发送]
 M --> A
 A --> O[SG8 演练与官网MVP]
 O --> P[SG6 Apollo获客交接]
 P --> X[SG7 多渠道与维护]
```

图表达交付顺序；下面是精确依赖，例如SG8审计基础先于正式发送就要完成。

## 可独立交付的单元

| 单元 | 依赖 | 写入边界/产物 | 必须证明 |
|---|---|---|---|
| [SG0.1 共同schema与假服务](modules/SG0-boundary.md) | 无 | packages/sales-contracts/；Hermes只消费固定版本 | 结构校验、未知版本拒绝、跨语言同fixture，fake不调用网络 |
| [SG0.2 客户连接与动作授权](modules/SG0-boundary.md) | SG0.1 | 客户绑定/工具scope/连接撤销tests，不改公开客服权限 | A/B工具、连接、业务和操作者负向测试；无默认客户 |
| [SG1.0 选定代码基线和三入口接线证据](modules/SG1-channel.md) | 无 | 只读路由/开关/持久化盘点与证据 | 记录OEM/单品/客服入口、旧dummy、有效提交条件和选定SHA |
| [SG1.1 询盘产品附件只读接口](modules/SG1-channel.md) | SG0.2, SG1.0 | sales-integration路由＋资料adapter，复用批准快照 | 越权/未提交/附件跨归属拒绝，固定版本事实可追溯 |
| [SG2.1 客户Sales执行边界](modules/SG2-hermes-runtime.md) | SG0.2 | Sales专属runtime/工具代理/记忆和目录适配 | A/B同时运行不读错知识/文件/连接；遗漏scope拒绝 |
| [SG2.2 事件接收根任务与可靠派发](modules/SG2-hermes-runtime.md) | SG0.1, SG0.2, SG2.1 | sales_flow事件接入＋复用assignment/outbox | 重复事件一个根task，崩溃恢复不丢已确认接收事件 |
| [SG1.2 询盘通知与补偿扫描](modules/SG1-channel.md) | SG1.1, SG2.2 | OEM/单品保存后最小hook及source reconciler | 保存成功后通知丢失可补扫；附件回滚和历史记录不误发 |
| [SG2.3 运行成果manifest与固定版本](modules/SG2-hermes-runtime.md) | SG2.2 | 运行目录/manifest/归档与旧run限制 | 并发run/符号链接/伪造hash拒绝；旧run不覆盖当前版本 |
| [SG3.1 业务规则Sales skill与样例](modules/SG3-sales.md) | SG0.1, SG1.0 | 新规则/skill/schema/evaluation，不改Phase2客服循环 | 模糊采购、缺价、恶意输入和跨业务样例有预期 |
| [SG3.2 资料到正文附件完整准备](modules/SG3-sales.md) | SG1.1, SG2.3, SG3.1 | 准备流水线/事实校验/成果提交 | 自动形成带来源、缺项、HTML/text及附件的审核版本 |
| [SG4.1 Resend邮件适配器](modules/SG4-resend.md) | SG0.2 | 草稿/显式发送/reply/fake合同及错误映射 | HTML附件roundtrip、实际reply收件人、幂等和超时证据 |
| [SG4.2 Resend回调联系人与回信通知](modules/SG4-resend.md) | SG4.1, SG2.2 | 回调接收/去重/联系资格/线程映射 | 伪造回调/错inbox/重复乱序不产生新任务或复活许可 |
| [SG5.1 操作者控制与批准合同](modules/SG5-human-control.md) | SG0.2, SG2.2, SG2.3 | 企微身份/command/epoch/批准记录，保护旧文章流 | 对象不明不发；旧版本/无权限/暂停后批准均拒绝 |
| [SG5.2 固定预览与网页共用批准](modules/SG5-human-control.md) | SG5.1, SG3.2 | 现有portal壳内sales预览route、附件及会话adapter | 个人身份/权限检查、HTML sandbox、私有附件、失效版本 |
| [SG8.1 持久审计结果回执和告警](modules/SG8-operations.md) | SG2.3, SG4.2, SG5.1 | 审计投影/告警/成本；ChannelReceipt可选 | 批准人/版本/发送ID可追溯，回执失败不重发邮件 |
| [SG5.3 受控发送与竞争恢复](modules/SG5-human-control.md) | SG3.2, SG4.1, SG4.2, SG5.1, SG5.2, SG8.1 | 固定payload/唯一send_operation/outbox及对账 | 两入口批准、暂停竞争、超时已成功、24h窗外不盲重发 |
| [SG4.3 确认模板一次发送与切换](modules/SG4-resend.md) | SG1.2, SG5.3 | 只停旧询盘确认hook，新确认共用发送账 | 两条确认路径互斥、历史不补发、密码重置不变 |
| [SG8.2 官网MVP演练与小范围启用](modules/SG8-operations.md) | SG1.2, SG3.2, SG4.2, SG4.3, SG5.3, SG8.1 | 端到端tests/runbook/客户接入与采样表 | dry-run→测试收件人→获批真实询盘；退出与回滚可操作 |
| [SG6.0 Apollo客户授权和回复正文证据](modules/SG6-apollo.md) | SG0.2 | workspace/连接/sequence规则/授权收件来源证据 | Partner与Agent授权分开；证明真实回复正文获得路径 |
| [SG6.1 独立活动准备与批准执行](modules/SG6-apollo.md) | SG6.0, SG3.1, SG5.1, SG8.1 | ICP/受众/序列版本及批准/启动/暂停adapter | 未批准不启动；受众/发件人/内容变化重新批准 |
| [SG6.2 回复停发分类与Resend交接](modules/SG6-apollo.md) | SG6.1, SG4.2, SG5.3, SG8.1 | 持久reply事件、stop确认、正文匹配和路由 | 停发失败不继续外发；OOO/拒绝/缺正文不当营销许可 |
| [SG7.1 一个其他渠道的联系人接入](modules/SG7-sources-maintenance.md) | SG0.2, SG4.2 | 获准文件导入或官方接口、来源/业务/许可映射 | 重复导入不重复；多来源不覆盖拒绝，归属不明隔离 |
| [SG7.2 独立维护活动](modules/SG7-sources-maintenance.md) | SG7.1, SG3.2, SG5.3, SG8.1 | 受众/内容固定版本、资格过滤和活动结果 | 入库不等于可营销；审批后退订发送前排除 |

## 每个单元的工作方法

1. 读本模块、共同合同和当前代码。先记录实际SHA、现有测试/部署状态，确认修改范围。没有的能力标为缺口，不照旧报告重写已实现功能。
2. 为上表验收写一个能暴露当前缺口的测试或可复现证据，再实现最小行为。文档/配置盘点单元只做证据，不为低影响改文档补空洞测试。
3. 跑对应包/模块的针对性检查；涉及真实DB并发就使用真实测试DB，不能用内存stub证明事务和租约。
4. 核对客户、业务、操作人、版本、外部不可逆动作、历史数据和回滚，再检查相关原有测试。
5. 交接本单元的提交、变更文件、测试/失败项、未验证部署部分和下个单元。不将planned改成完成，除非验收结果有依据。

## 代码与协作规则

- 当前worktree只是设计分支。实施SG1前确定合适的Channel代码基线；较新Phase2/catalog已有功能先复用，不能直接在03be缺失处重新实现。涉及别人分支的整合先核对提交/写范围，不整批merge未审查改动。
- Channel负责询盘事实/API/提交后交接；Hermes负责私有任务/运行/控制；Sales流程包负责业务规则；发布工具负责Resend/Apollo adapter。通用Hub不硬编码Channel产品/报价。
- 不默认每模块建分支或PR；当前这条工作流使用此设计worktree，后续每仓库实施分支策略由实施范围决定。同一checkout同一时刻一个写入者，共同schema由SG0维护。
- Hermes源码不在此仓库；开始其实施单元时另建/指定Hermes工作区，遵守该仓库AGENTS，不直接改正在运行或有他人改动的checkout。
- 不自动创建Linear/Symphony任务、PR或发群消息。这份方案不等于客户已签约或已授权真实账号对接。

## 建议的验证命令

以下是实施后要提供的目标命令，尚未创建的包/脚本不能现在宣称通过。先固定工具版本和测试环境，再在SG0.1/相关模块创建实际scripts。

| 范围 | 目标命令及说明 |
|---|---|
| 本轮设计检查 | `python3 docs/sales-agent/check_design.py`，只查文档/数据/DAG，不执行真实业务 |
| Channel共同合同 | `pnpm --filter @vibelingan-channel/sales-contracts test`及`typecheck`，SG0.1建立 |
| Channel集成 | `pnpm --filter @vibelingan-channel/sales-integration test`，SG1建立；既有单品/OEM tests继续跑 |
| Hermes Sales后端 | 按所选Hermes分支现有测试框架接入`test_sales_*`；SG2.1记录真实命令，不在未核对依赖时假造框架 |
| Hermes审核网页 | 该仓库`web`目录`npm run check`＋浏览器检查，依其现有npm/package-lock |
| 外部服务 | 客户授权后用受控测试收件人跑adapter contract/投递/附件/线程，保留脱敏证据 |


## 官网MVP验收清单

- OEM、正式单品、已准备好的客服确认入口均可自动形成稳定Sales根任务；未提交聊天不触发。客服入口依赖原Phase2完成时先验收已接入口并明确partial，不能把两入口通过当三入口完成。
- 保存成功但通知丢失可恢复；历史询盘默认不补发；附件失败回滚不触发。
- 内容与附件完整生成，资料缺失能请人补充；真实价格/交期有来源。
- 所看/所批准/所发送绑定同客户、任务、发件人、收件人、正文附件版本。Web/企微有具体操作人权限；网页个人身份不足时只读并标记审批partial。
- 改稿/新来信/暂停/接管阻止尚未提交旧稿；已提交结果正确显示，不宣称能撤回。
- 重复命令/回调不重发；超时未知对账不盲发；人工Resend接管没有后台竞争。
- 固定确认只发一次，切换时旧路径停用，密码重置不受影响。
- 全过程有持久成果、批准和执行记录；可选Channel回写失败不影响发送幂等。
- A/B客户运行、知识、文件、连接及查询负向测试通过；本地通过不替代部署身份验收。

## 上线前才需要的业务输入

负责人/备份批准人和可批准的承诺；可信产品价格资料；首批渠道/联系许可范围；留存及退出政策。未提供时采用draft_only，不自行决定真实商务承诺或永久留存。Resend预览/内部接口/事务由工程负责，不再列为客户要决定的技术问题。

## 交付状态

本轮产出设计和可检查的实施图，不包含实现工期承诺。尚无真实账号联调或客户实际验收。第一步可以开始SG0.1与SG1.0；其他单元按依赖推进，真实账号接入和发送不因设计完成而自动获授权。
