# 发布可靠性实施记录

2026-10-13。用户已批准按整合方案实施；原 pricing checkout / feat/catalog-alibaba-price-tiers，起点 39705e2。没有新建分支、worktree 或 PR；按用户要求 inline review。每项保留红测和通过证据，未执行的门槛不记完成。

## P0：真实故障与入口清单（进行中）

- 腾讯云管理登录状态 REQUIRED；已请求用户恢复登录，尚未读取三件时钟的存储 observation。已有实际 prepare 400 证据仍只证明阶段，字段根因未知。
- 当前 DashboardShell 仅使用 sections 内存导航，没有隐藏 collection 的 URL 入口；不能用 registry readOnly 声明冒充可操作 UI。
- 来源写入消费者：ingest.ts、raw-replay.ts、runner.ts tombstone、db/index.ts observation upsert；后续失效测试须全部覆盖。
- 两个已复现 API race 保留于 design-review-evidence，后续转为仓库回归测试。

## P1a：实际生效内容先于校验（红测准备）

运行问题：buildCatalogDetailCandidate 解码供应商 title/description，planCatalogDetailApproval 才应用网站字段，导致未采用文本拦住有效网站稿。

数据：网站名称、描述、图库与人工价格属于 product；供应商 observation 保留完整私有原件。本 MIU 修正字段归属和校验顺序；产品内容 generation 的原子绑定仍属于 P2，尚未实施。

技术约束：SourcePageSchema 对 header 进行严格网站校验；不能把未校验来源文本写入它，不能只在浏览器截短。source staging 会复用相同 revision，故 revision 和 CAS 必须覆盖实际采用的网站字段。

修正：提取共享 applyWebsiteDetailHeader，候选与批准同用；只有最终采用的字段经过网站 schema，仍检查完整来源身份/报价/SKU。保留原件，不截断。

```ts
const effective = applyWebsiteDetailHeader(sourceHeader, websiteProduct);
// prepare 与正式批准使用同一字段归属规则；暂存核对 product 内容摘要。
```

不采用：增加描述上限、忽略所有校验、删除长来源文本；这些不能证明预算或完整性。

风险/测试：未采用超长 title/description 应通过；有效来源但超长网站描述必须拒绝；来源 HTML 不得在网站描述被替换后重新带入；prepare 期间管理员修改须 CONFLICT。

写作检查：读了 detail-candidate.ts、shared/catalog/detail-approval.ts、catalog-detail-source.ts、catalog-source-staging.ts；将“时钟就是超长字段”改为“存在确定的校验顺序问题，时钟根因待取证”，与真实响应的证据范围核对。

### P1a 验证与 review

- 新增三项顺序测试在实现前确实失败：未采用 title、未采用 description、采用了非法网站 description。第一次 root 下 tsx 解析失败是命令环境问题，不算红测；改从 apps/site 运行才取得 3 个业务失败。
- 实现后 6 个相关文件共 86 tests passed / 0 failed / 0 skipped，包括完整暂存/最终提交及 105 SKU。
- inline review 发现 websiteProduct 的 ID 未核对，已补守卫和测试；source header 保留私有来源文本，批准共享合约仍严格检查实际采用内容，公开候选不带 sourceHeader。供应商归属比较继续使用来源原文，未改 Keep/Use。
- review 发现直接存有效 header 会把网站描述当供应商描述，已采用私有 SourceDetailHeader 合约避免；替换描述后的 source content/note blocks 不带入新版本。未增加任何公开字段上限。
- 类型检查发现测试可选 text 和 structured 空对象两处问题，已修正；最终类型检查、lint、真实小流程待本节后补证。
- 三件时钟真实根因、长内容持久化预算及 P1 其余 issue/只读 Preview 尚未完成，不得由以上测试推定。

- 最终 shared/catalog-import/admin 类型检查均通过，7 个改动 TS 文件 Biome 通过；SDK contract gate 通过。SDK 首次 sandbox IPC EPERM 不算 SDK 失败，取得所需本地权限后原 gate 正常执行通过。
- 真实隔离小流程：production Astro build + 真 handler + JSON DB + Chromium，public 41 / catalog 90 / formal journey 8 / classification visibility 8 / taxonomy 1，合计 148 passed / 0 failed / 0 skipped。覆盖 source→Edit/Preview→单件审批→公开 SKU/价格/图片→询盘，以及分类 Save and publish。runner 已确认临时 DB 和服务清理。证据 /private/tmp/channel-clock-repair-2026-10-13/p1a-local-e2e.log。此轮不是 20 件验收，也不是 test 现场验收。
- 身份保护临时 mutation（移除 ID 检查）使新增测试失败，随后 finally 恢复原实现；证据 p1a-identity-mutation.log。
- 类型检查纠正了一处机械替换误触 catalogCategoryLabel 的空分支，已恢复 {}，未分类维持不强加分类；最终 admin tsc 通过。
- P1a 本地独立 review 结论：本单元无遗留 P1/P2；P0 和其余 P1–P7 门槛继续待执行。

### P1a 提交后第二轮 review

- 57b1c5c 的第二轮反例发现 P2：从人工描述切回来源描述时，structured 内容改变却复用原 revision/cursor，可能继续沿用缺内容暂存。新增测试先失败（同一 revision），随后将实际暂存的 content/noteBlocks 纳入 revision。
- 本轮只修本 MIU 引入的缓存依赖；P2 的全来源/product generation 仍待实施。57b1c5c 未推送、未部署；review gate 在该问题修复前保持未完成。

## P3a：缺失保存版本不得解除发布保护（红测准备）

P0 的管理授权仍待完成。在不依赖真实供应商字段的范围，先执行已批准 P3 的独立守卫子单元。

运行问题：manual 保存后 `guard = typeof current.updatedAt === 'string' ? current.updatedAt : undefined` 静默关闭后续 CAS；初次 get 也没有像 Alibaba 路径核对分类返回版本。

数据：expectedUpdatedAt 来自确认分类/打开表单的版本，只在同 productId 的成功保存回执后前进；缺版本或错误 ID 都不能前进。

技术约束：浏览器只负责保持版本链，最终 CAS 仍在 DB；这里不能通过重读最新行自动批准别人修改的数据。

修正：共用保存回执身份与 revision 检查，manual/Alibaba 同样严格；初次 manual 版本失配在任何批准前退出。

```ts
if (guard !== undefined && current.updatedAt !== guard) throw stale;
guard = savedProductRevision(saved, id, guard);
```

不采用：缺 revision 后设 undefined、自动采用最新 revision、把旧 published=true 当本次回执。

风险/测试：missing revision / wrong ID / stale opening revision 三项先红；确认拒绝之前没有 approval 或 publication 写入；完整现有 batch/approval API 回归必须保持。

### P3a review / 验证

3 个新增用例实现前全部失败，实现后与 batch/approval API 合计 55 passed / 0 failed / 0 skipped。review 追踪初次 get 消费者，改用已有 getRecord 身份校验，避免从另一 product 的读回构建审批。拒绝缺失 revision 后不通过重读最新行偷偷放弃旧保护。P3a 尚未解决普通行发布缺 guard、live refresh 意图或持久化操作，继续 P3b。

## P3b：live 刷新不得写发布开关（红测准备）

运行问题：refreshedProduct 的读回和 `{published:true}` 补写之间，另一管理员可以下架；旧刷新会把它重新上线。

数据：intent='refresh-live' 只用于本次批准后的 review 确认，绑定当前 productId / updatedAt；不含 published/archived 字段，不授权重新发布。后台最终写必须 CAS，已下架/归档立即拒绝。

技术约束：仅把按钮禁用或读回当前 published 都挡不住随后下架；review 需要独立确认，不能用 published=true 的副作用清标。复用现有 update 保存事务，不加新共享锁。

修正：update 支持显式 refresh-live intent，强制 admin、已有批准内容验证、expectedUpdatedAt 和空 patch；保留 Changed/Removed 对精确 incoming 的 Keep/Use 规则。

```ts
update({ intent: 'refresh-live', values: {}, expectedUpdatedAt });
// 与下架竞争同一个 products CAS；不会生成 published:true。
```

风险/测试：manual/Alibaba × 正常/读回后下架四个前端反例；真实 handler 的清标、缺 guard、状态 patch、已下架、贡献者五项。逐项先红再绿，另保留 stale source digest 和未决供应商内容的标志测试。

### P3a/P3b 验证与组合节点

- 前端 batch/approval/新 guard 与完整 admin handler 共 274 passed；随后补充 4 项数据库写入交错/供应商/批准边界用例，refresh-live 的 9 项 handler 用例全部通过。site/admin 类型检查均通过。
- 红测中 withdrawn 的公开错误码最初写为内部 PRODUCT_STALE，实际 HTTP 合约为 CONFLICT；已纠正 transport mock，避免把无效 error envelope 造成的通用 409 当业务错误。
- review 确认 refresh-live 空 patch 不写 published/archived；强制 admin、既有批准指纹和写入层 CAS；过期 source digest 或未决 Keep/Use 保留 Changed；无新图片锁/额外共享事务。
- 新组合 lane：20 个隔离 raw-derived source 商品，全部保留原 Misc/None，经 Assign category → Save and publish；一件注入一次 BUSY，验证同 operationId 重试，20 个批准 revision 和价格/SKU/照片，9 张共享图计数 +20，再 UI 批量 Disable 及 finally 恢复。此为本地合成数据，不冒充三件时钟或 test 现场验收。

- 首轮新增 20 件 lane 失败，保留 p3ab-twenty-e2e.log：fixture 的 pricing 实际 unavailable，测试错误地预期 USD tiers。核对旧 color fixture 注释与 normalizer 发现其只保留 SKU/图片，缺币种和交易类型；没有改生产逻辑或放松断言，给本轮合成 fixture 显式补 normal/Piece wholesale 输入并在 seed 阶段断言 3 个 tiered offers。原缺上下文的无价 fixture 保留。
- 首轮 finally 的 20 件未发布、原 Misc/None、公开详情 404 与 9 张共享图基线计数断言均执行通过；runner 随后确认隔离 DB/服务清理。功能验收仍按失败记录，重跑不能抹去首次失败。

## P4a：图片锁冲突返回可重试结果（红测准备）

运行问题：acquireImageReferenceLocks 内层 catch 将已经确定回滚的 DATABASE_TRANSACTION_CONFLICT 吞成 INTERNAL_ERROR，外层 BUSY 映射无法接管；同时直接记录 SDK error 可能带私有链接。

数据：每次取锁有 owner UUID，按图 ID 排序；取第二张图失败时，先释放本 owner 已取得的锁。只有精确 SDK 冲突码可判 BUSY，transport 不伪装成确定回滚。

技术约束：复用现有 imageMutationOwner/stale-holder 原语，不加第二套锁；释放失败不得遮蔽已提交结果。

修正：清理后仅精确事务冲突返回 BUSY，其余维持结果不明/INTERNAL_ERROR；日志只记受控类别，不写原 error/私有 URL。

```ts
await releaseImageReferenceLocks(acquired, owner);
return isTransactionConflict(error) ? busy : unconfirmed;
```

风险/测试：conflict 与 transport 两项，必须都清理已取锁、保持商品未修改；BUSY 不扩到超时；日志不含注入的 synthetic-secret。陈旧锁恢复 UI 仍是 P4 后续，不由此宣称完成。

- P3ab 第二轮 20 件组合通过：新增一条实际浏览器流程确认 20/20 原 Misc/None 发布及恢复、20 个匹配 operationId/revision、每个 3 SKU 的 USD tiers、9 张共享图 +20 再回基线；其中一件 BUSY 使用同 operationId 重试。整个独立 lane 26.7 秒，包含登录/断言/恢复，尚不是性能 P95。全套 public 41 / catalog 90 / formal 9 / visibility 8 / taxonomy 1，共 149。runner 清理结果另补。
- P4a 日志测试 review 发现 JSON.stringify(Error) 不含 message，会假通过；改用 node:util.format 对齐真实 console 格式后，transport 的私有链接断言确实先红。随后修生产日志仅含受控类别。

- 最终 P3a/P3b/P4a 相关完整回归 280 passed / 0 failed / 0 skipped；site/admin/e2e 类型检查、7 文件 Biome 均通过。关键 mutation：删除数据库 CAS、把 lock conflict 判为 false、把原 SDK error 放回日志，各自被新用例抓到，finally 完整恢复代码。
- 149 项组合浏览器测试的 runner 记录已确认删除临时 DB/服务；最新 P4a 修改仅改变锁失败分支，focused handler 回归通过，最终整合浏览器 lane 仍在 P6 重跑。
