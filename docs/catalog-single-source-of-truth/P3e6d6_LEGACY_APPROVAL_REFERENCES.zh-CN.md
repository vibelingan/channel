# P3e6d6 旧审批图片计数与事务预算

状态：本地实现与回归通过；基线93cf421。真实pending/proof producer仍关闭。

## 实际写点和反例

finishStagedApproval与commitCatalogApproval仍按rawbase+delta判断/整行写。base0+已提交加1的旧SKU实际effective1，替换SKU应可减1，却被误拒；base1+已提交减1再减1又可能写成effective负数。大整数边界也必须先合并全部已确认项再加本次delta。不能先独立结算后另开事务审批。

## 共享规划和数据

在已有事务首次读取/验证image lifecycle、存储与mutex后，共享只读规划负责：验证ledger/base，预先计算全部额外点读预算；对非空ledger调用既有C1只读settlement planner，重新从真实transaction读取image+proof并与首次image逐字段比较；只将计划返回给原审批唯一写点。未知proof保留，取消释放pending而不改计数；普通字段、proof本身和原身份/来源/actor guards保留。

无ledger且有合法base沿旧路径；缺base且delta0不初始化，仍承认legacy。缺base需要非零delta时拒绝MEDIA_NOT_READY，不能把未知共享引用猜成0；历史审计/readiness仍是启用前门槛。安全整数溢出/负数、坏ledger/proof、两次image不一致均拒绝且0写；供应商运输/冲突异常继续抛出。

## 预算与写入

staged基础预算仍5+N图片get+W非零delta图片set；atomic基础预算仍3+2V SKUget/set+2N图片get/set。只对本次非零delta的非空ledger额外预留1次image重新点读及P个proof点读，合计R=sum(1+P)。必须在任何proof读取前检查baseOperations+R<=98，不能在第99次才返回错误。合法80proof单图可在剩余预算内处理；多图超限沿现有APPROVAL_TOO_LARGE，最终大图合法组合由尚未启用的own-root协议承接，不能缩小商品图片或SKU业务上限。

staged保持DEC-21：delta0图片绝不写，即使只读规划能结算，也留后续专属操作结算；非零delta在唯一既有image set里合并settlement和delta。所有delta0图片只验证base/ledger结构，不读取他人proof、不结算、不重设计数；其原ledger原样保留，避免未改变引用的共享图因他人pending导致额外读取或新预算失败。atomic保留每图approvalFence冲突写，非零delta合并同一计划，不能为简化而去掉防并发删除的fence。所有实际读在任何写之前，商品/job或SKU与图片依旧在原事务一起提交。

```ts
const references = await planApprovalImageReferences(tx, images, delta, 98 - baseOperations);
if (!references.ok) return references;
// Only after all reads: reuse original image/product/job/SKU writes.
```

拒绝：逐图独立increment事务、伪造缓存tx.get、只按base算、丢未决pending、只结算当前root、在不计入global预算的前提下读proof、或让staged所有共享图都写以抵消读检查。只有既有C1 proof/settlement引擎负责解释证明，不复制一套算法。

## 检查

先通过真实staged/atomic入口复现已提交加1后旧SKU替换的误拒及危险负数/溢出，覆盖坏proof/缺managedbase/missingproof保留。再覆盖80合法边界、超全局预算前拒绝、读顺序、两次image不同、write失败原子回滚、精确重放/不重复计数、DEC-21 delta0图片零写/atomic原fence保留。实际SDK与JSON流程按同一实现核对，随后完整回归/类型/构建；P3e6e最终根激活、原丢回执P1和UI/历史/真实三时钟/20件发布回退仍开放。


## 实际结果与review

最初6个旧staged/atomic真实入口反例全部业务红；随后13个场景有10红/3正常控制。最终新增32项：staged18、atomic12、共享规划2，176聚焦通过。验证正/负已提交净值、取消/未决保留、缺managedbase与非零delta未知legacy拒绝、未知但未改变legacy保留、MAX_SAFE净值/溢出、坏proof/第二次image缺失或变化/错误首次ID、供应商异常透传、后段写失败整体回滚和同一任务重复0写。其余新增健壮性控制是在实现后补齐，不冒称32项都先红。

80proof的合法旧staged总91文档操作、atomic总92；两图160proof及102/103全局预算均在任何proof get前拒绝。额外单元锁定两次image重新点读也需预算（90额外读不能塞入88余量）；两张未改变共享图共160pending在0额外预算下保持0terminal读。staged仍只写非零delta图；atomic仍为每图写原approvalFence。不会从未改变图快捷路径授予公开权限，public非空ledger仍按C1独立核对；历史审计与最终媒体seal门槛没有被省略。

24个源码反例全部检出，共95重叠测试失败，三源SHA恢复。覆盖忽略effective/settlement/本次delta、丢未决、跳比较、跳proof/预算/重新get成本、过度拒80或读未变共享图、猜legacy0、危险最终count、原始count过早判断、吞供应商错、伪造缓存tx.get、两审批忽略合并结果、staged误写共享图、atomic失去deletefence、没预留原actor/SKU/product/image操作、错误ID。恢复后实际SDK205与176聚焦通过；初版两处测试字符串格式人工修正后才执行绿测，不计产品反例。

实际Node20安装SDK205组保留此前169组、新增36组，raw及生产adapter的staged/atomic五终局状态、91/92实际docops/同transactionId/读先于写、两种超全局预算的0proof读/0写、六坏ACK回滚/重试、审批commit已落盘丢确认后的同任务读回与0重放写、缺managedbase拒绝。汇总最大92，另外source85/delete83/counter82分别保留，避免把旧source85误说全局最大。只替换HTTP运输，不代表真实云MVCC/COS/P95。

四个独立Node24/20进程使用三个真实本地PNG：先暂存既有已上线商品的旧SKU→新SKU审批并附精确proof，旧图200/新图404；第二进程finish后丢响应，旧图404/新图200；第三进程重开同job、保留源/分类/身份和proof、epoch5/pending清空，并0文件写重放；第四进程恢复该临时商品未发布、全部图404，私有PNG仍在，随后整个夹具目录删除。这只是既有live商品的旧审批，不是整条新发布流程或真实20件验收，原publication丢回执P1仍开放。

七包及scripts5344通过：shared309、DB1900、admin638、local722、public182、sync308、site797、scripts488；实际Node20全DB/public及相关JSON2314通过，0失败/取消/跳过。19包types、E2Etypes、standing SDK、显式六TS文件Biome与git diff通过。native adapter整个文件与93cf421相同，原产品保存actor/classification fence未动。精确三函数/site及编译后旧审批/媒体/公开读取组合在commit review后执行。

实际review六源/测试、原C1只读planner/两个SDK桥接/预算函数、协议及三记录；把初稿“每个非空ledger补读”改为“只对非零delta补读”，并以两个未改共享图160pending/0预算控制和staged写点检查核对；从快照重新get、24反例造成的95重叠失败及实际SDK请求核验不可用缓存冒充事务读。无新SDK方法/shim/依赖/HTTP结构/锁/持久字段。lifecycle/upload/protection、own最终root/proof激活、UI/历史/provider/P95/test真实三时钟/20件发布恢复与原formal P1仍开放，producer关闭/fullDeliveryReady=false。
