# P7a9：取得图片hold时读回当前有效像素证明

## 运行问题

后续20件共用同9张图，图片已是应用持有的不可变protected target。每张仍依次reserve、额外get、begin protection、get protected health、advance，再做attest。begin在有效缓存时仅重复确认已committed，get protected health又重新开启一轮完整当前输入事务。P7a8减少inspection写入后，9图每件仍3次worker，重样本90秒仅12件发布。

## 数据与约束

| 值 | 边界 |
| --- | --- |
| includeProtectedHealth=true | 仅原私有reserve命令可选，省略仍返回原reservation形状；不加公开HTTP命令 |
| protectedHealth | 既有readCatalogProtectedPixels验证的当前immutable target、intent、policy、checksum、size和inputDigest；缺失返回null |
| hold/job lease | 原reserve事务验证并写入；所有图片/intent/cache读取在任何写入之前，最后仍验证当前能力 |
| 图片与计数 | 缓存只读，无新复制、无cache共享写入，无发布引用变化 |
| 后续advance与attest | 原事务继续读当前图片/hold/像素记录/输入摘要；缓存命中不能直接推进或ready |

单事务增加最多image、intent、pixel receipt三个点读，仍远低于100操作；不扩大到多图片事务，不含对象网络调用。既有SDK get/set，无新SDK/存储/集合/环境。

## 选择与流程

reserve增加私有可选flag和私有可选protectedHealth回执。有效回执来自与hold同一当前事务；worker只在默认真实检查路径使用它，以其inputDigest传原advance。缓存miss/老policy/不同target/不同checksum/占用锁/坏记录均走原prepareStoredCatalogImage，再真实读取/保护/验证。注入checkImage的测试/诊断路径保留原检查，不用缓存跳过它。

本单元仍保持每轮最多4张媒体检查，用完整1图/9图小流程验证后，再由独立P7a10把有效缓存和物理I/O的分轮上限分开；不在本单元提前改变物理检查或证明上限。

## 风险与反例

先验证opt-in能取得当前证明、省略完全兼容、失效cache必为null；原schema不认识flag应失败。已保护共享图的小流程不能再发begin/get-protected-health或对象I/O，仍通过原advance/attest到ready，原代码会调用重复命令。reserve回执后取消、编辑或图片绑定变化，下一步必须拒绝旧证明；另一个imageId的伪回执必须拒绝。丢失reserve ACK后继续原job应恢复且零重复对象写入。

先RED、再实现和review，接着Node20及kernel/105图/真实HTTP-PNG组合；完成有界缓存分轮后统一跑原20件90秒和全部formal流程，不能放宽验收或把prepare当publish。


## 小流程结果与review

初始12条红测：旧行为1通过、11失败，省略flag的旧返回契约保持通过；其余失败为flag尚不支持、有效缓存重复保护命令、未采用新回执。实现后12/12通过，再补ACK丢失恢复。只增加原reserve的私有literal true选项和可选回执；所有图片/intent/receipt点读在hold/job任何写之前，_id不匹配返回CORRUPT，正常cache miss返回null，guard不放宽。worker仍执行原advance和attest，取消/编辑/换图/伪imageId均拒绝，图片/产品业务行及既有共享cache均不改。首次类型检查发现测试夹具true被扩大成boolean，仅收窄测试literal，没有把协议改为任意boolean。普通检查选项依旧调用原字节检查；用显式分支替换三层异步三元，复核路径/返回值相同。该单元尚未改变4张媒体轮次；P7a10另测缓存分轮。

后补ACK丢失后，整个小流程13/13、0跳过通过，仍使用原jobId恢复。


## 原故障注入路径复查

首次Node20组合575项573通过/2失败。两条既有缓存测试仍把故障注在旧get-protected-image-health命令，新快路径不再调用它；未将断言放宽成零读取。编辑竞态改在实际返回保护证明的reserve之后注入，并明确断言已触发，仍要求STALE及cursor=0。缓存回执读取异常需保留原可用fallback：可选reserve事务异常时，在预算内仅一次用同job/lease/image的原无flag reserve，幂等重取hold，再走原保护/字节回退。明确失败返回、权限/校验/状态/BUSY及事务冲突异常不重试，预算用尽不开始fallback。两次ACK都丢仍可显式继续同job；一次丢失应在本轮恢复。原字节fallback测试实际注入可选和原回执读取故障，仍要求只读一次真实对象、verified且不产生假retry。
