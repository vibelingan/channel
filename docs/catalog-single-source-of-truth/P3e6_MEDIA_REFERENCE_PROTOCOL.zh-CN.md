# P3e6 大媒体提交协议复核与最小实现

状态：纯计划、同快照读/结算、取消读端、公开消费、旧计数/删除/来源/上传写入保护，以及内部原根暂存、最终发布和可信恢复已通过各自本地检查；客户流程尚未接入，producer未启用。原正式响应丢失P1、真实云验收和fullDeliveryReady=false保留。初始基线c0058e7。

## 运行问题与边界

现有 finish 的实际逻辑是 5 个固定操作 + 图片点读 + 计数变更写；自己的操作另有 source/版本读，合法 105 SKU/多图片不能塞回同一 98 操作预算。不得降低合法图片数量，也不能先加公开计数、稍后再发布商品，后者会让私有图提前公开。

采用同一审批根协调的分阶段计数差值：先在图片行暂存该操作的 +/-1；最终 product + 原操作成功回执 + 小型不可变提交证明同事务落盘；只有存在对应证明的差值才影响有效计数。最终提交失败时，暂存差值不公开任何图片。证明是已有审批集合中的不可变数据，不承载第二套状态机，也不取代原根的身份、版本、TTL、取消、重试与成功语义。小商品保留直接事务快路径；无引用变化继续不写共享图片。

有效计数 = 已结算 publishedRefCount + 同一快照中所有已提交差值的和。结算一次合并所有已提交差值、同时更新基数并移除这些条目；不能只结算调用者的差值。已提交真相不因管理员撤权、source 更新、后来下架或根过期而撤回。证明不能在仍可能有图片引用它时删除。

## 技术约束与反例

2026-10-18 重读 CloudBase 官方 /database/transaction：首次读生成快照、单事务最多100操作、30秒、事务中仅doc而不支持where。Context7不可用。当前应用保留98操作预算。官方示例返回包装不可照搬；后续适配仍核对 installed node-sdk3.17.2/database1.4.3。这里的纯函数不声称证明真实云MVCC。

非快照读反例：基数0，+A已提交、+C未提交、-B未提交；先读C未提交，随后C上线、B下架A，最后读A/B已提交，得到0，尽管每个真实时刻至少有一件公开商品。单独读取一个调用者也会算错：基数0，已提交+A/-B，先结算-B会产生-1。因此 public/delete/settle 必须在同一事务快照点读图片和其所有小证明，或使用已独立证明等价的方法。

## 数据与存储预算

图片内部账本有版本、单调epoch、最多80个未结算条目。每条只有操作根ID、差值、完整差值计划的树根/叶数、叶位置和哈希路径。提交证明只有固定字段：kind、操作根ID、树根、叶数；ID由这些字段哈希生成。用位置与左右顺序明确的Merkle路径，把某张图的 +/-1 绑定到整个冻结计划，避免为验证一张图读回几万ID或1MiB根。叶中包含imageId和delta，跨图复制、反向差值、错误位置/路径/根均拒绝。奇数尾节点复制自身，路径必须是规范长度。

计划上限65536个不同图片差值，路径最多16层；超过当前两版图库/描述图/10000 SKU图片并集的合同上界，不缩小现有合法组合。每图80条的完整账本限制为128KiB UTF8应用预算；不是腾讯云业务字段上限。当前catalogReferencedImageIds还合并原始图组，每侧原始两组最多36、批准头图库/描述图27、SKU图10000，因此两侧最多20126；65536不会缩小该已支持边界。无差值不写图片。80是暂存槽上限，不是产品发布上限：满槽时先结算已提交/永久取消项并可续接排队，不能把正常20件变成永久失败。80证明+图片1读=81；结算再加图片1写=82，仍须为调用者根/来源读写计入总预算。分组时按实际已读图片数、证明并集和拟写数逐个准入，不能读20图后再额外读80证明。

本步只实现计划生成、成员证明验证和一致快照的有效计数/结算规划，不接数据库、存储SDK或public API。快照由未来事务调用者保证，纯函数通过必须显式提供每个proofId对应的记录或null防止漏读。不能将“没查”当成“查到不存在”。

## 全部消费者的接入条件

| 入口 | 已观察的当前行为 | 启用账本前必须处理 |
| --- | --- | --- |
| public-api/handler getCatalogImage | 原始计数门禁、缺字段legacy fallback | 有pending时同快照求有效计数；无pending保留现有快路径和fail-closed |
| db catalog-detail-staging/commit | 事务内计数增减 | 同一引擎结算或走新版协议；不能越过98预算 |
| admin applyImageVisibilityDelta | overstock等旧入口提交后increment | 必须与pending兼容，不能盲减基数；不扩出另一锁 |
| db native/JSON incrementField | 原子inc或文件锁，images不在catalog-row集合 | 只改变图片计数分支；保留OEM/login等其他计数器 |
| db backfillPublishedRefCounts | 分页tally后绝对覆盖，要求静默窗口 | pending/epoch及tally开始前的版本保护；不能双算或覆盖并发发布 |
| admin abandonUpload / sync discard | mutex→preparation hold→approval hold→产品引用→raw0 | 同锁结算，保留扫描次序和active proof；删前不能只看基数 |
| image-deletion | 持有现有mutex，raw0后tombstone | 不允许未结算项被丢弃；不可逆删除前持久化意图 |
| image-upload / source-media-import | pending0激活；active重复只复用/校验，spread保留字段 | 新建保持0；重验/复用不得清空账本或换掉已证明字节 |
| catalog-image-protection | 持有既有mutex，先验证同checksum新对象再迁移，spread | 保留账本；旧字节清理与pending hold等价保护需race证明 |
| admin legacy migration | 仅stage migration指针、不改当前provider/status | 保留字段及mutex；不算新内容审批 |
| trusted update/upsert/full-set | 未全部加保护 | 从repo生成写入清单；保护字段不能被普通patch/fullset覆盖 |
| admin图列表、preview、inspect、媒体健康 | 部分直接检查/显示基数 | 有pending时真实可用状态/删除按钮一致；私有preview不走公开门禁 |

所有真实启用前置项尚未完成；本表不声称现有旧入口已经修好。新持久字段不得先写到test/production让老读端误判。

## 媒体可用性与持久hold

上述计数协议只解决计数，不自动证明图片字节可用。媒体seal必须在持久审批hold之后核对status/存储/既有mutex；最终提交需相同的身份/版本/根/计划和未取消状态。删除先取得同一图片mutex再读hold；迁移只能保留相同已验证字节。完整复核确认index.ts原来已按一小时加十分钟余量查询hold；并非只有一小时。P3e6b1保留这个期限与余量，并为明确取消写永久标记，再让三种查找路径排除已取消根。余量与真实事务/时钟边界仍须provider验证，全体图片writer的保护握手也未完成；不能据此直接省掉final图片读或启用分阶段计数。

## MIU与测试退出条件

P3e6a：纯计划、证明、同快照计数/全体结算；红测→实现→独立hash/产品真相模型→故障注入、Node20/typecheck。P3e6b：同一根的持久hold/永久退役及有界媒体准备，先证明删除握手；P3e6c：native/JSON一致快照读与严格ACK结算、分组预算、重开恢复；P3e6d：所有旧计数/回填/删除/普通写入消费者兼容；P3e6e：自己的finish/visibility证明最终原子激活并恢复；之后接完整单件、批量、编辑UI与历史审计。每步重算实际预算，关键串联回归。原方案其余P3/P4/P5/P6/P7门槛保留。

不采用：逐个非快照读、仅结算当前root、提前加计数、重读1MiB根、把商品URL重写为另一套公开媒体协议、降低合法图片数、伪造tx.get缓存行绕过final校验。


## P3e6a实施与review

新增catalog-image-references纯模块，生成排序去重差值、分层哈希与按需成员路径，验证完整一致快照并规划全体已提交项结算。不存在DB或public调用点，未写入新账本字段。输入是公开引用集合，不是draft-only保护集合；未来producer必须由服务器从冻结product/candidate产生，不能接收浏览器声称的proof。

未来最终激活必须同时核对：根冻结的树根/叶数、全部adopted图片的可用性seal、所有差值已持久化的游标/hash、原身份/来源/生命周期/TTL，以及原成功语义，才可在product/root/proof同一事务写不可变证明。计数差值树不覆盖无变化图片，不能代替全体adopted媒体seal。证明存在后的精确重放零重复写；坏ACK和丢失commit确认仍须在后续真实adapter串联测试，纯函数不能证明它们。

先红：缺模块的测试加载失败；随后实现51行为测试。覆盖0/1/2/3/5/20/21/105/10000/20126图片及65536最大路径、重复去重/无差值零写、每图80暂存/81拒绝、128KiB预算、明确null与漏查区别、错ID/字段/成员/左右路径/奇数padding、重复root、正负净值与MAX_SAFE_INTEGER、未提交不公开、发布后下架及跨后续root保留。20/50/100按四件为一组的纯模型，以及12商品/4共享图/2000步线性化模型，每步以独立商品集合和BigInt真相计数核对；不称为真实UI并发、客户商品或丢响应恢复测试。

18源码反例全部业务红，累计134重叠失败，包括漏成员检查、漏image/delta绑定、无序子节点、只结算首项、已提交误当pending、漏读当不存在、proof不绑定、重复root、忽略差值、丢未提交项、epoch不变、81误准入、非规范奇数padding、额外字段、proof不绑定操作、逐项检查导致合法净零MAX误拒、逆序计划。finally恢复生产文件，前后SHA一致，最终版本重跑。不是通过语法/导入失败冒充检出故障。

最终七包+scripts4876：shared309/DB1594/admin637/local616/public131/sync304/site797/scripts488，fail/skip/cancel均0。Node20.19实际DB全量1594通过，19包types/E2Etypes/Astro216项0error/0warning（8既有hint），两文件显式Biome/standingSDK/diff通过。独立esbuild Node20单模块构建后，6组0/1/3/20/105/20126计划用Python hashlib独立重算根、proof ID及13条成员路径全部一致；该产物不是三个云函数的发布候选。生产函数入口及native/JSON源码未变，未重跑原已知失败的正式UI恢复断言。

本步实际review两个源码/测试文件、本MIU文档、IMPLEMENTATION_LOG与SDK-PROBE；另核对public图片门禁、admin旧counter维护、native/JSON increment、backfill、image-deletion/upload/source-media-import、catalog-image-protection、media引用提取与publication schema。人工审阅和程序检查分别记录：测试名称删去“lost answers”，改为“线性化模型”，因为这里没有真实HTTP回执恢复；以原formal P1仍开放、无新的DB调用点及测试只直接调用纯函数核对事实。

风险仍未解除：真实事务快照与写冲突、80槽续接和P95、所有旧writer/backfill兼容、永久取消与expiry hold、全体媒体seal和最终activate原子性，均是启用前硬门槛。原P3/P4/P5/P6/P7未完成。不得用本步通过宣称用户发布已修好；fullDeliveryReady=false。


## P3e6c1b取消读端补齐

commit与cancel共用由root/treeRoot/leafCount派生的同一终局行ID。取消差值为0、结算移除本pending，缺证明仍保留；80项仍81读+1写。已提交结果不能被取消，取消只针对尚未提交的操作；后续producer必须在原根事务精确重放或写唯一终局，禁止翻转kind。此时只有factory与统一读端已验证，真实producer仍关闭。详见[P3e6c1b](P3e6c1b_CANCELLED_REFERENCE_PROOF.zh-CN.md)。


## P3e6d1旧增减路径

images.publishedRefCount的既有incrementField改用同快照全体终局结算加delta、唯一图片set；legacy缺counter保持未知并返回null。其他字段不受影响。尚未接入旧审批、删除、回填和普通writer，不因此启用producer；没有操作ID的旧delta丢回执后不可盲重试。详见[P3e6d1](P3e6d1_LEGACY_REFERENCE_ADJUST.zh-CN.md)。


## P3e6d2删除兼容

普通/孤儿隔离先核对完整有效引用，未决或正数不删；只读规划把终局清理合并进同一次隔离写入，80项83docops。后台abandon也交给事务判定ledger，保留无ledger路径，冲突给继续/取消后重试提示。source retire/upload和其余writer不在此步完成，producer仍关闭。详见[P3e6d2](P3e6d2_IMAGE_DELETION_REFERENCES.zh-CN.md)。


## P3e6d3来源清理兼容

普通删除与来源退役共用同一只读零引用规划；source含URL note最大85docops，pending写只接受无ledger或合法空0，active复用保留原ledger/count/storage。候选清理旧base预检查/错误原因已对齐事务，所有准备/审批hold和引用扫描保留。其他writer与最终提交仍未接入，producer关闭。详见[P3e6d3](P3e6d3_SOURCE_CLEANUP_REFERENCES.zh-CN.md)。


## P3e6d4创建/更新与回填兼容

普通图片创建、deterministic create、update/upsert和租约写入共用保留字段守卫，已受ledger管理的base不能被绝对覆盖；metadata以原局部更新语义保存。回填报告managed/missing skip，写时再次核对，不吞未知供应商错误。只覆盖这些入口，其他通用remove/条件remove/非计数increment、生命周期writer和旧审批/最终原子激活仍待核验，producer关闭。详见[P3e6d4](P3e6d4_ORDINARY_IMAGE_WRITES.zh-CN.md)。


## P3e6d5剩余通用入口

managed图片不得经通用remove/条件remove删除，实际持久删除流程继续通过其原transaction rowstore；missing/未匹配/旧无ledger语义保留。image非专属计数increment不能改ledger/保留路径或operator，专属publishedRefCount仍按d1结算。handler原有Images must be removed through abandonUpload及batchRemove拒绝保留。lifecycle、旧审批和最终激活仍待核验，producer关闭。详见[P3e6d5](P3e6d5_ORDINARY_IMAGE_DELETION.zh-CN.md)。


## P3e6d6旧审批兼容

旧staged/atomic共用只读有效引用规划；实际delta非零才补读proof并把全体已确认结算+delta融合原image唯一写，未知保留。delta0不补读、不结算，staged不写共享图，atomic仍写原deletefence。全局98预算含原actor/SKU/product/image操作及真实image重新get，80proof91/92可走、超限先拒。缺managedbase或需要非零delta的未知legacy不猜0。没有增加新发布producer；公共读仍独立C1验证，最终seal/历史/own-root终局未由本步完成。详见[P3e6d6](P3e6d6_LEGACY_APPROVAL_REFERENCES.zh-CN.md)。


## P3e6d7 上传与存储保护

pending 激活/标失败仅接受无账本合法旧状态或合法空零账本；有账本缺基数、非空/坏账本、显式 null 均不可转换。已完成 active 的重复确认保持只读；legacy active 同字节复核完整保留共享引用。上传与来源 pending 共用纯校验，native/JSON 提前复制命令；实际权限/当前行/锁仍在原事务。存储保护同身份迁移 commit/release 以实际 C1 结算串联测试确认保留当前引用，生产保护模块未改。详见 [P3e6d7](P3e6d7_UPLOAD_REFERENCE_STATE.zh-CN.md)。最终 root/proof 与 producer、历史和真实验收尚未完成，不能启用。


## P3e6e1 冻结引用承诺

同一 staging 根在全部页与媒体回执完成后，从服务端冻结 publication 生成完整 Merkle 计划，并要求当前商品 canonical raw+approved 集合与媒体 seal 数量/摘要完全一致。正常 header 生成会保留图库/详情图，容量正控证明这一前提；不新增 retained IDs 或改变计数规则。小 references 绑定保留原身份/版本/策略/媒体/TTL 条件，读回重算树，重复零写、取消保留历史。实际关联来源7文档操作，只写原根，不暂存任何图片差值或终局证明。详见 [P3e6e1](P3e6e1_OWN_REFERENCE_PLAN.zh-CN.md)。后续必须实现按预算暂存、80槽续接与唯一终局 product/root/proof 原子激活；当前 producer 仍关闭。


## P3e6e2a 纯差值暂存转换

stage转换在合法明确base与完整旧账本上验证并追加根成员，完全重复只读、同根不同计划拒绝，未知项保留，epoch安全递增；满80槽报PENDING_FULL供后续真实持久化续接。原C1先结算全部终局，随后本转换加入新项；二者尚未接到新的图片/root写事务。抽象undefined账本参数不替代真实字段存在性检查。详见[P3e6e2a](P3e6e2a_PENDING_STAGE_TRANSITION.zh-CN.md)。真实producer、取消/过期/满槽恢复与最终提交仍关闭/未完成。


## P3e6e2b 内部图片页与取消终局

原根 referenceStage 绑定冻结计划/前缀，C1同快照全体结算后保留全部未知项，逐图预留pixel读与最终写，图片和游标同事务提交。正常20图88操作，最坏实测98；满80未知项先忙、取消终局结算后可继续。已经暂存的原操作取消同事务写永久标记及唯一cancel proof；commit槽不可翻转。详见[P3e6e2b](P3e6e2b_OWN_REFERENCE_PAGES.zh-CN.md)。客户调用路径未启用，自动过期/撤权管理员恢复、最终原子激活与真实并发/P95仍是硬门槛。


## P3e6e3 内核唯一发布提交

原根完成页/完整前缀/媒体回执/原输入版本全部匹配且终局槽为空后，原产品上线、同根complete回执与commit proof在一个事务提交，关联来源15操作/三写，不随图片数扩大。普通managed图片的内容身份也禁止经metadata替换，名称/原锁仍可用；生命周期仍由原媒体流程控制。完成历史查询必须读同proof，后续下架后current=false且重复无写。详见[P3e6e3](P3e6e3_OWN_PUBLICATION.zh-CN.md)。客户接口未接线，可信过期/撤权恢复、live-edit、历史/provider/P95/test真实验收仍为启用门槛，不能据内核完成关闭原正式UI P1。


## P3e6e4 原根可信恢复

内部恢复只永久取消已验证失效的原操作，不接管旧owner发布。过期/撤权恢复不读取坏supplier；当前admin/原scope/输入/codec/终局与最后时钟校验保留。原根与cancel proof同事务、可信审计首次保存，精确重放0写，已complete需原proof且永不翻转。实际80root满槽组合证明退役一项后原页可续接；自动有界caller尚未接入，不能称满槽自动恢复。详见[P3e6e4](P3e6e4_TRUSTED_OPERATION_RECOVERY.zh-CN.md)。原UI P1、liveedit/review/provider/P95及真实三时钟20件发布回退仍开放，fullDeliveryReady=false。


## P3e7a 浏览器可用的小状态

product-operation-start/get/cancel经现有Admin鉴权与开关，由独立DB facade转换到原内部命令，拒绝浏览器prepare/proof/recover/publish。只读status4096字节不返回大根；原完成回执与current分离，过期和取消仍可检查，重复取消零写。接口与315本地/459实际SDK控制已通过；客户UI尚未调用、有界满槽caller尚未完成。详见[P3e7a](P3e7a_OPERATION_STATUS_API.zh-CN.md)，原P1及真实验收未关闭。
