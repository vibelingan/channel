# P3d1：显式下架必须取消较早的发布意图

基线97cb542已完成20文件inline审查、精确三函数/15页站点构建、Node20真实原生SDK列表烟测及检查修复/读回小流程。保持原目录/分支、无agent，继续批准的P3。

当前advanceCatalogProduct只在published/archived的布尔状态变化时推进catalogLifecycleVersion。草稿收到明确published:false后布尔值相同，较早审批的productFingerprint也不变；updatedAt虽前进，staged approval刻意不使用无关时间戳，所以旧job仍可finish。这违反已批准方案“即使当前已是draft，Disable也取消更早pending publish”。下架保持既有批准历史，不能只靠当前按钮禁用。

本单元在实际写入层保留明确patch语义：正常更新中显式published:false或archived:true都构成生命周期屏障，即使同状态；缺published/archived、普通内容/来源捕获、重复创建或create-if-missing不伪造屏障。版本只能由写入层递增，不接受浏览器计数。一个补丁同时下架归档只推进一次，不写内容generation或清除批准历史/检查成果。新建仍从0开始。受保护旧写必须stale，未完成旧审批在begin/page/finish既有指纹校验拒绝；已完成审批回执仍只表示批准历史，不能当当前已发布。

实施将原forceContent参数改为明确的内部options，既有强制内容失效调用逐一迁移；唯一状态函数识别lifecyclePatch，两类真实写入口planCatalogProductSave与runCatalogRowMutation传入原显式patch，避免在已合并完整行里猜用户意图。同步/来源写的生命周期字段必须审核，不允许误把快照当新操作。无新表/新SDK调用/事务读写，不降低旧审批保护。后续稳定operationId与持久回执继续，不能把本单元称为统一操作完成。

先红测：纯保存计划同状态/缺失/重复/同时字段/上限；真实staging在begin后与finish前被同状态Disable取消；JSON实际admin下架/重启/旧finish读回；普通来源元数据与已完成历史正控。测试包含事务边界/原子回滚和两种完成顺序。再逐段审查、故障反例、相关全量/类型/SDK/构建、小流程。未执行不预填通过，fullDeliveryReady=false。


浏览器首次2失败：手机Actions文字同时匹配summary与表头sr-only，按实际summary修正定位。另一项验证了既有批量Disable没有携带选品时updatedAt，属于后续统一操作/批量CAS缺口；本单元聚焦实际写入层取消旧审批，保留首轮失败并在P3d2修复初次与重试的冻结版本。未把删除越界断言称为该CAS缺口已修复；该缺口继续阻断整体发版。


## 数据与事务

| 值 | 形态/归属 | 有效期与用途 |
| --- | --- | --- |
| lifecyclePatch | 本次服务器收到的显式产品patch，只在内存 | 同一写入事务；不能从已合并行推断下架命令 |
| catalogLifecycleVersion | 产品上的非负safe integer，旧缺失/null按0 | 生命周期历史；明确下架/归档及状态转换推进，不能被表单传入值覆盖 |
| forceContent | 内部options布尔值 | 来源/SKU变更原有内容失效调用，和生命周期意图独立 |
| 原审批job.productFingerprint | 服务器生成的冻结摘要，含已有生命周期版本 | begin/page/finish在事务中比较；版本变化不能完成旧候选 |

```ts
// 原来只比较最终布尔值，无法表达同状态Disable。
const changed = before.published !== next.published;
// 新行为：只由明确原patch识别命令，仍在实际写入事务内递增。
advanceCatalogProduct(before, merged, now, { lifecyclePatch: input.data });
// 来源/SKU原有强制内容失效保持明确，不传生命周期patch。
advanceCatalogProduct(parent, parent, now, { forceContent: true });
```

| 当前状态/补丁 | 最终状态 | 生命周期版本 | 检查/批准历史 |
| --- | --- | --- | --- |
| draft + published:false | draft | +1 | 内容检查与批准历史保留；旧pending审批拒绝 |
| live + published:false | draft | +1 | 同上，按原可见性流程调整引用 |
| archived + archived:true | archived | +1 | 重复归档也是取消旧意图，不清历史 |
| 同时published:false/archived:true | archived draft | 只+1 | 不重复推进 |
| 普通元数据/缺开关/archived:false未变化 | 原状态 | 不额外推进 | 不误取消有效审批 |
| 新建/重复create-if-missing | 新建从0/已存在不写 | 不伪造重复屏障 | 原创建语义保留 |

不使用“每次updatedAt变化都取消审批”，因为无关来源捕获/操作元数据会误拒有效候选；不从完整合并行读取published:false作为新意图；不删除批准历史或检查成果。版本达到safe integer上限明确拒绝并保留原数据，交P5定向审计修复，不回绕到旧代次。未增加DB读取或写入、锁/计数表或SDK方法；原生两个入口各≤3文档操作，写失败回滚，变更不增加98操作预算。

## 执行与复核

实现前11项有效行为红测：两文件109项98正控/11失败，同状态Disable在begin/page/finish通过旧校验，明确复现。实现后覆盖legacy缺字段、重复/同时下架归档、正常无开关/同live保存、上限、两类实际写入口、原生事务失败回滚、JSON重启真实admin/完整历史、两种审批与下架并发顺序；桌面1440和手机390实际点击Batch Disable，保留分类、原报告/内容代次，其余商品逐值不变。

首轮adapter206项203通过/3失败：夹具误用不存在的updateDoc和试图用admin写只读来源时间戳，改为真实adapter.update；未改产品权限。浏览器首次2失败记录见前，明确区分后续批量CAS缺口；首轮类型误把有index signature的CollectionDoc展开后当固定属性，补正确变量类型，未cast/ignore绕过。所有错误日志保留，不计有效通过。

最终相关后端+站点全量3896=shared309+DB1231+admin637+local516+public131+sync304+site768，0fail/skip/cancel。8新反例和4旧完整读取/版本反例全部由断言检出，每次有正控，无编译/导入假红；先后5源文件及原8文件快照finally还原/哈希核对。共151失败断言含重叠，不是151个独立产品缺陷。旧反例每次74项实际浏览器组合，表单/Preview完整读取和协议错误仍能被抓住。

故障后455后端和74客户端正控通过；Node20同455+74=529通过，全部0fail/skip/cancel，包含29实际浏览器流程。全部packages/三函数/local类型通过，standingSDK通过；Astro216文件0error/warning、8既有hint；9完整代码/测试文件显式Biome/diff通过。未重复运行本单元未改的487脚本测试，也没有把上单元结果加进本次总数。

独立实际原生产物探针保留编译handler/native adapter/安装SDK，只替换假环境HTTP并模拟真实事务，不注入源adapter，禁止真实socket/fetch。旧97cb542实际update成功但在“compiled native Disable must fence same-state pending publication”断言失败。初次夹具把本入口误按set merge:false模拟，真实源码使用update merge:true/$set，产生夹具错误，留档并按安装SDK实际sender修正后才取得上述有效红测。最新精确提交的产物正控在审查后构建，另记review侧车；不是云端写入或test验收。

逐项复核9代码/测试路径与原生save/generic/fenced写、JSON锁、原staging指纹、actor权限、分类身份、来源reconcile/照片准备、SKU父级失效、batch初次及retry接缝。明确记录批量CAS/稳定回执仍未完成，不让“两个并发顺序安全”扩大成所有发布已安全。人类文案核对本单元12路径，把“旧发布取消”收紧到“较早未完成审批在版本校验处拒绝”，已完成回执只保留历史，不代表现在live。

### 屏障/失效反例

| 反例 | 正控 | 失败 |
| --- | --- | --- |
| withdrawal-barrier-lost | 437 | 21 |
| disable-literal-inverted | 438 | 20 |
| archive-literal-inverted | 453 | 2 |
| save-patch-intent-lost | 443 | 15 |
| row-patch-intent-lost | 449 | 6 |
| source-force-content-migration-lost | 416 | 39 |
| variant-force-content-migration-lost | 431 | 24 |
| approval-lifecycle-fingerprint-lost | 445 | 10 |
### 旧浏览器保护反例

| 反例 | 正控 | 失败 |
| --- | --- | --- |
| summary-accepted-as-complete-get | 70 | 4 |
| missing-list-version-accepted | 72 | 2 |
| edit-skips-complete-get | 68 | 6 |
| preview-skips-complete-get | 72 | 2 |

P3d2继续冻结批量版本及持久操作回执，合法大媒体/历史审计/云并发性能/test真实20件发布恢复仍阻断完整交付，fullDeliveryReady=false。
