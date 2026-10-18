# P3e6c1 图片引用的一致快照读回与结算

状态：内部快照读/结算及native、JSON适配完成本地验证。基线26c0a9a。账本producer/最终公开提交仍关闭。

## 运行问题与选择

P3e6a已用独立商品真相模型证明：跨快照读取图片基数及不同提交证明会得出从未真实存在的计数；只结算调用者的差值也会把合法共享引用变成负数。下一步提供一个内部事务原语，使用同一transaction读images和账本列出的所有小型immutable proof，再计算有效数量或结算全部已提交项。只查proof，不按后来的actor/source/TTL撤销已提交事实；不读取1MiB操作根，也不做where或全表扫描。

不新建计数第二事实来源。图片增加catalogPublishedReferenceLedger的字段名作为协议预留；本步只处理测试夹具中的账本，没有实际写入pending/commit proof的producer。现有public/删除/旧increment/backfill继续原逻辑，全部消费者兼容前不得启用真实账本。后续producer、writer保护及计数迁移仍须逐一验证。

## 输入、预算和状态

strict内部命令{action:read|settle,imageId,maxDocumentOperations?:1..98}；imageId沿现有图片ID语法，不新增ID业务长度限制。命令只含原始值，进入SDK启动/JSON锁之前解码成独立对象，不能等待后采用caller改动。默认98不是新增vendor上限，沿本仓库100减余量的应用预算。

同事务点读图片1次，最多80个proof，每批至多4个并行点读，禁止一次无限并发。预先验证有界账本/成员证明再取proof，read预算1+proof数；settle有proof时保守另留1次整行写预算，最多82。全部读先于唯一image写。没有active proof则0写，不改epoch/updatedAt。结算应用所有已提交项，保留未提交项和全部其他图片字段，epoch+1。

| 图片状态 | read | settle |
| --- | --- | --- |
| 不存在 | missing | missing，0写 |
| 无counter、无ledger | legacy，保持字段不存在 | legacy，0写 |
| counter有效、无/空ledger | counted原值 | counted，0写 |
| ledger存在而counter缺失/坏值，或ledger/proof损坏 | 拒绝，不降级legacy | 拒绝，0写 |
| 有pending但证明不存在 | counted不采用该差值 | 保留pending，0写 |
| 有已提交证明 | counted采用所有已提交差值 | 基数与ledger同事务结算一次 |

read/read不互斥；read/settle各自快照内部一致；settle/settle竞争同image记录，重试者读新epoch和pending后0重复写。JSON跨adapter锁保证该交错，native使用既有runTransaction/严格set ACK；本地SDK传输不能替代真实vendor快照/冲突证明。派生结算不能破坏图片mutex/tombstone/storage metadata，完整spread保留，并由同image写冲突处理并发变化。

## 检查

红测覆盖混合+/-已提交/未提交、全部结算、后续撤权/来源/过期不撤销commit、80个证明/82操作边界、坏counter/ledger/proof/漏读、读失败/坏ACK、命令等待前冻结、0写重试、真实SDK与JSON并发/文件重开。原P1、全部消费者兼容、最终提交与UI/P95/test部署/3时钟20件恢复未完成，fullDeliveryReady=false。


## 实现与验证

新增catalog-image-reference-store，共用strict原始值命令和一个事务体；native在实际SDK启动前parse，JSON在等锁前parse。pure模块抽出readReferenceLedger供获取proof IDs和最终结算共用，原51引擎行为保持。row response必须明确为doc/null，undefined不能当查无；proof批采用allSettled，任一失败时排空本批后抛错，不能留下请求和事务关闭竞争。所有读在image唯一set前，无root/source/actor读取，不重判已提交事实的当前资格。原native保存/actor fence块保持逐字未改。

先以缺模块红测，再补两条真正业务红：undefined被??null当成不存在，以及Promise.all先拒绝时仍有3个读取未结束。修复后pure51/store49/JSON10共110聚焦通过。JSON十条覆盖读无mtime变化、首次/重开/零写重复、同图settle/settle和read/settle、跨图共享proof、文件persist失败回滚、锁前捕获和三类损坏。不是使用内存对象代替真实JSON文件状态。

实际安装Node20 SDK、compiled native及生产adapter method接线12组，仅HTTP传输替换：混合+/-/缺失proof、80项82文档操作（81读+1写）、预算少1在读proof前拒绝、读先于唯一image写、全部未提交项与metadata保留、3种坏ACK回滚重试、commit已生效却确认丢失后不重复结算、真实SDK启动延迟后原命令不变、legacy/missing及坏proof拒绝。installed database1.4.3 document.js167–193直接证实事务get的data为单doc或null，非事务get才是array；继续使用原SDK包装和strict ACK，不照搬OpenAPI。

四独立Node24/20进程以真实文件先读未结算有效1、结算丢答案、重开和再settle；基数1/epoch5/0后续文件写、proof保留，夹具已删除。不能把它叫真实provider snapshot/并发证明。

抽取后的原引擎18反例再次检出134重叠失败并SHA恢复，另17快照/适配器反例检出52重叠失败与2个仅SDK探针检出的接线/启动前捕获失败，三源文件恢复SHA一致。失败路径包括假legacy、缺写预算、超并发、读操作产生写、丢metadata、吞失败/undefined、未排空、零写重复变写等；没有用syntax/import failure冒充反例检出。最终SDK基线重新编译后12组通过，避免遗留mutant bundle。

本步对应五相关包3446（DB1732/admin638/local641/public131/sync304）全部通过，fail/skip/cancel0。实际Node20全DB+新JSON1742；19包types/E2Etypes通过，Astro216项0error/0warning、8既有hint，standingSDK通过。未改site/scripts，未把此前26c0a9a的4981记成当前整仓重跑；最终功能串联仍按总矩阵继续。显式Biome/diff和精确SHA构建在review节点完成。

review实际覆盖pure/helper/native/JSON/adapter接口/package出口、两新测试、本步文档/IMPLEMENTATION_LOG/SDK记录；复核installed SDK get和原保存块。简化为同一纯引擎、同一事务体，保留4并发proof点读与实际文档预算。实际修改：初稿“imageId至多200字符”改为“沿现有图片ID语法，不新增ID业务长度限制”，核对isApprovalImageId只有字符语法限制，并把201字符误拒测试改为非法换行。单图80未结算证明、82文档操作与20件批量是不同的边界。

最强剩余限制：所有旧counter/公开/删除/回填/普通写入consumer还没有接入，故无真实pending字段producer；真实vendor读快照/写冲突/P95仍未验证，原formal P1继续。不能用此原语通过宣称完整发布修复；fullDeliveryReady=false。
