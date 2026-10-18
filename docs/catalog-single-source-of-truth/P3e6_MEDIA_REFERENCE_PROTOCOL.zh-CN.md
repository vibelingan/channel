# P3e6 大媒体提交协议复核与最小实现

状态：P3e6a基础纯函数局部验证通过；未启用图片账本、HTTP、公开放行或最终发布。原正式响应丢失 P1、真实云验收和 fullDeliveryReady=false 保留。基线 c0058e7。

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
