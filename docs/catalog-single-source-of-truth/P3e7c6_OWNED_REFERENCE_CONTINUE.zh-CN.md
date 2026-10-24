# P3e7c6 原任务图片引用页续接

基线7da7dd9f：冷媒体实际Admin已接，5925当前完整覆盖/2960Node20/592SDK/10故障21重叠/精确三函数site+14进程补充完成。原客户UI和完整发布未启用，所有现场验收仍开放。

## 问题和边界

媒体ready后的实际continue目前返回staging，图片引用承诺及private pending页尚未接上。native已有operation-approval-references、operation-approval-reference-page和满80槽时最多3候选的可信恢复。直接一次循环到底会重置子步骤12秒预算，恢复游标若丢弃又可能每次从前三个不可回收成员重扫；浏览器不能自己生成图片列表、引用增量或最终成功证明。

本MIU只接原任务引用准备，不调用operation-publish。引用pending仍不公开商品，原公开计数不增加；原生图片账本、就绪证据和原根游标在同一事务提交。预算不足可下次续接，取消使pending没有公开权利。

## 数据与状态

| 值 | 生命周期/范围 |
| --- | --- |
| 原productId/operationId/inputDigest | 已冻结任务；每次真实get核对actor/current/revision/TTL |
| references.prepared/staged/total | 原根持久事实，响应只给小状态；页cursor只取服务端staged |
| referenceRecovery {imageId,ledgerDigest,nextOffset} | 原有最多80成员游标；下一请求携回，服务端重新核对当前实际页图片和账本摘要，不授予权限 |
| 剩余budgetMs | 服务器单调时间计算，不接受浏览器指定；原12秒父预算向下传递，子步骤不能重置12秒 |

状态转换：配置/媒体未就绪保持原步骤；mediaReady且未prepared先冻结承诺；每次按实际staged推进20图以内private页并读回；staged等于total停止且重复零写；明确MEDIA_BUSY返回等待及可选恢复游标。get发现complete返回原历史回执，取消/编辑/撤权停止。未知IO抛出，不猜页完成。

## 实现选择

独立server引用续接器复用DB facade和原恢复实现。主continue只在已有媒体ready且预算允许时组合调用，传严格捕获的scope及可选恢复游标。cursor schema移到shared、DB仍按原路径reexport，避免复制两套合约。共享响应给有界referenceRecovery提示，不能在reserved/saved、媒体未ready或已complete上伪装活跃恢复。请求4KiB/严格字段保留，不接受私有root/图片列表/增量/预算。

未选择新增表/根/后台调度器，也不让客户端直接调用native写命令。准备引用和最终发布分开，使暂存、取消、满槽续接可独立验证；下一MIU接最终提交时仍要重新验证分类与角色/源版本，不把当前引用准备当成发布成功。

## 验证

先用实际Admin冷PNG路径断言references prepared/staged/total，以当前未接实现得到明确业务红测。随后测20+1页、多页/零图、重复和并发continue、每个异步边界的取消/编辑/撤权、预算耗尽、不推进的伪OK、未知IO、MEDIA_BUSY带/不带游标、跨scope/坏游标和4096响应预算。原DB满80槽/可信退役/ACK回滚与丢回应测试保留，再增加继承父预算的反例。修复后review、相关及组合测试、SDK/类型/必要构建；不把本步骤当完整发布/真实云/P95验收。


## 实施与验证

实际Admin continue在mediaReady后接原引用承诺与private页，读服务端staged作为游标，成功也必须读回且单调前进；完成后重复零写。仅明确MEDIA_BUSY可以带有界等待提示，包含原恢复游标或null。故障进度不冒充成功，未知IO抛出，原根/角色/current/TTL每次读回核对。父剩余预算传到DB facade及恢复子步骤，预算0在首次页事务前停止；没有新表/锁/worker/SDK方法。

共享cursor schema沿DB旧路径reexport，身份/ledger摘要/offset严格、有既有1024字节输入预算；continue请求仍4KiB，客户端不能传图片列表、增量或预算。referenceRecovery只能出现在当前staging、配置/媒体已ready且引用尚未完成时；完整成功、旧版本/取消、saved/reserved及媒体未ready不能挂活跃恢复提示。

54新增（local35/DB5/shared14），521相关/5979全包与脚本/实际Node20 3014通过；19包类型、E2E类型、standing SDK和9文件Biome/diff通过。实际Admin从冷PNG到引用pending、公开HTTP商品/图片均404、取消后私有、21实图20+1页、零图空承诺、并发同根只留一个pending成员均通过。原105实图组合现在也继续到引用页，仍未发布。真实页/freeze提交后回应丢失重开完成剩余阶段，再次重开零写；冻结后预算耗尽下次同根继续。取消/编辑/撤权在freeze/page等待后停止，坏scope/游标、未知IO、不推进的OK及remaining budget/cursor携带均测试。

11变异均检出，12重叠断言失败另1安装SDK facade故障、5源码SHA恢复，恢复后521与604SDK再次绿。604=原592+12：实际Admin27图引用20+7原生页事务88/36、6个image/root坏ACK整页回滚、引用页提交丢commit回应零写重开、2个像素证据coded/malformed读取不吞、实际Admin满80槽前三成员不可回收返回offset3后下一请求携回，找到第四个真实过期输入的旧根并续原页、原DB facade传budget0不启动事务。全套最高98保留。SDK图片为原声明健康的metadata fixture，实际字节由本地/精确编译PNG另证，不能称为真实CloudBase MVCC/COS/P95。

最初两条实际Admin红测只因references尚未prepared而失败。接线后5条旧媒体用例仍期待引用未准备或重开立即零写，已按新阶段改成引用prepared及“完成剩余引用后再次重开零写”，仍严格核对media只写一次。共享budget helper初次相对导入路径错误导致加载失败，已纠正，不计业务红测；TS提示循环入口重复complete判断，删除冗余判断，保留每次异步读回后的校验。SDK新read fault首次未指定query文档ID所以未命中，指定真实像素记录后才验证；报告预算变量初在块内导致输出ReferenceError，移到报告可见范围后604完成。旧媒体提交丢回应现在合法补一个引用承诺写，探针保留媒体无重复和后续零写证明。

人工review/simplify/humanizer核对9个改动代码/测试、原native references/page/C1保护像素和可信恢复，以及原20秒Admin/12秒启动预算。合并新服务的重复包装，只保留一个可注入依赖的入口；文案“引用准备”明确为私有pending并以公开HTTP404核对，不写成已发布。未知或不能回收的满槽根不会被清空；等待/图片修复UI和最终发布仍未接，旧completed seal的P5修复等原门槛保留。源属性选择性mapping未加入。fullDeliveryReady=false，接下来验证精确产物/多进程并继续最终提交。


提交3d5f4da的逐文件复核发现P2：服务层已校验全部配置完成，共享response schema却漏了该条件，可能接受其他调用方生成的矛盾恢复提示。新增独立用例在修复前明确红测，补superRefine条件后绿；单独移除条件也再次失败。54新增/521相关/5979完整重跑/3014Node20/19类型+E2E/9Biome/604安装SDK均通过，11故障12重叠另1SDK、5SHA恢复。修复合入同一未推送提交；未把初次review标为无问题，记录保留在owned-reference-continue-review-r1.json，最终精确SHA再次review后才构建。
