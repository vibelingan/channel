# 02 商品公开变更记录

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

`catalogPublicHeads`与`catalogSeoTasks`按商品ID确定编号，同站点明确绑定。sequence为安全整数，只在实际公开投影变化时递增；撤回保留visible=false的墓碑，不删除记录。semanticHash由规范化后的公开列表字段、详情批准版本、分类路径及公开图片引用组成，不含内部价格、同步时间和构建时间。

在现有事务中读公开前后状态，计算完整公开投影差异，再写head和最新待办。重复请求已由业务回执认领，不再重复加版本。旧商品无head时以当前公开投影初始化，不能把缺字段一律当撤回。已有发布器先登记已验收快照对应版本，初始化只读核对，不重新公开商品。

### 写入方接入清单

至少核对实际存在的`catalog-row-mutation.ts`、`catalog-product-operation.ts`、`category-transaction.ts`、`catalog-source-invalidation.ts`、`alibaba-product-identity.ts`、adapter.ts及其CloudBase事务入口；批准详情与旧后台入口也要列明。它们不都是同一个函数的调用者。实施时逐项记下事务、读写字段、公开影响和测试，不凭一次rg就说全部覆盖。供应商同步只有改变真正公开投影才排队。

核心形状：

```ts
await tx.writeProduct(next);
await recordPublicChange(tx, beforePublic, afterPublic); // 同一事务
```

这里的recordPublicChange是拟新增的公共事务模块，不是现有API。SDK调用沿用现有Node SDK适配，不给wx类型补不存在的方法。上云前按仓库SDK合同核对官方与安装包，确认新增集合权限。

### 取舍和测试

不让每个页面手动发GitHub请求；也不把HTTP外部调用放数据库事务里。外部唤醒失败不会丢待办。

测试：公开新增/修改/撤回/重发分别递增；相同投影与重试不递增；事务失败不留下半个待办；老数据初始化；人工保存、分类移动和供应商同步都覆盖；并发变更序号严格单调；不同商品与内部草稿不相互阻塞。

## MIU CAT-02：可靠唤醒与补漏

事务提交后异步唤醒受限调度器，待办是事实来源。首次通知丢失、回复丢失、服务重启都由保留待办恢复。几秒内连续变更合成每个商品最高sequence；撤回优先，不因常规合并窗口额外等待。

调度器只启动指定仓库、已验收源码与指定内容更新入口。推荐GitHub App短期安装令牌，权限仅本仓库Actions写和必要的Contents读；不在浏览器、助手或商品记录里存GitHub个人长期令牌。已有安全凭据若不能覆盖这项能力，部署前单独完成授权，不能把CloudBase管理密钥当GitHub凭据。

独立定时补漏按待办查询，不每次抓全站正文；先按5分钟配置评估。GitHub schedule并非严格准点，因此不作为唯一唤醒通道或一分钟目标的保证。重复唤醒仍由共享部署锁和已认领版本收敛。日常内容变化复用已验收程序包，不重新跑全仓代码CI；代码发生变化才走代码检查。

测试：唤醒失败、重复事件、乱序、工作进程退出、同商品连续三次更新、跨商品批量、现有部署占用、未知旧任务均有确定结果。没有真实上云配置和事件记录前，不标为自动更新已启用。

### 拟实现的验证入口

CAT-01：`packages/db/src/catalog-public-changes.test.ts`，命令`pnpm --filter @vibelingan-channel/db exec tsx --test src/catalog-public-changes.test.ts`。CAT-02：`scripts/product-refresh-dispatch.test.mjs`，命令`node --test scripts/product-refresh-dispatch.test.mjs`。这些文件仍是计划，不能据此报告测试已运行。
