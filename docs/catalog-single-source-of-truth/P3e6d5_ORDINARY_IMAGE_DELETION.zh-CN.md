# P3e6d5 剩余通用图片写入口

状态：保护已实现，聚焦测试/SDK/跨进程验证通过，完整本地回归通过；基线ff138a6。pending/proof producer关闭。

## 实际问题

DbAdapter.remove与removeDocIfFieldEquals不检查新ledger，可信调用者可能直接删掉已被管理的图片行；incrementField只有精确publishedRefCount走专属协议，其他字符串仍传给SDK，catalogPublishedReferenceLedger.epoch之类路径会绕过普通patch守卫。用户后台remove/batchRemove images已经明确拒绝并指向abandonUpload，保留该产品流程。

## 约束和选择

只沿既有images行/ledger字段。通用删除读取实际行后，有own ledger一律要求已有持久删除流程，不按base0判断可删，也不尝试在通用入口结算或删字节。无ledger保留旧可信调用语义；missing/条件不匹配返回false，不执行未授权动作。native在原NodeSDK事务内get+remove/严格ACK，JSON沿既有文件锁；按官方事务写冲突契约设计，同一图片的producer写与删除竞争同一文档；真实provider竞争仍须后续验证。任何不能确认的删除回执必须回滚，不假报成功。实际专属删除runImageDeletion使用已有transaction rowstore，不经过通用入口，因此不引入第二套状态机/锁。

非publishedRefCount的image increment先复用d4字段守卫，禁止ledger、子路径和operator；普通metadata计数沿原行为，精确publishedRefCount继续d1的结算/增减。不改变其他collection、权限、持久格式或HTTP动作。

```ts
if (expected && image[expected.field] !== expected.value) return false;
assertOrdinaryImageReferenceRemoval(image);
await store.remove('images', image._id); // Existing strict-ACK transaction rowstore.
```

不采用：看rawbase0后直接删除、删除前清ledger、先结算再另开事务remove、把通用删除改成自动删COS、或者创建第二删除状态。这里只保护这些通用入口，上传/字节保护/旧审批和最终激活仍需后续检查。

## 检查与退出

先用实际JSON公开接口复现managed有效/损坏ledger被通用删掉，以及保留字段increment被接受；确认文件未变和public仍200。missing/条件不匹配、legacy与普通metadata增量、专属持久删除作正常控制。随后native事务/ACK/实际生产接线与SDK请求、恢复/重开、字段守卫故障注入及相关全量/type/build串联；不把本步当真实20件发布验收。


## 实际验证与review

19个实际JSON入口用例实现前13业务红、6正常控制；合法缺失/条件不匹配、legacy删除、metadata计数、专属增减和持久删除继续可用。首轮控制误用了不存在的quarantine动作/返回状态，按现有ImageDeletionCommandSchema修正为begin/finish与ready/removed，原失败日志保留，不计入13业务红。新增27项为native8、JSON19；426聚焦通过。格式检查指出六处多变量声明，人工分别声明后再跑，通过时才继续；未使用unsafe自动修复。

10项故障注入全部检出：7测试反例30重叠失败、3SDK-only。包括漏managed删除guard、误拒legacy、忽略/晚捕获条件、JSON两个remove入口漏守卫、保留字段increment漏守卫、生产native两个remove接线和increment前置接线。三个源文件SHA全部恢复，绿色控制重跑。删除ACK严格性直接沿用原rowstore；已有及新增坏ACK、实际SDK两类坏回执都须回滚。

实际Node20安装SDK169组，保留d4全部137组，新增32组：raw及生产remove/conditional入口对有效0/1及坏ledger只get不write，legacy同一transactionId下1get+1remove，missing/条件不匹配零remove，坏ACK回滚、已提交丢确认后missing读回且零重复remove、实际SDK start等待前冻结条件，以及五类保留increment字段在任何SDK调用前拒绝。现有专属counter、source retirement与持久删除所有组保留。只替换HTTP运输，不代表供应商MVCC或部署。

四个独立Node24/20进程持久化真实PNG/public200，第二进程拒绝通用remove/条件remove/保留字段increment且0文件写，公开字节仍可取；第三进程下架/扣计数、核对preparation/approval holds、持原mutex经begin写持久intent并丢弃响应，字节仍在而public404；第四进程从既有intent恢复，再删实际PNG并finish移除行，proof保留，missing重放0文件写。目录已删。没有添加第二套删除状态或把通用remove自动变成删字节动作。

实际review五个代码/测试文件、原rowstore严格remove、handler对images的remove/batchRemove拒绝和abandonUpload已有入口，并对照d4/协议/本说明；将“producer写会冲突”改为“按官方契约设计，真实provider竞争仍须验证”，避免把本地SDK替换运输写成已跑真实云竞争。无新SDK方法/shim/依赖/HTTP动作/锁/持久字段。upload/protection/旧审批原始计数、最终原子激活、UI/历史/provider/P95及test三时钟/20件发布恢复仍开放，原formal P1/fullDeliveryReady=false。


## 最终本地检查

shared309、DB1868、admin638、local722、public182、sync308、site797、scripts488，共5312通过；Node20全DB/public及相关JSON2282通过，0失败/取消/跳过。19包types、E2Etypes和standing SDK通过；显式Biome检查四个非排除的代码/测试文件、native人工review与git diff检查通过。原saveCatalogProductInCloudBase至initialized完整actor/classification fence块与ff138a6字节相同。精确提交三函数/site构建与完整worker/admin/public/sync删除回退串联在commit review后执行。precommit失效--silent输出不作证据，原formal P1与fullDeliveryReady=false继续。
