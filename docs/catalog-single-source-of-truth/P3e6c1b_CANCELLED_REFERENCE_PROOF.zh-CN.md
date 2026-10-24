# P3e6c1b 取消结果的引用证明读端

状态：本地读端完成；基线ae9503d。真实proof/pending producer仍关闭，最终写入及完整发布流程未完成。

## 已批准方案需要补齐的边界

P3e6a要求80槽满时可以结算已提交或永久取消的操作。当前proof只认识commit，不能表示取消。取消后的待提交项若一直保留，会占槽；若把取消证明当损坏，又会让同一共享图的其他公开引用无法读取。不能在每次读取图片时再下载最多80个1MiB操作根来检查cancelledAt。

采用同一个小型终局proof槽：commit和cancel使用同一root/treeRoot/leafCount推导的proof ID，kind分别为catalog-image-reference-commit-v1和catalog-image-reference-cancel-v1。commit应用+/-差值；cancel不改变计数，只允许结算时移除本操作的pending。缺proof仍是未决，必须保留。已提交事实不能被取消撤销。

终局行不是第二套可变状态机，原操作根仍是唯一协调者。后续producer必须在同一事务写root与唯一proof，并且已存在终局行只能精确重放，不能从commit改成cancel，也不能反向改；取消只针对尚未提交的操作。此写入保证尚未实现，本步的纯构造/读端不能证明不可变性或取消/提交race。真实producer仍不能启用。

## 读端、预算与验证

同一proof ID对应一种不可变终局结果，故仍每pending只读一个小doc；80项最多81读+1结算写，公共只读0写。取消+1保持原私有/公开计数，取消-1保持原公开引用；混合commit/cancel/missing统一计算。任意终局结果都可从pending清除，epoch+1；重复结算0写。公开读端遇到合法cancel无需报数据损坏，其他商品的引用继续生效。

内部纯函数结果appliedProofIds改名resolvedProofIds，准确表示已解决的commit或cancel。仓库搜索仅四个纯函数测试使用旧名字，无生产HTTP字段，也没有真实producer数据；不为未发布内部API保留别名。plan.proof继续明确为commit类型，取消factory独立构造相同承诺的小行，不复制root、来源、令牌或图片清单。

先红：用独立字面量的合法cancel行输入当前真实结算引擎，验证拒绝旧only-commit行为；不以缺export/导入失败作为业务反例。之后覆盖两种差值、混合状态、80槽清理、坏承诺/ID/kind/额外字段、重放、真实JSON与公开HTTP共享图和SDK事务。最终写入原子性、所有旧consumer/cleanup、vendor/P95、原formal P1及真实3时钟/20件发布回退仍未完成，fullDeliveryReady=false。

## 数据、实现与取舍

证明只含`{_id, kind, operationRootId, treeRoot, leafCount}`，沿原proof永久保留规则；所属原审批根、树和成员数量必须完全相符。`CommitProofSchema`与`CancelProofSchema`组成按kind判别的严格union；计划始终生成commit，独立取消factory只选承诺字段，不复制私有输入。

```ts
if (proof.data.kind === 'catalog-image-reference-commit-v1') sum += item.delta;
resolvedProofIds.push(proofId);
```

同事务快照里合法取消行解除其pending但不参与sum。native/JSON和public复用原纯引擎，无另建结算器。拒绝独立cancel命名空间，避免每项额外读取和两个终局结果并存；拒绝读取完整操作根，保留80项82文档操作预算。写端仍须保证root与唯一终局行原子提交，不能因factory能生成对象就声称race已解决。

## 实际验证

六个业务红测以独立字面量cancel输入原引擎，旧版本均以INVALID_PROOF拒绝。新增18纯函数、3真实JSON、7公开HTTP测试，共28项；聚焦182通过。相关DB1750、local644、public182，共2576通过；实际Node20跑DB+public+本JSON文件1945通过，均0失败/取消/跳过。19包类型、E2E类型、standing SDK及五文件显式Biome通过。

原引擎18个源码反例产生163重叠失败，另9个取消反例产生90重叠失败，均确认源码SHA恢复。实际安装SDK的Node20编译探针15组，复用原12组并增加正负取消及80取消项；同transactionId、82docops、三坏ACK回滚、已commit但丢ACK恢复、重复0写都检查。此探针替换SDK HTTP发送，不证明真实云MVCC。

四个独立Node24/20进程：取消加引用有效值0、结算丢弃响应、重开、重复结算；最终base0/epoch5/空pending/证明保留，后两步文件内容及mtime均不变，隔离目录已删除。证据在`output/pricing-clock-repair-2026-10-13/p3e1/reference-cancel-*`；尚未运行本SHA最终函数产物检查，commit review后继续。

实际review纯引擎、新纯测试、JSON与公开HTTP两测试、协议文档和SDK/实施记录；把测试中的“does not restore an aborted addition”改为“keeps a cancelled addition inactive”，对照有效计数0而非回滚既有加引用。保留同名terminal ID、严格schema和resolved命名，未增加SDK方法、shim、依赖、HTTP字段或真实producer。原formal P1、旧计数/删除/backfill/普通writer兼容、最终原子发布、UI/provider/P95、真实三时钟resync和20件发布回退仍开放；fullDeliveryReady=false。
