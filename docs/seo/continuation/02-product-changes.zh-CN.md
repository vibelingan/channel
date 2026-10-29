# 02 商品公开变更记录

## 先看摘要

当前完成的是事务记录组件及本地测试，公开摘要生成与商品保存、同步、分类等实际写入入口尚未接入，也没有创建云端集合或启用自动更新。

这一块的目标是记住“哪个商品真的变了，需要更新它的页面”。客户保存商品时，商品与待办一起写入；任何一半失败就都不算成功，避免接口已改但页面更新永远漏掉。几次连续修改可以合成最新一版，失败会留下待办，不要求客户再点保存。它本身不生成HTML，也不通知Google。所有实际商品写入入口都需要接入，私有草稿和内部同步状态不触发更新。解释见[先读说明](EXPLAIN.zh-CN.md)。

## 需求

商品新增公开、修改已公开内容、换分类、撤回、重新公开，都要有可靠更新记录；私有草稿或同步任务只改变内部状态时不触发重建。记录与业务写入在同一事务中完成，不能商品保存成功而待办凭空丢失。失败不能靠客户再次点保存补救。

## MIU CAT-01：公开版本与待办同事务提交

### 现状

`catalog-product-state.ts::advanceCatalogProduct`已有内容、生命周期和分类版本；`catalog-product-operation.ts`提交批准快照。`catalog-publication-fingerprint.ts`已有业务指纹，但它不是完整公开页面摘要，不能直接把这个值当SSG所有输入的版本。公开列表DTO也没有稳定的公开版本字段，不能靠列表名称或URL不变判断正文没变。

### 数据与归属

仅新增服务端集合，浏览器拒绝直接读写，不改商品业务schema的含义：

```ts
type PublicHead = {
  productId: string; sequence: number; visible: boolean;
  semanticHash: string; detailRevision: string | null;
  changedAt: string; latestEventId: string;
};
type RefreshTask = {
  productId: string; requestedSequence: number; acceptedSequence: number;
  state: 'pending'|'leased'|'writing'|'accepted'|'needs-readback';
  attempts: number; lease: null | { runId: string; until: number };
};
```

`catalogPublicHeads`与`catalogSeoTasks`按商品ID确定编号，同站点明确绑定。sequence为安全整数，只在实际公开投影变化时递增；撤回保留visible=false的墓碑，不删除记录。semanticHash由规范化后的公开列表字段、已批准的实际公开详情内容、分类路径及公开图片引用组成，不含内部价格、同步时间和构建时间。detailRevision用于读回和分页一致性，不把这个不透明编号本身当成内容变化：相同公开内容重新审批得到新编号，也不应凭此重建或伪造lastmod。现有source invalidation会forceContent，原始contentGeneration也不能直接当作公开语义版本。若当前审批摘要含内部字段，需在已有批准快照上增加明确的公开摘要；不能靠散列整份DB文档省略这一步。

在现有事务中读公开前后状态，计算完整公开投影差异，再写head和最新待办。重复请求已由业务回执认领，不再重复加版本。旧商品无head时以当前公开投影初始化，不能把缺字段一律当撤回。已有发布器先登记已验收快照对应版本，初始化只读核对，不重新公开商品。

### 写入方接入清单

至少核对实际存在的`catalog-row-mutation.ts`、`catalog-product-operation.ts`、`category-transaction.ts`、`catalog-source-invalidation.ts`、`alibaba-product-identity.ts`、adapter.ts及其CloudBase事务入口；批准详情与旧后台入口也要列明。它们不都是同一个函数的调用者。实施时逐项记下事务、读写字段、公开影响和测试，不凭一次rg就说全部覆盖。供应商同步只有改变真正公开投影才排队。

本轮在当前代码上补读了下面这些具体位置，作为下一段实现的入口；这不是宣称所有写入方已经接完：

| 已核对的位置 | 看到的实际行为 | 接入时必须防止什么 |
| --- | --- | --- |
| `catalog-product-operation.ts::publishOperation`末尾 | 商品、完成回执和批准证明在同一事务写入；详情使用immutable-v1版本 | 只监听`published`布尔值，会漏掉已经公开商品重新批准的新正文 |
| `catalog-row-mutation.ts::runCatalogRowMutation` | 商品创建/修改/删除；变体和源资料改变时也可推进父商品版本 | 内部输入版本变化不一定改变已批准的公开内容，不能全部重建 |
| `catalog-source-invalidation.ts::planSourceInvalidation` | 同一值的绑定写入也可能只用于并发协调；另一路会forceContent | 不能把一次锁定或contentGeneration增加当作公开正文变了 |
| `category-transaction.ts::runCategoryCommand` | 除分类指派外，还分派mapping和taxonomy命令；有些路径写规则而不写商品 | 不能只在一处商品保存函数挂钩，就说分类路径变化全部覆盖 |
| `catalog-taxonomy-transaction.ts` | 独立的分类注册表事务入口 | 需核对分类名称/路径变更影响哪些已公开页面，并为这些商品留下待办 |
| `alibaba-product-identity.ts::runAlibabaProductMutation` | 多条分支经writeProduct写商品，并与来源绑定/租约一同提交 | 保留现有同步互斥与审核流程，仅按公开投影判断是否排队 |
| `cloudbase-adapter.ts`与`catalog-detail-staging.ts` | 前者有真实CloudBase事务，后者接入批准工作流 | 待办必须在真实事务内写入，不能仅让本地假存储测试通过 |
| `adapter.ts`的持久化本地实现 | 与CloudBase适配器并非处处调用同一个函数 | 两种适配器的公开变化行为都要验收，不凭相同类型签名推定一致 |

先在这些入口的现有测试中补公开前后投影与事务失败案例，再接公共记录模块。分类批量影响需要有界枚举和可靠待办；不能在一个事务中无上限扫描全部商品。逐项覆盖及最终接入结果仍待CAT-01代码实现。

核心形状：

```ts
const change = await planPublicChange(tx, beforePublic, afterPublic); // 先读版本与待办，完成计算
await tx.writeProduct(next);
await writePublicChange(tx, change); // 同一事务，只写已算好的结果
```

这里的planPublicChange/writePublicChange是拟新增模块，不是现有API。沿用仓库“所有读取与计算在前，写入在后”的事务组织，不在写完商品后再临时读取版本。完整公开详情的摘要应在已有批准流程准备好，事务内核对其不可变版本与证明，不逐件扫描全部变体来算散列。SDK调用沿用现有Node SDK适配，不给wx类型补不存在的方法。上云前按仓库SDK合同核对官方与安装包，确认新增集合权限。

独立分类事务若实际改变多个公开页的投影，应在同一次提交留下分类级待办，再有界分批派生成商品待办并保存进度；不能让分类事务无上限扫描或写全部商品。重复分派仍以当前公开投影、商品版本与分类版本核对，不增加重复版本。是否影响商品正文、分类页或仅后台配置，要以03实际使用的投影为准，不把所有分类维护都当作商品重建。

### 取舍和测试

不让每个页面手动发GitHub请求；也不把HTTP外部调用放数据库事务里。外部唤醒失败不会丢待办。

测试：公开新增/修改/撤回/重发分别递增；相同投影、相同内容重新审批与重试不递增；事务失败不留下半个待办；老数据初始化；人工保存、分类移动和供应商同步都覆盖；并发变更序号严格单调；不同商品与内部草稿不相互阻塞。

## CAT-01分段实施记录

### 第一段：事务记录组件（代码与本地验证完成）

现有商品变更事务还没有公开版本与页面更新待办。先实现`packages/db/src/catalog-public-changes.ts`，由调用方传入已核对的变更前后公开摘要；组件不接收整份商品文档，不自行猜测哪些内部字段可以公开。

数据仍使用上面的两个私有集合，增加格式版本与规范站点地址，记录ID由站点地址和商品ID共同确定。记录保留到恢复与重发之后，撤回写成不可见状态，不删除历史。没有旧记录且公开内容没有变化时不擅自登记为已交付；已有页面的初始化仍需后续对照已验收快照。

组件分两步调用，便于沿用现有事务：

```ts
const plan = await planCatalogPublicChange(tx, { siteOrigin, before, after, now });
// 调用方完成其余读取，再执行原来的业务写入。
await tx.set('products', nextProduct);
await writeCatalogPublicChange(tx, plan); // 只写记录，不再发起读取
```

`before/after`包含商品ID、是否公开、完整公开内容的SHA-256和当前详情版本。详情版本只用于读取，单独变化不增加内容序号，也不更新lastmod。公开内容摘要的生成和真实写入方接线属于下一段，不能用`publicationContentFingerprint`替代。

约束：调用方必须持有同一数据库事务或本地文件写锁；组件不提交事务、不发送HTTP、不调用GitHub、不生成HTML。新增商品从1开始；连续修改只保留同一商品的一条最新待办。正在交付或结果未知的任务仍保留原执行者和待确认状态，即使租期过了也不能由新变化擅自释放。

51项专项测试已通过，包含45项组件行为和6项真实安装SDK的离线传输测试。覆盖新增与同事务失败撤销、相同内容重试、只换详情版本、修改后改回、撤回重发、连续变化、执行中到新版本、站点隔离、计数溢出和损坏记录。数据库包全套2526项通过，类型检查、SDK合同检查通过。远端检查以对应提交的GitHub Actions结果为准。[本地验收记录](evidence/catalog-public-change-core.json)。

重试次数有明确归属：没有执行者的新内容版本从0开始；相同内容或只换详情版本不能重置次数。旧任务仍在执行或结果未知时，保留其执行者、版本和计数，不因新内容或租期过期而释放。后续执行器在确认旧任务结束后，才能为新版本建立新的重试预算。

五次故意破坏检查也均被测试捕获：漏写待办、丢失执行者、版本重置、盲目重复写入，以及让新内容继承旧版本已耗尽的重试次数。原文件均已恢复并复测。

SDK测试实际运行`@cloudbase/node-sdk 3.17.2`和`@cloudbase/database 1.4.3`，网络层替换为既有离线测试传输；它不是CloudBase模拟器，更不是真实云库验收。没有改SDK类型声明、现有业务接口或部署流程。未接入业务入口前，只报告组件结果。

### 第二段：公开摘要与真实写入入口（下一段，尚未实现）

先复用实际公开投影，补齐审批时的完整公开变体摘要；不把审批内部字段或不透明revision当作正文变化。然后按上面的写入方清单接入，两种存储适配器分别验证，并重新核算CloudBase事务操作预算。分类注册表变化保留有界分派的单独路径。只有逐项接线与真实数据库验收完成后，才标记CAT-01完成；CAT-02与商品SSG自动交付仍独立交付。

## MIU CAT-02：可靠唤醒与补漏

事务提交后异步唤醒受限调度器，待办是事实来源。首次通知丢失、回复丢失、服务重启都由保留待办恢复。几秒内连续变更合成每个商品最高sequence；撤回优先，不因常规合并窗口额外等待。

调度器只启动指定仓库、已验收源码与指定内容更新入口。推荐GitHub App短期安装令牌，权限仅本仓库Actions写和必要的Contents读；不在浏览器、助手或商品记录里存GitHub个人长期令牌。已有安全凭据若不能覆盖这项能力，部署前单独完成授权，不能把CloudBase管理密钥当GitHub凭据。

独立定时补漏按待办查询，不每次抓全站正文；先按5分钟配置评估。GitHub schedule并非严格准点，因此不作为唯一唤醒通道或一分钟目标的保证。重复唤醒仍由共享部署锁和已认领版本收敛。日常内容变化复用已验收程序包，不重新跑全仓代码CI；代码发生变化才走代码检查。

测试：唤醒失败、重复事件、乱序、工作进程退出、同商品连续三次更新、跨商品批量、现有部署占用、未知旧任务均有确定结果。没有真实上云配置和事件记录前，不标为自动更新已启用。

### 拟实现的验证入口

CAT-01第一段已实现：`packages/db/src/catalog-public-changes.test.ts`及`catalog-public-changes.sdk.test.ts`，命令`pnpm --filter @vibelingan-channel/db exec tsx --test src/catalog-public-changes.test.ts src/catalog-public-changes.sdk.test.ts`。写入方接线测试尚待下一段。CAT-02的`node --test scripts/product-refresh-dispatch.test.mjs`仍是计划，文件未实现、测试未执行。
