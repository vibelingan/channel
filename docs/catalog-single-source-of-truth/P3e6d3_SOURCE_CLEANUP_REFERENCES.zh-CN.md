# P3e6d3 来源图片清理与待上传状态保护

状态：本地来源退役、pending状态保护与候选清理兼容完成，基线7c1ee95。真实pending/proof producer仍关闭；其余writer/最终发布和真实云验收未完成。

## 问题与边界

source-media-import retire仍只检查rawbase0并直接写隔离intent；有已提交+1或未决pending时可能误退役，已提交-1又会误拒。removeImportedCandidate也有与abandon相同的旧base预检查，并把底层引用冲突误说成delete-failed。复用同一删除引用校验，不能另写计数逻辑或先写settlement再读来源link。

pendingImage允许checkpoint/activate/fail时需要同步验证：没有ledger沿原行为；合法空ledger/count0可继续；非空/坏ledger不得把不一致来源图片继续激活或标失败。active图片复用保持原内容/字节身份，不增减计数；其整行解锁写入必须保留当前计数和账本，不因rawcount出现而重复加guard。新发布producer仍必须只接收active/已验证字节，并遵守同一mutex和hold，这一步不能代替最终握手。

## 数据与选择

提取d2的只读零引用/无未决规划到image-deletion内部共享函数，普通/孤儿删除与source retire共用，原有无ledger特殊规则留各自入口。输入是同事务第一次读到的实际image；非空再读image/proofs并对照，禁止伪造缓存get。返回ready+合并后的完整image或conflict/corrupt，供应商错误抛出，0写。

source retire先校验ownership/过期/mutex/link/存储身份，之后用计划清理合并进原image隔离set和既有link failure note；最多初读image1+link1+plannerimage1+proof80+image/link各1写=85docops。给planner95预算，预留前三项已有操作。proof保留，未知/正数不退役，持久intent先于字节删除。

```ts
const prepared = await planImageReferenceDeletion(store, image, 95);
// Only after all reads: quarantine prepared.image and retire only this operation's URL claim.
```

native/JSON source命令首个异步边界前以已有schema解析复制，包含target嵌套字段。candidate入口保留所有准备/审批hold与原引用扫描，有ledger时交给底层事务决定，conflict映射still-referenced。无第二锁/队列/持久字段或SDK方法。拒绝猜缺proof为取消、直接改基数以及宽松初始化未知legacy计数。

## 检查

先用现有source retire和checkpoint/activate/fail接口复现坏状态；另用实际importCandidateImage→removeImportedCandidate检查前置拦截与原因。随后覆盖空/无ledger、80项85ops、所有权/时间/新URL持有人、严格ACK与SDK实际接线/提前capture、JSON重开/字节清理、旧d2删除与increment/public完整回归。backfill/genericwriter、旧审批/最终原子提交、UI/历史/provider/P95/test及真实时钟/20发布恢复仍开放；fullDeliveryReady=false。

## 实际结果与review

12个真实入口场景先红11/通过cancel控制1；不是缺export或脚本语法失败。最终新增34：DB24（source22/native捕获2）、sync4、local6。415聚焦先通过，另四个先拒guard与两个active正常控制补入最终各包；最终shared309/db1831/admin638/local673/public182/sync308/site797/scripts488=5226通过，实际Node202196通过，0失败/取消/跳过。首次完整5224后只增加两项DB正常active控制，整个DB1831和Node202196补跑，其他包生产/测试字节未再改。19包/E2Etypes/standingSDK及最后DBtypes通过。

来源15反例：14测试产生139重叠失败，加1生产路由SDK-only；还在提取后重新运行d2全部17反例（16测试75重叠失败+1SDK-only），独立前缀保存旧提交证据。两集合共32反例检出，源码各自五SHA恢复。覆盖跳过规划/settlement、过度拒绝合法legacy/空ledger/active复用、错误清新URL持有人、跳租期/锁、旧base预检查、原因误报、native/JSON晚捕获与生产路由。首轮注入器缩进未匹配即退出并恢复，不算业务检出；修正定位后完整重跑。

实际Node20安装SDK66组，保留43读/旧增减/普通删除组；source helper和生产adapter覆盖五种终局状态、80取消85docops/同实际transactionId、image/link两set的六种坏ACK回滚、retire丢commit ACK后0写恢复、SDK start时改变命令和嵌套target仍按原快照、pending三种失效写禁止。汇总明确来源最大85、删除83、旧counter82，并将“单image写”标记限定reference路径，避免与来源image/link双写混淆。只替换SDK HTTP，不是真实vendorMVCC/P95/COS证明。

四个独立Node24/20进程：创建实际PNG与来源claim/target，退役时清账本/URL且保留字节并丢回答，重开后完成PNG删除、图片移除、proof保留，重放0删字节/0文件写。目录已删。实际cleanupOrphanImages本地API覆盖五种状态：addition/missing/corrupt保留PNG，removal/cancel删除，重复清理安全。active热命中/跨URL去重复用保留非空ledger、原base、checksum、storage与proof，并释放仅自身导入锁；刻意过度拒绝这两正常路径时两项失败。

保留开发/夹具失败：提取函数后格式检查指出参数赋值，人工同时发现command.imageId残留，改为局部image/当前image._id后才跑绿色测试。真实API测试原用通用upsert创建proof，自动createdAt/updatedAt导致严格codec拒绝；改为隔离夹具内精确terminal行，保留两个失败日志，不放宽生产proof。SDK扩展首次start变量重名SyntaxError，放进单独作用域后66组通过。没有把这些脚本/夹具错误当业务反例。

实际review九个代码/测试文件、MIU/协议/SDK/实施记录及source active解锁分支；把初稿“不写其计数”改为“不增减计数，整行解锁保留计数和账本”，对照两个真实源码写点与warm/reuse正常断言，避免把整行写说成不写。原saveCatalogProductInCloudBase到initialized、actor/classification fence块需最终review再对照7c1ee95，未主动改动。无新SDK方法/shim/依赖/HTTP字段/锁/队列；Context7不可用，复用已核验官方/安装SDK事务契约。精确提交函数/site构建及worker/public/admin/sync组合在commit review后继续。

旧审批、backfill/genericwriter、最终终局producer/原子提交/丢回执恢复、UI/历史/provider/P95、test部署与真实三时钟resync/load/Edit/Preview及20件分类保持发布回退仍开放；fullDeliveryReady=false及原formal P1保留。属性筛选mapping想法未进入此实现。
