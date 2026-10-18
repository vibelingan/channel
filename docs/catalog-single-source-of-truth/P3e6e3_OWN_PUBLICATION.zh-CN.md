# P3e6e3 原操作发布的唯一提交

基线6cee65ab。实现前退出条件：同一事务核对当前actor、原根input/policy/TTL、产品内容/身份/生命周期/分类/来源、全部配置页与图片暂存前缀、当前completed媒体回执；唯一终局槽为空。然后仅写product、原根complete+小型completion、不可变commit proof。不得另行published补写或提前产生proof。复用既有publication/pagination/approvalReceipt与版本推进，不修改已有分类/别名/来源。内部入口不接受浏览器proof/list/候选。

重放由原root和相同终局proof证明已经提交；当前产品仍匹配成功快照才current。随后下架或其他批准不能被历史成功重新上线。取消不翻转complete根，过期/被撤权原actor的可信恢复仍待后续。根strict历史codec同时适配complete，不让旧legacy finish取得新根。

本地最终事务、完成回执、普通图片字节保护与组合测试已完成；精确提交构建待提交后补记。客户HTTP/UI、真实provider与P95仍未验收，原正式UI P1/fullDeliveryReady=false。


## 实施与业务边界

新增内部 operation-publish，只接受原productId/operationId/inputDigest。继续原actor/source/identity/content/lifecycle/classification/policy/TTL检查，并核对全部配置页、完整规范referenceStage前缀、空终局槽；重新验证当前completed媒体回执必须等于冻结绑定。未决Changed/Removed直接拒绝，不能借分类批量操作自动批准；以后显式供应商审阅需自己的已确认流程，不能把这些标志忽略掉。

最终事务复用advanceCatalogProduct推进上线生命周期，validateProductPublication给有界安全字段诊断，建立既有immutable publication/pagination/approvalReceipt。只写product、原根complete+completion、同一Merkle commit proof，图片基数不先加也不重写。小型completion保存成功时的productUpdatedAt/published=true/原版本快照，保留初始operation/saved/media/references/progress。读取严格重建job、全部引用前缀及同一终局证明；已有成功读回不依赖原TTL，当前版本不同则current=false。下架后的重放只读历史，取消不得翻转complete或删除commit proof。旧legacy入口strict decoder不接收own根。

同时补齐提交前字节稳定性：普通images写入已有ledger后，不得改status、provider/mode/file/path、mime/size/checksum、inline data或保护标记，含字段路径/存在性；相同字段可精确重放，名称/其他metadata与原mutex继续可用。受保护内容更新仍走既有媒体生命周期，未创建ledger的新图片导入激活仍可用。没有新锁。完整检查migrateImageLocally只更新新建无ledger图片；旧迁移只加migration*候选，不换当前字节；回填只写受保护counter；source/upload/protection原transaction生命周期与正控保留。native/JSON生产adapter及原save actor/classification区块逐字节未改。

## 红测、反例与回归

新增56测试：DB48（own操作33、普通图片保护15），JSON8。初始24项新增最终操作测试有11项业务红，其余13项拒绝正控在未识别action时已通过，不能把它们算作独立新根因证明。之后16项字节稳定性检查在旧行为失败，含真实JSON并发普通图片变更/最终提交；另两项Changed/Removed在实现最初仍可被批准，已先红后补拒绝。

最终相关381全通过；完整5585=shared309/DB2101/admin638/local762/public182/sync308/site797/scripts488，fail/skip/cancel均0。实际Node20相关2597、19包types/E2Etypes、standingSDK、六文件显式Biome/diff通过；Astro216文件0error/0warning、8既有hint。未采用unsafe lint fixes，delete测试手动改Reflect.deleteProperty保持字段缺失语义；precommit的错误lint --silent打印PASS不算证据。

27个源码故障全部检出，25个unit故障共101重叠失败、两个SDK-only。覆盖漏任一最终写、提前写proof、未完整暂存、盲覆盖终局、不复核媒体/截止/网站字段、漏生命周期、完成根不查proof/伪装current/重放重新上线/错误取消、完成job/引用/取消标记损坏、未决供应商自动批准、普通内容/path/presence/相等重放/原锁误拦、生产路由和等待前输入捕获。第一次仅移除readApprovalJob检查时，unfinished-page用例仍被references的冗余页检查挡住，未记成检出；补variantCount与root列表不一致的独立用例后，该故障才被检出。finally恢复五源码SHA，399 SDK正控、381相关在恢复后重跑。

截止测试先在媒体job读取时跨时钟，只能证明媒体复核拒绝；已改在最后一个媒体产品读取后跨原服务期限，并精确断言APPROVAL_EXPIRED，使删最终截止检查的故障确实检出。捕获故障使用正确command字段：native先完成343项正常SDK用例，再在本次publish的真实startTransaction等待改写输入处失败；JSON正常发布重开仍通过、仅等待期间改写用例失败。

## 安装SDK与实际图片串联

实际Node20安装SDK399项保留329+70，只有HTTP传输被替换。原持久化与生产adapter均调用真实事务，关联来源最终15文档操作：actor/root/product/source三读共6、终局槽1、媒体job/product/source三读共5、最终三写3；与1图/27图数量无关，不用缓存图片伪造事务get。全部读先于写，九类product/root/proof后段坏ACK逐项整体回滚/重试；commit已应用确认丢失时，get/重复finish证明同一complete与proof，零重复写。上游图片页仍最大98；最终不声称15操作可证明云端MVCC或P95。

SDK探针第一轮把导出的计数read别名snapshot误写成顶层run，引发探针递归和夹具污染；修正脚本使用实际snapshot及正式sourceObservationDocumentId后399项通过，生产逻辑未因此修改。首个真实PNG发布夹具只有配置图没有主图，最终检查正确拒绝imageIds；保留R1日志，改选真实编译worker已验证、在准备前就有主图和描述的隔离warm手工商品，未修改其Misc/子分类。来源绑定另由实际SDK场景验证，不能把这件手工夹具称作三件真实来源时钟。

五独立Node24/20进程：编译worker真实保护PNG/ready→当前JSON私有暂存，商品/图404→原子发布丢回应，商品/图200→重开同根成功与零文件写→编译admin真实update下架，商品/图404，私有24×16/SHA、原分类和commit proof保留，重放历史不重新上线。父adapter原文件未动，子进程顺序接管独立快照，finally清理。当前使用6cee65ab的编译worker/admin/public配合新源码JSON；精确新提交构建需随后补跑。

另把普通字节保护故障接进实际PNG流程：允许普通写把已暂存图改成failed/另一对象，然后实际完成同根发布。公开商品确实200，编译图片路由404；断言检出，原保护源码SHA恢复、隔离夹具清理，381相关重跑通过。这是原风险的独立重证，不是只测试throw是否发生。

## 人工review与交付边界

实际审阅product-operation、detail-staging、image-reference-write三个生产文件，以及DB操作测试/图片保护测试、JSON操作测试和四记录文档。交叉核对媒体完成证明/图片hold/immutable target、C1终局读、旧下架counter、普通写所有入口与import/migration/既有actor围栏。文案把“complete代表当前已上线”改为“完成历史+current/revisionCurrent”，并区分source SDK/手工warm PNG/客户时钟；按实际写入、五PID、200/404和finally日志核对。未改共享API/SDK/shim/dependency/env，无agent/新分支/worktree/PR/push/deploy/客户数据改动。

原正式UI整笔发布丢回应的P1尚待新操作接口接线后重测。本步只完成内核原子提交；尚需可信过期/撤权恢复及80槽续接、live-edit私有候选、供应商/分类审阅回执、UI全部操作组合、历史数据与问题列表fallback、真实provider竞争/P95、test部署和三时钟resync/load/Edit/Preview及20已有分类商品发布/只恢复自有清单。fullDeliveryReady=false，不能启用客户新producer。
