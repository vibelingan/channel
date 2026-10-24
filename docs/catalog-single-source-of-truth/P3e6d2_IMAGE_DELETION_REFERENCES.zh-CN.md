# P3e6d2 删除图片前核对完整引用快照

状态：本地普通/孤儿删除及后台abandon入口兼容完成，基线b91c7ac。真实pending/proof producer仍关闭，其余写端及最终发布未完成。

## 运行问题与不变量

runImageDeletion仍只检查原publishedRefCount。base0+已提交加1会被误判为可删；base1+已提交减1会误拒绝。删除字节不可逆，必须先用同一事务的所有小型终局证明计算、结算；有效正计数或仍未决的pending禁止隔离/删除。不能对已提交引用只取rawbase，也不能把任意缺proof当取消。

## 数据与约束

原图片mutex、所有者、status和存储身份检查继续；原调用者的商品/准备/审批hold扫描继续。仅当存在ledger时扩展引用检查，旧无ledger行为不变。合法空ledger复用本行快照，不多读；非空先做所有者/lock检查，再在同一事务重读图片+proof，比较两个图片快照一致，防止把传入的旧图片伪装成缓存事务get。初次授权读取1+后续image/proofs81+唯一隔离set1，80项最坏83docops；为首读保留1，因此计划预算97。所有读必须在set前。

新增内部只读settlement planner复用C1加载，返回snapshot和可选完整settlement image，不提前写。仅当effective0且移除所有终局后pending为空才把它与原删除intent合成唯一set；拒绝路径0写。取消保持基数，已提交移除正确降为0，证明永久保留。未知/坏ledger或proof返回corrupt；vendor读错误继续抛出终止事务，不能报告成功。已deleted行的同步intent解析只接受无ledger或合法空ledger/count0，不能继续删除仍带pending的损坏隔离行。

## 实现边界与取舍

```ts
const plan = await planCatalogImageReferenceSettlement(tx, { imageId, maxDocumentOperations: 97 });
// Read-only plan. Combine its cleared ledger with the deletion quarantine in one write.
```

拒绝先settle写再runDeletion读写、nested事务、假的缓存tx.get、全表扫描和每项根读取。授权前不读取proof，token/uploader/原mutex条件保持。native/JSON边界在首个异步步骤前解析复制删除命令。真实producer还需遵守同mutex和持久hold，不以本删除读端替代该握手。source retire/upload invalidation、旧审批、backfill/genericwriter和最终原子激活在后续MIU，不宣称本步全体完成。

## 测试

先在现有runImageDeletion入口以实际行/独立proof构造业务红测：commit+1保护、commit-1清理后删除、cancel清理、missing仍保护、坏proof/ledger拒绝、已隔离行pending拒绝、orphan防护。之后覆盖所有者/lock先拒、空/无ledger预算、80项83ops、混合与存储身份保留、并发与严格ACK/重开、public bytes与正常删除恢复。完整本地/真实vendor/P95/三时钟/20发布回退仍开放，fullDeliveryReady=false。

## 入口、回退与实际结果

后台abandonUpload也有rawbase预检查，先补五个真实本地文件入口测试：四失败（加引用/missing/坏proof误报内部错误，已提交移除仍误拦），取消控制通过。入口对有ledger的图片把最终决定交给原删除事务；无ledger原预检查保持。conflict返回CONFLICT并提示完成或取消相关商品操作后重试；corrupt返回保留图片/修复后再移除提示，forbidden保持上传者限制，未知写结果仍按既有runner读取持久intent恢复。未读到安全intent不能删字节。

最终新增36项：DB30（删除21、planner2、native7）和local6。八个底层业务红测先复现；五个入口中四个业务红测再复现；无导入/语法错误代替。441聚焦通过；完整shared309/db1807/admin638/local667/public182/sync304/site797/scripts488=5192通过，实际Node202142通过，均0失败/取消/跳过。19包/E2Etypes/standingSDK通过；测试中复制asconst夹具推导成字面量导致三项类型错误，改为真实接口参数类型后复跑，不放宽生产类型/校验。

17源码反例均检出：16测试反例75重叠失败+1生产adapter路由SDK-only；五文件SHA恢复。反例覆盖跳过ledger、未结算就隔离、放行正数/未决、错快照、吞供应商错误、丢metadata、跳权限/锁、planner提前写、旧入口拦截、冲突误报、native/JSON晚捕获和不安全intent恢复。原saveCatalogProductInCloudBase/actor/classification fence块需在最终review再对照b91c7ac，未主动修改。

实际Node20安装SDK43组（保留原29），原helper及生产adapter验证同实际transactionId、83docops/80取消、1隔离set、3坏ACK回滚、SDK start前命令捕获、已隔离但丢ACK后0写读回/finish/proof保留，以及1读空ledger。SDK组合脚本首次重复声明eighty/begin变量，SyntaxError只算脚本失败；改名/复用变量后通过。只替换SDK HTTP，不证明真实vendorMVCC。

四个独立Node24/20进程创建两份实际本地文件：先隔离且保留字节、丢弃回执，重开后删除两个文件并移除图片，证明仍留存；再重放0字节删除/0文件写。隔离目录已删。实际后台本地API验证加/未决/损坏保留两份字节，移除/取消正常删两个文件，重复abandon安全。精确本SHA构建、worker有效PNG到公开HTTP/后台删除串联在commit review后继续；不是云端真实选品验收。

实际review十个代码/测试文件及MIU/协议/SDK/实施记录。把原对所有结果统一“Image deletion is incomplete”改为引用未完成时完成/取消商品操作后重试，对照五项API结果code与真实文件是否仍在；未知供应商/持久化结果保留原runner恢复路径，不把每个冲突都说成删除失败。未增加SDK方法/shim/依赖/HTTP字段/第二套锁。新export只是内部只读planner和已有删除schema，复用已核验SDK契约；Context7不可用。仍需source retire/upload、旧审批、backfill/genericwriter、终局producer/最终提交、UI/历史/provider/P95/test部署/真实三时钟resync和20件恢复；fullDeliveryReady=false及原formal P1保留。
