# P3e6d1 旧增减与待结算图片引用兼容

状态：本地incrementField兼容完成，基线ad383a8。真实pending/proof producer继续关闭；其余旧写入/删除/回填及最终发布尚未完成。

## 场景与不变量

旧`incrementField('images', id, 'publishedRefCount', delta)`只改基数。例：base0、已提交+1 pending、旧取消发布delta-1，旧JSON写-1，即使有效值应为0。反向例base1/已提交-1/旧加1也会多算。必须同快照结算全体终局，再加旧delta，同一次图片写入移除已解决项并保留未决、metadata/mutex；不能先settle写再increment写。

## 数据、寿命与约束

原`publishedRefCount`和可选`catalogPublishedReferenceLedger`继续留在images。proof仍永久保留，不复制原根。内部adjust输入`{imageId, delta, maxDocumentOperations?}`，delta安全整数，max沿98；无新HTTP操作、DbAdapter能力或持久状态。单图80pending最多81读+1写，4并发点读；所有读在唯一set前。当前原子旧审批/删除/回填/genericwriter尚未接入，不宣称全体兼容。

缺图片返回null。缺counter且无ledger的legacy图片保留缺失，不猜0或delta；返回null继续既有公开legacy查找，等待P5按商品真相审计/回填。ledger有但counter缺失、坏counter/ledger/proof都拒绝且0写。现有NodeSDK inc在absent字段不可靠，JSON的假定零初始化不能作为真实基数。此行为只针对images.publishedRefCount；OEM/rate/其他字段继续原inc。

## 实现与取舍

抽取C1同快照加载/纯计划为内部共享步骤，read/settle行为保持。adjust从`settlement?.ledger ?? originalLedger`和有效值生成一张最终image，epoch由全体结算至多+1，delta不另加epoch；0delta且无终局0写，0delta有终局可清理。native用现有catalogRowStore/严格ACK；JSON复制、文件锁及持久化失败恢复，与C1一致。

```ts
const next = snapshot.effectiveCount + delta;
// Validate next as a nonnegative safe integer before any write.
await tx.set('images', { ...settledImage, publishedRefCount: next, updatedAt: now });
```

拒绝rawbase+delta、两次写入、nested事务、对legacy默认0、修改nextCounterValue全体调用者，以及提供通用重复重试承诺。旧delta没有operationID，丢ACK后无法安全盲重试；本步只能确认readback，不声称一次性业务操作恢复。后续ownedproof最终提交解决原P1，旧postcommit错误隔离/回填边界保留。

## 测试与review

先用实际JSON adapter/现有incrementField复现正反pending错误、取消/混合/损坏、0delta文件写及legacy缺失误初始化；然后测试共享纯步骤预算/边界/metadata、native严格ACK/同transactionId与生产接线、两JSON adapter并发。重跑C1/cancel/public及相关包/Node20/SDK/types，在关键节点检查函数产物与worker/public衔接。最终provider真实MVCC/P95、所有旧写端和真实三时钟/20件验收仍未完成，fullDeliveryReady=false。

## 本地结果与证据边界

八个现有JSON API红测均复现业务错误，无缺export/语法错误替代。最终新增44项：共享快照20、native7、JSON17。相关native/store/JSON聚焦372先通过；随后补持久化失败测试，JSON17全部通过。完整各包及脚本最终5156通过：shared309/db1777/admin638/local661/public182/sync304/site797/scripts488；0失败/取消/跳过。首次完整5155之后仅增加一项JSON持久化测试，补跑整个local661和实际Node20新集合2098；其他包生产/测试代码未再改动。19包types/E2Etypes/standingSDK通过，新增测试后local types另补通过。

18个源码反例均检出：16个测试反例79重叠失败，加两个实际SDK-only反例（生产increment路由绕过、SDK start后才读取输入）。三文件SHA恢复；原saveCatalogProductInCloudBase到initialized之间的保存/actor/classification fence块逐字节等于ad383a8。

实际Node20+安装NodeSDK3.17.2/database1.4.3编译探针29组，保留原15读端用例，加正反增减、混合取消/未决、80项82ops、三坏ACK回滚、输入提前捕获、legacy缺失保留。每张图片和proof点读、唯一set都使用同一实际transactionId；已写但丢commit ACK后只做readback，不盲重放非幂等delta。四个独立Node24/20 JSON进程验证base0+已提交1再减1，丢回答后重开为0，空ledger/epoch5/proof保留，后续读/零delta无文件写，隔离目录已删。没有真实vendor网络/MVCC/P95证明。

本轮两次夹具问题均保留：Biome unsafe把delete改成undefined并给proof生成可选链赋值，导致一项文件加载失败和四项存在性测试失败；改为Reflect.deleteProperty和显式对象断言后复跑通过。SDK探针把同步parse拒绝误用assert.rejects，改为assert.throws，生产解析位置未动。这些不算产品反例。新测试专门破坏JSON内存rollback时出现一项业务失败，恢复后通过。

实际review共享加载/增减、native原接线、JSON事务提取、接口/门面注释、三测试、本说明及协议/SDK/实施记录。措辞把“null只表示missing”补为“legacy缺counter的基数未知也返回null”，对照实际未增加字段/0写/返回null测试，避免把未知当0。没有新SDK方法/shim/依赖/HTTP字段/环境。官方[事务文档](https://docs.cloudbase.net/database/transaction)再次核对点文档、首次读取快照、100ops/30s；示例包装不能替代已安装SDK实际返回。Context7不可用。当前分步计数producer关闭，旧审批、删除、回填、普通写入、最终原子提交/恢复、UI/provider/P95、test发布和真实三时钟/20件恢复仍需完成；fullDeliveryReady=false和原formal P1保留。
