# 发布可靠性实施记录

2026-10-13。用户已批准按整合方案实施；原 pricing checkout / feat/catalog-alibaba-price-tiers，起点 39705e2。没有新建分支、worktree 或 PR；按用户要求 inline review。每项保留红测和通过证据，未执行的门槛不记完成。

## P0：真实故障与入口清单（进行中）

- 当前腾讯云管理授权 READY；三件时钟的实际 observation 已只读取到并复现 facts 数量上限，P1b 已完成本地容量修复与 150 项组合验证。详见 P1b_REAL_CLOCK_REPAIR.zh-CN.md；云上定向 resync/发布/恢复尚未执行。
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

## P2a：已绑定来源的原子失效（红测准备）

运行问题：ingest/replay/tombstone/generic upsert 写 observation 后，产品仍可能保持 detailSourceReady=true；只在稍后 promotion 失效留下窗口。

数据：来源当前内容与 active 状态、已有 alibabaProductLinks 的 productId、产品当前主来源和单调 catalogContentGeneration。首次缺 generation 作为 0；来源改变后同事务 +1、撤销准备标记，保持 published/分类/人工字段/批准历史。

技术约束：CloudBase 快照读取不会产生写锁；必须与最终审批竞争同 products 写。仅 doc 读取，先完成来源/link/product 读，再写 observation 与 product；无共享全局 fence。已再次核对官方 /database/transaction 与已安装 database 1.4.3 实际 transaction/index.js；文档示例返回包装与当前 SDK callback 结果不同，沿仓库 SDK gate，不照抄。Context7 未提供。新增最坏来源事务 6 个 doc 操作（含 lease），远低于 100。

修正：共用 server-only 来源失效计划，接入两个 lease writer、generic observation upsert 的 CloudBase/JSON 实现。语义相同的 observedAt/evidence 更新不增加 generation；同 observedAt 不同内容必须失效。旧绑定被替换时不写无关商品。

```ts
const invalidated = await planSourceInvalidation(tx, before, next);
await writeObservation(next);
await writeProduct(invalidated); // 与批准/解绑竞争同一记录
```

不采用：异步标记、缓存 TTL、先读取来源当作互斥、在每件商品上写共享 taxonomy。

风险/测试：真实生产 CloudBase adapter 函数 + JSON adapter 的五个 writer 用例先红；补 no-op、ABA generation、错主来源、失效回滚、lease 丢失及 link/检查交错。新绑定与所有 row/media/classification writer、列表准入仍是 P2 后续，未由本子单元证明。

### P2a review / 验证（进行中）

- 五个 writer 红测转绿；67 项相关测试通过。另补损坏链接拒绝和两个 JSON adapter 实例的 source/finish 双顺序交错，证明 source 先提交时旧 finish 拒绝，finish 先提交时旧批准保留而新草稿变 stale；不把两个 fulfilled 当必须互斥的两次发布。
- 全 DB、JSON adapter、ingest/replay/runner/linking/selected-sync/photo-preparation/source-prepare 回归共 444 passed / 0 failed / 0 skipped；db/local-server 类型检查通过。新增事务 double 具备快照副本与失败回滚，禁止写后读，确认最坏 6 操作；这些仍不是 vendor race 证据。
- SDK gate 首轮 3 个结构断言失败，原因是生产 fenced update 提取为实际共享 helper，旧断言只看 object method 和变量名；更新为 AST 限定 helper 的 runTransaction 回调检查，不用整个模块里的相同文本代替实际路径。详见 P2a_SDK_PROBE。最终 gate 和 mutation 待补。

- P2a 第二轮 review 实证旧 source-page 可对新 generation 写回 ready：新增用例先失败，修正为 SourcePageSchema 携带 contentGeneration、暂存事务 CAS、readCandidate 比较准备/当前 generation；无需增加事务记录。manual-source 同样绑定现有 generation，清理解绑后旧来源的 generation seal；缺失/null 仍按 legacy 0 工作。
- review 发现非法已有主来源 link 不应被静默跳过，已改为事务写前拒绝；合法的非当前主来源仍不修改无关商品。

- P2a 最终相关回归 449 passed / 0 failed / 0 skipped；db/admin/local-server 类型检查通过。SDK gate 更新后通过；断开 fenced-upsert 的 sourceInvalidation 接线使限定 AST gate 失败（没有被模块中其他同名调用蒙混），撤销后还原。移除准备 generation CAS、移除最终审批 generation 指纹，两项 mutation 也分别被回归抓到。
- P2a 与 P1/P3/P4 整合浏览器测试再次通过 public 41 / catalog 90 / formal 9（含本地 20 件）/ visibility 8 / taxonomy 1，共 149；runner 确认删除隔离 DB/服务。此次仍无真实 test 发布/恢复。
- CloudBase adapter 原文件被仓库 Biome 配置排除，未冒称其 lint 覆盖；只将本次新增事务函数分段格式化，保持既有无关代码不动。新 helper/test、其他改动文件仍执行 Biome；CloudBase 代码由 tsc、行为回归和 SDK gate 覆盖。

- 最终分段格式化后 SDK gate 又捕获 1 项 matcher 失败：原正则要求 update( 与 replaceNestedObjects 同行。保留同一调用约束并允许合法空白；新增 source transaction 的 AST 校验保持不变。该失败和修复均保留，最终通过以 p2a-sdk-final-r2.log 为准。

## P3c：普通 Edit 的打开版本与 live 保存意图（红测准备）

运行问题：CollectionView 的 `updateMutation({id, values})` 丢失打开表单时的版本；live 表单携带默认 `published:true`，保存编辑会进入显式发布分支，可能覆盖其他管理员刚完成的下架。

数据：编辑快照持有产品 ID、打开时 updatedAt（旧行缺失/null 明确表示 null）、打开时 published。这个快照只在本表单存活；每次受保护保存的返回版本继续传给后续写入。null 是“仍无版本”的 CAS，undefined 才是不提供保护。

技术约束：后端最终产品事务必须核对版本；浏览器的先读不能替代 CAS。审批暂存的版本由既有流程处理，不把 lifecycle 开关混入普通编辑。

修正：表单从打开快照推导 save-draft / refresh-live / publish / unpublish，live 保存移除默认 published 开关。只有明确的编辑意图可进入人工审阅路径；分类批量原有 Changed/Removed 拒绝保持。

```ts
const intent = opened.published && values.published !== false ? 'refresh-live' : ...;
updateRecord('products', opened._id, values, opened.updatedAt ?? null, intent);
// 数据库： (existing.updatedAt ?? null) === expectedUpdatedAt
```

不采用：在提交时取最新时间戳替代打开版本，这会把他人的修改当成用户已经看过；也不因旧行缺版本取消保护。

风险/测试：legacy null CAS 首次编辑、并发后 stale；manual/Alibaba live 默认开关保存后发生下架，不得写 publication toggle；对应 handler null 透传与 UI 打开快照接线，再测组合浏览器。

文字审查：将“版本仍为空也安全”改为“只在仍为空时允许首次保存，后续更新即拒绝旧表单”，保留明确的并发条件。检查实际 CollectionView、api、handler、catalog-product-identities 与数据库 plan。

- P3c 首轮红测确认 5 个失败（两种 legacy CAS、manual/Alibaba live 开关、null guard 透传），修正后相关回归 281 项通过。首轮从错误 cwd 执行的命令未启动测试，另留 p3c-red-r2 才作为红测证据。
- 首轮组合 browser：public 41 / catalog 90 通过，formal 8 通过、2 失败，runner finally 清理成功。其一旧用例故意保存期间下架，旧预期表单关闭，与新增明确冲突语义不符；实际页面还揭露 conflict 误匹配 Archived 字段，使全局错误检测遗漏。新增独立红测后修复分类；用例改为显式检查冲突和保留表单，再取消。另一项是新用例 Name exact selector 未包含必填星号，改为实际 accessible textbox 名称。两项均不抹去首次失败。
- 首轮 tsc 发现一处 non-product inline select 调用仍传 id，改为传当前 doc；null 存储测试通过 Reflect.set 注入真实不受信任行，避免谎报为正常 CollectionDoc 类型。最终检查待补。

- 第二轮 public 41 / catalog 90 / formal 前 9 项全部通过（原保存期间下架流程已按冲突预期通过）。新增第 10 项在登录页超时，未捕获响应所以不能将限流根因写成已确认。该 lane 已通过多次真实 UI 登录，编辑用例改复用 beforeAll 的真实 API 登录会话，保留后端会话再验证，不额外测试共享登录窗口。与原用例一样不记录 token。全部 runner finally 清理成功。
- 最终相关 unit 296 passed / 0 failed / 0 skipped；db/admin/site/e2e 四个 tsc 通过。完整第三轮 browser 与 mutation 待补。

- 第三轮组合 public 41 / catalog 90 / formal 10 / visibility 8 共 149 通过；taxonomy 最后 Misc 步骤在 14 件读取结果的 Promise.all 中出现 APIRequestContext POST read ECONNRESET（无应用响应），1 failed。新普通编辑完整用例 2.1 秒通过，20 件 26.1 秒通过；finally 清理成功。尚未确认重置的具体来源，不能记为全套通过。SDK gate 首次 sandbox tsx IPC EPERM，授权范围内只读脚本重跑通过。
- 三项 mutation（数据库 CAS、live 保存意图、conflict 全局提示）分别被测试抓住，finally 恢复后相关 296 项再通过。完整第四轮运行与 P6 transport/read recovery 门槛保留。

- 第四轮组合全通过：public 41 / catalog 90 / formal 10 / visibility 8 / taxonomy 1，共 150，runner 确认删除隔离 DB/服务。第三轮 ECONNRESET 未重现，原因仍未确认，保留为 P6 transport/read recovery 检查项，不用此次成功覆盖历史失败。
- P3c 最终 review 沿 UI 打开快照→client intent/null guard→handler nullable schema→identity facade→原子 plan CAS 逐段核对；旧分类 Changed/Removed 拒绝、贡献者权限、非产品 inline edit 均保留。guard/null、live intent、global conflict 三项 mutation 皆检测。当前子单元未剩确定 P1/P2；持久操作与更多恢复入口仍是 P3/P4 后续，整体尚未交付。

- 提交后 review 追加两实际 JSON adapter 的 legacy 并发保存检查，必须恰好一个 saved、一个 stale（该 DB API 用结果值拒绝，不能误数 Promise fulfilled）。同时将新增隔离浏览器会话初始化限制为本次 owned origin 的 admin 路径，避免导航/frame 扩散。SDK nullable/addInitScript 已核对安装类型与官方文档，详见 SDK-PROBE；没有引入新 CloudBase 方法或 shim。

- 提交后复核最终 312 项相关回归通过，含双实际 JSON adapter 的 absent/null 两场竞争；删除原子 CAS 后该两项变红，finally 恢复。e2e/local-server tsc 通过；实际 addInitScript 回调经 AST 提取运行，owned admin / 外部 origin / owned 非 admin 三场边界通过。该小修只约束隔离测试夹具，不修改产品行为；产品功能以第四轮 150 项证据为准。

## P2b：产品行写入的内容、分类和生命周期版本（红测准备）

运行问题：普通 Edit / 图片绑定 / 人工价格没有与保存原子撤销 ready；绑定、pin、unlink、reconcile/promotion 和自动分类直接使用请求 now，可能将已有单调 updatedAt 写回旧时间；内容 A→B→A 与下架→上线的旧任务无法仅靠相等值识别。

数据：catalogContentGeneration、catalogLifecycleVersion、catalogClassificationRevision 是各产品的安全整数计数；缺失/null 作为旧行 0。内容包括网站文本、价格、图选择、供应商决策、主要来源与选定报价；分类包含 family/category/subcategoryIds。批准快照和媒体计数不由这些计数重写。

技术约束：共用 server-only 纯产品状态计划，在既有产品事务内应用，无额外 SDK 方法、全局写锁或网络调用。准备输出字段不能算成内容输入，否则审批自己让自己过期；共享图 refCount 同理。无语义变更不增加内容/分类/生命周期版本。

修正：normal save plan、Alibaba 所有 product set、分类专用事务与已完成 source invalidation 复用同一版本推进；输出时间始终比已有时间晚。批准 job 指纹额外绑定生命周期与分类计数以防 ABA。

```ts
next = advanceCatalogProduct(before, proposed, now);
await tx.set('products', next); // 同一原子写中 ready=false 与 generation 前进
```

不采用：API 层异步失效、统一用 updatedAt 代替每种版本、每次无变化同步也递增内容版本。

风险/测试：真实 normal plan、Alibaba pin/unlink、自动分类的计数/ready/time 红测；无变化和 metadata 保持 ready；同毫秒内容 ABA 与生命周期 ABA；非法/耗尽计数 fail closed；随后所有 DB/source/classification/sync 回归。通用 adapter product/variant writer 与新绑定 observation fence 尚为 P2c 后续，不由此单元宣称覆盖。

- P2b 首轮扩大回归 825 项中 801 通过、24 失败；失败集中在现有 pricing repair 的读回契约，新增合法 generation/ready 字段被旧 protectedHash 判为额外变化。修正为从同一纯状态计划计算 expectedProtectedHash，保留原 protectedHash 审计，读回仍逐字段精确匹配预期；不扩大忽略字段列表。补“批准后 generation 又前进”拒绝测试，防止盲确认其他写入。
- Review 另补 price.syncedAt-only 红测并复现无谓失效，内容指纹只排除该价格捕获时间。配置照片与供应商决策 fixture 改用实际合约形状，pin fixture 明确已有被清除的选择；避免用未定义→空 pin 的语义无变化样本假装证明变更。
- 类型检查首轮发现 CollectionDoc spread 丢失索引签名、私有状态错误字段不在公开校验 issue union、pin/unlink test 输入没有正确判别。分别加明确 CollectionDoc 类型、只在 DB 写入 issue union 加私有状态字段、用判别分支构造真实输入，未使用 any 或压制类型。

- 第二轮扩大回归 827 项全通过；db/admin/local-server 类型检查通过，sync 新增 mock 参数缺显式类型被 tsc 抓到并补齐。Review 两条新红测发现旧快照 ready 输出可在无内容变更时被回写，以及空 pin 被误当内容变化。现在普通产品计划保留既有检查输出，只有专用 preparation CAS 可写回 ready；空/缺失选择按相同无选择语义。补所有三种计数的损坏/耗尽分支和生命周期/分类 ABA 拒绝旧 finish。

- P2b 最终 846 项 DB/sync/handler/source 回归 + 3 项公开投影回归通过，0 failed / 0 skipped；db/admin/sync/local-server/public-api 类型检查通过；SDK contract gate 通过。源码生命周期指纹、Alibaba product writer 接线、pricing readback 三项 mutation 均检测并 finally 恢复。
- P2b 整体生产构建 browser 150 项全部通过：public 41 / catalog 90 / formal 10 / visibility 8 / taxonomy 1；20 件 Assign category 发布及恢复 26.0 秒，普通 Edit 组合 2.1 秒；这些是单次流程时间，不是 P95。runner 确认删除隔离 DB/服务。
- Review 审阅实际 catalog-product-state / adapter / alibaba-product-identity / source-invalidation / category-transaction / detail-staging / pricing-repair 与各测试、package exports、public projection。将“价格修复不得改其他字段”的笼统表述收窄为“保留网站字段，准备版本与状态按相同规则失效，读回逐项匹配本次预期”，没有删除 protected 字段保护。
- 明确剩余 P3 条件：若当前已是 draft 但另有 pending publish，显式 Disable 仍应取消旧发布意图，不能仅凭布尔状态没变化认作纯 no-op。P2b 这里只实现语义状态变更计数，明确同状态生命周期命令由 P3 durable intent 完成；此条件已补测试矩阵，发版前必须绿。
- 腾讯云 MCP auth(status) 本轮仍为 EXPIRED / env NONE；真实三件字段根因与云端 race/验收未由本地 150 项替代。

## P2c1：通用产品/配置写入的原子失效（实现、review 与验证中）

运行问题：normal identity save 与 Alibaba 专用变更已接入版本规则，但 adapter 的 create/update/upsert/remove/conditional remove/increment 及 lease writer 仍可修改产品/配置而保留父产品 ready；配置换父产品时两边都需失效。

数据：目标行 before/after、产品 ID（配置旧/新 productId，去重最多两个）、内容 generation。产品新建默认 generation/lifecycle/classification 0 且未准备；合法捕获时间或无内容计数更新不作废内容；缺失父产品不创造占位行，父产品日后新建必为 stale。

技术约束：CloudBase 快照读不会锁住父产品，配置写与所有受影响 products 写必须在同一 doc-ID transaction；先完成全部读取再写，最坏配置移动 3 read + 3 write，带 lease 最多再加 1 read。source-page / approval transaction 是专用输出提交，不能被通用输入失效钩子再次作废自己。JSON 必须共用一个 withMutationLock，禁止在锁内再调用 adapter.get。

修正：集中一套 server-only row mutation body，复用 P2b 的产品状态计划；两个 adapter 的通用入口和 lease 分支调用同一 body。batch facade 沿已有单行入口调用，仍须搜索确认覆盖；不对图片 refCount 写入作产品内容失效。

```ts
const before = await tx.get(collection, id);
const parents = await readAffectedParents(before, next); // 全部写前读取
await tx.set(collection, next);
for (const parent of parents) await tx.set('products', invalidate(parent));
```

不采用：配置写后异步失效、逐件发布写全局 taxonomy、只处理创建而遗漏移除/改父产品。落盘失败是否已有保护先用实际读取验证，不凭私有内存变更推断对用户可见。

风险/测试：实际 JSON 公共 CRUD/lease 方法的 row/parent、双父、no-op、错误条件删除；create 新状态；persist fault 后磁盘与正常读一致。CloudBase 将测试实际生产 helper，SDK gate 限定各 adapter 委托，覆盖写/父写失败与零 ACK、删除 ACK、lease 拒绝和最大操作数。新绑定 observation revision fence 仍为 P2c2，未在本单元宣称完成。

### P2c1 已执行的 review / 测试

- 实际 JSON CRUD 红测 19 项中 15 失败、4 已通过；两项 persist fault 的既有正常读取本来就安全，因为每次 withMutationLock 重读磁盘。未增加假想的全局 rollback/clone 机制。实现后 19 项通过，后补 batch facade、两实例 source/child 并发及非法身份边界。
- Cloud 先测 17 项全部失败：两个既有 lease writer 未失效父产品，另外 15 项是缺少通用生产 helper 的契约失败。实现后与 JSON 共 36 项通过，再补新 SKU、旧 lease、三个私有版本字段保护。
- 实际 batchUpdate 产品和 batchRemove 配置沿相同 adapter 入口；重复 ID 的删除只失效一次。两 JSON adapter 并发写来源和 SKU 后 generation 累积 +2，两个变更都保留。缺失父产品不新建占位行。
- 最终补充身份边界前，DB/sync/admin/public/JSON 回归 895 passed / 0 failed / 0 skipped，9 个代码/包配置文件 Biome 通过，完整 SDK gate 通过。cloudbase-adapter.ts 被现有配置忽略，仅格式化并人工审查本 MIU 修改的 13 个函数/方法，不能将其冒充全文件 Biome 通过。
- parent / ACK / 单个生产分支三项 mutation 均被检测，finally 恢复。SDK gate 按具体 catalog 分支 AST 检查，不被其他六个合法 helper 调用满足。
- inline review 发现 create 的非法 _id 行为不一致：JSON 拒绝，Cloud 原实现会换随机 ID。已补入口测试先红，修复及最终回归结果后补。正常 facade 不允许表单指定 _id，仍将内部契约一致性作为本单元要求。
- 当前全套浏览器串联仍在执行；不将中途已过的 lane 记成全通过。P2c2 新绑定来源 revision fence 仍未实施，lease takeover 的云端隔离行为也未由本地 fake 证明。

写作核对：审查 catalog-row-mutation.ts、catalog-product-state.ts、cloudbase-adapter.ts、json-adapter.ts、db/index.ts、两个实际 adapter 测试和 SDK gate。把“全部 lease race 都覆盖”限定为“读取时已失去 lease 的拒绝已测；事务中途 takeover 仍待 vendor 验证”，把“磁盘失败需新增回滚”更正为“既有普通读已重载磁盘，实测安全”。

- 身份边界红测：Cloud 的 3 个非字符串 _id 输入进入 SDK 路径，未得到预期身份拒绝；JSON 的对应 3 项通过。Cloud 改为仅在 _id 未提供时生成 ID，其余非字符串先拒绝。第一次应用补丁用了 apps/site 工作目录，文件未找到，后续回归仍 3 失败；不计为修复验证。回到 checkout 根目录应用成功后，全量相关回归 901 passed / 0 failed / 0 skipped，db tsc 和完整 SDK gate 再次通过。
- 首轮 P2c1 全套浏览器 150 项通过，临时 DB/服务已删除；身份边界最终修正后第二轮完整串联仍在运行，结果后补。

- P2c1 最终节点：身份守卫修正后的完整浏览器串联 150 passed（public 41 / catalog 90 / formal 10 / visibility 8 / taxonomy 1），包含原灯具规格/说明、20 个带完整时钟规格的 raw-derived 商品发布/回读/Disable、原分类和图片引用计数恢复。最终 taxonomy 1.2m 属单次运行，不能写成性能 P95。runner 确认删除临时 DB 和服务，证据 p2c1-combined-e2e-r2.log。
- 最终相关回归 901 passed / 0 failed / 0 skipped，db/admin/sync/local-server/public-api 类型检查通过；9 文件 Biome、完整 SDK gate 通过。Cloud 文件沿现有 ignore 规则采用修改函数作用域格式化、类型/行为/SDK 检查和人工审查。
- P2c1 inline review 本地子单元无遗留 P1/P2；source/link/new-binding fence、readiness 列表准入、durable intents、恢复 UI、历史数据修复与全量构建/真实 test 验收继续执行，不由本节点宣称完成。
- 提交后 inline review 补了两个真实 JSON adapter 的同 ID 创建/删除竞争：业务结果应恰好一个 created / 一个 exists，以及一个 removed / 一个未移除，父 generation 只前进一次。这里拒绝是 fulfilled 的状态值，不能按 Promise fulfilled 数量误判。同时保留 source/child 两个合法写都完成且 generation +2 的非互斥并发用例。
- 删除 ACK 的独立 mutation 也已执行：只移除 deleted===1 守卫时，silent deletion rollback 用例失败；finally 恢复后 Cloud 27 项再通过。该补测未改变运行时代码。

- 提交后两个互斥竞争补测与全套相关回归合计 903 passed / 0 failed / 0 skipped；local-server tsc 初次发现新增测试的两处不可达 reason 分支。该条先前把 tsc 提前记为通过，现已更正，待修正后重新验证。只新增测试和记录，运行时代码与已通过最终 150 项浏览器/SDK gate 的版本逐字一致。
- 类型更正后重新执行：local-server tsc 退出 0，相关回归仍为 903 passed / 0 failed / 0 skipped；Biome 退出 0。原因是 assert.equal 已把 status 收窄为 fulfilled，随后读取不可能 rejected 分支的 reason 被 TypeScript 正确拒绝；去掉重复的 assert，保留显式拒绝分支及业务结果断言。证据 p2c1-postreview-final-tsc.log / p2c1-postreview-final-regression-r2.log。

## P2c2：来源版本绑定与新绑定窗口（2026-10-14，红测）

当前 linking/create-draft 在事务外读取来源、生成 patch，事务内仅检查产品 link revision 和来源身份，未比较生成 patch 的来源版本。6 项实际 server linking + transaction body 交错回归已先红：link/create-draft × source/observation 改变四项，缺完整 observation 两项；旧代码仍写入过期 patch 或 fallback 草稿。测试 fixture 的 observation 改为每次 clone，避免修改共享常量污染其他用例。

数据边界：冻结实际采用的 normalized source 语义 hash 和完整 observation 语义 digest；捕获时间/无关审计字段不因自己变化而造成假冲突。新绑定需完整有效 observation；镜像来源仍保留，可定向 resync。缺来源不是 linked-elsewhere。

实现方向：db 复用 catalog-import 的真实 observation 校验及 sourceObservationDocumentId，不复制第二份近似 schema/ID 算法；workspace 依赖先核对无环。事务内重读来源和 observation 比较冻结版本，先读后写；新绑定写同一 source/observation fence，与 sync/replay 竞争同一记录。已绑定变更仍与 source invalidation 竞争同 products 写，不加入逐件全局 lease/taxonomy 写锁。source+observation 的半写入一致性也需检验，不能将“两个 hash 各自没变”当作同一次完整捕获的证明。

P2c1 最终 SHA 6cafe7c 已完成 inline review 与 SDK gate；P2c2 的执行记录如下，尚未部署。


### P2c2a：新绑定输入与事务写入防护（本地子单元）

- link/create-draft 冻结规范镜像和完整 observation 的业务 hash；事务内重读身份与完整契约，来源变更返回 source-changed，缺失/错身份/不完整返回 source-not-ready，不再错报已绑定别处。复用 catalog-import 的真实 decoder/ID 算法；新增 workspace 依赖无环，离线安装仅增加本地链接。
- 首次 claim、旧空 claim 修复、次要来源改主来源均在同一事务写两条 per-source catalogBindingGeneration，再写产品/link；已是同一主来源则沿既有产品争用。无逐件全局锁。所有读取先于写入；新 draft 是 4 读 4 写，最大 40 links 的既有界限保留。
- review 抓到两个边界并修正：同 sourceKey 但 externalProductId 错误也拒绝；已存在次要 link 不能因此跳过主来源切换的两条来源防护写。Cloud 桥复用 sdkAnswer 保留编码错误，不把编码失败当缺失或成功 ACK。
- 先红后绿：原 6 项过期/缺 observation 反例；次要转主来源两适配层反例；Cloud 四次 set 的 throw/zero/coded ACK 及提交失败均回滚全部行。实际双 JSON adapter 两种先后次序验证来源先写则不建 product/link，绑定先写则后续来源使 generation +1、ready=false、仍未发布。新对象 generation 起点为 0，未把它错算为 1。
- 最终相关回归 977 passed / 0 failed / 0 skipped；db/sync/admin/local/public 五模块 tsc 通过，扩大夹具后 local tsc 再通过。13 个修改代码/JSON 文件的 Biome 分批通过，Cloud 沿既有 ignore 规则仅人工审查修改桥接、配合类型/行为/SDK 验证。完整 SDK gate 通过；17 个语义 SDK/schema 表面与落盘 probe 行机械关联。
- 两项独立 mutation：移除 observation fence 导致 3 项指定测试失败；移除来源版本比较导致 4 项指定测试失败。finally 恢复后 977 再通过。首轮从错误 cwd 启动/修改失败的日志未计入红测或通过证据；实际有效证据均是后续正确路径执行。
- 生产构建本地浏览器完整串联 150 passed（41 public、90 catalog、10 formal、8 visibility、1 taxonomy），覆盖完整 raw-derived 来源、三件时钟原始属性、20 件分类发布/审批/公开回读/Disable、分类和引用计数恢复；owned DB/services 清理成功。该结果不是云端 20 件验收。
- 扩大到所有 local-server 测试曾得到 212 项中 191 passed / 21 failed。分类夹具缺 observation、分类版本新增断言、人工价格编辑后缺 prepare 步骤已修正，相关 10 项通过。旧 UI-02 演练工具通过普通 CRUD 写 sourceReady，被版本保护拒绝，仍需迁移到受保护的准备通道；不放宽普通写入来消除失败。本单元不把全 local-server、全构建或发布门槛写为通过。
- 后续 P2c2b 必须处理镜像与 observation 半写入一致性、normalized-source 全部写入失效、reconcile/promote 的冻结输入；P1/P2/P3/P4/P5/P6/P7 的其余门槛按计划继续。真实 vendor snapshot/lease 交错仍未验证，不由内存/JSON 测试替代。

文字核对：复核 linking.ts、catalog-source-binding.ts、identity/cloud bridge、测试夹具和本日志；将“source 不存在是 linked-elsewhere”改为明确缺失/未准备/版本改变，保持权限、分类、published、完整原值和本地/云端证据边界。未增加未来属性筛选 mapping 功能。


### P2c2b：完整捕获配对和来源输入写入（2026-10-14，本地子单元）

范围：同一共享 row mutation body 处理 products/productVariants/alibabaSourceProducts/catalogSourceObservations，所有通用 CRUD、lease upsert/update 在已有事务或 JSON mutation lock 内写来源及已绑定主产品的失效。特殊 observation recency upsert 保留旧排序保护，并剔除输入携带的私有绑定版本。source keys/provider 不允许原地换身份；合法空 claim 无产品可失效，损坏 link 仍明确拒绝。metadata-only/no-op 不推进 generation；来源 createdAt/updatedAt 保持原 writer 合约，完全相同的重试读到已确认状态即返回，不发可能零更新的 SDK 写。

完整 ingest / raw replay 最后写 sourceContentHash，配对本轮规范镜像业务 contentHash；旧记录以精确 payloadId/evidenceId 证明捕获关系。private marker 参与 observation 失效，时间戳/evidence/绑定 counter 仍不当业务变化。link/create/reconcile/promote 都冻结来源及 observation 业务 hash，事务内重读；新绑定仍写双来源 fence，已有绑定与来源 writers 竞争同产品。quarantine 候选改为 identity-v3，主来源版本参与冻结 hash，不把旧 v2 hash 无证明升级；次要来源不产生 promotion，仍冻结产品/link 身份。旧待审批 run 保守返回 superseded，恢复 UI 和历史审计仍属后续门槛。

复核修正：

- 完整 source snapshot 省略分类/描述/路径/来源时间时，旧 merge 会残留历史值；ingest/replay 共用 sourceMirrorValues 显式清空私有来源缺失值（null/空路径），不改网站分类、描述或 published。两个实际 ingest/replay 反例先失败于旧分类残留/未清理，修复后通过。
- 曾为旧 fixture 保留无镜像兼容分支，没有真实 Alibaba collector 依据，已删除。显式 Alibaba primary 必须有同身份完整 mirror 和 observation；实际 prepare 的 dangling-source 反例先证明旧分支错误进入 staging，再变为零写入拒绝。正常夹具补齐完整镜像/外部 ID，显式 []、错 canonical ID/provider/key、无效/不完整 observation 不自动修补。生产代码没有测试夹具推导器。
- quarantine 另一个 promote 调用由 tsc 捕获并补齐；旧 takeover 测试硬编码 v2 导致未到拦截点，已使用当前完整冻结 fixture，保留 takeoverCount===1，避免“提前被其他条件拒绝”伪通过。
- 同步私有 binding fence 不允许普通写/计数器修改；特殊 recapture 也不能用旧副本降级已提高版本。

证据：11 项来源半写入/规范 writer 反例全红后全绿；reconcile/promote 4 个过期补丁反例先红；Cloud source/observation × source/product 写点 × throw/zero/coded/wrong-ID ACK 全回滚，删除 ACK 与 lease 拒绝/预算分别覆盖。source 事务最多 5 文档操作，lease 6；已有 max-40 links 边界保留，无新的逐件全局写锁。三个 mutation 分别检出移除镜像失效写（9 个失败）、移除捕获配对（2 个失败且正向 prepare 仍通过）、断开 observation predicate（实际普通 observation CRUD 失败）；finally 恢复。

严格分支最终相关回归：1030 passed / 0 failed / 0 skipped；五模块 tsc 通过。此前 1027/1029 的通过只覆盖当时版本，未冒充严格版本最终结果。SDK gate 通过，29 个复用 SDK/schema 表面有机械关联的 installed-types/runtime probe 行；Cloud 文件既有 ignore 不作为 lint 通过计入，其修改函数按类型、行为和 installed SDK gate 人工复核。

只读补取三件真实 alibabaSourceProducts（当前 env diversity-123-d9grnqfux221323bb，ap-shanghai，auth READY），未取明文凭据、未写云业务数据。连同真实 observations/media/products 副本，在临时 JSON 用严格 prepare → review → begin/page/finish 验证三件均通过，所有属性仍完整 113/113/121，header 7668/7675/8136 bytes、job 12005/11866/12269 bytes，variants 4/2/1，仍 published=false 且网站分类不变；finally 清除 DB/owner。证据 p2c2b-real-clock-strict.log。这个结果不代表 test 云环境已修复或已实际发布。

浏览器证据：初版/清理镜像版各 150 passed；严格镜像检查后的 r3 在两个只存 observation 的旧浏览器 fixture 上暴露 3 个失败，正式 10 项为 7 pass/3 fail，owned DB 清理。已补齐两套 fixture 的镜像、外部 ID 和一致的原始图库；fixture/e2e tsc 通过；r4 完整生产构建串联最终 150 passed（41 public / 90 catalog / 10 formal / 8 visibility / 1 taxonomy），全部 owned DB/services 清理成功。r3 的真实失败保留，不用先前版本的通过替代修正后的结果。

未完门槛：显式主 link 的完整检查/准备 seal、旧 UI-02 local rehearsal 受保护准备通道、共享报告/正常和问题列表准入、只读 Preview、全 SKU/人工配置、durable intents 和恢复、历史 audit/resync/激活、vendor 隔离交错探针、全构建/transport/performance/test 部署、20 件真实选品发布和恢复。旧 UI-02 全 local-server 失败组仍未修复，不能由本单元的 1030/150 替代全服务器门槛。

文字核对：review source-inputs/binding/invalidation、row mutation、ingest/replay/promotion/quarantine、admin prepare、实际 Cloud/JSON 桥接及测试；将“两个 hash 未变”明确为“配对证明 + 事务内冻结输入”，去掉无真实依据的缺镜像兼容，区分来源清空与网站分类、局部回归与全量/云端验收。未实现未来选择性属性 mapping。


P2c2b 提交前 inline 复核：来源完整捕获、普通/lease/特殊写入、绑定/已有重建/promotion/quarantine 消费者逐条追踪，source/header/media/public 字段归属未变；危险假设（无镜像兼容）已通过反例推翻并去除。显式主 link 的完整检查和 source-page seal 仍属于下一单元，不把它或其后的 readiness/durable operation/recovery/full local-server/deploy/cloud acceptance 记为已完成。


### P2c2c：显式 primary link 和逐页写入 seal（2026-10-14，本地子单元）

824f27d 已完成提交后 inline review / SDK gate，仅为本地子单元。下一步核对 source primary link 与 source/product 的精确归属，并把冻结的 link/source 证明带入 source-page 的事务 seal。alibabaProductLinks 在 collection definition 是 readOnly，正常身份写入由受保护 mutation 执行；分类 suggestion/assignment 只更新其 metadata fence，不能把无关 metadata 当绑定变化。

另一个必须验证的边界：当前所有 source pages 写同一个 detailPreparationFence=revision，第二页可能成为相同记录写入，无法证明建立了新的物理写入防护，也可能被零更新 ACK 拒绝。需要逐页变化，已确认的重试则不重写；补纯协议反例和实际生产 Cloud persistence 的 zero-on-identical 测试。必须在最终浏览器串联后才继续。三件真实 primary links 已只读取得，后续严格数据副本验证不虚构 link。


实际实现：共用严格 primary-link decoder，拒绝缺失、空白、错归属，只有显式允许的旧空 claim 保留；剔除分类/审计 metadata 后冻结 identity hash。prepare 要求真实 mirror、完整 observation、精确 primary link；source-page 在同一事务内重读 source/observation/link/product 并比较冻结 hash、canonical observation ID、gallery 与 generation，变更在任何写入前拒绝。逐页 observation fence 使用 revision+page 的 hash，每页建立实际变化；已确认的重试不重写。20 SKU 页最多 47 文档操作，无新的共享写锁。

测试：初始 3 项反例先红；最终相关回归 1044 passed / 0 failed / 0 skipped，六组 tsc（db/sync/admin/local/public/e2e）通过，12 个修改代码文件 Biome 通过，installed SDK gate 通过。30 个复用 SDK/schema 表面机械关联到落盘 probe，包括新增 decoder 的 refine。实际 production Cloud persistence 用零更新 ACK 模型验证 21 SKU 分页/重试，所有要求写入均有变化；两实际 JSON adapters 验证准备与解绑两个先后次序，旧包不能恢复解绑。五种冻结 link 场景拒绝 product/connection/external-ID/relinked 变动，metadata-only 保持通过。

独立 mutation：恢复旧 revision-only fence 时，实际 Cloud persistence 的第二页在 ACK guard 失败；移除事务内 linkHash 比较时，relinked 反例失败而 metadata 正向仍通过。finally 恢复后执行最终 1044/类型/SDK/浏览器门槛。新增三项 decoder 测试也包含在 1044 中。首轮 1035 中 1 个普通人工价格 fixture 缺 primary link，修正正常夹具后重跑；不放宽生产检查、不自动补显式坏 fixture。

最终生产构建浏览器串联 150 passed（41 public / 90 catalog / 10 formal / 8 visibility / 1 taxonomy），临时 DB/services 清理成功；日志 p2c2c-combined-e2e.log。三件真实存储副本连同实际 primary links 通过严格 prepare/review/begin/pages/finish，完整原值 113/113/121、header 7668/7675/8136 bytes、job 12005/11866/12269 bytes、variants 4/2/1，仍未发布且分类未变，临时文件清理。无云业务写入、resync、发布或部署；真实 vendor transaction/lease 交错仍未验证。

提交前 inline review 已逐条核对 decoder 消费者、HTTP workflow 不接受内部 source-page、冻结证明/事务写入、ACK 与重试、测试有效性和 public/private 投影。当前子单元无剩余 P1/P2；后续旧 UI-02 工具、共享报告/列表/Preview、durable intents/recovery、历史修复、全量构建和 vendor/test 现场验收仍阻止完整交付。文字核对将“重新绑定只是 metadata”更正为 linkedAt 参与身份 hash，并区分当前子单元通过与全部发布修复完成。


### P2c2d：旧本地演练准备和正式审批接线（2026-10-14，本地子单元）

旧 UI-02 工具的 18 项现有测试先复现 17 failed：普通 CRUD 的 ready=true 被输入版本保护挡住，不能用放宽普通 writer 解决。新增仅在具体 JsonFileAdapter 的 prepareLocalDetailClone(begin/seal)，不加入 DbAdapter、Cloud adapter 或 HTTP。要求 localDetailClone=true、精确 ui02 owner；begin 标记 writing 并撤销 ready；seal 在既有单文件 mutation lock 内比较本轮 revision/generation，检查完整且唯一的自有 active manifest、所有配置 revision 及实际生效审批计划后才写 ready 和 content generation。失败不写；新一轮开始使旧 seal 不能获胜。

approveLocalDetail 使用真实 manageCatalogDetailApproval 的 review/begin/pages/finish，写不可变 catalogDetailVariants 和正式回执，移除旧的先清 publication 再逐行覆盖快照做法。只在已接线隔离 workspace、确认 clone 后创建本地虚拟管理员，无云凭证或云动作。人工编辑使 ready 失效后，对完整当前候选重新检查；最终发布保留 expectedUpdatedAt 和 requireDetailApproval，并在隔离 workspace 复核图片引用。此工具仍是本地 fixture/HTTP 演练，不冒充真实客户入口或云现场验收。

测试补齐：无 clone/错误 owner/旧 generation/旧 revision/缺 manifest/写入未完成不能批准；正常 21 SKU 使用 staged immutable-v1 并保留人工名称。损坏 canonical variant 用例改为损坏实际 immutable 存储行，不再修改已不被读取的旧 productVariants 输出；正式 v1 原 adapter 用例仍保留。部分 materialization 失败使用真实 begin 状态，不通过普通 CRUD 注入受保护 ready。两独立 mutation 移除 generation/owner 守卫时，各自反例失败且正常审批正向通过；finally 逐字恢复。

最终扩大回归 1150 passed / 0 failed / 0 skipped，包含全量 apps/local-server/src/*.test.ts 及 db/sync/选定 admin/public 回归，耗时 152445ms。新增五项与原十八项的最终 focused 23 passed；local/e2e tsc、3 文件 Biome、installed CloudBase SDK gate 通过。初次接线误用不存在的 createDocIfMissing 被运行时/tsc 检出，已按实际 createDocWithId 合约修正；可选 revision 类型也已修正重跑。先前失效/失败日志保留，不算通过。修改范围没有新增第三方 SDK 方法，仅复用 Zod.parse，installed 声明和有效/无效 manifest 的实际运行覆盖。C 的 150 浏览器通过属于上一单元；本单元的实际 HTTP/子进程前端 transport probe 已在 1150 中执行，不宣称重新跑过 150。

提交前 inline review：核对具体 Json seam 无 Cloud/HTTP 消费者、mutation lock/持久化恢复、准备与普通 writer 版本边界、真实 staged workflow/immutable public/RFQ consumer；当前局部无剩余 P1/P2。下一步继续 P1 共享安全问题契约、只读 Preview/完整 SKU/人工配置和 P2 准入，再 P3/P4 持久操作/恢复等完整门槛。未 push/部署/修改云业务数据。

文字核对：实际复核 json-adapter、catalog-detail-workspace 及测试、正式 workflow/storage/public handler；将“普通写入 ready”更正为“带 owner/revision/generation 和完整 manifest 的受保护本地准备”，明确本地工具与正式客户入口的证据区别。


### P1c：分页前校验全量配置（2026-10-14，本地子单元）

原计划仅验证所有 canonical IDs，配置实际内容只在当前页解码。新增 21/105 配置 × 页外 SKU 201 字符/选项 51 项/报价 33 项，6 个反例先失败；105 正常配置的分页/报价归属正向通过。实现用同一个 CatalogDetailVariantSchema 校验完整集合后才返回当前分页，不改来源、不丢配置；数量与既有 manifest 上界同为 10000，纯计划 10000 通过、10001 拒绝，该测试不代表最坏大小的审批 job 已通过字节预算。报价先按 sourceVariantKey 建一次索引，保留每个配置和产品级报价的原顺序，避免每个配置再次扫描全部报价。

两个实际 prepare 反例确认第 21/105 配置非法时，第一页即返回字段路径，persist 命令为 []。移除全量配置检查的独立 mutation 检出六个纯计划反例和这两个实际 server 反例共 8 failed；正常 105 配置仍通过；finally 原样恢复后再执行最终验证。

最终相关回归 1365 passed / 0 failed / 0 skipped，包含 catalog-import 根测试、shared/catalog、db、sync、实际本地演练及选定后台/公开消费者，耗时 10993ms；七组类型（catalog-import/shared/db/admin/local/public/e2e）、3 文件 Biome、installed SDK gate 通过。新 server 测试的 unknown validation 曾被 tsc 拒绝，改用实际 CatalogValidationSchema.parse 后重跑通过，不用类型断言。跨文件搜索另找出 change-audit 和 supplier-review 消费者，补跑 13 passed。最终生产构建浏览器 150 passed（41 public / 90 catalog / 10 formal / 8 visibility / 1 taxonomy），owned DB/services 清理成功；证据 p1c-combined-e2e.log。

本地纯计划基准（Node 24，合成数据，不含 DB/网络，不代表云端 SLO）：0/20/105 配置各 50 次，warm P50/P95 分别 0.02/0.05、0.25/1.87、0.88/6.05 ms；10000 配置 10 次为 89.21/95.10 ms，首次 97.09ms。三个复用 schema 表面 array/max/safeParse 已按 installed Zod v3 数组签名和实际上下界/无效输入机械关联。无新 SDK 方法或 shim。

提交前 inline review 已追踪 prepare、旧本地工具、来源审核/变更比较、分页及报价消费，当前局部无剩余 P1/P2。仍需共享安全 issue 契约及所有审批阶段原因、只读 Preview、人工配置/无损选项投影、容量预算报告、列表准入、durable operation/recovery、历史修复、全量发版验证及云现场验收。尤其来源审核尚有未采用长来源文本的有效字段合并缺口，要随共享生效计划继续修正；不把本单元的全 SKU 检查当作 P1 整体完成。无 push/部署/云业务写入。

文字核对：复核 detail-candidate、实际 prepare、change-audit/supplier-review、workspace 和对应测试；把“全部配置 ID 通过”更正为“全部配置实际内容在分页前通过同一网站合约”，明确 10000 数量、job 字节预算、本地计算和云端性能的区别。


### P1d：安全问题报告和生效计划边界（2026-10-14，本地子单元完成，待提交后精确 review）

当前 HEAD 8d8c177 已完成精确 inline review，仅为 P1c。正在接线共享 catalog/issues：固定 code/字段名/数值/恢复动作，不返回原始 message、枚举输入或任意 source key；CatalogValidationError 只保存安全 issues。网站实际生效 header、全部配置、结构化内容、正式 review/begin/page、manual-source 预检查使用同一解析边界；API 错误可选携带安全 issues，浏览器 envelope 先校验，AdminApiError/DraftSavedError 保留恢复信息。成功 DTO/发布状态/分类/来源原件不变。

现有字符串 formatter 的 PRIVATE_SOURCE_TOKEN 回显先复现失败；数字记录 key 被当数组下标的边界也先红后修正。原始来源坏数据先仅返回 SOURCE_NOT_READY，已补具体安全字段分支；缺记录/半捕获/归属变动保持独立 not-ready。persistence 的已有结构化拒绝不被外层改成通用提示。

中途集成：111 中 108 pass/3 个旧字符串报告断言失败，更新为新字段/限额/脱敏契约；扩大 1207 中 1203 pass/4 fail，发现来源 facts 的不同校验分支给出 edit/resync 不一致，已修正并统一私有候选路径。另两项 Admin 旧夹具用 HEAD 的原 API/transport 也复现 2 fail：分类发布 fixture 缺当前版本且未给供应商 Changed 状态；静态断言还期待 patch(row.original._id) 旧参数。已补完整已分类/待审核/正确版本场景，并断言实际 Alibaba review 拒绝原因，保留 New 允许发布语义；单行断言检查完整打开 snapshot。后续 focused 171 pass、八组类型通过（均为当时版本）。

容量诊断保持既有 10000 配置、128 KiB 单配置、512 KiB job；数量常量集中，完整配置在第一页之前也检查 UTF-8 字节，超限报告具体 ordinal、期望及实际 bytes，无截断/分开存储。两项原 begin 字节预算通用失败先红；精确 131072 bytes 通过、131073 拒绝，以及来源字段/隐私/两级预算/persistence 76 项 focused 通过（仍为当时版本）。第 21 项 UTF-8 超限的实际 prepare 零写入反例刚补，最新 28 个代码/JSON 文件 Biome 通过。最终扩大回归/八组类型/SDK/反向注入/实际时钟副本/完整浏览器流程仍待当前代码执行；不得用上述中间结果当最终通过。

文字核对：实际复核 shared issues/detail-approval、source observations/candidate、db workflow/staging/manual/source、admin handler/approve-once、浏览器 API/envelope 和对应测试。把“截短原始 Zod message 是脱敏”更正为只生成受控字段/数字；把来源规格的 Edit 提示修正为 resync，并区分配置容量与 job 容量、局部通过与现场交付。尚未实现只读 Preview、人工配置/无损选项、列表准入、durable operation/recovery、历史修复/启用及云现场验收；没有 push/部署/云业务写入。

P1d 最终验证：r5 1705 passed / 0 failed / 0 skipped；八组实际配置类型和 installed SDK gate 通过。第一次类型命令将根 tsconfig.e2e.json 错写到 apps/site，命令明确失败；更正存在路径后完成第八组和 SDK，不把错误命令算通过。28 个变更代码/JSON 文件实际 Biome 通过，git diff --check 通过。四组反向注入各 1 个预期失败和 1 个正常正控通过：数字 record key、旧私有字符串 formatter、浏览器 issue gate、完整来源配置字节 gate；finally 恢复后执行上述 r5。证据均在 /private/tmp/channel-clock-repair-2026-10-13/p1d-*。

三件真实存储数据副本再次通过生产 prepare/review/begin/page/finish，T142/T157/W203 的 113/113/121 facts 完整，job 字节 12005/11866/12269、配置 4/2/1，分类和未发布状态保留，独立 JSON 与 owner marker 已清理。最终生产构建浏览器 150 passed（41 public / 90 catalog / 10 formal / 8 visibility / 1 taxonomy），owned 临时 DB/services 清理通过；这是本地门槛，没有部署或现场发布。

最终本地纯计划 CPU 基准（与浏览器并行时测量，不代表云端 SLO）：20 配置 n50 P50/P95 0.72/4.33ms；105 配置 n50 1.67/10.79ms；10000 配置 n10 155.86/280.90ms，cold151.66ms。与 P1c 相比加入完整 UTF-8 序列化预算有计算成本，普通小批样本仍为毫秒；大配置、云端网络与整个批量流程的 SLO 待后续实测。22 个保守枚举复用 Zod 表面与 installed 声明/运行测试 probe 机械精确关联；无新 Cloud SDK 方法。

### P2c2e：真实云 lease 接管验证及修正（2026-10-14，本地及该项云实验完成，待提交后精确 review）

P1d 提交 2a62715099d65cece91aa6d0b2edb1e1d8267d8f 精确 inline review 完成，22/22 SDK 表面证据关联，仅局部完成。

独立云实验使用 Node20.19.3、实际 bundled node-sdk3.17.2 和生产 upsert 函数，仅随机前缀 crp_20261014_b32d0526 的5个 ADMINONLY 临时集合；临时 EventFunction 禁止客户端调用，无 HTTP/定时触发器，原应用函数代码未动。读版本1后 B 写2，A 只写独立结果仍提交版本1，证明读集合不验证；加入实际 fence 写入后 A 重试读2并拒绝。实际来源 writer A 读过 lease1 后暂停，实际TTL过期，B取得lease2但不写来源，A恢复仍成功落入 stale-holder-A。独立管理端读回 receipt/source/lease 确认；request6f1112b5-c18c-47c9-b8f4-1b014edf14b5，证据临时 vendor-probe 目录。

复用身份更新已有同值 lease set 模式的云对照：同值 set 可在接管后触发冲突，正常 ack.updated=1；但4个同持有者事务竞争lease，10轮40次仅32成功，8次 DATABASE_TRANSACTION_CONFLICT，6220ms，不能直接上线。第一次4并发断言3/4失败被保留，随后补全逐件失败观测，未降低通过标准；request a6a8aff9-2fe7-4dc0-8a32-ae306a717932，后续完整结果见 invoke-noop-v2-result.json。

拟修正：所有来源 upsert/update、run/checkpoint claim 的实际写入与现有 lease 文档同事务；复用同值写回而不新建字段/集合。在同一 connection/holder/fence 的数据库提交处排队，避免同一同步持有者自相冲突；不同连接/持有者及所有商品审批不进入该队列。队列是吞吐措施，持久层 lease 写入才是正确性保障。普通 sync runner/raw replay 当前是顺序处理；仍需验证4并发压力、不同持有者互不阻塞、失败后释放、真正 take-over、原异常/0写入、SDK/完整回归与浏览器。尚未实现；云临时函数/5集合及单项权限 override 仍在本次实验 ledger 中，后续必须清理并读回。

P2c2e 实现：upsert/update/run claim 的 lease 加入实际写集合；generic catalog 子行/父行通过 beforeWrite 只写一次 lease，所有读取仍先于写入。复用原 lease 的完整同值 set，验证 _id 后去掉 SDK 禁止的 _id payload；每次 ACK 必须确认。原 identity promote/repair 已有同值 lease set，现在和来源写入共用 connection/holder/fence 进程内提交队列；失败 finally 释放且删除空队列。队列用于减少同持有者竞争，正确性仍由存储事务保护；其他连接/持有者/新 fence、普通分类/编辑/审批都不排队。无新字段、集合、SDK shim 或对外协议。

新增快照模型依据云实测，只验证写集合：旧代码21项中11个接管反例失败、10个现持有者正控通过；修正后全部通过，另5项队列顺序/独立key/异常释放与4项 fence异常/0ACK的业务零写入及恢复通过。首次98项88通过/10失败均为原6操作上限已增到7，保留回滚检查并精确断言4读+lease/source/product共3写=7，unfenced5保持；没有放宽数据或原子性断言。新测试两处非空断言被实际 Biome 拒绝，改用存在性检查后5文件通过（大型cloudbase-adapter依旧按已有配置排除）。

最终回归1735 passed/0 failed/0 skipped；DB/admin/sync/local/public/e2e六组类型及SDK gate通过；最终生产构建150浏览器通过（41/90/10/8/1），owned DB/services已清理。反向注入只在独立esbuild内存副本进行，工作区字节未动：禁用lease写入11 failed+10正常正控，禁用队列1 failed+4独立/恢复正控。真实时钟副本在P1d完成后未改变内容投影，本MIU不将未重新执行的时钟副本称作新验收。

修正版实际云候选包 SHA256 5f2b23e866a3b23e969f49f19b9568def733ff211d8a457470e232ed1fb2491d，包含上述真实生产函数（基于2a62715的未提交P2c2e，不是应用部署SHA），Node20.19.3。实际TTL过期并接管后oldResult=false、oldWriterRefused=true、source保持baseline；4件并发10轮40次来源upsert全部完成并逐件读回40，40个native callback、0重试、0失败，写入段9595ms。独立管理端再次核对receipt及全部40个唯一sourceId。原无队列同值fence压力40次中32成功/8冲突、6220ms，修正是以提交排队消除自相冲突；不把更短但失败的旧测量称作吞吐优势，也不把同步写入性能当20商品发布SLO。

云实验清理：先读所有记录验证本run所有权，control54/leases2/sources41/links0/products0，共97条纯合成记录；删除临时EventFunction， fresh读取规则后只去掉本函数override并读回原wildcard；删除5集合，再独立checkCollection证明均不存在。只剩原3函数且ModTime均为2026-10-12，应用函数、商品、媒体、分类及发布状态未改。清理证据vendor-probe/cleanup-verified.json，所有实验代码/账本/原始结果保留在/private/tmp/channel-clock-repair-2026-10-13/vendor-probe供复核。无应用部署/push。

文字核对：实际复核cloudbase-adapter、catalogRowStore、runCatalogRowMutation、AlibabaProduct identity、runner/ingest/raw-replay/selected-sync和对应测试。将“事务中读过lease就能阻止旧worker”更正为写集合fence；区分过程内排队的性能用途和持久事务的正确性用途，明确供应商同步与用户审批的边界。此项完成不代表其他vendor race、完整P2或全部发布可靠性交付完成。

提交前跨文件复核还保留两项明确后续门槛：P2c2f 要补齐非catalog supplier offer/update和run/checkpoint实际业务写入ACK，当前 lease fence 自身确认不等于所有旧目标写入已确认；P6切换新实现前须禁止旧sync新入调用并排空旧调用，manifest最大timeout900秒，原timer默认关闭保持不变。旧代码不参与新fence，不能用新实现的正确性证明覆盖旧调用仍在运行的窗口。上述是发布阻断项，尚未开始暂停/部署操作。

### P2c2f：确认每次同步业务写入回执（2026-10-14，本地子单元完成，待精确提交 review）

P2c2e 提交 ad19f794653718839232070a32ff83e64e9d0ac6 已完成精确 inline review；该项云实验资源清理与整体未发布边界不变。本单元修复其复核中记录的旧目标 ACK 缺口：非catalog supplier offers/raw-replay manifests/runs/checkpoints 的 create/upsert/update 必须确认1次实际写入或对应的新建ID；run claim 确认 run set 与 checkpoint update 两条回执，任一未确认即事务回滚，避免phantom run或checkpoint独占。继续使用原 confirmDocumentWrite/sdkAnswer，coded原生错误保留code，无新SDK方法/shim。未变化目标不强制冗余写入或ACK。

31项先红：30个假成功反例失败，1个正常no-op正控通过。覆盖4集合x3变更入口x0/coded ACK，4个新建错误ID，run/checkpoint各1个零写入；每个拒绝检查整事务无变化，清除故障后同owner队列能继续成功。修正后整个DB/sync/实际prepare消费者758 passed/0 failed/0 skipped，五组backend消费者类型及SDK gate通过，test与standing gate的真实Biome2文件通过，大adapter保留既有lint排除；diff whitespace通过。内存副本移除ACK确认30 fail/1正常正控，原文件未动；同时重新确认fence11fail/10正控、queue1fail/4正控。

已把精确update ACK加入现有自动SDK合约门槛：真实已安装@cloudbase/database1.4.3包装器通过假的请求发送层取得updated1/0，并检查它实际返回该字段；新增2项检查通过。反向在独立Node进程内让实际SDK update返回值丢掉updated，文件和发送过程仍保持原样，恰好2项新检查失败，get/set/remove/发送序列正控保持通过。此为SDK包装器合约证明，不是云端0写入故障注入。原P2c2e真实云40次测量和150浏览器是上一个节点证据，不称作本ACK版本的新云/浏览器验收；后续关键节点与最终test继续重跑。

文字核对：实际复核cloudbase-adapter的generic guarded upsert/update、run claim、已有confirmDocumentWrite/sdkAnswer，SDK document.js70-145实际返回分支，standing合约脚本、runner/ingest/raw-replay消费者及对应测试。将“await写入就算成功”改为精确回执确认，区分正常no-op、0写入、coded失败与新建ID；未改变分类、商品内容、正常发布入口、来源原件、队列范围或审批状态。完整MIU和test部署/真实20件发布回退仍未完成。

### P1e：来源比较使用网站实际字段（2026-10-14，本地子单元完成，待精确提交 review）

P2c2f 提交 e52e7054aa92309b67825d9da83d187ac75a02bf 已完成精确 inline review。compareWithApproved 仍用来源原始标题/描述校验整个网站DTO，未采用的合法长来源文本会让 audit 和供应商Review跳过实际价格变化。四个先红反例确认 raw observation 合法，但 changed/unchanged 均被误记 skipped。修正只在比较的bindings中加入与正式prepare一致的网站产品字段及已经验证的 Alibaba source owner上下文；不写入或覆盖现存owner。

最终小流程组合88 passed/0 failed/0 skipped，覆盖共享字段合并、来源准备、audit和实际Supplier Review；整个admin336 passed/0 failed/0 skipped，admin类型和3文件真实Biome通过、diff whitespace通过。供应商Review两项长标题/描述用例证明价格变化仍展示，完整待决描述保留，严格SupplierReviewSchema通过、原件和网站数据不变。内存副本移除合并：audit4fail/6正常正控，supplierReview2fail/7正常正控；原工作区字节不动。同步ACK/fence/queue反向证据同时保持原预期。

本单元无新第三方调用/签名/SDK方法/shim，0个新SDK表面；不把P2c2e的云40次/150浏览器重算成本版本验收。正常权限、raw来源完整性、分类、原件存储和JSON成功协议不变。SDK/浏览器/完整组合及test实测在后续关键节点继续。另已读回本任务附件：先前pricing-takeover是archived_worktree，没有本任务新增活动worktree；当前继续原pricing目录。

后续已定位但本单元未宣称解决：从audit分页循环与builder全量校验推导，超大SKU集合有重复全量构造，待共享只读完整计划抽取时去掉；本地UI-02工具新建时采用来源文本合理，重放已有管理员编辑的clone还需验证source-only preliminary是否误拒绝未采用长文本。两项保留为P1/性能验证门槛，无云端性能结论。只读Preview、无损options/人工配置、问题入口、列表准入、持久操作/恢复及最终部署验收仍未完成。

文字核对：实际复核catalog-change-audit比较/应用、catalog-supplier-review认证与只读API、SupplierReviewSchema、正式prepare的websiteProduct绑定、detail-candidate/approval合并规则及本地workspace消费者；把“没有observation”更正为已确认的未采用来源文本误拦，严格区分来源原件、网站采用值和只读比较结果。本轮没有实现未来按分类选属性的mapping功能，也未丢弃或分组原属性。


### P1f1/P1f2：无业务写入的 Preview（2026-10-14，本地子单元完成，待精确提交 review）

P1e 提交3bbb91b0b6b084fbb94cd42f51086ef2d123b329已完成精确inline review。本单元把已有source读取/完整校验/字段合并抽为server-only readAlibabaDetailPlan，正式prepare仍显式校验SourcePageSchema后仅调用一次持久化；新preview action直接读取同一计划，不创建配置身份、不写暂存、不导图片、不批准/发布。浏览器用kind=preview与inputDigest，审批仍要求kind=review与expectedDigest/revision；运行时也验证review，不能靠TypeScript把误传预览掩盖成安全。新API读取新鲜actor、完整真实source/observation/primary link，结束前再查来源绑定、商品和actor。分页版本覆盖完整来源/配置/媒体绑定、网站实际字段、分类/生命周期/批准版本，不含请求页号，不能混用两版配置；这不是数据库提交的串行化证明，真正审批仍走原受保护提交。

来源图库回退来自本次绑定observation，不使用旧列表URL；私有已导图片保持原鉴权Blob读取和撤销。Preview继续使用原弹窗、网站组件、图片hook及Edit入口，归档草稿也可只读查看。人工零配置保持同一网站header规则；已有人工配置的无损投影仍是未完成门槛。复核发现旧人工扫描超过10000行可能漏行后按零配置继续，两个先红反例确认Preview与正式prepare均存在该边界；两端现明确返回数量/上限issue，不静默批准空集合。

最终focused50 passed/0 failed/0 skipped；包括0/1/20/21/105配置、整集合后页错误、缺真实mirror、source/link换版、页间编辑和读中编辑、撤权、归档、错误请求、当前图片来源、未暂存草稿、人工扫描超限和误审批。整个shared/import/db/local-server/sync/所有admin/public/前端消费者1859 passed/0 failed/0 skipped（p1f2-broad-r4.log）；admin/site/E2E三套实际类型通过，实际Biome11文件及diff whitespace通过；standing CloudBase SDK gate通过。27个Zod/React/Playwright新/复用表面的安装版本、签名、返回读取及正反例见SDK-PROBE；无新增CloudBase SDK方法/shim或供应商资源。

内存独立bundle故障注入：偷写暂存5fail/3正常正控；移除预览页版本校验2fail/14正控；移除审批kind运行时校验1fail/25正控。全部工作区源码字节不变。误传预览在修复前确实触发importSourceImage及prepare/review，修复后在任何网络调用前失败。首次测试入口缺模块只记接口红，不冒充业务回归；人工超限和误审批反例另外记录了真实行为失败。

三件实际存储数据副本先做readonly Preview，核对JSON DB字节完全不变，再做真实prepare/review/begin/page/finish；HTTP JSON详情一致，113/113/121原属性完整，4/2/1配置，header7668/7675/8136 bytes，job12005/11866/12269 bytes，分类不变、published=false，finally清除DB/owner。最初直接比JS对象仅因Review带sku:undefined而Preview缺省键失败；改按真实HTTP JSON形态比较，没有丢字段/截短值来压过差异。证据p1f2-real-clock-r3.log；不是云产品修复或现场发布证据。

最终第三轮构建后浏览器public41/catalog90/formal10/visibility8/taxonomy1，共150 passed/0 failed/0 skipped，runner确认临时DB/服务清理（p1f2-combined-e2e-r3.log）。真实handler+JSON+Astro产物+Chromium/WebKit证明首次Preview只有preview请求，切SKU、分页、重开、瞬时失败Retry及Edit读取不写任何商品字段；单件、普通编辑冲突、Assign category→Save and publish的20件及下架后共享引用恢复均通过。第二轮同样150通过；首轮旧测试错把prepare/review列为只读允许操作，修正为只允许preview/supplier-review/photo-sources并加强整记录不变断言；首轮失败导致worker重登，后续20件在登录页明确遭频率限制，未进入发布，限流没有削弱。最后类型检查另纠正Playwright断言说明参数从toEqual第二参数移到expect第二参数；最终第三轮包含该修正。

文字核对：实际复核source/helper、readonly endpoint、handler鉴权/安全issue、shared header/DTO/staged workflow、浏览器approval API/Preview及正式和现场验收spec；把“Preview不发布”修正为“不准备、不导入、不写业务数据”，把“比较对象相同”区分为实际HTTP数据相同与undefined非线上差异，保留本地隔离20件与云上真实20件的证据边界。下一步继续无损配置/人工配置、独立问题面板、完整计划复用/性能、列表准入、durable intent/receipt/resume、恢复、历史修复及全量发布门槛。未push/部署app/更改任何云商品，未实施未来按分类选属性mapping。


### P1g1：配置选项无损投影（2026-10-14，本地子单元完成，待精确提交 review）

P1f1/f2提交904030dfe4525d4c54059c1292d6327e4f13b3e8已完成精确inline review。新增4个先红丢失反例：同名多值被optionValues字典折叠、数字名称改变顺序、来源特殊名称和canonical自身__proto__键被丢掉。独立检查实际安装Zod3.25.76的helpers/parseUtil.cjs:102，确认其对象合并跳过__proto__。原始来源数组和已存detailSourceCandidate早已保留完整选项；本单元没有增加存储字段、分页集合或再复制一份来源。

现将canonical字符串字典在校验时转换为自身键的tuple数组，保留普通及null-prototype合法字典、拒绝Date/Map/数组/继承对象及非字符串值。正式审批在Alibaba来源的canonical字典与来源“每名称最后一个值”的既有镜像完全一致时，恢复已有完整来源选项的顺序和重复项；字典确有不同的legacy canonical覆盖时保留原优先级，SKU、人工配置照片及报价规则不变。正式prepare继续从本次来源重建镜像。网站原有按ID选择保留；相互冲突的多值轴不会被虚构成单值组合。

小流程81 passed/0 failed/0 skipped，涵盖共享审批/分页/版本保护、公开选择与渲染。5个真实Json持久化流程分别0/1/20/21/105配置，使用严格真实source/mirror/link，readonly Preview字节不变→实际prepare→review→begin/page/finish（逐页重开adapter）→真实handler发布→完整公开分页/网站选择→最后页配置的持久询盘及同key幂等→下架及私有404，全部通过且finally清理本次临时目录。询盘仅为本地disabled-local通知；曾因测试适配器默认未开启RFQ而明确unavailable，现显式以真实本地启动同样的enablePublicInquiries=true配置运行，没有加localDetailClone绕过来源验证，没有改生产开关或发外部通知。

旧任务边界：既有折叠计划的page hash不能接受新完整选项，拒绝后整个store/游标及旧公开revision不变；重新明确审核的新operation能完整完成。Job decoder、旧字段和既有受保护提交未更改；不声称旧语义任务能无提示透明续接，durable UI恢复与最终切换检查仍属P3/P4/P6。类型检查暴露测试返回值需要Progress/Backfill判别，以及跨应用严格检查下既有单一配置选择分支未证明array[0]存在；改用真实discriminant收窄，并加元素存在条件，未用cast压过问题，正常匹配行为不变。

最终后台/shared/import/db/local/sync/所有admin/public及网站/询盘/图库消费者2266 passed/0 failed/0 skipped（p1g1-broad-r2.log）。第一次扩大检查为2265通过+1个默认关闭的图库浏览器测试；随后显式GALLERY_BROWSER_TEST=1执行整个最终集合，真实Chromium点击、失败、换SKU、滚动及旧控件用例也通过，不把skip算通过。8套实际类型、5文件实际Biome、standing CloudBase SDK gate与diff whitespace通过。新增5个Zod方法表面核对见SDK-PROBE。未将上一节点150应用浏览器组合当作本版新证据；下一UI节点及最终发版继续跑构建组合。

缺陷注入的独立bundle：只恢复canonical折叠2fail/23正常正控；丢弃__proto__自身键3fail/22正控；在真实完整持久化流程中恢复折叠4fail/零配置正控1pass；工作区源码字节未动。三件真实时钟数据副本再走readonly→审批，113/113/121属性、4/2/1配置及header/job预算保持，published=false/分类不变，临时DB/owner清理（p1g1-real-clock.log）。这些是本地证据，不是云20件验收或云性能结论。

文字核对：实际复核shared输入解析/字段归属/容量、source-staging既有镜像写入、原生prepare/review/immutable SKU/public API、网站分页/标签/多值直接ID选择、RFQ不可变snapshot及旧job/page hash。把改动说明中含糊的“保留选项”具体为“保留同名项、原顺序及特殊自身键”，写明既有网站按ID选择原本已正确并继续保留，不把它误报为新修复；核对存储字段0新增、canonical覆盖仍生效及价格/图片语义不变。本轮不做未来分类属性mapping、不分表、不丢来源事实。其余P1完整计划/人工配置/问题面板、P2准入、P3/P4恢复、历史修复及全发版/test/真实20件回退门槛继续实施。


### P1f3：详情失败时可查看问题并进入现有修复入口（2026-10-14，本地子单元完成，待精确提交 review）

P1g1提交37fbaa4ae22234ad7750c6c7d94e988c696e8665已完成精确inline review。Preview继续使用原红色提示样式；新增CatalogIssuesPanel不依赖成功的website DTO，严格解析最多50个受控issue，显示配置位置、长度/数量/字节限额、具体remedy，折叠显示code/path。实际Edit callback必传，支持Retry重读第一页；登录过期可直接进入现有登录路由。resync提示指向实际sidebar的Alibaba Sync，不编造Edit内有resync功能。后续P4仍需完成更直接的恢复动作及未保存编辑保护。

readDetailPreview把wire safeParse失败转换为自有提示，不再把Zod received内容或任意未知异常信息展示给用户；真实AdminApiError保留受控issues，旧UNAUTHORIZED缺issues也有sign-in恢复。先红wire用例证明确实曾泄漏private-raw-token；新增面板缺模块仅算接口红，不冒充现有业务回归。

最终focused34、整个前端210及shared/import/db/local/sync/所有admin/public/网站消费者2274 passed/0 failed/0 skipped（GALLERY_BROWSER_TEST=1，p1f3-broad-r1.log）。site及E2E两套实际类型、9文件真实Biome、diff whitespace通过。18个新/复用SDK表面有精确安装契约/正反例表；没有新增CloudBase方法或shim。独立bundle缺陷注入4项均触发预期失败并保留正常正控；最初TSX loader未插入缺陷的结果不计，修正后显式断言已插入，工作区源码字节未变。

构建后public41/catalog90/formal10/visibility8/taxonomy1，共150 passed/0 failed/0 skipped，runner确认本次临时DB/服务清理（p1f3-combined-e2e-r1.log）。真实55配置草稿保留瞬时503 Retry用例，再注入明确400/TOO_LONG的wire错误，确认Configuration55 SKU及201/200限额可见、Alibaba Sync指引、展开详情并点击真实Open item to repair进入同件Edit，整条保存记录不变。此400是明确注入，不声称该fixture真实SKU超长。组合包含g1无损选项运行时代码、单件/普通编辑/20件Assign category→Save and publish/下架及共享计数恢复；不是云上真实20件验收。

手工配置范围复核：当前集合配置productVariants为hideFromNav/adminAccess:none，CatalogImport为只读且apply仅CLI，现有正式UI无配置导入/编辑入口。2026-10-14对确认环境diversity-123-d9grnqfux221323bb的只读分页覆盖products1121及productVariants2578个唯一ID；7件active manual均已发布，其下active配置0，全集active非Alibaba配置0。计数为多页观察，不是事务快照，也不证明7件详情已健康。私有metadata证据manual-configuration-scope-2026-10-14.json留在临时证据目录，无名称/价格/图片/凭据。依已批准计划的条件规则，本轮正常UI支持manual零配置；CLI人工配置仍明确拒绝，不能静默丢行或声称其已受支持。不扩展另一importer工作流；P5继续审计旧数据，新增正常UI配置入口前必须另补无损投影及完整验收。

文字核对：实际复核CatalogIssuesPanel、preview失败转换/API边界、AdminDetailPreview/PreviewModal现有Edit交接、sidebar Alibaba Sync名称、登录路由、issue合约和formal浏览器断言。把“Edit修复来源”更正为“进入Alibaba Sync刷新来源”，把“有修复按钮”具体为“真实现有Edit callback已由构建浏览器点击验证”；核对受控path、50上限和未知异常不泄漏。未push/部署app/操作云商品，未来分类属性mapping继续仅为想法。P1计划复用/照片选择、P2查询与启用、P3/P4持久恢复、历史修复及最终整合/test现场验收继续实施。


### P1h1：完整候选复用、照片字段拒绝与本地重放（2026-10-14，本地子单元完成，待精确提交 review）

P1f3提交a2617960098ac648a46ebb00324e69fed7fc6774已完成精确inline review。两个实际先红反例：readAlibabaDetailPlan忽略损坏的configurationPhotos，导致其中合法选择也一起丢掉并继续；UI-02已有clone保留有效网站文本，却被未采用的1001字符来源标题/30001字符说明拦住。已让Preview与prepare在任何暂存前返回安全、可Edit修复的照片issue；原DEC-20图库成员规则保留，不把已移出图库的旧照片当作新错误。

抽取buildCompleteCatalogPreparationPlan，独立严格校验header与完整配置，公开分页继续从同一规则解码。audit和Supplier Review比较直接用整份配置，不再为每50行重建全部来源。105配置SKU getter计数由旧逻辑3次降为1次，恢复旧循环会触发新测试失败；这是本地计算次数证据，未冒称云耗时达标。0/1/20/21/50/105完整计划和分页保持所有SKU、重复选项、完整私有来源header及原件不变，公开candidate不带sourceHeader。

UI-02先只读查已有group link/clone，再按实际保留网站字段做preflight；新建仍检查要采用的来源文本，4种provider/字段无效组合不预留任何产品/配置/link身份。最终canonical ID计划一次构造所有配置，保留三方字段合并、完整原始来源header及现有批准版本，未采用描述不构建结构化来源文本。Alibaba与Dianxiaomi各105配置的重放→重新审批→公开读回证明有效保留文本不误拦，旧公开内容在重新批准前不变。正常新建、缺媒体修复、手工SKU编辑和当前本地owner/generation封印检查均保留。

最终相关消费者2284 passed/0 failed/0 skipped，显式开启真实图库浏览器（p1h1-broad-final-r2.log）；8套实际类型、8文件真实Biome、diff whitespace及standing SDK gate通过。第一个测试写入cwd错误未产生新用例，不计红测，实际p1h1-red-r2记录两个行为失败。抽取期间变量重名、内部空首页不符合decoder关系均被测试拒绝，改为直接header校验；类型又抓到schemaVersion字面量和新测试缺search，均按真实契约修正，无cast压过边界。SDK gate初次sandbox的tsx IPC失败不算通过， scoped elevated重跑通过。

独立bundle注入：坏照片忽略1fail/8正常正控、未采用文本误拦1fail/2完整重放正控、旧分页重复构建1fail/10正控；工作区字节不动（p1h1-mutations-final.log）。109项小流程在首次修复后通过；随后补了新建无效文本零身份写入用例，最终2284集合包含它。

构建浏览器public41/catalog90/formal10/visibility8/taxonomy1共150通过，临时DB/服务清理确认（p1h1-combined-e2e-r1.log），包含普通单件/Edit/20件Assign category→Save and publish/共享计数恢复。浏览器运行时保持源码冻结；之后仅把schemaVersion收窄为字面量并补测试search参数。独立Node20 esbuild前后emit字节相同，SHA256 ad8e6b69aa64b1edb5b3b7c8068d89ab399c60863bbe5263bd116d874a414d5d；所有最终类型与2284集合在该修正后再通过，不把尚未执行的云验收算作完成。

真实三件时钟副本再走readonly Preview→正式prepare/review/begin/page/finish，113/113/121属性及4/2/1配置完整，header7668/7675/8136bytes、job12005/11866/12269bytes，分类/published=false不变，临时DB/owner清理（p1h1-real-clock-r1.log）。本轮没有新云产品写入、push或部署。

文字核对：复核detail-candidate完整/分页边界、source照片选择、audit比较、UI-02的group绑定与三方合并、结构化内容采用规则及实际测试。把“分页缓存”改为“一次构造完整候选”，因为本单元未增加缓存；把“照片异常回退”改为“损坏字段在暂存前明确拒绝”，保留原图库成员过滤行为。正式一次审批仍有重复来源读取/构造，下一子单元继续处理；normal/issues/preparing查询、持久操作与恢复、历史修复/启用、最终性能/全构建/test/真实20件回退门槛均未关闭。未来属性mapping继续留作后续想法，原始属性不筛除、不分组或新分表。


### P1h2：一次审批复用完整来源，最终照片预算提前校验（2026-10-14，本地子单元完成，待精确提交 review）

P1h1提交f61cd0a1dfaae0e3252d2e691f94b7ae430058d8已完成精确inline review。实际原生JSON审批先红测得105配置/106不同媒体URL，6页来源准备重复查询636次链接。现在approveInOneRequest每次创建独立preparer，完整来源/媒体映射/配置转换只读一次后分20行暂存；普通prepare和Preview每次仍重新读取。缓存只活在本次请求，绑定actor/product，完成、失败或重启第一页清除；不加全局缓存、DB副本、字段、集合、锁或SDK方法。

实际修复后每请求106次链接读取、最多8并发。两次正常审批之间经真实handler Edit标题，第二次读取新数据并发布正确标题；两次都完整105配置、回执operationId匹配、真实公开最后页→下架及图片publishedRefCount回0，finally清理本次JSON目录。六个21配置的页间注入在第二次native source-page提交前分别改来源raw、图库、generation、主绑定、actor或归档；旧计划均拒绝，注入后的DB字节不再变化，ready=false/nextPage=1，未批准/未发布。此为本地原子协议边界证据，不冒充新的云并发实验；原native事务/fence保持。

Review又补出真实先红边界：第105配置源数据距128KiB只有不到3bytes，加入合法9张配置照片后越界，旧first-page Preview仍通过。现按最终全部照片选择再检查每个配置的UTF8预算；Preview和prepare返回相同Configuration105容量issue及Edit remedy，零暂存、原件不变。该样本是明确构造的边界，不是三件时钟的实际根因；属性未截断，容量上限未放宽。

最终2292 passed/0 failed/0 skipped（p1h2-broad-final-r3.log，真实图库浏览器开启）；针对性小流程71项通过。admin/local-server/site三套类型、4文件实际Biome、diff whitespace及standing SDK gate通过。测试写入首次cwd错误不计红测，实际p1h2-red-r2为636/106成本失败且6个保护正控通过。类型发现严格optional不能赋undefined和mock输入unknown；改成明确可空的固定shape及从适配器派生参数类型。Biome拒绝delete/多变量声明后按规则修正，无ignore或cast放行。

最终8个独立bundle故障注入均确实插入源码：去最终照片预算1fail/9正控，去请求复用/六种native保护各1fail/6正控（p1h2-mutations-final-r2.log），工作区字节不变。两项复用Zod表面安装契约/结果读取见SDK-PROBE。真实时钟副本再走readonly→prepare/review/begin/page/finish，113/113/121属性、4/2/1配置、header/job预算与分类/未发布状态保持，临时DB/owner清理（p1h2-real-clock-final.log）。

文字核对：实际复核source完整读取/分页、approve默认依赖生命周期、SourcePageSchema与stageSourcePage当前CAS、原生读取计数/两次Edit/公开恢复、照片合并预算及source-plan断言。把“缓存来源”明确为“同一请求复用，下一请求重读且逐页native检查”，把“图片字段长度正常”更正为“合并后的整配置UTF8预算也必须正常”。未把P1h1的150应用浏览器重算成本版新证据；下一P1性能节点再运行构建组合。

正式review/begin仍重复读取/构造，下一子单元继续收敛同一审批计划。normal/issues/preparing查询与启用、durable intent/receipt/resume、直接恢复/保留编辑、历史修复、其余性能/云race/Node20构建、test部署及真实20件发布读回恢复仍未完成。未push/部署app/改云商品，未来属性mapping不在本轮。


### P1h3：复用审批计划和全配置媒体检查（2026-10-14，本地子单元完成，待精确提交 review）

P1h2 提交 cca8a9fbdf0679e6e7fe134e10e7ba37bed987c0 已完成精确 review。本单元先红确认 staged begin 和 readonly review 都把同一105配置有效计划构造两遍；新 prepareCatalogApprovalPlan 同时返回计划和摘要。实际批准 UUID 只改变 publication.revision，摘要仍使用既有 review-candidate 规范值。改前捕获的0/1/20/21/105配置及manual0六个摘要逐字匹配；完整manifest身份/缺行/混版检查保留。分阶段page仍使用局部计划，不错误套用完整manifest检查。

正常快速审批改为一次服务端全配置媒体摘要，替代每显示一页再读全部配置；摘要显式 opt-in，普通严格客户端返回shape不变。真实JSON/handler105配置正常路径读取420降为210，后页缺图315降为105，后者在begin前交回既有媒体准备流程。review的kind、商品ID、digest、revision、总数、pageSize及摘要都校验；错误商品回执不能进入begin。prepare完成、review完成及finish前补时间预算边界。真实21配置在最后stage后交回浏览器，同operation恢复同job/revision，正常发布、公开读回、下架、计数归零并清理。这里是本地读次数及fake-clock断点证明，不当作云端延时达标。

94针对性测试通过；八个包类型检查、最终site类型检查、九文件实际Biome、standing SDK gate通过。构建后组合150 passed/0 failed/0 skipped，实际20件隔离分类发布及恢复在内，临时DB/服务清理。三件真实时钟存储副本再次完整prepare/review/begin/page/finish，113/113/121属性与4/2/1配置保留，header/job字节及未发布状态不变，独立JSON清理。这些不是test部署/真实商品变更。

首次全量2316pass/1fail发生在画廊测试模块dynamic import、组件断言之前；原日志没有HTTP状态，不能断言504或具体根因。单独及顺序诊断分别11/2317通过，三轮构建并行尝试均未复现。已核实Astro与测试Vite默认共用site/node_modules/.vite，日志出现config变化重新优化；现仅给测试分配独立临时cacheDir，after清理，消除这项共享资源。最终全量2317 passed/0 failed/0 skipped（p1h3-broad-final-r3.log）；保留首次失败及根因未证实，不用自动retry/skip或改断言抹除。另独立内存hover缩放故障使原浏览器断言恰好1fail/10正控，确认测试缓存修正没有削弱探针。

13个审批内存故障注入均被对应测试检测：重复计划、摘要混入目标revision、缺行放行、只看前50图片、破坏旧客户端shape、错商品/错kind/非法total/pageSize及三个预算边界，另实际native续办；每轮工作区源码不变（p1h3-mutations-r1.log）。SDK14个复用Zod方法和1个Vite调用有逐项表，官方与安装版本契约对照；无新增CloudBase方法/shim。

文字核对：实际复核commit/staging/workflow、fastapprove、native成本及续办、摘要兼容/六个golden、图库测试/安装Vite和Astrocache配置。把“只review第一页”改为“一次review检查服务器已读的全部配置”，把“已经修好测试失败根因”改为“已消除已核实的共享缓存，原动态加载失败的具体原因未证实”。余下normal/issues/preparing查询与启用、durable intent/receipt、恢复、历史修复、性能/云race/Node20构建、test部署与真实20件恢复仍开放；无push/app部署/真实商品写入，也未做未来属性过滤mapping。

提交后复核纠正：p1h3-cache-isolated-parallel.log实际是gallery exit1、Astro exit0；外层诊断脚本exit0没有验证子任务，上一句“并行均exit0”错误，撤回该项通过结论。新网络记录明确捕获504 Outdated Optimize Dep，且首次动态导入刚发现React/Zod依赖并触发优化reload。独立缓存仍不足；该测试基础设施问题继续修复，review保持未通过。


P1h3提交后review修正：d2add46的review withheld，明确记录并行子任务失败及误读wrapper退出的两个P2。画廊空HTML首次通过dynamic import载入harness，Vite此时才发现React/Zod依赖，优化变更触发reload；新日志捕获504。测试启动时显式预优化React、DOM/client、两种JSX及Zod，并关闭自动新依赖发现；只改变测试服务设置，原组件断言不变。独立缓存仍由本测试清理。诊断wrapper现在逐一assert两个child exit，finally清理后才接受通过。修正后同构建并行gallery0/Astro0（p1h3-gallery-startup-parallel-r1.log），最终全量2317pass/0fail/0skip（p1h3-broad-final-r4.log），site类型/实际Biome通过，再次hover故障恰好1fail/10正控。重跑没有自动retry。修改了测试文件后重新证明原探针有效；未将built150算作这次测试设置的新运行。实际修正文件为gallery测试、实施记录及SDK证据；把“外层exit0=全成功”更正为“必须逐个断言子任务”。首次原日志未录status的事实保持。

### P2d1：有版本的私有检查摘要和输出保护（实施中）

本单元先建立有界PreparationReport契约及唯一写入保护，尚不启用列表过滤。摘要绑定productId/inputDigest/policyVersion/contentGeneration，只含最多50条受控issues和状态/时间，不复制source/配置/图片原件。ready/preparing/blocked分别检查布尔组合与issue severity；旧字段缺失或策略/版本不匹配不能当ready。分类、权限和供应商决策仍由发布阶段即时检查，报告不授权发布。

已观察普通advanceCatalogProduct会保留patch中的未知policy/report字段；必须把这些字段像内容generation一样归服务端专用提交管理，普通save/create/upsert/increment不能伪造。内容修改保留最后报告供诊断但将state置stale，generation前进；单纯lifecycle/subcategory变化不重复检查内容。正式报告生产/CAS、native查询/计数/全选与UI入口属于后续子单元，影子回填及启用之前保持现有列表行为，不能让旧商品突然全部消失。第一次测试写文件cwd错误不计红测；实际p2d1-red-r2为7fail/1正控。


P2d1验证：红测7fail/1正控后，保护输出字段及普通increment守卫修复；189针对性测试通过，含24摘要契约、8写入保护、Cloud/JSON各3真实adapter helper入口及既有来源/link/父配置失效。首次focused命令列了不存在的local文件，实际只执行140，不能声称local已覆盖；已改为真实catalog-row-invalidation.test.ts，最终189均执行通过。完整2355 passed/0 failed/0 skipped（p2d1-broad-final-r1.log，实际画廊浏览器开启），shared/db/admin/local四消费者类型、8文件实际Biome、standingSDK通过。

6个内存反证：移除report保护4fail/4正控；放开三个output计数3fail/5正控；去generation检查3fail/21正控；去商品identity/策略/ready warning守卫各1fail/23正控（p2d1-mutations-r1.log）。源码未改。19项安装Zod3.25.76方法有逐项契约与结果证据，无CloudBase新方法/shim。未为这个尚未接线的私有字段重复称built150或云验收；下一整体小流程节点重跑。

文字核对：实际复核preparation schema/readCurrent、advanceCatalogProduct、runCatalogRowMutation、nativeCloud helper及JsonFileAdapter保存、旧版本输入语义及19项SDK表；把“检查通过即可发布”明确为“只描述已保存输入，不能授权分类/媒体/权限/发布”。最后报告保留以便诊断，content修改使state stale且generation变化，旧报告不重新生效；该保留不增加完整来源/配置副本。生产/CAS/查询/UI/影子回填启用仍未完成。


P2d1精确review发现并修正：b93c903暂未bless，因为datetime单独接受7万位小数秒，独立probe实际返回accepted=true/report70311bytes，违背有界摘要约定。新增反例先1fail/24正控，再仅给内部生成checkedAt加max40；来源原件无截断。最终全量2356pass/0fail/0skip（p2d1-broad-final-r2.log），finalshared类型、实际Biome通过；原schema探针重跑并增加去max40反证，共7个独立mutant均产生预期失败和正控（p2d1-mutations-r2.log）。四套consumer types之前已通过，后续修正类型不变；无新SDK方法，19表面完整记录。旧built150/云实验不重算为此版验收。这个容量发现是review修复项，不让它留到启用后。

### P2d2：检查结果的版本保护写回及旧捕获证明（本地子单元完成，待精确提交review）

fd7ccdfba15be742b949ba417a2aa1a9a5700afd精确review已完成。私有报告复用现有内部staging事务通道，不新建状态机/集合；HTTP approval命令不能提交该内部snapshot。写回重新核对admin身份、商品ID/内容generation/策略，以及网站实际输入、主来源/observation/link/捕获证明的同一摘要。只写product检查字段，不改updatedAt、分类、发布、批准内容或图片计数。过期计算拒绝；相同完整回执不重复写product，JSON也不重复写盘；错误generation有受控system-repair issue。尚未接线自动生产报告或列表查询/启用。

内部新命令先12fail，明确是功能尚未接线，不冒充已有产品回归故障。取证又发现旧来源配对漏洞：legacy依赖raw evidence ID，原来源写入版本却忽略它；3个实际反例先红/3正控（p2c3-capture-red.log）。现在legacy evidenceId参与observation输入，主来源payloadId变化时legacy推进商品generation并stale；新版content-hash配对不因rawID变动推进内容版本。并发review进一步推导出“观察到modern/missing后，另一写入切换legacy”的读集合窗口，因此modern/missing也写同值product作实际事务fence，保持generation/updatedAt。该防护依据前面真实vendor已证明的write-set竞争，不把只读校验当隔离证明；本次新增配对/report云race和重抓延时仍待P6实测。额外点读/单商品写仅发生于content-hashed来源的raw捕获ID改变，不增加共享全局锁或每条普通列表的source读取。

最终191focused通过，包含23写回/CAS/权限/来源变化/HTTP边界、7捕获证明、nativeCloud59与JSON49及既有staging/失效。实际helper测试验证scalar/array读、fail/silent/coded/wrongID回执回滚；JSON磁盘故障保持文件及下次读取，幂等重放零persist调用。完整2396 passed/0 failed/0 skipped（p2d2-broad-r1.log，实际画廊开启），八consumer types、11文件实际Biome、standingSDK通过。首次类型检查发现扩展Failure union失去已有validation可选字段，改为共享既有Failure、仅并入新的success分支；测试noDelete按nullable fixture处理，无cast/ignore。

九个独立内存mutation均有各文件独立baseline并按预期失败，保留正常正控且源码不改（p2d2-mutations-r1.log）：finalinput10/13、policy1/22、actor3/20、SDKACK2/57、JSONreplay1/48、legacyproof1/6、mirrorcapture5/2、productfence2/5、modernrawproof1/6（前为fail后为pass）。三件实际时钟副本再走readonly Preview→prepare/review/begin/page/finish→读回，113/113/121facts、4/2/1配置、header/job字节、分类和未发布保持，独立JSON/owner清理（p2d2-real-clock-r1.log）。未拿旧built150作这版新浏览器证据；下个接线小流程重跑构建组合。

SDK11个复用表面逐项见SDK-PROBE；官方事务流程/安装数据库真实入口及现有vendor实验对照，安装index绑定的是transaction/index，不能误用同目录旧transaction.js或文档包装返回值。文字核对实际文件为preparation-store/staging/产品摘要、source-inputs/invalidation、Cloud helper/JSON与23/7/59/49断言；把“现代重抓不写商品”改为“不推进内容版本，但保留实际商品事务竞争”，把“检查成功即可发布”明确为“报告不授权发布”。旧packet可能需要重新review；durable恢复、正常模式/query/count/fullselect、自动检查/worker授权/影子回填启用、完整预算、媒体恢复、历史修复、其余云race/性能/Node20构建、test部署及真实20件恢复仍开放。无push/app部署/真实商品写入，无属性过滤或存储拆分。


### P3a0：按实际媒体读写计算现有 finish 事务预算（本地子单元完成，待精确提交 review）

dbf7b4810760df7363605a23c3710b0f8d11675a 的精确 review 已完成。本单元先红复现固定46张上限误拦正常完整图库/描述图替换：9+18张新图与9+18张旧图共存，实际finish86操作，却返回APPROVAL_TOO_LARGE。原47张用例实际79操作，同样被旧上限误拒。现在唯一planStagedApprovalMedia计算5个固定操作、全部图片点读及真正改变的live-use计数写入；finish使用同一个delta，不再把无变化图片算作写入。原DEC-21共享图只读、image lock/active/storage/counter检查、原子product/job提交及重复finish语义保持。

43个staging回归通过，新增完整rollover、live恰好98/超过98、unpublished恰好98/超过98共五个边界，独立包裹tx逐次计数。超预算时只读actor/job/product共3次，整库不变；成功回放整库不变，旧图计数归零、新图计数保留。真实广泛消费者2397 passed/0 failed/0 skipped（output/pricing-clock-repair-2026-10-13/p3a0/broad.log，实际图库浏览器开启），db/admin实际类型、两文件实际Biome及standingSDK通过。没有新SDK方法或shim；官方/database/transaction再次核对100操作/30秒/doc-only，Context7未提供，仍保留98应用预算。安装数据库契约门槛实际通过，不采用文档示例的包装返回值。

独立esbuild内存mutation：baseline43/0；恢复旧46限制41pass/2fail；忽略delta写入42/1；恢复无变化图片写入41/2；各轮0skip，工作区源码字节不变，日志位于同一私有p3a0目录。先红输出明确正常full rollover false!=true，不把新增未接线接口当业务根因。本次没有重复计算旧built150或旧云实验为新证据。

中断前/private/tmp盘点目录已消失，原未结束cell不可恢复，未声称其完成。已重新只读盘点并逐页持久保存六集合：observations1109、normalized sources1109、primary links1109、source-media links13240、products1121、images9805；独立JSON检查ID唯一/排序/分页计数及起止总数一致。证据目录output/pricing-clock-repair-2026-10-13/capacity-census-20261014-1710，属于多页非事务观察，不是同一时刻原子快照，也不是已跑完审批容量盘点。

文字核对实际staging finish、catalogReferencedImageIds、既有DEC-21/rollover/幂等断言、纯计划及新tx计数探针；把“最多46张图片”更正为“5+实际读数+计数变化写数不超过98”。没有把媒体暂存字节、旧新版本联合图片、公开wire上限混为一项。本单元只修误拒；合法超98组合的分阶段协议仍是P3硬门槛，不能靠提前报错或移出正常列表算解决。P1完整预检、P2报告生产/query/UI/影子启用、durable操作与编辑/媒体恢复、历史修复、vendor races/性能/Node20全构建、同SHA test部署与真实20件发布恢复继续实施。未push/部署app/改云商品，没有新分支/worktree/agent或未来属性筛选mapping。


### P1h4：Preview/来源准备/Review/begin 共用完整配置与任务容量（本地子单元完成，待精确提交review）

P3a0提交8a9db6058fcd26f7fb7aa963ead050627b0d6897精确inline review已完成。本单元实际先红：readonly Review放行整任务超过512KiB和第105配置超过128KiB两个独立反例；Prepare和readonly Preview也分别放行整任务超限，共四项行为失败。第一次写测试cwd错误未写入任何用例，空test-name命令不计红/通过；重新用确认路径写入后的四个失败才计证据。

抽取现有JobSchema构造，统一catalogStagedApprovalCapacityIssues检查完整配置与任务。Review仍一次构造完整有效计划，六个原digest golden保持。任务身份保留两个最大200-code-unit字段的JSON控制字符最坏预算，避免当前管理员能过而另一合法身份/历史revision后来超限；独立近限任务实际短身份523788bytes可存、最长合法身份超512KiB，预检明确拒绝，不增加正文/属性副本或放宽上限。真正持久任务仍使用原actor/operation/request digest/UUID和ISO时间，placeholder只在内存容量计算使用，不写入job。

来源暂存的product及variant序列化抽为两个纯函数，readonly完整候选用同一字段生成规则模拟暂存再调用实际审批计划/容量；原生page写入也使用它们，身份/CAS/observation物理fence/游标检查仍在原事务。完整媒体选择/结构化内容/无损属性和重复选项保持，未产生额外数据库读、provider请求、身份预留或暂存。归档Prepare明确CONFLICT；归档Readonly Preview沿现有override保持可读。类型检查抓到未知generation流入强类型投影，改为复用SourcePageSchema.shape.contentGeneration.safeParse，不cast；缺失/null/0/2兼容，负数/字符串/unsafe整数零写入system-repair。容量先于缺图拒绝，坏内容不能被MEDIA_NOT_READY掩盖。

最终101focused、完整2403 passed/0 failed/0 skipped（p1h4/focused-final.log、broad-final.log，实际图库浏览器开启）；八套实际shared/import/db/admin/sync/public/local/site类型、六文件真实Biome、standingSDK通过。此前2402集合之后新增身份预算测试，最终2403已重跑，不拿旧集合替代。构建后真实前后端/独立JSON库public41/catalog90/formal10/visibility8/taxonomy1共150通过，包含20件Assign category→Save and publish/下架恢复；已独立核对各子任务计数及本次临时DB目录不存在。构建期间运行时代码冻结，后续仅增加unit身份预算测试，四个运行时文件摘要留在p1h4/runtime-digests.json。不是云test部署或真实20件验收。

十项独立内存故障注入有各文件baseline46/24，0skip且源码字节不变：review容量44pass/2fail、job字节43/3、配置字节44/2、身份预算44/2、source容量22/2、generation23/1、source投影丢facts22/2；由于staging测试文件改过，又重跑原三项媒体探针：旧46上限44/2、忽略delta45/1、共享图写入44/2。精确mutation日志在p1h4/mutations.log，不以仅变绿证明测试有效。

新只读盘点副本全部1109件经实际来源准备与同一完整审批容量预检，1109容量通过；1071能生成job，实际job最大15075bytes/Preview最大35928bytes/finish最多50操作/45图片；另38仅为配置图片未绑定（MEDIA_NOT_READY），不是属性/分类错误。未把这些缺图当成功发布或永久坏文件，原images投影未含实际锁字段，因此也未声称全集媒体健康。本轮真实三件时钟额外点读57个实际图片ID的状态/锁/计数，在内存副本完整Preview→prepare→begin→page→finish→不可变配置读回/重复finish：113/113/121facts、4/2/1配置、分类/人工字段/未发布及图片计数保持。三件本次job最大12283bytes，具体actor元数据与早期探针不同，不能用字节差异误认正文变化。私有证据capacity-census-20261014-1710内保留初版、r2及real-clocks-full-p1h4结果；不写云产品，副本与云快照分开，多页非事务观察不冒充同一时刻。

当前来源样本支持保留完整属性而无需L1拆分存储；不能据此承诺任意未来正文都可存。新SDK方法/shim为0，复用Zod3.25.76 parse/safeParse/shape三表面有安装类型及正反例表。官方Zod v3页面能打开但工具无正文，未将其算作已读契约；安装类型/实际行为为本轮精确证据，CloudBase实际standing gate另已执行。Context7不可用。

文字核对实际Job构造/Review、SourcePage serializer、完整source planner、Preview回读和100/101项断言、容量盘点脚本及150runner清理。把“当前短任务能存即可”改为“完整实际任务及合法身份预算均能存”；把“38坏商品”更正为“38件配置图片尚未完整绑定”。本单元未把真正超98图片组合、public-wire整页上限、P2报告生产与原生query/count/fullselect/UI/影子启用、P3持久操作/取消/回执、P4恢复、历史修复、vendor race/SLO/Node20全构建、test同SHA部署和真实20件恢复算完成。下一继续接线；无push/应用部署/客户写入/新分支worktree/agent，未来分类属性mapping未实施。


### P2d3a：照片准备完成也使旧检查结果失效（本地子单元完成，待精确提交review）

5851cb8d4cec809d6f1bb3e0d4c87fbe9ea9093c精确inline review已完成。实际代码显示configurations照片复制的part.field=null，完成时只更新alibabaAutoPhotos配置标记；或者只清alibabaPhotosPending，图库可完全不变。原contentFields忽略两项，来源检查可能停留preparing，且同generation旧ready计算仍可写回。先红8fail/140正控，覆盖两种纯版本变化、两种最终报告CAS、Cloud及JSON实际写入各两种；不是靠UI假设推断已发生生产故障。

现把既有alibabaPhotosPending/alibabaAutoPhotos纳入统一内容指纹，照片完成/状态反转推进generation并stale，旧报告保留诊断但不能复用；相同marker重放不推进，pending缺失/null/false保持完成态等价，不因清旧空字段多一次检查。异常非布尔值仍保留原值指纹而非强制变false。两字段已在原数据模型中存在，本单元没有新集合、存储副本、DB请求、worker、列表启用或授权扩展；旧公开版本/发布/分类/人工字段保持。规范化及报告输入复用同一catalogProductContentDigest，避免只有write-side失效而final CAS漏读。

148focused、完整2412 passed/0 failed/0 skipped（p2d3a/red.log、focused.log、broad.log，真实图库浏览器开启），db/admin/sync/local四套实际类型、五文件真实Biome、standingSDK通过。Cloud更新在原2个doc操作中完成，JSON重复相同状态gen保持。四个改动测试文件均有独立bundle baseline11/25/61/51；分别去pending/auto字段共8项，每项恰好1fail并保留正控；去缺省兼容10pass/1fail。测试文件改动后重跑原保护探针：输出字段7/4、report CAS13/12、native ACK51/10、JSON replay50/1，均0skip、工作区源码字节不变（mutations.log）。13独立缺陷注入不把基础设施报错算业务反例。精确diff无新第三方SDK调用/类型；实际SDK门槛记录独立日志，全球无效precommit不计成功。

本小单元未重算P1h4的150构建浏览器为新版证据；下一报告/query/UI整体节点再跑。文字复核实际photo-preparation中field=null/auto marker/flag清理、advanceCatalogProduct的共享fingerprint、report final CAS、native/JSON实际调用和ABA/重放测试；把“图片没换就不必重查”更正为“配置图片准备状态变化同样需要重查”，区分修复未来自动检查缺口与已观察生产故障。正常列表仍未启用PreparationReport。

后续仍需解决media-link写入与检查snapshot稳定性及自动生产/后台授权、nativequery/count/fullselect/UI/影子回填启用。官方EXCEED_MAX_RESPONSE_SIZE文档本次确认云函数最大响应6MB；P1h5须覆盖整页实际HTTP封装及合法大配置分页，不能只看单配置128KiB或job512KiB。单文档平台大小尚未取得明确当前契约，不猜1MB或16MB。真正超98媒体组合/P3durable操作/P4恢复/P5历史修复/P6vendor race与SLO/Node20全构建/P7test部署与真实20件恢复继续实施；无push/应用部署/客户写入/新分支worktree/agent/属性过滤mapping或拆分存储。


### P1h5：整页字节预算、固定页宽与浏览器容量回退（本地子单元完成，待精确提交 review）

继续原 pricing 分支；a578309 已精确 review。先用合法的 50 个大配置确认固定每页 50 会超过网站 2 MiB 响应限制；累计内容超过 8 MiB 时，旧消费者也会报错。新增 shared 纯计划按完整 header/content/notes、最大完整配置和认证预览媒体元数据的实际 UTF-8 JSON 字节选择 1..50 页宽，应用预算 1.75 MiB。属性、选项、价格和图片均保留；普通 0/20/105/10000 个轻量配置仍每页 50。预览媒体单项不可分割时返回受控容量问题，不能截断。

分页提示绑定批准 revision，放产品私有 catalogDetailPagination；与批准切换在原 product 写入内提交，不加 finish 文档操作。只有需要缩页的内部 job 增加可选宽度，六个既有普通摘要 golden 保持。普通 save/create/upsert/increment 保留服务端输出保护。readonly Preview、Review 和 public 都用完整输入决定宽度；网站第一页协商后固定实际宽度和 revision。累计预算触发时转现有分页模式，保留选中配置；混版、重复 ID、异常响应仍拒绝。

第一轮全量为 2434 pass / 1 fail：真实 HTTP 子进程证明，过期 revision 在商品变少后先撞到页码范围检查，误报 invalid-request，失去刷新回退。现先判断 revision，新增“旧版本第 2 页 / 当前版本越界第 2 页”分别返回 CONFLICT / VALIDATION_ERROR。测试夹具的推断窄类型及 local-server 测试跨入前端 tsconfig 的两处类型错误也已修正：原生整条链只读实际 HTTP 响应并调用共享 decoder，真正网站 transport 由构建浏览器流程验证。一次 focused 命令从根目录无法解析 tsx，0 个业务用例执行，不计红测；改到 apps/site 后实际 91 项通过。

第一轮构建正式流程有 2 项失败，分别为读回 ECONNRESET 和恢复阶段 update 超时；该轮不计通过。新增全大配置被放在共享单文件 JSON 库中，使每次原生事务复制和整库持久化都携带大样本。浏览器夹具调整为前 49 个配置各 1 项、最后一个有 42 项多字节选项，仍经原始 Alibaba envelope/normalizer/materializer/照片准备，并验证全部 50 个身份、最后大配置、全部预览/公开页、手机选择、分类发布和撤回。未增加超时或重试掩盖错误。50 个全大配置仍由实际 public HTTP 全页测试、完整 staged approval 和 shared 真实字节测试覆盖。修正后的原失败流程通过；单文件测试成本是已核实的额外负担，但首次连接重置的网络级原因没有独立复现，不能据此声称已经解决所有连接异常。

最终本地全量 2437 passed / 0 failed / 0 skipped，含实际图库浏览器；九套 shared/import/db/admin/sync/public/local/site/e2e 类型、26 文件实际 Biome、standing CloudBase SDK gate、git diff --check 通过。构建后的真实页面与独立 JSON 后台 151 passed，分组 41 public / 90 catalog / 11 formal / 8 visibility / 1 taxonomy。逐组退出和日志计数已核对，owned 临时 DB 目录独立确认不存在。20 件共享媒体 Assign category → Save and publish 和恢复通过，属于本地 fixtures，不能当云 test 的真实 20 件。构建期间运行时代码冻结，之后仅格式化三个测试/fixture 文件，运行时摘要保存在 p1h5/runtime-digests.json。

故障注入先发现测试缺口：字符计数代替 UTF-8 字节时，原“只有末配置很大”的轻量页测试仍通过。新增 50 个全大 CJK 配置逐页真实 JSON 上界断言后，错误实现明确失败。最终九个文件 baseline 全通过，25 个独立内存缺陷分别检出 UTF-8、后页尺寸、媒体预算、hint revision、批准宽度写入、预览/公开宽度、后续 transport 固定、集合回退、选中项保留、输出保护和旧容量/媒体/来源版本/代次守卫，均有正常控制、0 skip、源码不变。脚本首轮正则转义错误及随后注入器未命中均不计业务证据；r5 日志逐项检查成功。46 个实际安装第三方表面经 TypeScript 声明解析及同表格单元 join 完整覆盖，精确证据见本目录 SDK-PROBE 及 output/p1h5。

文字核对实际 pagination/approval/job/Preview/Review/public HTTP/website transport、集合状态/选择 reducer、原生串联和 raw/browser fixture。将“一个大配置通过”明确为“所有配置共同决定固定页宽，逐页读回不遗漏”；将“150 已通过”修正为“最终五组共 151，清理已独立核验”。未筛选来源属性或拆分存储。

发布仍受原 P1—P7 门槛约束：旧已批准大数据需影子审计和分页提示迁移，兼容读端先部署、旧 writer drain 后再写大数据；云端单文档上限当前契约仍未知。P2 媒体绑定快照/生产者及服务身份/原生查询计数全选和 UI、真正超过 98 操作的媒体协议、持久操作与恢复、历史 resync、vendor race/SLO/Node20 全构建、同 SHA test 部署、三件时钟及真实 20 件发布读回和恢复均继续。未 push、应用部署或修改客户数据。


### P2d3b：批量审批拒绝坏图片存储类型（本地子单元完成，待精确提交 review）

5848807 的精确 inline review 已通过本地子单元，整体仍未发版。在媒体快照接线检查中发现 staged finish 使用 String(image.storageProvider)，而 direct commit 和公开图片读取使用严格类型。因此 ["cloudbase-storage"]、["local-disk"]、嵌套单元素数组均能被误当合法存储类型，批准后实际图片读取会拒绝。此为代码及本地反例，不声称云端已经存在这些坏值。

五个完整 begin/page/finish 反例中，三种数组原实现实际完成批准，两个 null/unknown 控制正常拒绝；红测 49 pass / 3 fail。修改为与 direct commit 相同的两个字符串严格比较，所有坏值在任何 image/product/job 写入之前返回 MEDIA_NOT_READY，批准版本和全部存储状态不变。没有新增存储、额外 DB 操作、锁或字段，不影响有效 cloudbase-storage/local-disk 或旧缺省计数。首次运行红测的日志路径错误使命令未执行，不计证据；实际 r2 红测已独立检查。

最终 87 focused、全量 2442 passed / 0 failed / 0 skipped，db 类型与两文件实际 Biome 通过。新 strict-provider 反证恢复旧 String 转换，49 pass / 3 fail；因为 staging 测试文件有新增用例，又重新执行该文件原页宽、完整 Review/job/配置/身份容量、旧图片上限、delta 预算和共享图片不写探针，另外八项各有预期失败及正常控制。所有十次执行（一个 baseline、九个独立缺陷）0 skip，源码不变。SDK diff 无新/修改第三方表面，仅移除 JavaScript String 强制转换。H5 的构建 151 是上一 SHA 的组合证据，本次不重新计为新版浏览器验收。

文字复核 staged/direct commit、readImageMutationState 和公开图片 provider 分支及完整 finish 状态断言。把“绑定了 imageId 就说明图片可用”明确为“还须核对实际图片状态、存储类型、锁及计数；源链接只是绑定关系”。下一继续媒体快照保护和报告生产，暂不启用列表准入。

新增官方证据：2026-10-14 MCP 已读 https://docs.cloudbase.net/lowcode/faq 全文，数据模型 FAQ 明确写文档上限 16MB；腾讯云系统限制 https://cloud.tencent.com/document/product/876/47177 明确的是数据库单次出包 16M 和函数同步响应 6MB。两者不能混为同一个限制；FAQ 位于微搭数据模型模块，仍需核对当前 NoSQL SDK 路径的适用性及完整产品写入预算，不能把它直接当已完成目标环境容量实验。尚无新增云写入、部署或真实发布验收。


### P2d4：完整只读准备检查及测试只读传输恢复（本地子单元完成，待精确提交 review）

a21e490 精确 inline review 已通过。新增未注册的 inspectCatalogPreparation，严格命令、存储管理员前后验证、完整 product/source/observation/link 输入摘要、有效 generation；沿完整 source plan 或既有 manual Preview 检查所有实际采用图片，去重后每波最多 8 个点读。完整状态/严格 provider/锁/计数检查、12 秒波次间软预算、最多 50 条安全诊断；超过诊断容量的末项硬错误仍使结果 blocked。没有 DB 写入、身份预留、暂存、provider 下载、后台身份伪造或列表启用。

实际反例发现 Preview 线容量不一致：完整源计划可通过但私有预览 URL 过大会使实际 Preview 拒绝。抽出唯一 catalogSourcePreviewPagination，检查模块和已接线 Preview 共享实际完整分页字节检查，避免双重来源读取。另覆盖已存批准损坏/错误商品、已知不可用或策略不可导入的配置图，以及人工配置图替换恢复。HTTP/HTTPS 按原复制策略逐 URL 规范化，不让 utility 的 200 项 UI cap 截掉已知失败集合。

输出明确 kind=unsealed-inspection，没有 PreparationReport 必需的 schemaVersion/state/mediaReady，实际 schema 拒绝直接持久化。媒体摘要不含共享计数的合法绝对值或临时锁 owner/time；计数合法性仍在摘要且每次检查，实际文件标识变化使摘要变化。两次输入相等不证明全局媒体原子性；媒体绑定/删除封存及 service lease、报告生产/query/count/全选/UI/影子回填继续，不能以这个中间结果放行发布。

最终 focused58（33检查+25source）、广泛消费者 2485 passed/0failed/0skipped，图库浏览器实际开启；admin/local-server/e2e 实际类型、六文件实际 Biome、fresh standingSDK、diff check 通过。实际完整构建浏览器 41+90+11+8+1=151，owned DB 路径独立确认已删除。浏览器覆盖共享已接线 helper/既有流程，未注册检查模块仅单元验证；verified-source-digests.json 明确两者不同，未用早期 inspector digest 冒充最终构建。

初版检查测试16项失败源于 fixture 构造器复制了 observation、测试后来修改脱离 adapter 的对象；修正真实存储引用，未声称16个产品缺陷。17个最终独立内存缺陷均失败并保留正常控制，baseline33，0skip/源码不变，覆盖全图/类型/健康/末错误/待图/并发/输入/撤权/预算/代次/旧批准/线容量/共享计数摘要/临时锁摘要/永久失败/URL/人工回退。初轮故障脚本未命中 anchor 不计证据，final-r2 已机械核验全部18条执行。

第一轮构建在 list 转发 route.fetch 遇 ECONNRESET，随后5项未运行，该轮不计通过。相邻测试 helper 只对 get/list 加 maxRetries=1，分类用例精确 list 转发同样一次；写动作仍0，HTTP400/503不重试。真实 Playwright request sender 到 owned loopback 的10项测试证明临时读重置恢复、持续读重置恰好两次后失败、4种未知写响应只尝试一次。3个真实网络 fault mutations 各被检出；原 CollectionView 分类核对故意跳过，构建浏览器仍1业务失败/2正常控制，无 ECONNRESET；源文件 SHA 字节恢复且临时库删除。最终正向151全通过。该项只是测试传输恢复，底层首次重置原因尚未复现，也不是应用 P4 持久回执/恢复完成。

真实 T142/T157/W203 使用 capacity-census-20261014-1710 已存只读副本，经实际完整计划保留113/113/121属性、4/2/1配置，检查 ready、扫描27/25/24媒体，所有集合字节状态不变；没有刷新云端当前数据、resync、像素验证或真实发布，不把旧快照当现场验收。24个第三方表面（18安装声明+6 @playwright/test导出facade）逐单元精确join，Context7不可用、Zod文档无正文均如实记录；Playwright官方 maxRetries 和安装 coreBundle.js 返回/转发/ECONNRESET语义核对。没有新 CloudBase 方法/shim/依赖。

文字实际复核 catalog-preparation-inspect、完整source/Preview共享分页、manual Preview拒绝非来源配置、readImageMutationState、PreparationReport契约、admin-api helper/list路由、loopback和真实浏览器失效断言、SDK表格及已存时钟脚本。将“检查ready等于可存报告”改为“只读未封存诊断，须媒体保护和最终CAS才可存”；将“连接重置已解决”改为“测试只读转发可恢复，底层原因未独立复现”。未push/部署应用/修改云商品；不新增分支worktree/agent，不筛属性或拆分存储。P1—P7总交付仍未完成，下一继续已验证的媒体URL绑定差异、全部配置媒体准备和持久操作/并发协议。


### P2d5：复制和详情绑定使用同一 Alibaba URL（本地子单元完成，待精确提交 review）

da453e5 精确 inline review 已通过。实际先红18pass/2fail：已按既有复制策略存成HTTPS的 s.alibaba.com 地址，在完整详情 source plan 里仍按HTTP找绑定，导致已复制图片被当 unbound；含查询参数与大写HTTP/主机两个反例。抽出 shared 单 URL alibabaPhotoSource，沿用全部旧协议/host/凭证/端口/2048字符策略；UI 集合仍200上限，gallery/description仍9/18，顺序和去重不变。sourceLinkImageId 对可复制地址复用此规范化；已有其他HTTPS绑定保持可读，不发起下载。

复核时主动补旧绑定反例：仅用新策略规范化会改变历史HTTP alicdn 非当前复制策略地址的查找key，17正常控制/1fail。保留原CDN查找规则作为只读旧key兼容，不因此允许copier抓取此端口；具体provider/sourceUrl/imageId仍严格核对。没有改变source link、配置选择、published/分类/计数，也没有新的DB请求。

故障注入发现测试盲点：原拒绝凭证用例同时有用户名和密码，删除username检查仍全绿。拆为用户名单独/密码单独两项实际子测试，再对两道守卫分别注入才确实失败。初轮控制数量检查未满足，以及这个存活缺陷均保留日志，不记通过。最终两个baseline18/20全通过，12个独立缺陷分别破坏新URL规范化、旧key兼容、provider/URL/imageId三道绑定校验、UI200、host/HTTP/用户名/密码/端口/去重；全部检出，有正常控制、0skip、源码不变，mutations-final-r3.log已机械核验。

最终focused95（含33完整检查和24既有photo preparation），广泛消费者2493 passed/0failed/0skipped，真实图库浏览器开启；shared/admin/sync/local/site五套实际类型、四文件实际Biome、standingSDK、diff check通过。初次类型失败是新增表格被推断成string[][]而noUncheckedIndexedAccess视解构值可缺失，改为实际字面tuple as const，未assert外部数据。此节点未跑新版构建浏览器，P2d4的151不重算；后续完整配置媒体及报告串联节点重新跑。SDK新/改第三方表面为0，工作区pure helper不冒充vendorAPI。

文字实际复核shared选择器/单URL、sourceLinkImageId/完整plan、worker configurationPhotoSources/copier/import allowedUrl及原手动绑定兼容；把“同一网址有绑定就能查到”改为“复制与读取须使用同一传输规范化key”，把“放开200就修好”保留为未实施项：完整配置遍历还须验证断点续跑和marker字节预算，不能把来源URL列表无限复制进product。未筛选属性/拆分正文存储/新增分支worktree/agent，未push/应用部署/云端商品写入。媒体封存/报告生产/query/UI、真正超98媒体、持久操作与恢复、历史修复、vendor/P95/Node20构建、test部署及实际三件时钟和20件发布恢复仍继续。


### P2d6a：来源图片失败记录成为检查依据（本地子单元完成，待精确提交 review）

c558b03 精确 inline review 已通过。先红38pass/3fail：没有product URL副本时，已持久not-found/6次fetch失败仍被只读检查当作preparing；反过来，商品旧unusable标记盖过来源图当前新的临时重试记录。把原copier的10分钟/6次/永久失败/固定manual retry cutoff规则抽到shared纯函数；copier读旧失败及本次失败都复用，检查从已有精确source-link读取中带回受控状态，不增加DB查询，不复制原始失败原因或私有值到响应。

有效当前失败记录优先于旧商品摘要，永久或耗尽失败给blocked/edit，临时失败保留preparing/retry-media，旧无有效时间的记录不冒充已确认失败；错误provider/URL绑定不能提供状态。人工配置图覆盖仍可ready。只对实际unbound配置失败加入媒体输入摘要，状态由临时转耗尽时摘要变化、商品inputDigest不变；不把所有无关图片计数或失败时间当作内容改变。来源packet、public DTO/分页/revision及实际批准数据未增加失败字段。

额外收紧失败metadata的信任边界：次数须正safe整数；缺失/负数/小数/字符串/Infinity/unsafe沿一次旧失败兼容，不能因此提前制造永久失败；reason必须真实string，数组不经String伪装not-found。25个pure行为测试覆盖每种永久/临时原因、恰好10分钟、恰好6次、手动cutoff相等与旧记录、坏次数/坏时间。原24个copier测试保持，包括6次、manual retry续跑和单件原子保存，不拿检查模块测试替代复制行为。

最终focused129，全量扩到shared顶层全部测试后2662 passed/0failed/0skipped，实际图库浏览器开启；shared/admin/sync/local/site五套实际类型、七文件实际Biome、standingSDK、diff check通过。四个bundle baselines42检查/25policy/24copier/18binding通过，31个独立故障全部失败且有正控/0skip/源码不变：重跑原17检查保护，新增持久状态/当前优先/摘要、绑定三守卫、失败时间/次数/reason/阈值/延时/cutoff及copier两个共享策略入口。日志已机械核验。不新增第三方SDK表面、shim或依赖，没有新的网络抓取/授权路径。

文字实际复核sourceLinkPhoto到完整plan私有sourceMedia、Preview只投影原gallery/description字段、unsealed检查及失败摘要、copier copiedState/copySources与shared policy、25pure/42检查/24copier和18binding断言。将“永久失败只能从product.unusable URL列表判断”改为“当前有效source-link失败记录为准，旧摘要仅在缺记录时兼容”。没有将新只读状态当作媒体封存、正常列表启用或文件存在证明。

下一完整配置准备需去掉误用的UI200上限，同时改为有界完成摘要，不能将无限完整URL列表再复制进product。沿现有四并发、源图链接复用、商品CAS和单件图库/可见性最后保存语义；还须覆盖末页失败、软预算续跑、同源重复、manual retry、来源/管理员编辑中途变化。很长已复制前缀的重复元数据扫描成本仍要在持久操作/服务协议和云性能验证中解决，不承诺现有波次软预算是严格墙钟上限。P2媒体封存/生产/query/UI、P3大媒体/持久意图、P4恢复、P5历史、P6/P7继续；未push/应用部署/云商品写入/新分支worktree/agent/属性筛选或正文拆分。


### P2d6b：完整配置图片准备与固定大小完成标记（本地子单元完成，待精确提交 review）

3b17c3a 精确 inline review 已通过。先红24正常控制/5fail，实际捕捉worker的200项误截断、长URL复制进product的额外存储、续跑末图遗漏、永久失败最后来源漏处理以及“完成且无失败”缓存被删后重试无效。完整观察逐URL使用既有安全策略、按序去重，不再调用有UI200cap的集合helper。界面cap、gallery9/description18和属性/原始观察保持。205个HTTP/HTTPS混合重复来源实际52个零预算调用推进，每张成功图只下载一次，实测peak4；每次中途产品照片/可见性完全不变。

配置完成标记仅4字段：schemaVersion、完整规范化来源序列的SHA256、sourceCount、unusableCount；205个约1800字符URL依然小于256bytes，不重复存完整URL或配置imageId/unusableURL数组。来源全文及逐图失败仍在原observation/source-link；图库/描述图旧marker和人工所有权不变。纯旧sources格式继续读取，原200完成标记实际205时复用前200/只复制后5。来源同数量换URL和变为空集合正确更新；显式重试检查全部配置绑定，只重下载失败或已删缓存。

新协议反例抓到兼容洞：损坏的新摘要带一个sources字段，会被strict新parser拒绝后又误走旧parser当成已完成。实际extra-field子例/父例失败，现版本化字段出现就不允许回退旧配置格式；格式、hash、计数及失败计数边界均测，重跑对应mutants已检出。复制过程中发布/归档/批准仍由原未批准draft/身份/updatedAt CAS拒绝，不覆盖分类或人工照片。来源图片失败数量纳入既有统计，live/archived/approved不再误计草稿待图。

第一轮151构建通过并清理后，主动补出另一引入风险：缺失/损坏/停用/错主来源观察被当作有效空集合，可能清掉已有完成摘要或复制旧来源。47正控/4红已保留；改为返回undefined表示未知，只有有效空观察才返回[]。原生JSON后端另证明来源记录不可用后整个存储字节不再改变、无provider调用、检查不冒充ready。修正后再重跑全量及全部构建151；不以第一次旧runtime的151冒充最终版本。

最终focused159、全量2692 passed/0failed/0skipped，shared顶层和catalog、实际图库浏览器均开启；shared/admin/sync/local/site五套及root tsconfig.e2e实际类型、三文件实际Biome、freshSDK、diffcheck通过。最初tests/e2e/tsconfig.json路径不存在不算type成功，已用实际枚举到的tsconfig.e2e.json重新执行并留日志。三个测试fixture赋undefined数组的类型错误改为明确空数组兼容，没有断言外部数据。原单SKU期望改为新4字段schema，digest另用Python独立计算为a588ced5...411f883d，不从实现输出直接抄expect值。

最终两个mutation baselines51worker/3native全通过；26个独立故障检出且各有正控/0skip/源码不变，含截断、marker重复URL、digest/schema/strict及旧fallback、失败计数、重试缓存修复、草稿统计、等待/部分保存/预算/并发、生命周期/版本、原共享失败策略、native人工图/未绑定/永久失败、未知和inactive观察。新增native三例使用实际JsonFileAdapter/商品CAS/handler/approval/public读取：205独立图片检查206个实际采用ID，检查前后整库字节不变；另205来源共用对象的完整末失败→人工图库替代→approve→publish→五页205配置/最后照片读回→finally下架/引用数回0；来源未知不清旧标记。所有owned目录由after清理。这是后端串联与媒体元数据fixture，不是COS像素或205独立媒体最终批准。

修正后的构建实际151 passed，41public+90catalog+11formal+8visibility+1taxonomy；本次owned /private/tmp/channel-clock-e2e-lexar/channel-catalog-e2e-5EztgA独立确认不存在，runtime-final-digests完整核验。含20件共享媒体Assign category→Save and publish及恢复，属于本地样本，不是云test真实20件。新第三方SDK表面0，无新vendor方法/shim/依赖。

文字实际复核photoPreparationPlan/configurationPhotoSources/copySources/单件save/摘要strict和legacyparse/status，以及新增原生准备→检查→审批→公开读取→恢复；将“完成标记存URL全表”改为“固定摘要与计数，逐图记录沿用现有source-link”，将“来源读不到=零配置”改为“未知和有效空集合分开”。仍保留每次续跑重复扫描已复制前缀的真实性能风险，软预算不是严格墙钟上限。真正超过98媒体操作、媒体绑定/删除封存、service身份/报告生产/原生列表query/count/全选/UI、持久intent/取消/回执、历史resync、vendor/P95/Node20全构建、同SHA test和真实三件时钟/20件发布恢复继续。未push/应用部署/云商品写入/新分支worktree/agent/属性过滤或正文拆分。

本轮额外只读刷新CloudBase登录READY及ap-shanghai当前环境清单：diversity-123-d9grnqfux221323bb下3个基础函数admin/public-api/alibaba-catalog-sync，Nodejs20.19且Active，当前地域环境总数1。该清单不证明实际test/prod URL隔离或其他地域不存在；部署前仍须核对真实目标、路由及数据边界。未切换环境或创建云资源。


### P1h6：配置图顺序与准备缓存一致（本地子单元完成，待精确提交 review）

24e10e7 精确 inline review 已通过。补真实counterexample：网站配置图按provider position排序，准备packet却按原数组前9记录sources/unboundSources。10张原数组逆序、网站实际用的9张已复制、未用的末序图未复制时，网站有9张有效图仍被准备错误拦住。先红18正常/1fail，actual old module probe另读git24e10e7源码bundle运行，独立确认其网站图片9..1、准备来源0..8、unbound错误为position0。

抽唯一orderedCatalogMedia纯排序供既有图片投影与准备元数据共享。网站图片数量、绑定/去重/渲染及source全文均不变，仅准备元数据按网站已有position顺序取前9；不引入新的图片选择、属性筛选或存储拆分。媒体顺序受影响时才给source revision增加内部policy材料，必须重做旧准备缓存；已正确排序的输入保留原revision，避免所有正常商品无谓重暂存。

对最强反例实际跑原生后端：先保存从旧模块结果还原的raw-prefix准备，readonly Review证实allVariantsBound=false；新approve必须重暂存、清掉旧unbound，随后真实handler发布/public详情读回9..1并finally下架、九张计数回0。忽略policy材料的mutation确实使旧缓存复用并失败。原native测试第一次发布失败是fixture没有商品主图，shared publish validator明确要求至少一张；没有修改这条用户规则，而是先给合法的owned gallery并从旧模块重新计算该上下文的legacy revision，再完整通过。不把这个fixture失败称为产品bug。

旧模块独立输出legacy ordered revision=daccb357...0d6e81c，reversed=a74d6b92...b131758，owned-gallery reversed=a1b4a8ab...bc5e3c9；原始完整值及复现脚本在p1h6/legacy-source-results.json与legacy-probe.mjs。单位测试同时锁定普通ordered旧revision完全不变、affected必须不同。实际源码没有被旧模块探针覆盖写入，所有执行在内存bundle。

最终101focused、2695广泛消费者passed/0failed/0skipped，实际图库浏览器开启；shared/import/db/admin/sync/local/site七套实际类型、四文件实际Biome、freshstandingSDK、diffcheck通过。native fixture的packet.action原推断为string，改为显式内部命令字面source-page，未cast外部数据；类型修正后focused和全部mutation重跑。两个baseline20source/4native通过，14个独立故障均失败且保留正控/0skip/源码不变，覆盖元数据/投影排序、in-place污染导致policy漏判、affected/ordinary revision、native旧缓存、新三binding守卫及原native人工图/未绑定/永久失败/未知观察保护。

P2d6b的151构建是上一SHA，不作为这个小修的新版浏览器证据；本次小流程用真实JSON事务/handler/公共详情及恢复串联验证，最终P6/接线节点再跑构建浏览器。新SDK表面0，仅工作区helper与built-ins，无SDK/shim/依赖/URL/环境更改。

文字实际复核detail-candidate排序、完整source map/packet/revision及SourcePage旧完成短路、readonly Review、source preparer、native approve/public/withdraw。把“改排序就够了”补成“修元数据排序，并让确实受影响的旧准备缓存重做”；将“发布错误”明确区分合法主图校验与待修的source缺图误判。仍未完成媒体封存/删除与绑定安全、后台service/报告生产/query/UI、真正超98媒体、durable intent/取消/回执/恢复、历史resync、vendor/P95/Node20全构建/test同SHA和实际三件时钟/20件恢复。未push/应用部署/云商品写入/新分支worktree/agent。

### P2d7：先隔离再删字节，失败可重试（验证与 review 进行中）

原导入删除忽略 remove(false)，会报成功；导入删除和 abandonUpload 都先删字节再删行，数据库失败会留下 active 坏图。三个接口反例在旧实现下实际失败，241 个既有控制通过。随后增加共享严格删除状态机与执行器，生产 CloudBase/JSON 适配器原子 begin/finish；原图片锁和权限不变，原行保存有界意图，字节操作在事务外。

串联发现并修复：deleted 迁移行仍可走旧 base64 预览（原生先红 4 控制/1 失败）；旧 migration 可给隔离行追加新目标（5 控制/1 失败），现在迁移持原资源锁并重读；数据库锁的 acquire/release 必须确认更新 ACK。迁移上传本身的未知提交补偿仍属下一媒体写入单元，未声称已修复。

review 再发现两个文件标识问题：2,048 字符限制误拒编码后的对象键（35 控制/1 失败），改为 8,192；trim 会使真实末尾空格文件仍在、行已删却返回成功（7 控制/1 失败），已逐字保留原目标。历史 census 的 images 投影没有文件标识，已明确不能拿 0 个返回指针证明兼容性。

最终检查数字和浏览器恢复证据待本轮运行结束后补记。证据目录 output/pricing-clock-repair-2026-10-13/p2d7。状态表、并发边界和未完成上线门槛见 P2d7_IMAGE_DELETION.zh-CN.md。没有新建分支/worktree/PR/agent，没有 push、应用部署或云商品写入。

写作实际复核 image-deletion / runner、CloudBase 与 JSON 原子封套、两条删除入口、migration 及 preview、故障用例和 SDK gate。把“对象优先删除，失败留原记录”改成“先持久化不可使用状态，失败保留原删除目标”；把“文件标识标准化”改成“文件标识逐字保留”。核对权限来源、原目标、数据库 ACK、真实文件是否仍存在以及测试对象清理，不把元数据成功写成云端字节或发布验收成功。

P2d7 最终本地验证：315 focused / 2,769 broad，均 0 failed / 0 skipped；8 个相关包 + 根 E2E 类型检查通过；Biome 13 文件（CloudBase adapter 按仓库原配置排除，已单独逐行 review）、新鲜 standing SDK 通过。36/27/8/20/224 五个 baseline 全绿；22 次运行缺陷注入（其中同一隔离缺陷由四种测试入口交叉检出）全部检出，有正常控制、0 skip、源码未变。另 8 项 SDK gate 注入各有 92 正常控制；21 个 package/method pair 与 SDK-PROBE 精确对齐。未知版本测试盲点先存活、补测后失败；冗余迁移单守卫移除仍被其他守卫挡住，最终用准确旧迁移函数回退与互斥移除验证；初版 probe 的路径错误不算检出。

浏览器门槛未完成：最后一次冻结源码构建为 41 public + 90 shared + 11 formal + 6 admin 通过，1 admin 失败，1 admin 与 1 taxonomy 未运行。失败是 BUSY 发布回执已出现、状态读回尚未结束时，Try again 按钮可点而内部 guard 静默返回。前两轮 151 通过不能替代这轮失败。三个相关 UI 模块逐字等于 15a253a，证明不是本单元改了该 UI；仍作为实际交付阻断，转入 P4a0 单独修复并复验。失败现场已保存 failed-browser-retry/error-context.md，临时库 N3bnoH 已确认删除；运行源码哈希全部匹配。未冒充 test 发布或真实产品验收完成。

### P4a0：发布冲突后重试不得静默丢点击（本地子单元完成，待精确提交 review）

P2d7 最后一轮实际构建暴露旧 UI race：失败回执已经出现，stage 已切到 refreshing，按钮却只按 publishing 禁用；retryPublication 仍检查 pending/busy/inFlight，于是正常点击被静默丢弃。三个 UI 模块与15a253a逐字相同，属于原流程缺口，但仍作为交付阻断处理，没有靠重跑把148通过/1失败/2未运行写绿。

用 diagnosing-bugs 收紧复现：依次排查按钮门禁不一致、模拟 BUSY 未撤销、请求已发但版本过期。把 BUSY 后真实 product list 读回主动挂起，确认 Checking product statuses 已显示，旧按钮仍 enabled，固定在 disabled 断言失败；独立反馈组件先红7控制/1失败。原回执、选中商品和分类没有修改。增加 first-party retryDisabled 通道，分类编辑器传 pending || busy；原 retrying 仅描述确实重试中的标签。现在读回结束后才接受重试，仍由原后端校验与 per-product guard 负责发布。

受控正向浏览器走完：读回挂起→按钮禁用→finally释放→按钮启用→一次发布写→实际 published=true 与原分类读回。另一个临时 Astro 构建只断开编辑器的 busy prop，同一 disabled 断言确实失败；源码哈希不变。组件 baseline8全绿，移除门禁与混淆读回/重试标签两项均7控制/1失败/0skip。初次根目录 JSX 配置错、临时 Astro absolute config 解析错均只算脚本错误；按实际 site配置和 Astro源码修正后再收有效证据。一次给定测试文件名不存在被 Node 忽略，随后显式 test -f 校验所有测试路径，最终 focused65 为真实四个文件测试，不能用之前8条单文件结果冒充。

最终 focused65 / broad2770 均0failed/0skip；site与根E2E类型、Biome4、新鲜standingSDK93通过。SDK-PROBE共15package/method pairs（13实际声明+2真实import facade）精确对照安装1.61.1与官方文档；未使用新文档1.62才有的signal。完整重新构建151 = 41 public + 90 shared + 11 formal + 8 admin + 1 taxonomy，全通过，PYTlr7临时库已删除。原样受控场景包括在完整151中，没有增加重试次数或放宽业务预期。P2d7运行源码除本单元三个明确UI文件外均哈希相同，所有失败现场保留于对应evidence目录。

P2d7 review 中已观察的这个 P2 在本单元关闭；整体仍未完成媒体写入与来源绑定封存、report producer/query/UI、持久意图/大媒体协议/恢复/历史修复、vendor/P95/Node20总构建和 test真实三件时钟及20件发布恢复。未push、应用部署、云商品写入、新建分支/worktree/agent。

写作实际复核 ProductClassificationEditor 的 pending/stage/inFlight/readBack/finally、BatchUpdateFeedback props/标签/原有调用方、CollectionView mutation与retryStarted、受控E2E route与Promise finally，以及组件和API测试。把“失败时可以立即重试”改成“读回结束后按钮启用，一次重试接受一次发布请求”；核对了真实旧UI失败、caller单独断开反例、实际服务写入次数、持久读回和隔离库清理。

## 2026-10-15 P2d8a：上传前永久目标检查点

继续原 checkout、原分支，基线 ed9eaf9。先用真实 JSON 文件数据库与本地字节存储复现导入提交 ACK 丢失导致 active 行指向已删文件、规范化 URL 绑定缺失、供应商 503 阻断已导入 URL 重试：1 个对照通过、3 个业务反例失败。原始复现保留为下一步导入状态机的验收，当前没有将它们记为已修好。

上传适配器新增等待持久化回调的 permanent-target 检查点；云端单次 mint 后按安装 SDK 的 raw PUT/header 协议写字节，空 HTTP200 才确认，默认总时限60秒。SDK类型收紧到实际 Buffer/fs.ReadStream；Uint8Array 转Buffer，普通流走受限 PUT。清理和激活协议后续接入，不凭上传基础层声称整条发布流程完成。

已执行：存储45项/0失败/0跳过，11次运行代码故障全部检出；SDK98检查及10次带干扰项的门禁故障全部检出；5个后端/存储类型检查、3个云函数构建通过。证据：`output/pricing-clock-repair-2026-10-13/p2d8/`，详见 [P2d8a](P2d8a_TRACKED_MEDIA_UPLOAD.zh-CN.md)。完整回归已完成2815项/0失败/0跳过，耗时119.48秒，日志为同目录 broad.log。

文字复核实际阅读：`P2d8a_TRACKED_MEDIA_UPLOAD.zh-CN.md`、本条实施记录、`SDK-PROBE.md` 新增段；把旧代码注释中“wx default structurally satisfies”和“multipart/form-data”更正为实际 node-sdk 注入与 raw PUT。对照安装包输入 guard、五个凭据头、官方200/空响应体契约和实际测试计数；删除“never leak”式无法由这一步支持的保证。属性筛选想法不进入当前实现。没有 push、部署或云端业务数据改动，没有新分支/worktree/agent。

P2d8a 独立审查：f4c0b94 的 SDK 发送方分母漏掉 Git 加引号的非 ASCII 文件名，独占临时 Unicode 发送方复现98项假通过，先将该提交标记 BLOCKED。修复采用 NUL 分隔路径；追加第10个门禁故障要求同一发送方明确失败。未修改上传运行代码，原45/2815测试、5类型和3函数构建结果仍对应同一运行代码；门禁本身重新执行。

## 2026-10-15 P2d8b：来源图片原子绑定与恢复

32b935a精确review已通过，接入上传检查点的实际caller。新增strict版本化URL归属/永久目标/回执命令，现有JSON mutation queue与native node-sdk transaction执行同一状态机；取代导入先字节后独立image/link写入及失败后盲删。校验和复用持原图片互斥并同值物理写图片行，防止快照读误作串行保证。失败记录不会覆盖并发成功，BUSY有明确重试状态；清理先退休再删，部分删除重启续接且只报告确认文件。

实际完整回归2887、Node20.19关键流程438，均0failed/skip；三函数构建、Node20打包/离线产物smoke、四后端类型通过。31运行缺陷在159正控baseline全部检出，3新增SDK连接缺陷各99正控/1业务失败；源码恢复hash一致。SDK inventory25对与SDK-PROBE逐cell join无遗漏。完整重新构建浏览器151通过；含本地20件分类发布/BUSY恢复/引用数恢复，owned N6f0Ek目录独立确认不存在，19文件冻结hash匹配。这是本地样本，不是云test真实选品验收。详情和边界见P2d8b_SOURCE_MEDIA_IMPORT.zh-CN.md。

复现更正：原测试误认shared规范化会去fragment；真实helper保留fragment。更正字面期望后回退旧导入实现再跑，取得1控制/3真实业务失败；旧有错误oracle不作为根因证据。初版mock写集合漏记、root Zod解析失败和shell只读status赋值仅算工具错误，最终有效探针另留完整结果。

文字实际复核source-media-import schema/claim/checkpoint/activate/reuse/fail/retire、native bridge与JSON queue、importCandidateImage、copiedState失败记录、cleanupSourceMediaImage和后台两lane、源测试及本单元SDK/实施文档。将“注册成功表示文件健康”改为“注册绑定可复用，文件健康须后续独立验证”；将“清理失败就没有删文件”改为“只逐项报告确认删除，未知结果保留intent继续”。核对永久目标逐字保留、旧任务nonce、真实本地PNG、部分删除回执及0skip/恢复hash。没有将metadata mock冒充云存储证明。

其余MIU继续，不新增筛选属性/存储分支/worktree/agent，不push或部署。真实clock resync/load、保留现有分类的20件Assign category→Save and publish和恢复仍未完成。

## 2026-10-15 P4a1：普通上传完成与过期清理

0c01a98精确review通过后，先用真实本地数据库/字节/后台请求取得1控制/5失败，修旧completeUpload和cleanup各自读写的竞争。现有图片mutex先持有、后下载；原子完成校验用户、身份、目标/输入指纹及当前owner，active与严格回执一并提交。成功重试不重新下载；暂不可读保留pending，坏字节原子failed并保留目标，不执行不可靠补偿删。过期清理先terminal intent再删，所有deleted进入恢复lane，当前active/未过期/来源归属/非零引用仍由写入守卫拒绝。

最终3298全量/250文件（本轮扩大消费者范围）、483Node20组合均0failed/skip；三函数构建/Node20产物加载及四实际类型通过。83baseline，24运行故障检出；SDK103检查，3接线故障及1wire null形状负控各102正常/1失败；SDK28pair已精确join，最终完整构建浏览器151通过，juwvaC隔离目录独立确认已清理。旧active直传无回执的兼容重试已补齐，首次真实读回后追加回执；引用数0/2保持，坏字节保留active并明确替换入口，损坏新回执不能退回旧模式。

实际修正了return reject Promise导致finally提前释放锁；初次故障注入被本地queue掩盖，75全绿不记检出，补写入开始前受控延迟后同缺陷确实失败。completion变量漏声明和Biome格式提示不算runtime证据。旧字节上限用例只模拟低维尺寸提示，改为真实超过10MiB字节；新增低报提示场景确认以真实字节为准。

文字实际复核image-upload、ImageDeletion orphan命令/runner、两adapter工厂、finalizeCatalogImageUpload、cleanupOrphanUploadImage、后台两入口、实际native/cloud测试及SDK/doc。把“浏览器multipart POST”改为“raw PUT”；把“失败就补偿删”改为“失败保留精确目标，经持久终态清理”；把“active回执证明现在COS健康”保留为尚不能成立的结论。核对身份、真实尺寸、未知ACK、源文件恢复和旧读端兼容边界。其余MIU继续；没有push、部署、云业务写入或新分支/worktree/agent。

独立review先红1控制/1失败：放宽旧v1上传者会误接纳损坏旧intent，改为严格image-deletion-ownerless-v1专用版本，原v1不放宽。另旧active兼容先红1控制/2失败后修复。新增never SDK类型与真实SDK set序列化互证，根/嵌套undefined均省略，异常null负控失败。FakeRequest少data封套只算探针错误，按实际document.set转换源码修正。类型检查拦住非法顶层MEDIA_NOT_READY及测试可空row，修正为既有VALIDATION_ERROR与明确非空断言；终止自有链，重新全量3298/95.79秒、Node20483、构建与最终浏览器151通过，juwvaC已清理。15文件hash匹配。

## 2026-10-15 P2d9a：存储字节只读取证与检查

三件时钟57张实际云存储图片共14,124,824字节，fileId/长度/SHA全部匹配；本机sharp0.34.5严格像素解码57通过，前后图片内容元数据无变化，无云端写入。新readStoredCatalogImageBytes只读校验实际字节并核对目标读回，63行为测试、14运行故障均验证；全量251文件3361项/0fail/0skip，89.94秒，admin类型及两文件Biome、SDK103通过；Node20关键91/0fail/0skip，三函数构建及Node20裸目录离线产物smoke通过，新模块尚未由生产handler引用。类型与故障脚本计数错误不算业务检出。尚未接入服务端封印、列表或发布，下载仍须补硬截止/流式上限；不把字节签名当像素证明、不把Mac解码当Linux部署证明。详见[P2d9a](P2d9a_STORED_IMAGE_BYTES.zh-CN.md)。没有部署、现场resync/发布/分类修改、新分支/worktree/agent。

文字实际复核P2d9a、新模块与测试、SDK-PROBE和本条，把“图片健康已验证”改为具体字节与本机像素观察，核对57/63/14/3361分母和零云写入。其余MIU继续。

## 2026-10-15 P2d9b：有界读取与真实SDK负控

本地139项小流程组合、23实际运行缺陷、SDK106及4门禁缺陷完成；15对SDK清单先持久化再逐行匹配，包含实际TypeScript5.9.3调用和node-sdk3.17.2契约。修复了真实HTTP已完成socket的NativeSignal异常、CJS/ESM两份Error类识别、可变options放大限制，并单独验证流式超限拒绝写入前不释放锁。单独加signal仍有显式关闭保护的绿变体未算检出；恢复旧单独取消路径后确实失败。详见[P2d9b](P2d9b_BOUNDED_MEDIA_READ.zh-CN.md)。

真实云端只读探针：三件时钟各一图原fileId/长度/SHA匹配，Linux x64/Node20.19.3/glibc2.28/256MB，226–344ms。1字节cap明确too-large；1ms期限在2ms触发，SDK元数据145ms内结束，HTTP GET仍为0。错误口令拒绝。临时函数先后两轮均删除并读回确认不存在，仍只剩原三个应用函数；三路health保持fdf39d9。没有业务数据、分类、发布、来源或图片写入，也未部署应用；函数资源创建/删除不算“云端0变更”。

最终文案/注释后全量253文件3415/0fail/0skip，101.70秒；Node20关键184、五后端类型通过。23运行/4SDK故障重新全跑并恢复，与全量12文件hash一致。三函数产物和浏览器151将在精确提交review中重建。源码12文件的hash与日志绑定；当前仍未完成健康封印/列表/统一发布及实际客户3+20验收。

文字实际复核12个源码/测试/门禁文件、新文档与SDK-PROBE、本条记录。将“云端0变更”改为“临时函数创建删除，业务0写入、应用未部署”，将“10MiB内存上限”改为“接纳字节上限”，把用户提示中的completeUpload/PUT改为稍等后重试上传。核对139/23/106/4/15分母、真实返回字段和两轮清理。其余MIU继续；没有push、新分支/worktree/agent。


## 2026-10-15 P2d9c：像素、动画和原生运行时

独立像素检查覆盖正常与损坏JPEG/PNG/GIF/WebP、APNG后续帧、海报/局部帧/调色板，以及截止后的原生调用保护。34行为、17实际源码缺陷、Node20组合173、254文件3449全量/98.46秒、SDK106、类型和4文件Biome通过，最终17文件hash恢复一致。真实Linux/Node20.19.3/256MB探针18项通过；三件时钟各一张实际图片长度/SHA匹配，1ms人工预算的4MB PNG在490ms返回timeout且原生调用0，不当成1ms硬截止。

部署取证修正父目录与函数同名误识别，确认MCP Event强制在线安装过滤根node_modules，普通ignore和删除package.json均不能关闭。标准Node imports与vendor依赖布局已在独立探针跑通；应用打包/准入尚未接线。7条失败记录、4轮有效临时函数及小包对照已删除，两个自有临时代码对象前缀为空，业务写入0、应用部署0。详情及失败记录见[P2d9c](P2d9c_PIXEL_DECODE.zh-CN.md)。

文字实际复核两个像素模块、34测试、package/lockfile、vendor包、官方MCP和manager源码、SDK清单及本文，区分预算/同步CPU、临时资源/业务写入、字节/像素/当前版本授权。最大合法图片及并发资源不冒充已验证；没有实现未来属性筛选或业务存储拆分。


## 2026-10-15 P2d9c1：review修复合法空APNG数据误拒

精确review48d062c发现PNG3允许fdAT的frame_data为空，原length<5误拒；37项红测36正控/1失败，改为<4后37通过，整帧无像素及不足4字节仍安全拒绝。首轮未获blessing，修订后再review。3452全量/80.45秒、Node20组合176、18源码缺陷、17冻结文件hash、类型及Biome通过；真实Linux同默认加载器21项通过，临时函数删除/读回完成，累计5轮有效临时创建+7失败记录及独立小包对照均清理。57张实际时钟冻结副本由当前默认模块回放全部通过，字节/SHA一致，非新云快照。

文字实际核对PNG3空数据条款、<4范围守卫、三个新增正反例、故障统计、修订全量与云端结果、清理清单和本文；将首轮候选的最终结果标为首轮，保留修订证据区分。应用vendor打包与健康版本保护继续，fullDeliveryReady=false；无业务写入、应用部署、新分支/worktree/agent。


## 2026-10-15 P2d9c2：review修复APNG控制块顺序

第二轮review发现额外acTL/fcTL顺序限制会误拒合法图片，40项红测39正控/1失败；最小修改后40通过，缺失/晚到acTL负控保持拒绝。最终3455全量、179Node20组合、19实际源码缺陷及17文件hash、类型/Biome、CloudBase SDK106通过。10对Sharp调用实际有12种签名，415处调用零无法解析，已保存完整重载清单。真实Linux默认加载器24例通过，3张时钟实际图片长度/SHA匹配；临时函数第6轮删除并读回确认，业务写入0、应用部署0。具体证据见P2d9c2和pixel-revision2-*。

实际复核两个模块、40测试、PNG标准、SDK签名、全量/故障/云结果与本文；将单方法签名改为逐一使用重载，保留前两次BLOCK记录，独立模块通过不能代替应用打包、健康封印或发布验收。其余MIU继续。


## 2026-10-15 P2d9d：函数原生解码器打包与执行门禁

新增按真实导入打包的vendor依赖闭包、固定版本及逐文件校验；三函数tsup保留私有导入，既有自动产物门禁真正解码四种格式。frozen安装准备Linux原生包，lockfile不变；默认Linux126文件20,301,236字节，与独立归档原生字节一致。23小流程（含三配置与像素默认加载）、Node20组合23、485部署脚本和7种真实源码缺陷均通过对应验证，零跳过/取消；8源码hash恢复一致。旧产物移开后23仍通过，测试自产临时public-api。SDK13对声明/运行时核对、Biome7/SDK106通过。新打包模块生成的真实Linux探针24例通过，原有3实际时钟样本字节/SHA一致，第7轮有效临时函数删除并读回确认；业务写入0、应用部署0。

实际文字复核8代码/配置文件、新文档、SDK记录与本条，将Linux检查与本机ABI对照分开，保留初始测试依赖旧产物及漏导入的失败记录。正式handler尚未消费像素模块，下一步验证原生资源预算并接入存储健康；不等同现场修复或完整交付。见P2d9d及pixel-pack-*。


## 2026-10-16 P2d9e：实际字节、像素和当前记录联合检查

新增只读health接口，共用一次对象读取、一次base64解码和前后两次记录读取，像素完成后才核对目标、锁及计数。新增31/小流程135、255文件3486项/97.09秒、Node20组合210、五后台类型、Biome4/SDK106通过；12源码缺陷检出且97–134正控保留、零跳过/取消，19冻结hash恢复一致。修复测试开始信号挂起及手抄JPEG常量差异，不把这两次失败计为产品验证通过。

资源实测保留反例：256MiB四张最大画布两张timeout，原两张串行仍timeout；相同默认代码改到512MiB后两张串行及四张不同图并发均通过并逐件SHA匹配，分别1353/2091ms，非P95。正式worker只读确认512MiB/900s；本轮只改自有探针资源，没有改正式函数配置。后台准备必须使用对应预算和恢复机制，不能把256MiB交互函数或单纯限流写成已经可靠。

真实默认DB/存储/像素路径三件时钟各一图通过，182946/194482/161224字节与SHA匹配，当前记录读回一致；无冻结记录或内容注入。第12轮有效临时实例删除并读回确认，只剩原3应用函数，业务写入0、应用部署0。25继承SDK/编译对完整匹配，无新SDK方法/shim。实际文字复核4代码/配置、新测试、DB只读链、资源/清理及本文；将read evidence与ready封印分开，来源/商品/存储版本准入仍未接线。详见P2d9e和image-health-*/pixel-budget-*；其余MIU继续。


## 2026-10-16 P2d9e1：review修复失败字段透传

812649b保留BLOCK：两条反例证明typed decoder的额外私有诊断会随invalid/retry透传。失败输出改为status/reason白名单，137组合（含33健康）通过；13源码缺陷检出，99–136正控保留、零跳过/取消。修订全量3488/81.68秒、Node20组合212及19源码hash通过。原3486/210/12不覆盖或重算。

真实默认路径57张时钟图片当前记录、对象和像素全部通过，14,124,824字节及逐件SHA与manifest一致，服务内23,596ms/约101.6MiB；非发布P95。实际产物SHA/4调用源码hash匹配。第13轮有效临时函数删除并读回确认，业务写入0、应用部署0。文字实际复核白名单、2反例、13故障、修订回归和57实际记录，保持当前证据/准备封印/发布验收边界；其余MIU继续。

### P2f1 服务调用与当前租约能力

增加server-only catalog-preparation-authority子入口。独立环境/用途HMAC、30秒严格准入与5秒skew、WeakMap不可JSON复制能力、当前120秒租约与owner/version/nonce/输入/generation绑定；仅准备媒体和报告存储，无发布/审批/分类权限。66模块、165组合、Node20关键133、9真实故障检出/源码恢复，DB类型、Biome、CloudBase门禁通过。实际复核模块、测试、package出口、现有store/inspection，明确准入不代替DB原子领取，准备模块尚无正式consumer。业务写入/应用部署0；fullDeliveryReady=false，接着实现任务仓库和实际producer。

### P2f2 持久任务、适配器与租约时序

增加私有确定性preparation job、当前admin创建/查询/取消/显式retry、私有dispatch和服务claim/renew/release；接入DB facade、CloudBase事务及JsonFileAdapter共享锁/原子文件。nonce轮换、单调leaseVersion、当前输入复核、前后双租约校验；不修改分类、published或批准内容。

review红测修复排队/重试前取旧时间和输入读取期间租约到期。113组合、Node20关键179、12源码故障/正控≥91/3hash恢复，四后台types、显式新文件Biome、CloudBase门禁通过；第一轮广泛1127，最终重跑另存broad-final待读回。实际复核新增state machine、facade、两适配器、对应测试和官方/安装SDK返回值，纠正文档示例包装形状与runtime直接返回的差异；不声称本地wrapper测试是云实测。云授权已失效，未重新申请或操作云资源；本地实现继续。fullDeliveryReady=false；下步接实际producer、媒体receipt和准备写回。

P2f2最终重跑已读回：DB792+local-server339=1131，0失败/跳过/取消（1.99秒/72.55秒）。事务/字段/权限/跨文件review继续检查同一修订，不把旧1127重记为新增验收。

P2f2a：eaceace2精确review BLOCK发现私有任务集合未声明；补ADMINONLY部署资源与红测，集合总数31→32。486部署脚本、2真实配置故障检出/恢复通过。原eaceace2构建/Node20裸启动通过仍不授予部署；修订后重建并精确review。源/媒体receipt producer、列表与全流程继续，fullDeliveryReady=false。

### P2f3 租约候选读取

抽取既有preview/inspection只读核心，原HTTP人类入口仍前后核对真实admin身份；新增后端job bridge通过当前租约renew取得productId，无假管理员行。私有candidate返回全量imageIds，原人类inspection保持旧输出。76组合、Node20关键183、11真实故障/正控≥71/3源码恢复通过；真实本地source/manual无admin账号、105图片、伪造/过期/取消/途中编辑取消覆盖。review的privateTrace透传反例先红后以ok/code投影修复。广泛回归与类型/SDK在读回；不把metadata ready称作像素封印或发布许可。属性筛选不扩展、分类不修改、fullDeliveryReady=false；下一步接可信像素receipt/producer。

P2f3广泛回归已完成：admin535+local-server349=884，零失败/跳过/取消；四后台types、6文件Biome、CloudBase门禁通过。原HTTP人类入口复用同一core、服务入口仍仅backend导出；不把这一读取单元当作完整worker。

### P2f4 持久图片观察与真实小流程

新增私有catalogImageObservations/get-image-check/put-image-check，绑定当前lease、job nonce、产品输入和图片记录digest；verified核对imageId/SHA/字节数，invalid/retry白名单诊断，目标变化/旧任务/坏锁计数闭合。公共byte reader的纯metadata hash/shape移到DB子入口保持原合约。技术job独立mutationRevision确保同毫秒也有真实写变化，不撤销当前lease。未发布协议所有新job初始化0，溢出拒绝。

真实本地普通upload完成→默认存储/原生像素→观察持久化→释放/重开/新worker恢复通过；丢ACK和文件失败回滚覆盖。276组合、Node20加最终源预算343、14源码故障/正控≥273/3源码恢复；2资源故障19/17正控；广泛最终1711、487deploy、四types、9文件Biome、CloudBase106通过。新集合ADMINONLY、总数33，现场未创建。源码snapshot之后的image/blob变化仍可能发生，观察不签发ready；实际worker/目标保护/最终封印与后续全流程继续。实际文字复核纠正观察与发布许可混用，fullDeliveryReady=false。

### P2f5a 来源媒体批量读取

完整来源计划按最多100个确定性_id批次查询，并核对_id/provider/sourceUrl；单图helper保留点读。显式_id排序，忽略跨请求count/get差异。86组合、Node20含真实审批成本/公开读回/恢复96、8实际源码故障/41–85正控通过；广泛admin545+local352=897，0失败/跳过/取消，类型/Biome5/SDK106通过。第一轮旧106点读成本断言失败，改为2批0点读后先单独10项再全套重跑。修正组合测试相对路径；故障只移除HTTP赋值被上游规范化保护，未计检出，绕过完整规范化才是有效反例。实际复核source、fixture、inspection、真实审批成本与两adapter查询，文字明确“批次不等于单RPC”。worker、封印和完整交付继续，fullDeliveryReady=false。

### P2f5 持久媒体断点

同一技术job绑定全量媒体计划，观察与cursor/count/最后一步回执原子提交。重复相同一步返回原回执，不同数据/跳步拒绝；普通resume保留断点，queued已有计划可由当前admin显式retry轮换nonce并清空。human只看数量，不返回私有receipt/nonce/存储目标。扫描结束仍不写ready。

161组合+24真实文件=185及Node20、9实际源码故障/167–184正控/2源码恢复、广泛DB848+local355=1203、四types/4显式Biome/SDK106通过。Cloudwrapper源任务9操作，4种第二写失败回滚；默认文件/原生像素流程重开继续、丢ACK、重复并发、落盘失败覆盖。fixture无变化误作损坏与private persist类型访问均修正后重跑。实际文字复核job、schema、SDKwrapper、真实adapter/测试，明确checked不是verified；worker/目标保护/封印/业务交付继续，fullDeliveryReady=false。

### P2f6 有界默认媒体worker和实际入口

原fn-alibaba新增严格签名Event分支，先于timer；当前lease读取全量source/manual计划，private defer不扫未处理图片，human保留metadata检查。每步串行最多4图、20秒软预算，默认存储/原生像素观察与cursor同事务，最后复核完整采用计划，所有退出尝试release且失败不能假报成功。领取异常投影、source照片末步替换红测修复；最后release前取消仍拒绝。checked不是ready。

120组合/Node20（worker19真实默认流程与main/105配置/坏像素/重试）、10源码故障在118项上检出/114–117正控/3源码恢复；广泛admin546+alibaba303+local374=1223、四types/SDK106/9显式Biome通过。相对路径38组合漏admin已用root明确文件重跑；incomplete测试期待与exactOptional字段修复。workspace importer只增link:../admin，frozen offline安装通过，第三方版本未变。Linux126文件包完整性与Mac同JS/native Node20 profile通过，wip版本不算提交产物；云端完整已打包worker与最终目标封印待验。实际复核上述代码和测试，措辞保留软预算/历史扫描边界，fullDeliveryReady=false。

### P2f7a 受控媒体目标与上传凭证边界

backend catalog-sealed逻辑namespace映射catalog/sealed/imagehash/contenthash/attempthash.ext；浏览器broker拒绝reserved及escaped/traversal别名后才mint，服务器private minter保留既有PUT/rawheaders合约。两adapter要求beforeWrite回调并等待；是否真落库后续producer验证，namespace/callback自身不发ready。无真实图片迁移或业务状态变化。

55+1交付小流程/完整media157/Node20关键178、8源码故障检出/44–55正控/3文件恢复、广泛admin546+public131+local375=1052、五types+新增delivery类型/Biome8/SDK106通过。实际privatepreview→public404→fixture正引用字节→恢复0再404，非商品发布验收。SDK mapper移动前后AST完全一致、1/1 probe行；重读并保留官方node/storage OpenAPI，未混用shape。实际复核8代码/测试及admin/public交付与shared只读字段，纠正checkpoint持久性措辞、撤销无关header移动。保护attempt/CAS/最终封印与全流程继续，fullDeliveryReady=false。


### P2f7b 持久图片复制登记与目标切换

在既有私有观察集合增加独立kind/目的hash的登记协议，复用图片互斥锁和技术任务事务。当前租约reserve、beforeWrite checkpoint、真实目标health commit；共享图片复用attempt，取消/过期后按旧owner证据恢复，cleanup能力只能清理自己一版锁。保留旧对象，不改商品/分类/发布；marker不是ready。

跨流程红测发现来源activate ACK和普通上传finalize ACK在物理地址切换后都会冲突，现按私有已提交登记核对原始目标，并仅对同一上传者/意图/内容更新完成回执。名字可编辑；异图/异上传者/异SHA拒绝。实际双文件适配器竞争只有一个成功，另一个BUSY；故障测试恢复后重跑本地套件。

40组合、313Node20及新增竞争所在文件12项通过；9种源码故障和新增竞争的BUSY故障均检出/恢复。Cloud wrapper各阶段最大10/9/10读写，8种后续写失败/ACK异常全部回滚。真实文件默认读写/原生像素覆盖checkpoint前后、中断、落盘失败、丢确认、重开和重复完成；SDK106、六types及13显式Biome通过。大旧测试仅格式化新增块。扩大套件和精确构建结果在完成后附记，不把正在运行的检查记为通过。

实际文字复核保护模块/合约/测试、authority/jobs/source-import/upload-receipt/shared-path及两适配器测试、SDK记录与本条；把“保护完成”改为“图片目标切换”，不暗示已封印商品。测试字段删除及process.env恢复改用Reflect.deleteProperty，修正unsafe格式化产生的undefined语义。云端业务写入/应用部署0，fullDeliveryReady=false；继续接入默认worker复制及最终准备。

P2f7b扩大最终：shared288+media157+db886+admin546+alibaba303+local381=2561，全部通过、0跳过/取消。local最终在新增实际竞争和所有故障恢复后重跑，73.0秒；之前380项不是最终数。六types通过，新增竞争后local类型和Node20文件12项再次通过。


### P2f7c 默认worker实际图片复制与恢复

接入P2f7b：当前租约和原图锁登记→默认有界原图字节读取→beforeWrite登记永久目标→真实目标原生像素读回→当前输入/租约原子切指针→普通默认health读回→精确锁清理。保护后重复不再PUT，targeted恢复先读已登记对象；断点写入新目标摘要。保留原对象，不改商品/分类/发布，不签发ready。

review红测修复begin已落盘但丢确认后遗漏清理、目标传输失败误归为原图损坏。后者现在返回可重试，原图相同SHA字节的真实像素失败仍invalid/content。14项后补checkpoint丢ACK和原图坏SHA，最终35小流程/10源码故障全部检出并恢复，正控≥22/35，零跳过/取消。105计划只读已处理4图，facade点读28/来源批次2，九图跨三个worker步骤/重开保持完整。类型错误以局部摘要和明确状态对象修正，没有压制类型；集合混存按kind取观察。

实际复核helper/worker及两测试、新文档/SDK记录，措辞将“目标错误等于原图损坏”改为“目标传输异常可重试”。首次3对象读取/2解码、已保护1次健康检查；20秒是软预算，现有PUT60秒，性能P95和完整Linux云worker仍待后续门槛。扩大套件/当前三types/显式Biome/SDK/Node20及精确构建结果完成后另记。fullDeliveryReady=false，继续来源媒体producer/当前封印及业务全流程。

P2f7c最终当前证据：admin546+public131+alibaba303+local397=1377全部通过，0失败/跳过/取消；Node20组合330、三消费者types、4文件Biome、SDK106通过。目标失败归属修正后的最终故障10项，正控22–34/35；源码恢复SHA5f2819d8e1a2970545eb11e68c18dbe62ce1defd4c30ee811881f18a9f3ae31e。原33/9及修正前330保留为历史，不当最终结果。


### P2f8 受控图片像素回执复用

独立pixel policy/imageId/target digest的私有verified回执，绑定当前marker和完整committed登记；未保护/错图/旧策略/坏字段/目标变化/有锁均不复用。写在既有观察/cursor事务，已相同健康不重复写共享回执；默认producer只对已受控目标尝试复用。实际共享第二商品零对象读/零PUT，旧策略真实重查1次/不再复制；缓存运输异常退回默认读图，观察提交仍复核当前lease/商品输入。

176组合、11源码故障/158–175正控/3源码恢复、Cloudwrapper12操作及4种第三写失败整体回滚、4types通过。Node20组合358与补全部handler后的584通过。扩大首次DB909+admin546+public131+alibaba303+local402=2291零失败/跳过/取消；后补两个响应字段检查的最终admin、Biome/SDK日志待读回，不提前记通过。

review红测修复缓存异常引起不必要retry，以及新保护标记/尝试ID进入普通图片响应；严格CRUD原本已拒绝改写，名字编辑仍保留marker。新增响应剔除fault被226handler测试检出并恢复。实际复核cache/jobs/producer/handler及DB、Cloudwrapper、真实文件/native/human响应测试；将“读取即许可”收窄为“像素快照，最终提交另验”。SDK新predicate refine用官方v3+安装3.25.76精确TypeScript签名，首轮探针误匹配外层调用、包版本查错根目录均保留失败，修正精确callee/依赖包归属后15调用/11方法与实际overload通过。默认Linux云权限、完整封印、来源producer、列表/操作/UI/repair/性能/test现场单件20件发布恢复继续，fullDeliveryReady=false。

P2f8最终补验：admin548零失败/跳过/取消；替换此前546后扩大总数2293。4types、8完整显式Biome文件及SDK106通过，Node20最终584。大cloudbase-adapter.test.ts仅格式化新增块；SDK精确callee15调用/11方法/指定predicate overload已验证。


### P2f9a 当前服务租约保护的来源媒体仓库

复用SourceMediaImport，当前opaque lease/商品输入下执行claim/checkpoint/activate/reuse/fail/note-failure，子写入和最后同job fence前复核；途中到期抛错回滚整个事务。覆盖内部now为服务事务时间，retire明确禁止。JSON copy事务补实际remove，仅用于尚无字节的自有pending去重占位，不物理删对象/不改商品或发布。

164=56协议+104Cloudwrapper+4实际JSON，9源码故障/158–163正控/2源码恢复通过。source-backed10/去重12读写，8写ACK/3删ACK失败全回滚，实际第一子写/最后删除后到期均回滚。文件落盘失败/重开/真实去重删除及双租约URL竞争通过。fake.remove原只ACK不删除Map、spread复制liveclock和retire正控缺锁三个夹具问题已校正，并保留失败记录；不冒称生产bug。实际元数据样本不代替网络复制/像素/真实发布。

实际复核jobs、JSON、既有来源状态机/Cloudrowstore与测试、真实安装database1.4.3 remove方法3响应以及官方事务原文。文案“来源图已可用”收窄为“元数据激活，像素另验”；网络producer、最终封印/其余全流程继续。扩大/类型/SDK/Node20最终日志在读回，fullDeliveryReady=false。

P2f9a最终：DB933+admin548+public131+alibaba303+local406=2321全部通过，0失败/跳过/取消；Node20组合612、四types、3完整显式Biome、SDK106通过。JSON只格式化当前manageCatalogPreparationJob方法、Cloud旧大文件仅新增块/改动控制项，不冒称整文件formatter通过。实际安装SDK remove方法3响应及源码/声明核对通过。


### P2f9b1 已完成来源绑定的残留锁恢复

严格完成回执绑定active URL/image和同一operation owner，claim/合法确认重放可补做清理；note-failure、错误参数、其他owner、坏/缺receipt不清锁。只改两个锁字段，不动updatedAt/目标/引用数/商品。27纯协议先红后绿；最终Node20六文件212全部通过，DB/local types、3完整Biome与diff检查通过。Cloud写ACK四形态/实际写后租约到期回滚；真实PNG导入去重、持续释放失败、文件重开、零额外网络/PUT、迟到释放已验证。测试中boolean假设已按现有字符串协议纠正后重跑。复核实现/Source lease wrapper/现有release/Cloud与JSON/importer，文案将“READY已可发布”改为“仅来源绑定完成”。没有新增SDK接口，构建和完整业务流程仍待后续集成。fullDeliveryReady=false。


### P2f9b 来源网络producer接入实际worker

复用既有SSRF安全importer，仅注入当前opaque lease的来源持久接口，限定采用URL且不允许retire；人类响应不暴露私有sourcePhotos。未绑定配置照片先完成，每阶段最多4个/20秒软预算，再重读完整候选绑定像素计划。新去重绑定与清锁同事务，历史残留按采用URL/owner严格恢复后续查像素；不改商品/分类/发布。

最终Node20九文件298项，扩大DB948+admin549+public131+alibaba304+local418=2350项全部通过，0失败/跳过/取消。四types/SDK通过，7源码故障全检出123–132正控/133，原字节恢复。真实本地五URL跨步/重开/一来源PUT+保护复制/像素、503/404、取消前后、下载期间编辑、activation ACK丢失、错URL/retire、人工选图和105配置均覆盖。夹具dispatch旧闭包、取消缺leaseVersion、candidate投影预期和exactOptionalPropertyTypes错误修正后重新跑，不冒称产品bug。实际review生产和测试文件；“20秒限制”改为“软预算，现有网络deadline可能跨越”。精确构建/产物随后记，业务全流程仍未完成。

## P2f9c1：检查期间保留配置图

P2f9b 提交后精确函数产物已构建/打包并验证：Linux-x64 sharp0.35.5/126文件，显式Mac同JS profile在Node20冷启动、真实像素和bundled signed main五来源URL流程通过；4+1步仅一来源PUT+一保护PUT，warm零字节读取/网络/PUT，商品未变，隔离对象清理成功。仅本地受控DNS/fetch/LocalDisk，不计云端验收。

P2f9c1 关闭来源配置图在检查后被删除的前置竞态。当前租约先写私有占用，删除持图锁先查占用；取消或输入失效自然释放。实际两删除入口、磁盘字节、反向交错、八个写ACK故障和部分写后过期回滚已覆盖。2391项扩大回归、Node20组合492、4消费者types、11文件Biome、SDK gate通过；5个源码反例均检出并恢复。详见 P2f9c1_IMAGE_HOLDS.zh-CN.md。此单元不写ready、不发布；fullDeliveryReady=false。

## P2f9c2：逐张媒体核对摘要

基于P2f9c1占用和既有保护回执实现bind-media-seal/attest-media-image。每命令一张、完整输入/租约/当前目标/占用/像素policy核对，常量大小的有序摘要；不再读取字节，不改商品/图片/计数。真实105张配置图完整检查和逐命令核对、本地重开、实际ACK丢失与恢复、故障/旧policy/计数编辑均测试。2427项扩大回归、Node20组合279、4types、5完整文件Biome、SDK gate通过；8个源码反例全检出并恢复；source-backed核对事务10操作。详见P2f9c2_MEDIA_ATTESTATION.zh-CN.md。尚未写ready或上线，fullDeliveryReady=false。

## P2f9c3：原子就绪记录

v2 ready 需显式媒体凭据；原私有快照入口双层拒绝 ready。新 finish-preparation 以当前 opaque lease、完整 cursor/attestation 和全候选根，在 7 次 source-backed 点读写事务中核对当前 product/source/observation/link，同时保存 report 与 completed job；保留用户业务字段。原 grant 支持精确丢 ACK 的只读确认，写后到期抛错回滚。

211 份初始合约检查、修正夹具后 239 份集成检查通过；真实 3 图和 105 配置图均走到最终 ready，未分类/未发布保留。8 个源码反例全检出，172–218/219 正控，原字节恢复。首次夹具、类型与 formatter 失败记录完整保留，详见 P2f9c3_READY_COMMIT.zh-CN.md。扩大/最终静态与构建证据随后追加；worker 接入及后续列表/操作/UI/repair/性能/test 现场验收继续，fullDeliveryReady=false。

P2f9c3 最终本地：DB1045/shared290/admin549/public131/alibaba304/local438，共2757项全部通过，0失败/跳过/取消；Node20八文件组合420通过。四消费者types、13文件显式Biome、Cloud新增块格式、SDK gate、diff检查通过。source-backed原子提交7次读写、两写ACK各4形态与两次写后到期回滚均验证。完整 MIU inline review 未留本单元引入的P1/P2；默认worker接入与全业务验收仍待继续。

## P2f9c4：默认准备 worker 完整就绪

P2f9c3 精确提交三函数 build/package、Linux126文件完整性、同JS显式Mac profile与Node20产物/原生像素smoke均通过。默认worker接入当前 attestation/final；媒体子流程显式命名并共用租约执行器，签名main只走完整流程。每步最多4次核对，复用受控像素；完整候选再读后原子完成，最终丢ACK原grant确认，completed不再次release。

60项阶段/默认小流程组合已通过。真实9图跨步/重开/无额外GET或PUT、105配置图53步、取消/编辑/来源绑定变化、明确retry与两个阶段ACK丢失均覆盖。7源码反例在选定13测试上全检出，1–12正控/1–12失败，源码恢复；完整扩大回归、最终types/Node20/构建随后记录。详见P2f9c4_READY_WORKER.zh-CN.md。人类恢复/状态快照/准入/其余组合与test现场仍需继续，fullDeliveryReady=false。

P2f9c4 最终本地：admin549/alibaba304/local450，共1303项零失败/跳过/取消；源码恢复后的Node20三文件95、三消费者types、两文件Biome、SDK gate、diff检查通过。加强实际main的report/job读回后，七个反例全部重跑检出并恢复。复核active来源URL不能重定向，retire只接受pending/failed；catalogSourceLinks的adminAccess为none。最终事务不逐张读媒体，依赖已核对占用及应用受控目标/绑定；外部直接改库或对象字节不当作已验证路径。精确提交的构建与bundled main链路随后追加。

## P2f9c5：已完成任务只读恢复

P2f9c4精确提交三函数产物与实际bundled main通过：五URL跨4+1导入、一来源PUT+一保护PUT，当前ready/completed读回；第二商品共享图零额外IO也ready，未发布保留，隔离对象清理完成。bundle SHA c3fbb44e768b6756700d4e96679e6963519bbe994204d9f6b0f2d099acb076d1，仅受控本地网络/真实磁盘/native，非test现场。

新claim在完成任务上验证有效签名同nonce、当前输入与完整服务凭据，只读返回原ready；重启无需原WeakMap，五次source-backed点读，无租约/计数/商品/文件变更。即时丢ACK与重启共用报告检查。初始245项串联通过；补独立报告时间和禁止bindLease断言，8源码反例全部检出，21–30正控/31，字节恢复。完整扩大、最终types/Node20/SDK和精确产物随后记录。人类过期恢复与余下准入/UI/修复/现场验收继续，fullDeliveryReady=false。

P2f9c5 最终本地：DB1064/admin549/alibaba304/local452，共2369项全部通过，0失败/跳过/取消；Node20四文件288、四消费者types、五文件显式Biome、Cloud新增块格式、SDK gate、diff检查通过。反例恢复后完成扩大验证；无线上资源/业务写入。精确提交及模块重启的bundled main验证随后记。

## P2f10a：当前非就绪快照合约

P2f9c5 精确三函数 build/package、Linux126依赖完整性、同JS显式Macprofile与Node20产物smoke通过。bundled main冷模块/authority重建后，同一有效签名请求零IO、零改盘恢复原ready。初次重载夹具未重新注入local adapter误走默认云SDK，修正注入后同产物通过；失败夹具按时刻/假商品ID/五测试URL/本地存储确认后清理。bundle SHA e98c0fa377b2e013f380d4aecc2355abad53417009fa71cfa181e2244cb06500，不冒称云端验证。

checkpoint-preparation 当前服务lease下派生安全blocked/preparing报告并同job写fence，七次source-backed点读写；保留业务字段/公开版本。首轮244项、补两分支后选定48正控均通过，八源码反例均检出且41–47正控保留，原字节恢复。初次类型check因ES2023数组方法不在项目ES2022而失败，已改有界倒序循环；最终类型/扩大回归/Node20/SDK/产物随后记录。默认producer接线及后续状态/准入/UI/真实验收继续，fullDeliveryReady=false。

P2f10a 最终本地：DB1098/admin549/alibaba304/local454，共2405项全部通过，0失败/跳过/取消；Node20五文件324、四消费者types、四完整文件显式Biome、Cloud新增块格式、SDK gate、diff检查通过。八反例在48项中检出且41–47正控保留。精确构建随后记；默认worker接线及其完整非就绪状态流程仍待下一单元。

## P2f10b：默认流程诊断与取消

P2f10a 精确三函数 build/package、Linux126依赖完整性、同JS显式Macprofile与Node20产物smoke已通过。当前单元接入默认 worker 的来源/像素/确认阶段非就绪快照，并让取消原子撤销仍属于该任务的当前诊断状态；保持公开版本、分类、计数和用户字段。明确失败不能报成功，丢ACK确认与后续cursor恢复均有实际JSON测试。

31项选择基线通过；8个实际源码反例全部检出，21–30正控保留，恢复原字节后完成DB1107/admin549/alibaba304/local467=2427项及Node20五文件346项。四消费者类型、显式Biome三文件和原生新增块格式、SDK gate、diff检查通过。最初旧预算断言仍要求无报告而失败，按本单元实际新增preparing行为修正；失败日志保留，最终无跳过。来源取消最多8次事务操作和8个写ACK故障验证双行回滚。精确产物小流程随后记录。用户状态API、过期恢复、列表/UI、合法大事务、历史修复和test真实20件验收继续，fullDeliveryReady=false。

## P2f10c：当前人工进度与重试诊断

P2f10b 精确三函数构建/打包、Linux126闭包完整性、同JS显式Macprofile、Node20产物smoke与bundled main小流程全部通过。五来源URL按4+1继续，一个来源PUT和一个保护PUT；preparing/blocked可读、编辑后新任务ready，共享图片热路径零IO；模块重启后原完成调用不改盘。所有商品未发布，测试目录已清理。bundle SHA cb6da257b3af0d6e9d3349ac945e6830bf790edc014273284938344dfebf93f4，仅本地证据。

P2f10c 仓库status命令以当前admin、完整输入和完成证明投影安全状态，不依赖旧签名；六点读零写。显式retry八操作原子清除当前非就绪状态并重置，保留历史和全部业务字段。十源码反例均检出，33–41正控/42选定；恢复字节后DB1156/admin549/alibaba304/local469=2478、Node20五文件397、四消费者类型、显式Biome/原生新增块、SDK/diff通过。最初红测、重复导入、夹具时间方法错误均保留；额外流程反例发现“过期运行+媒体重试”的推荐动作不合法，修正并验证接管/释放/重试串联。尚无新HTTP/UI入口；精确产物随后记录，fullDeliveryReady=false。

## P2f10d：后台人工准备控制

P2f10c 精确三函数build/package、Linux126闭包、同JS Macprofile、Node20 smoke与bundled worker小流程全部通过；源码仓库status在真实bundle流程旁验证preparing/edit/ready和签名过期后只读ready恢复。bundle SHA ded0b61b28b6e8fbe65ecdc1c8c1d625a34219134baf5a942e53ab176025439e，目录清理、商品均未发布。该SHA没有新HTTP入口，未作此宣称。

新catalogPreparation API绑定重新验证的会话actor，只开放四人工动作；生产/本地配置authority，role/rollout/大小/strict输入和私有投影均校验。业务复核补有界ACK确认：start/status确认一次；cancel/retry只读恢复带recovery=status，不假报动作完成。HTTP+真实JSON/像素流程、丢ACK、未到达、两次不可用与中途撤权均通过。十源码反例检出，22–31正控/32选定；源码字节恢复后DB1156/admin574/alibaba304/local476=2510、Node20六文件429、三个直接消费者types、六完整文件显式Biome、SDK/diff通过。夹具Role/可选字段和import排序问题均已修正，失败记录保留。

管理auth只读刷新READY，原环境三Event Nodejs20.19函数已确认；admin20s/256MiB与sync900s/512MiB为当前观察，未改云端。官方/安装SDK callFunction合约已查；下一单元仍须解决worker调用预算/未知结果，不直接等待20sworker嵌在20sadmin。精确产物HTTP与review随后记录，完整准备执行/UI、其余发布与真实验收继续，fullDeliveryReady=false。

## P2f10e：有界继续准备

P2f10d精确三函数build/package、Linux126原生闭包、同JS Macprofile和Node20 smoke通过。实际bundled admin HTTP确认启动丢ACK后同任务、取消/重试/只读状态、rollout禁用无写；bundled worker的5URL4+1、warm零IO、阻断编辑修复和模块重启重放通过，商品全未发布，临时目录清理。admin SHA72b55dc9cda09af72758c0d910d46f610802fa735ed9c8681a681174dd1f70bd，sync SHA d35505d6911dfd2a48e49e1d5f40c41c5691d9a24c32c79075e98631f78a74f6。

新continue人工API先当前状态再申请签名，固定目标/$LATEST、8秒总调用期限、零SDK重试，并重新读取完成证明。只有匹配的partial/currentqueued/preparing才自动继续；来源503保留手动入口，未知结果查询，丢ACK可恢复实际ready，中途撤权拒绝。官方SDK与安装源码验证发现socket timeout可被持续收包延长，补共享总时长保护及真实loopback反例；未改云端配置。18源码反例检出并恢复字节，DB1156/admin637/alibaba304/local486=2583、Node20七文件279、三消费者types、14完整文件Biome、SDK新增块/语法、SDK/diff通过。最初分类warning测试预期与批准方案不符已改正；Node20首次错误文件名命令保留，未算通过。详见P2f10e_HUMAN_CONTINUE及SDK探针，精确产物随后审查记录，fullDeliveryReady=false。

## P2f11a：前端有界继续控制

P2f10e精确三函数build/package、Linux126闭包、同JS Macprofile和Node20产物/native smoke通过。实际bundled admin→安装SDK编解码/传输→同bundled sync按5URL4+1执行，两次调用ready；已ready继续零新增调用/零写盘，warm零IO、阻断编辑修复、模块重启只读重放仍通过，全未发布且临时目录清理。admin SHA4397de103f9e7dc0f6cf79a343735e41a542ebb8c929e2ddf1a16c712b09bd33，sync SHA971818adf33b42a5067c0191b1563d624d166c1e4fe96b0345d9ff3409ccf739。

新增前端严格五人工动作传输及单商品有界控制，冻结选品/任务、零未知写重发、实际状态恢复、角色失效停止、来源失败不循环，64请求/120秒及4次退避轮询可暂停继续。33行为+2真实HTTP/JSON/像素来源4+1组合在Node24/20通过，最终响应丢失只读恢复；11源码反例检出且原字节恢复。site662含显式真实无头图库、local486，共1148零失败/跳过/取消；Astro/types/四文件Biome/SDK/diff通过。TS异步收窄、Node25存储夹具、错误HTTP接线、跨包浏览器类型及复制observation夹具均已修正，初次失败保留。尚未接UI/列表/发布，精确站点构建审查随后记录，fullDeliveryReady=false。

## P2f11b：现有预览准备与恢复控件

P2f11a精确SHA站点构建15页通过；原单元仅提供前端控制器，未冒称已有界面。当前AdminDetailPreview三分支接控件，首次只读；actor/product隔离定位、同步动作互斥、当前controller/挂载/actor防旧响应、只在认证变化重置、手工响应product/job双绑定。明确查询/继续/停止等待/取消/重试，未知动作只读恢复，错指任务可直接检查当前商品；不改分类、批准或发布，raw Edit回调始终可用。

三真实浏览器红测检出并修复重新登录仍禁用、手工状态错商品与无关storage打断。双商品恢复用例补齐后，最终14源码反例全检出（9–12正控/13），字节恢复；首组未检出的反例及脚本定位错误日志完整保留。site675零失败/跳过/取消，含两个实际无头浏览器流；Node20五文件48、Astro212零错误/警告8既有hint、七文件Biome/SDK/diff通过。最终仅用户照片提示替换binding术语，13项再通过且formatter对比确认无逻辑变化。Markdown/CJS隔离宿主、SSR JSX配置、清理顺序与测试类型夹具均已修正，失败过程记录见P2f11b_RECOVERY_CONTROLS。精确构建审查随后追加；实际RecordForm子面板、原生列表/意图/大媒体/现场20件仍继续，fullDeliveryReady=false。


## P4b1：编辑附属读取重试

P2f11b精确site构建15页5.82秒通过。现有原始编辑页新增供应商/照片独立读取状态和Retry，保留用户输入与显式Keep/Use。实际预览错误→原始RecordForm→两个失败面板独立/交叠重试→版本保护草稿保存小流程通过，来源/照片/审批/分类/发布状态逐一读回，无隐含批准。

7源码反例全部检出（每次15正控、2浏览器断言失败），恢复哈希核对。恢复后完整site677、Node20两文件17、Astro213文件零错误警告8既有hint、三文件显式Biome、SDK与diff通过。失败日志、设计和故障备份保留；详见P4b1_EDITOR_READ_RETRY.zh-CN.md。无部署或客户数据写入，完整交付仍未完成。下一单元先验证并修复单张照片导入与并发选择的覆盖风险。


## P4b2：照片导入与当前选择

P4b1精确site构建15页5.22秒通过。浏览器在图库和描述图均复现晚到导入覆盖删除/排序；改为最新照片值ref，同步setField更新，完成时去重及容量检查。真实导入/签名syncHTTP、上传intent/受控PUT/真实完成、ImageManager和版本保护保存串联，覆盖两个字段的删除排序、容量填满后Remove/Add复用及相同内容去重；保存前零商品写入，最终草稿/分类/审批边界读回。

3源码反例均检出（19或21正控、4或2失败），恢复原字节后完整site683、Node20五文件36、Astro213零错误警告8既有hint、显式两文件Biome、SDK/diff通过，零跳过。首次错误按钮、错误cwd的冗余测试、源码定位断言均留记录，不算业务检出；仅核实自有进程后停止，孤立fixture按哈希/身份核对清理，最终编辑目录0。详见P4b2_EDITOR_PHOTO_SELECTION.zh-CN.md。无部署/客户写入，跨面板互斥与其余组合继续，fullDeliveryReady=false。


## P4b3：并发照片位置与供应商忙状态

P4b2精确site构建15页5.76秒通过。反向完成顺序在真实浏览器得到图库10/9、描述图19/18；首轮过早检查造成10项假绿，等待实际上传完成后8正控/2失败。来源复制在目标ImageManager预留1位置，文件接纳同时计算该位置；上传中的字段禁止来源Add，Keep/Use受完整忙状态保护且结束后可实际Keep/保存。已有删除/排序、文字编辑和其他剩余位置的上传继续可用。

最终16浏览器场景与表单/图片组件共39相关检查通过，包含两字段两种完成顺序、单空位/双空位、去重、受控503重试和390px无溢出。4源码反例分两批检出并恢复一致哈希；第四定位重复的工具错误保留，不当业务检出。恢复后site691、Node20五文件44、Astro213零错误警告8既有hint、五完整文件Biome、SDK/diff均通过，零跳过。所有自有编辑目录0。精确构建随后记录；列表准入、稳定操作/大媒体、历史修复与test现场真实20件发布恢复继续，fullDeliveryReady=false。详见P4b3_EDITOR_MEDIA_ADMISSION.zh-CN.md。


## P2g1：检查请求同步投影

P4b3精确site构建15页5.63秒通过。任务开始/显式重试在原事务中同步checking与严格有界请求，重复同输入零额外写入；当前检查点保留，取消只清理自身当前状态。受管字段与代次/策略读取校验保持，业务字段/批准/分类/发布不变。手工5操作、来源8操作，两个写点8类失败原子回滚，丢ACK后读回同对，实际JSON重开/取消/重试和公开私有字段检查通过。

10实际源码反例全部检出，298项/次保留正控，恢复SHA核对；随后仅将模块注释归位。最终DB1175/shared305/admin637/local487/public131/sync304/site691共3730项、Node20五文件394项，零失败/跳过/取消；六后端类型、Astro213零错误警告8hint、14完整代码文件显式Biome、SDK/diff通过。早期22个旧状态基线失败和脚本错误保留，未将跳过或旧失败当通过。详见P2g1_REQUEST_PROJECTION.zh-CN.md。精确三函数/站点产物随后记录；继续原生列表准入/计数/分页/全选，不部署或改真实商品，fullDeliveryReady=false。


## P2g2：原生准备范围与列表读回

P2g1精确5df99a1三函数build/package、Linux126闭包、同JS Macprofile与Node20 smoke、bundled admin→实际SDK→sync的5URL4+1流程通过；checking请求/重复start零写、warm零IO、阻断修复、模块重启/失ACK恢复和rollout拒绝通过，全未发布，fixture清理。site15页5.29秒。

新增可选normal/issues/preparing/unchecked，复用受管摘要与代次/身份/策略标量expr，分类/子分类/搜索/OR筛选在count/page前同一条件组合；公开行保留，旧数据仍可查，默认目录未切换。新范围补唯一_id尾排序。列表不确定count/坏行红测13正控9失败，修成明确失败而非空成功；三合法空目录/排序正控保留。实际worker有/无分类的checking→ready→编辑失效→blocked→修复ready小流程不改分类或发布。

双安装SDK serializer与官方/安装源码核对；当前云只读原生查询和31条查询内合成数据×4范围=124比较，四反控均通过，零合成数据/商品写入。13源码反例最终均断言检出且恢复哈希匹配；首轮TypeError夹具和探针/类型/格式工具错误留日志，不当通过。最终DB1200/shared305/admin637/local499/public131/sync304/site691共3767、Node20三文件133，零失败/跳过/取消。六后端types、Astro213零错误警告8hint、13完整文件Biome和被忽略adapter新列表主体独立检查、SDK/diff通过。详见P2g2_NATIVE_READINESS_QUERIES.zh-CN.md。精确产物随后；继续UI/计数/选品集成及P5审计后启用，fullDeliveryReady=false。


## P2g3：列表检查范围、选品与恢复

P2g2精确181625d三函数build/package、Linux126闭包、同JS Macprofile与Node20 smoke、bundled admin→安装SDK→sync及四范围逐阶段只读核对通过，所有产品未发布且fixture清理；site15页5.29秒。

现有CollectionView接入all/normal/issues/preparing/unchecked，UI在历史影子阶段显式all，旧省略scope协议不变。主表/分类计数共用范围、搜索、过滤，URL历史/分页/排序清理选品；坏或失败读回有独立重试，不报假0、不允许缓存页继续写。Preview准备或Edit修复后刷新范围；问题范围仍可只保存分类，禁用桌面/移动行与批量发布及分类Save and publish。列表有界字段投影尚未完成，继续P2g4，不能以条件轻量冒称响应有界。

实际红测检出失败PageJump、移动Publish漏保护；视觉检查又发现展开菜单429/390溢出，修成以整条选品栏为锚点，同时覆盖375px/20选品换行。最终12浏览器流程通过，12项源码反例均检出；首轮选品反例曾存活，补零选品及切回范围断言后检出，不算首轮通过。所有源码故障finally恢复并核对哈希。分类夹具缺版本、Select水合等待、可选data类型、旧Select清单4→5和短文案格式问题分别留日志，不当业务红测。

最终DB1202/shared305/admin637/local501/public131/sync304/site719共3799，零失败/跳过/取消；Node20后台39及客户端16通过。六后端类型、Astro215文件零错误/警告8既有hint、15完整文件Biome、SDK/diff通过；精确构建见提交review侧车。逐一审查15代码/测试与选择、分类CAS、原编辑和Preview接缝；文案把通用Product list改为The list，核对字段缺失和未发布语义。全部列表夹具已清理。详见P2g3_LIST_READINESS_UI.zh-CN.md。继续有界列表/完整Edit读取、稳定操作/大媒体、旧数据审计及现场实际20件发布恢复；无部署/客户写入，fullDeliveryReady=false。


## P2g4a：完整商品读取后再打开表单

P2g3精确364e3bb site15页5.83秒、三函数build/package、Linux126闭包、同JS Macprofile和Node20 smoke通过；实际bundled admin→安装SDK→sync、5URL4+1、warm零IO、阻断修复、模块重启/失ACK和取消重试通过。各阶段实际五范围读回正确且只读，未发布、未强补分类，fixture清理。

列表row不再直接作为产品表单/预览初始记录。读取对话框可Retry/Close，当前请求对象+序号、子组件active和HTTP取消一起隔离晚到结果；完整同ID商品读回后才挂载既有组件，保持原CAS和供应商规则。行Edit/Preview、带标记Publish、Preview Review changes/Edit均改接；非产品集合不变。此单元仍未收紧服务端列表字段，继续P2g4b。

初始12正控5失败及取消13正控1失败。最终21浏览器/48组合通过；8源码反例检出并恢复哈希。组合移除两个旧完成保护时，文字不变但实际update目标从ready串到blocked，已由真实请求和DB读回检出。StrictMode故障夹具、脏表单Cancel确认、旧源码正则及定位脚本错误分别留记录；没有改产品行为来迁就错误测试。手机390错误弹窗有几何/截图，错ID原反例再次检出。

最终site729零失败/跳过/取消、Node20客户端17、Astro216零错误/警告8既有hint、6完整文件Biome/diff通过；本单元无后端源改动，未重报整套后端。实际复核六代码/测试与Shell、表单、modal、保存接缝；取消措辞收紧到HTTP，不暗示服务端回滚。详见P2g4a_FULL_RECORD_OPEN.zh-CN.md，精确提交构建另记侧车。没有部署、客户写入、新分支/worktree/PR/push，fullDeliveryReady=false。


## P2g4b1：原生固定列表投影与完整读取隔离

基线850372b，原目录/分支/单人实施。P2g4a精确站点15页5.84秒已审查通过。显式admin-product-list-v1仅支持products；固定field投影在同where count之后/原生get之前，JSON先筛选排序分页再拷贝白名单，原get/旧协议/公开调用不变。详情/批准/任务/未来字段及autoPhotos描述/SKU结构不传列表；保留价格/审核/分类/图库来源与原CAS缺字段语义。每行与响应均有版本标记，客户端拒绝摘要进入完整GET；主表/计数cache key均含协议版本。

先红后绿，真实admin/adapter/浏览器覆盖；10项故障均被断言检测，四源文件恢复核哈希。全量3844（305/1206/637/508/131/304/753）0fail/skip/cancel，Node20 46、全部后端相关类型、Astro216零error/warning8hint、standing双SDK实际field/get sender通过。首次图库flag错误留下1skip，正确flag全量重跑；类型替身/精确optional/复制字典、EJSON探针预期和测试delete提示均修正并留首轮记录。只读三件时钟按实际字段表得约3KB/行，但无P95和硬上限结论。

实际复核共享协议/类型/exports、DB固定投影与原生查询/JSON/facade、admin校验和客户端完整记录隔离/CollectionView两个列表/测试，以及分类/价格/审核/图片/表单/公共读取接缝。正文“描述搜索”更正为真实series搜索，“有界完成”更正为固定字段投影；文档P2g4b_LIST_PROJECTION.zh-CN.md含具体证据。P2g4b2字节预算继续，无部署、客户写入、新branch/worktree/PR/push，fullDeliveryReady=false。


## P2g4b2：列表字节预算与可操作恢复

基线2594a53，原目录/分支/单人继续。共享迭代JSON字节预算使v1摘要每行≤8KiB、页含包络≤1MiB；普通小行保持逐值，大附属元数据保留核心和来源身份并显示完整Preview入口，核心摘要不足禁用行/已选批量快捷写且保留Edit/Preview/清选。原始get、来源数据和缺published语义不变，不强补分类，不持久化DTO标记。实际发现深度预留导致整页失败及手机菜单遮住清选，均先红测后修复。

真实浏览器完成Preview→分类保存→Edit与核心不足→Edit修复→原选品恢复操作；1440/390和截图验证，无force点击。25源码反例全检出，8文件finally还原/哈希一致，修改过的旧完整读取/协议断言经原故障再证。常驻Node20原生admin产物烟测保留真实bundle/SDK仅替换HTTP，旧2594a53在预算断言失败，新精确产物在审查后构建；原CI/部署命令无开关包含，删除接线真实驱动失败。

最终相关全量4359（309/1215/637/510/131/304/766+487脚本）0fail/skip/cancel；反例后65后台/72客户端通过。Node20 26+45通过，驱动4目标通过/19未选。全部相关类型、Astro216零错误警告8既有hint、16完整文件Biome+忽略原生函数源段比较、SDK/diff通过。路径0匹配、前置tsc/SDK未运行、夹具及格式首轮错误留档，不当通过。20文件与消费者复核，写作将性能结论限定HTTP预算；详见P2g4b2_LIST_BYTE_BUDGET.zh-CN.md。无test部署/真实写入/新分支/worktree/PR/push；P3及整体交付继续，fullDeliveryReady=false。


## P3d1：同状态下架也取消较早审批

P2g4b2精确97cb542已完成20文件inline审查、三函数/15页5.98秒构建、Linux126闭包/同JS Darwin Node20默认smoke（含真实原生列表SDK）、三个health SHA和检查修复/双协议只读列表组合，fixture清理；无云部署。

11项先红（98正控）证明draft再次Disable没有生命周期屏障，旧begin/page/finish仍成功。写入层以显式patch识别published:false或archived:true，即使同状态也只推进一次生命周期；保留内容检查和批准历史，旧unfinished审批经原指纹拒绝。forceContent迁为明确options，全部调用/来源及SKU父级失效复验；不增加事务IO或存储。

真实admin/JSON重启、原生事务失败回滚、两并发顺序与1440/390实际Batch Disable通过；初次夹具API/只读字段错误、手机summary重复定位、类型声明修复均留档。浏览器也确认批量初次写缺选品CAS，继续P3d2，未冒称已修。8新+4旧源码反例全检出，finally恢复/核SHA；529恢复正控及Node20各通过。相关全量3896（309/1231/637/516/131/304/768）0fail/skip/cancel；全部相关types、Astro216零error/warning8hint、9完整文件Biome、SDK/diff通过，未把未重跑487脚本当本单元结果。

旧97cb542真实打包native handler/SDK经受控HTTP事务实际在“Disable缺版本屏障”业务断言失败；首轮merge模拟错误保留，不当业务红。精确新提交产物在审查后验证。12路径与消费者逐段复核，措辞限定旧unfinished审批，不把历史批准称当前live。详见P3d1_WITHDRAWAL_BARRIER.zh-CN.md。稳定操作、所有重试/CAS及其余P3–P7继续，无test部署/真实写入/新分支worktree/agent/PR/push，fullDeliveryReady=false。


## P3d2 / P4b4：冻结批量输入与弹窗焦点，集成仍红

基线dd4780d，原目录分支单人继续。批量初次和人工重试保留原ID/补丁/每件updatedAt（legacy明确null）；缺映射或坏guard在任何请求前拒绝，复制异步输入，分类retry沿原分类保存回执，不重取他人新行作为自己的版本。带冻结guard的丢响应保持未确认，不能用published相同冒充本操作回执。实际桌面/手机Disable、Archive、分类保存后外部编辑/重试冲突与Edit核对通过。

完整site797通过，0fail/skip/cancel。完整生产构建公开41、目录90、正式11与visibility6通过；visibility丢发布响应自动确认仍1失败/1未运行，taxonomy未运行。保留原断言作为P3后续持久操作的集成红测，review/部署被此缺口阻断，不能称全流程完成。隔离20件Assign category→Save and publish、BUSY与共享图片恢复通过52.4秒（含setup/assert/restore，不是云端发布P95或真实20件）。

首轮全流程还暴露Preview关闭刷新后旧按钮DOM已脱离，修复按产品/动作定位当前节点、缺目标回标题；等待期间新pointer/keyboard/input取消该次延后焦点。先红5正控/2焦点失败，第一实现仍抢输入焦点6正控/1失败，修正后8场景+1控制9通过，原Preview E2E断言恢复通过。

public容量旧夹具遗漏v1投影/完整get且上传仍为POST/FormData，按现有实际协议修正夹具，保留原容量/移除重试/去重断言，完整GET恰一次。21源码反例全部检出（12批量/7焦点/2生产上传容量），4文件finally还原核SHA。旧摘要/完整GET反例和恢复后运行结果另续；不将重复失败断言当独立缺陷数。所有工具/定位/StrictMode夹具错误与完整流程红测保留。

实际复核6代码/测试路径、分类/Modal/审批/最终update/原生CAS/JSON/DTO/媒体消费者及4证据文档；把“安全重试完成”收紧为“固定原输入，未知结果仍需持久回执”。详见P3d2_FROZEN_BATCH_INPUT.zh-CN.md与P4b4_PRODUCT_DIALOG_FOCUS.zh-CN.md。后续沿既有catalogDetailApprovals扩展稳定操作/阶段回执，不新增第二套审批存储。无部署、客户写入、新分支worktree/agent/PR/push，fullDeliveryReady=false。

恢复后复核：4项旧摘要/完整GET反例均检出（88项/次，分别84/4、86/2、80/8、82/6正控/失败），8源文件还原核SHA；本轮合计25种故障、67项重叠失败断言，不是67个独立缺陷。随后Node24与Node20同4文件132项各通过，0fail/skip/cancel。Astro216文件0error/warning、8既有hint；E2E类型、standing SDK、6完整代码/测试文件显式Biome及diff检查通过。本单元未改后端源，没有把旧后端/脚本全量数加进本轮。完整集成红测仍在，审查保留一项必须修复的操作恢复缺口，不发版。


## P3e1：稳定操作输入预约与只读查询

基线a0cf8b5已逐项review10路径，明确保留1个自动发布恢复P1、未bless；精确site15页5.01秒不改变阻断。继续原目录分支。既有catalogDetailApprovals新增严格reserved协议，绑定actor/product/UUID、intent、原revision、深拷贝网站补丁及内容/生命周期/分类/来源/链接摘要；同ID相同输入不额外写，不同输入拒绝，get保留原基线并返回current/expired。没有新HTTP入口，没有复制整段来源或另建审批存储，没有改商品/批准/发布。

初红7正控/34失败；首次实现子分类摘要遗漏100正控/1失败，修复后继续。真实JSON的只读mtime红1正控/1失败，改为有tx.set才persist；双实例竞争、重开查询、native object/array插入及4种不可靠回执回滚通过。忽略采集元数据的预算反例48正控/3失败后，预算改用原hash的实际输入投影，旧hash固定样本保持。当前相关小组合199通过。19源码故障全检出、4文件复原核SHA；两项旧UI重试版本反例均7正控/2失败、4文件复原。

首轮七包全量在BUSY重试测试5秒等待超时，保留失败；退避代码允许约5.04秒，改两处等待15秒，所有请求数/原guard/冲突/字节断言保留并重证故障。最终七包全量3986（309/1290/637/518/131/304/797）0fail/skip/cancel；Node20后台199+浏览器43=242通过。16相关项目types、Astro216零错误警告8hint、8完整代码/测试文件Biome、SDK/diff通过。初次缺validation类型、错fn-admin筛选及格式错误留档，不当通过。

四个独立Node24/20进程在禁止网络的自有JSON库写预约/查询/重复，同612字节样本回执，零额外记录/查询文件写/商品写，fixture清理。不是云端实际操作或完整阶段重启。8代码/测试路径及3文档复核，文案把“恢复完成”收紧到“预约/查询已验证”，保持原visibility丢发布响应P1及全部P3-P7门槛。详见P3e1_OPERATION_RESERVATION.zh-CN.md；无部署、客户数据、新分支worktree/agent/PR/push，fullDeliveryReady=false。


## P3e2a：写入确认先于自身保存回执

准备P3e2时发现产品set/update、新slug/SKU身份set与旧身份remove忽略ACK，可无实际写入而返回saved。旧精确4b88e49打包native handler/SDK经过假HTTP，在有效业务断言失败。原事务统一检查updated=1、单个目标upsert或deleted=1，coded结果保留code；失败整笔回滚，重试成功。既有分类actor fence原段保持字节相同，自动审批误判为新增的失败尝试未执行。no-op仍完整检查分类/建议，只省空产品写；JSON省无fence文件重写，审查两次各2项红测后补齐权限与明确fence保护。

默认smoke:functions强制实际native写路径，正确创建/改名/身份移除，13种失败回执均拒绝且rollback/store不变；默认驱动编译去ACK模块必败，删接线也必败。16源码反例全检出，51重叠失败断言，4文件finally恢复核SHA。恢复后后台3244+脚本488通过，Node20后台274/驱动24通过；19项目types、Astro216零error/warning8hint、8完整文件Biome与忽略原生源段格式、SDK/diff通过。站点全量797通过（含实际浏览器组件），相关全量合计4529。精确构建在本单元后续证据续记，未提前归为通过。

实际复核9代码/测试路径及3证据文档、原保存/分类/建议/事务/JSON/HTTP/default smoke消费者。文案明确ACK不是云端验收；无真实网络、客户数据、test部署、新分支/worktree/agent/PR/push。原发布丢响应P1保留；后续继续同事务保存自身回执，fullDeliveryReady=false。详见P3e2a_PRODUCT_WRITE_ACK.zh-CN.md。


## P3e2：草稿自身保存阶段

基线b43fa82精确三函数/15页5.00秒/默认Node20 native ACK与下架、检查修复组合通过，原发布恢复P1仍阻断。继续原引擎：冻结server-only操作绑定，在原native事务/JSON锁内同时保存产品、slug/SKU身份与saved回执。初始base不变，另存自身snapshot/revision；重复零写，外部修改/下架/关联变化/旧策略/过期/撤权均拒绝覆盖，保留历史。旧调用无额外IO，原actor分类fence字节相同。没有HTTP/UI接线或新存储集合。

审查红测补齐配置照片新引用、live误用、字段错误被误作过期、空描述误用展示层非空合约及metadata-only状态差异。按实际审批投影检查描述同时保留原文，字段问题回具体path；保留原capture-only断言，增加revisionCurrent并与内容current/年龄分别检查。没有删除旧集成断言。27源码反例全部检出178重叠失败断言，3文件finally恢复核SHA；小组合373/Node20同373通过。实际compiled native原语+SDK受控HTTP10种回执故障与2类字段/6正常描述通过；四独立Node24/20进程同saved回执/零重复写、fixture清理通过。

早期全量业务3305/4594与类型失败、夹具/类型推断问题、冗余guard删除仍绿的尝试均保留，不当最终结果。最终七包+脚本4613（309/1370/797/637/577/131/304+488）0fail/skip/cancel；DB因新增提交后丢答复测试完整重跑1370，Node20小组合374。19项目types、Astro216零error/warning8hint、7完整文件Biome与忽略native源段/actor字节检查、standing SDK/diff通过。精确提交产物在review侧车补录。具体边界/回归见P3e2_DRAFT_STAGE_RECEIPT.zh-CN.md；新媒体、分类上下文/supplier计划冻结、create/live/approval/final及UI统一继续，fullDeliveryReady=false。无test部署/客户数据/新分支worktree/agent/PR/push。


## P3e2b：空草稿保存阻止旧审批提交

基线ae3dd28，JSON与实际SDK复现旧finish成功。只在新绑定草稿保存时沿原生命周期推进一次，重试零写，保留来源ready与历史字段缺省。7源码反例检出26重叠失败，源文件SHA还原。最终4618测试、Node20相关431、19types、显式Biome/native函数格式、SDK/diff通过；跨进程和实际SDK独立证明通过。详见[P3e2b](P3e2b_DRAFT_CANCELS_OLD_APPROVAL.zh-CN.md)。原发布恢复P1与全局后续项保留，未部署，fullDeliveryReady=false。措辞将“取消旧审批”限定为“拒绝旧finish”，不声称旧暂存占用已回收。


## P3e2c：冻结启动时批准身份

基线5526871，真实另一审批完成且时间戳不变时旧操作仍current。新snapshot的固定approvalDigest绑定批准版本/自身回执身份，查询和写入共同拒绝旧操作；价格摘要真实回填保持有效。旧reserved/saved历史可读但不可继续。20新增用例、六源码反例39重叠失败、实际SDK旧红/新绿、四进程零重复写通过。最终4638全量、DB1389最终重跑、相关377/Node20451、19types及四文件Biome/SDK/diff通过。详见[P3e2c](P3e2c_APPROVAL_VERSION_BINDING.zh-CN.md)。本次冻结原批准身份，自身审批阶段还未接入；原发布恢复P1保留，fullDeliveryReady=false。


## P3e3：publish先保存自己的草稿阶段

基线1feb275，扩展未发布商品publish意图的内部草稿保存；仍不批准/上线，不接入HTTP/UI。按实际intent核对源/observation/link，纯保存后快照复用已验证source，防写后再读。20/50/100分批保存/重开及零重复写通过；六源码反例69重叠失败，另去回执写让三个batch红。Node20实际SDK16文档操作/10坏ACK回滚/6源冲突和来源商品四进程恢复通过。最终七包+scripts4664，Node20477，19types、显式Biome/native函数actor比对、SDK/diff通过。详见[P3e3](P3e3_PUBLISH_DRAFT_STAGE.zh-CN.md)。代码注释限定已验证source绑定，明确内部草稿不等于客户发布；原formal P1和fullDeliveryReady=false保留。


## P3e3b：外层等待前冻结完整命令

基线62dddaa，发现SDK事务启动/文件锁前的caller引用窗口；8unit红、4实际SDK延迟响应红，旧legacy finish会批准晚改标题。用同一个捕获函数在两入口等待前复制所有持久化命令，保留原schema/容量，失败受控反馈且不写。16新增用例；六源码反例51重叠失败、2源文件SHA还原；5实际SDK正控、完整legacy旧红新绿、两种草稿SDK/四进程回归通过。七包+scripts4680、Node20493、19types和显式Biome/SDK/diff通过。详见[P3e3b](P3e3b_ASYNC_COMMAND_CAPTURE.zh-CN.md)。措辞把“事务内冻结”纠正为“SDK/锁等待前冻结”，原完整发布恢复P1保留，fullDeliveryReady=false。

## P3e4：同一操作的审批起点与查询

同一key由saved进入staging，保留初始输入/保存回执/TTL，get/start/重复begin恢复原游标，旧page/finish保持关闭。43新增测试；10源码反例28重叠失败并还原；安装SDK6组/4进程/隔离20起点串联通过。七包+scripts4723、Node20535、19types、显式Biome/SDK/diff通过。[P3e4](P3e4_OWN_APPROVAL_CURSOR.zh-CN.md)记录边界和最大根读取接缝。措辞纠正“审批成功”为“审批游标已保存”；整体验收fullDeliveryReady=false，原完整发布恢复P1保留。

## P3e4b：未完成审批的定向图片保护读取

解决P3e4新增大根的媒体检查读取接缝：服务端先匹配待删图片，只取两个ID，1get/0count/0写，JSON同语义且保留旧adapter分页fallback。61新增；14源码反例31重叠失败、3源文件还原；Node/wx/真实adapter12组实发参数通过。完整4784、Node20672、19types/显式Biome/SDK/diff与原保存保护块一致检查通过。[P3e4b](P3e4b_TARGETED_MEDIA_HOLD.zh-CN.md)保留云端执行/P95未测的边界。措辞从“返回图片清单/变快”改为“两个ID/减少回传”，global fullDeliveryReady=false，继续P3原P1。

## P3e5：同根审批配置分页

新旧入口共用页投影/hash/不可变写入，own页保留原始输入/保存回执/TTL，47文档操作、零写重复。41新增、17源码反例123重叠失败并还原；安装SDK12组/9ACK回滚、4独立进程、20来源商品420配置组合通过。完整4825/Node20713/19types/Biome/SDK/diff通过；测试类型有限键修正编译JS相同，相关测试和变异已重跑。[P3e5](P3e5_OWN_APPROVAL_PAGES.zh-CN.md)区分codec预算与语义候选。将“审批完成”纠正为“配置页已暂存”，旧批准版本保留、商品仍未发布；原完整发布恢复P1继续，fullDeliveryReady=false。


## P3e6a：大媒体引用协议与纯计算

复核全部计数消费者后，选同根协调、待提交差值与小型不可变证明；明确非快照读和单root结算反例，永久hold/旧writer/backfill仍是启用前门槛。本步只实现未接DB的计划/成员证明/一致快照结算纯函数。51新增、18故障134重叠失败并SHA恢复；完整4876、Node20 DB1594、19types/E2E/显式Biome/SDK/diff通过。独立Node20构建6计划、Python13成员路径交叉核对。详见[P3e6](P3e6_MEDIA_REFERENCE_PROTOCOL.zh-CN.md)。实际措辞修正：测试名去掉“lost answers”，限定线性化模型，不冒称HTTP或真实云恢复。原正式P1、真实三时钟/20件验收及fullDeliveryReady=false继续。


## P3e6b1：同根永久取消与图片hold释放

原操作根增加服务器cancelledAt，4文档操作、重复0写，保留草稿/页且旧save/begin/page不能继续；三种hold路径排除仅本取消根。原expiry一小时+十分钟余量保留并补65/69/71分钟检查，修正此前未读完整入口的假设。55新增、20取消反例156重叠失败+1SDK-only检出、11真实安装SDK取消/12发送层条件、四进程重开/清理。全量曾在旧流式测试出现1失败，控制启动延迟复现错误假设后修正测试并以硬截止十倍反例重证；生产8秒逻辑未改。最终4931全量/Node201742+invoker15/19types及admin补跑/Biome/SDK/diff通过。[P3e6b1](P3e6b1_OWN_OPERATION_CANCELLATION.zh-CN.md)记录完整证据。措辞“取消停止后续步骤”区别于回滚既有业务写入；原formal P1/fullDeliveryReady=false保留。


## P3e6b2：完成媒体准备回执交接

直接复用服务端completed证明，仅原审批根增加小绑定，12文档操作、重复0写；页/取消/历史codec保留其语义，不接HTTP/最终发布。50新增、14源码反例96重叠失败并SHA恢复；实际SDK11组/3坏ACK/commit丢确认、四独立进程及非空worker图片/读端hold衔接通过。全量4981、Node201792+invoker15、19types/E2E/显式Biome/diff通过。[本步说明](P3e6b2_MEDIA_RECEIPT_HANDOFF.zh-CN.md)记录夹具共享图first-match修正和证据边界。

更正P3e6b1门禁证据：旧绿色日志不能证明4cf5101最终新测试名与旧门禁名称组合通过；本轮门禁实际失败。同步启动/流式两项名称并要求至少15全通过，硬截止十倍反例使完整SDK门禁失败，恢复SHA再通过，生产逻辑未改。实际审阅三生产模块/两测试/门禁脚本与四文档；把“图片保护交接已证明”改为“本地读端交接检查通过”，依据实际worker/hold读端与未测字节删除/provider并发区分。原formal P1/fullDeliveryReady=false保留，继续最终提交与所有消费者。


## P3e6c1：图片引用快照与全部结算

一个事务体读取图片和全部小proof，4并行点读、最大81读+1写；native/JSON共用，严格区分缺失/失败读取，排空并发失败，保留原metadata/未提交项与legacy缺counter语义。59新增、110聚焦；实际SDK生产接线12组/三坏ACK/commit丢确认、四进程文件恢复通过。原引擎18反例134重叠失败重跑，另17反例52失败+2SDK-only检出，恢复SHA。相关五包3446/Node201742/19types/E2E/standingSDK通过。[本步说明](P3e6c1_REFERENCE_SNAPSHOT.zh-CN.md)保留未启用consumer/producer及provider/P95边界。review pure/helper/两adapter/接口/出口、两测试与三文档；把初稿imageId200字符限制改为沿现有字符语法、无新增长度业务上限，对照isApprovalImageId及非法换行测试；区分单图80证明/82文档操作与UI批量验收。继续旧消费者与最终提交；原formal P1/fullDeliveryReady=false。


## P3e6c2a：公开图片有效引用读端

非空ledger走只读一致快照，采用整张metadata与effectiveCount；无ledger及完整验证的空ledger保留1get，count0不误开事务。坏proof/能力/返回值拒绝而非fallback，日志不含私有错误/URL。44新增、19反例122重叠失败并恢复SHA，实际Node/Wx SDK编译HTTP11组/同transactionId/0公开写/单get通过；真实文件字节在独立HTTP单测覆盖。DB/public1907/Node201907/19types/E2E/standingSDK通过。[说明](P3e6c2a_PUBLIC_REFERENCE_READ.zh-CN.md)保留首版夹具缺config及错误proof根的修正，不算产品bug。review三生产模块/测试与三文档；将“有ledger必须事务”具体改为非空proof事务/有效空行快照，未冒称P95。继续旧写端兼容与final，原P1/fullDeliveryReady=false。

提交初审追加修复own-counter存在性，两个非法adapter HTTP反例从200expected404转绿，再删两个guard各自失败；真实adapter原检查保留，消费者不再走legacy fallback。上述最终计数均按该修复重跑。


## P3e6c1b：取消引用证明的统一读端

沿相同小型终局proof ID识别commit/cancel，取消清理自身pending但不变计数，未决仍保留。严格判别union及纯引擎由native/JSON/public共用；真实producer继续关闭。28新增/182聚焦；DB1750+local644+public182=2576，Node201945，19types/E2E/standingSDK/Biome通过。27反例253重叠失败且SHA恢复，实际安装SDK15组/82docops，四进程重开及0重复文件写通过。[说明](P3e6c1b_CANCELLED_REFERENCE_PROOF.zh-CN.md)明确读端不证明终局写入原子性。实际文字复核源码/三测试/协议及两记录，把aborted addition改为cancelled addition inactive，计数0并非撤销已提交事实；不把取消factory当不可变写端。原P1/fullDeliveryReady=false保留，继续旧writer及最终流程。


## P3e6d1：旧图片计数增减兼容

images.publishedRefCount走共用同快照加载、结算全体终局再加delta，一次完整set；80pending82ops。缺counter的legacy返回null且不初始化，其他字段沿原inc。44新增，8业务红；最终各包/脚本5156、Node202098、19types/E2E/standingSDK通过，新增持久化测试后补整个local661/Node20。18源码反例（16测试79重叠失败+2SDK-only）及三SHA恢复，实际SDK29组同transactionId/严格ACK/提前capture、四独立进程丢回执读回通过；非幂等delta不盲重放。[说明](P3e6d1_LEGACY_REFERENCE_ADJUST.zh-CN.md)保留unsafe夹具自动修改与同步parse探针断言修正，均非产品反例。实际review四生产模块/三测试、接口、MIU/协议/SDK/本记录；null说明补legacy未知基数语义。原保存actor/classification fence块byte-equalad383a8。旧审批/删除/回填/其他writer和final/UI/真实云验收未完成，producer关闭，原P1/fullDeliveryReady=false。


## P3e6d2：图片删除读取完整引用状态

底层/孤儿删除复用只读settlement计划，权限/锁先拒，非空ledger同事务重读image+proof、比对快照、有效0且无未决才合成唯一隔离set；80项83docops，空/无ledger原1读路径。已隔离intent有pending不可恢复。后台abandon旧base预检查和冲突误报也修复，真实本地字节覆盖保留/正常删除及重试。36新增/441聚焦；完整5192/Node202142/19types/E2E/standingSDK通过，17反例16测试75重叠失败+1SDK-only，五SHA恢复。实际SDK43组严格ACK/捕获/丢ACK恢复，四独立进程两实际文件恢复/0重放写通过。[说明](P3e6d2_IMAGE_DELETION_REFERENCES.zh-CN.md)记录SDK脚本变量重复与asconst测试类型修正，非业务反例。实际文字review源码/三测试模块与协议记录，将统一incomplete改为未完成引用的完成/取消后重试，核对code和字节状态。producer关闭，其他写端和final/云验收未完成，原P1/fullDeliveryReady=false。


## P3e6d3：来源退役、pending与候选清理兼容

来源退役复用d2唯一只读零引用规划，所有权/租期/锁/link先拒、image+URL note两写至多85docops；pending仅允许无ledger/合法空0，active热命中/复用不增减计数且整行解锁保留ledger和字节身份。候选移除有ledger交给删除事务，冲突映射still-referenced；native/JSON提前复制含target输入。34新增，12入口11业务红+1取消控制；最终各包5226（首次5224后只补2DB正常控制并补整个DB1831）、Node202196/19types/E2E/standingSDK通过。source15反例14测试139重叠失败+1SDK-only；共享模块提取后d2原17反例75失败+1SDK-only重证，五SHA恢复。实际SDK66组/双写6坏ACK/丢ACK恢复，四独立进程真实PNG删除恢复/0重放写，真实API五态保留/删除通过。[说明](P3e6d3_SOURCE_CLEANUP_REFERENCES.zh-CN.md)保留通用upsert自动时间字段导致proof夹具拒绝、提取与SDK脚本错误，不冒称产品反例。review九代码/测试与四记录，措辞“不写计数”改为“不增减计数且整行保留”，依实际两个active写点/正控。producer关闭，其他writer/final/UI/真实云P95和三时钟20件验收未完成，原P1/fullDeliveryReady=false。


## P3e6d4：普通创建/更新与旧回填计数保护

新增一处共享守卫供native/JSON普通create、deterministic create、update、upsert和租约写入使用：禁止写ledger/路径/operator、非法count与已有ledger的基数覆盖，metadata保持原值、createOnly只在实际创建时应用，输入在首个异步边界前复制。普通nativeupdate同事务get+局部update/严格ACK，不上传已有大image字段；租约fence保留。回填扫描与实际写入双重保护，managed/missing明确skip，未知供应商错误继续失败。新增59项/385聚焦，完整5285、Node202255/19types/E2E/standingSDK通过；20反例含16测试96重叠失败+4SDK-only，四SHA恢复；实际SDK137组及四进程PNG公开→回填→改名→下架→重开404/0重放文件写通过。[说明](P3e6d4_ORDINARY_IMAGE_WRITES.zh-CN.md)保留错误导入/格式/类型及注入器分类失败，不算业务红。review八源/测试和package、既有generic接口/调用者及三文档；“所有图片输入”改为本步创建/更新入口，并修正原回填注释，避免把跳过或维护窗口说成全目录原子修复。普通remove/条件remove/其他increment、上传/保护及旧审批原始计数/最终激活、UI/历史/provider/P95/test三时钟和20件发布回退仍开放；producer关闭，原formal P1/fullDeliveryReady=false。


## P3e6d5：通用删除、条件删除与保留字段增量

通用images remove/条件remove在既有事务/JSON锁中只允许无ledger旧路径，有任意own ledger要求既有持久删除；条件不匹配/missing仍false。非publishedRefCount增量先复用d4保留字段守卫，精确counter继续d1。native沿既有rowstore严格ACK，legacy1get+1remove，实际专属删除不经过该通用入口。27新增/19入口13业务红+6正控/426聚焦；10反例7测试30重叠失败+3SDK-only/三SHA恢复；实际SDK169、四独立进程真实PNG公开/拒绝/下架/quarantine持久恢复与删除、proof保留/0重放写通过。[说明](P3e6d5_ORDINARY_IMAGE_DELETION.zh-CN.md)保留第一版错误删除动作控制/格式失败，不冒充业务红。review五代码/测试、原rowstore与后台删除入口和四记录，将供应商写冲突表述限定为契约设计，真实竞争未验证。最终5312全量、Node202282/19types/E2E/standingSDK/显式Biome/diff通过；精确build在commit review后，旧审批/lifecycle/final/UI/历史/真实三时钟20发布回退及原formal P1保持开放，producer关闭/fullDeliveryReady=false。


## P3e6d6：旧审批共用有效引用规划与全局预算

staged/atomic在原事务中共用只读C1规划，仅非零delta图读取小proof/合并计数，delta0保留base/ledger不加terminal读取；staged继续0共享图写，atomic保留原每图deletefence。原初读与C1重新pointget需一致；预先预留actor/product/job/SKU/image全部操作和每图1+P额外读，91/92合法、102/103及160proof先拒而0proof读。32新增，第一6业务红/第二13中10红3正控，176聚焦；24反例95重叠失败/三SHA恢复；实际SDK205/36新、四进程真实PNG旧审批切图/同job恢复0写/源分类保留/最终未发布与图404通过。全量5344、Node202314/19types/E2E/standingSDK/六文件Biome/diff通过。[说明](P3e6d6_LEGACY_APPROVAL_REFERENCES.zh-CN.md)明确这不是原发布丢响应恢复或20真实选品。review六源测试/C1/SDK桥接/预算及四记录，将所有非空ledger补读限定实际delta，保留公共C1独立验证。native全文件及原save/actor/classification fence字节未动。lifecycle/final/UI/历史/供应商与P95、test三时钟和20发布回退仍开放，producer关闭/fullDeliveryReady=false。


## P3e6d7：上传完成与存储保护引用状态

pending 上传激活/拒绝与 source pending 共用合法零引用校验；无账本旧缺计数可继续，显式 null/坏或非空账本拒绝零写。active 完成确认与同字节复核保留共享引用。native/JSON 在首个异步边界前复制命令，原权限与当前行检查仍在事务/文件锁内。存储保护 commit/release 通过实际 C1 结算串联证明保留当前计数/账本。44 项新增、282 项聚焦通过；17 个故障注入检出（182 次重叠失败及 2 个 SDK-only），六 SHA 恢复；安装 SDK 255 项、四独立进程真实 PNG 激活/丢回执/重开零写/未发布恢复与 404 通过。全量 5,388、Node 20 2,400、19 包 types/E2E types/standing SDK/显式 Biome 通过。审查五生产/三测试与四记录，把“上传零引用”限定 pending，核对 active 正控；原 save 权限/分类 fence 和生产 protection 整文件字节保持。[说明](P3e6d7_UPLOAD_REFERENCE_STATE.zh-CN.md)记录准确红测与后补控制边界。精确构建与编译后入口随后补充；原整条发布丢回执 P1、最终激活/UI/历史/真实云/P95/三时钟/20 件发布回退仍开放，producer 关闭/fullDeliveryReady=false。


## P3e6e1：同一操作根冻结服务器引用计划

内部 references 步骤复用原 actor/source/版本/策略/取消/TTL，只在所有页和 media 完成后，以当前商品 canonical 集合与 seal 完全相等生成 Merkle 承诺，绑定到原根；不写图片 pending、计数、终局 proof 或 published。重复/页/media/begin/cancel 保留绑定，读回重新推导树，坏页进度拒绝。新增 62 项，最终聚焦 286；实际基线复证 12 业务红，补 codec 反例先红。24 故障检出（22 测试组 201 重叠失败+2 SDK-only），连基线共 25 项/213 失败，五 SHA 恢复。安装 SDK 277/22 新、关联来源 7 实际操作/唯一根写/严格 ACK/丢确认和输入冻结，四进程重开/页/取消/零重复文件写与夹具清理通过。全量 5,450、Node 20 2,462、19 types/E2E/standing SDK/六文件 Biome/diff 通过。审查三生产/三测试与四记录，按真实头生成器推翻新增 retained IDs 的猜测，保留原规则并加集合门槛；[说明](P3e6e1_OWN_REFERENCE_PLAN.zh-CN.md)区分测试夹具修正、冗余取消保护、纯容量与云 P95。native/JSON adapter 和原权限/分类 fence 全文件未改。精确三函数/site 与非空 PNG worker 组合随后补证；pending stage/final activation/UI/历史/真实云/P95/三时钟与20发布恢复及原整条发布丢回执 P1 仍开放，producer 关闭/fullDeliveryReady=false。


## P3e6e2a：纯pending暂存及满槽分类

原引用纯模块新增stage转换：验证明确base、完整旧账本和成员，同根完全重复零变化、重绑定拒绝，保留未知root、推进epoch并以原80/128KiB预算控制。PENDING_FULL与坏账本区分，实际自动恢复尚未接通。30新增初始为缺函数结构红；原20/50/100和2,000步真值模型的两处手工数组改接实际转换，原真值断言不变。152聚焦、15反例43重叠失败/源码SHA恢复、实际Node20单模块与Python独立3转换/hash验证、现有SDK277重新构建通过。全量5,480/Node202,492、19types/E2E/standingSDK/三文件Biome/diff通过。审查转换/新测试/模型/C1与四记录，明确抽象undefined不得替代真实字段存在性检查、满槽仍需持久化续接，而非已经实现恢复。[说明](P3e6e2a_PENDING_STAGE_TRANSITION.zh-CN.md)保留结构红/格式修正和冗余门槛事实。无DB/SDK新调用、native/JSON/原root/fence未改；暂存producer/final/UI/历史/云P95与实际三时钟20件验收仍开放，原P1/fullDeliveryReady=false。


## P3e6e2b 原根图片暂存及取消终局

同一事务按预算暂存图片与原根hash/cursor；全体终局结算、当前pixel证据与锁/actor/source/TTL检查保留。取消只写自身永久标记+同一不可变cancel槽，不翻转commit或删除他人pending。49新增/相关365、完整5529、Node202541、19types/E2E/standingSDK/六文件Biome通过；38故障全部检出、198重叠unit失败+三SDK-only/五SHA恢复；329安装SDK最大98文档操作。真实PNG四进程暂存丢回应/重开/取消结算通过，匿名始终404且分类/字节保留；采用独立快照，父文件未改。P3e6e1 的两项旧 late-capture 负例把复制结果字段写成 value，实际入口读取 command，因而当时失败不能单独证明等待期间改写输入。保留旧日志与历史计数，本轮改为 command 后重证：正常 JSON27 流程仍通过，JSON 锁等待输入用例失败；安装 SDK 的正常用例先完成261项，随后真实 startTransaction 等待输入用例失败。恢复后329项 SDK 与完整回归通过。新证据替代旧两项的因果解释，不改写原日志。

详见[P3e6e2b](P3e6e2b_OWN_REFERENCE_PAGES.zh-CN.md)。人工审阅六代码/测试文件和四记录文档；改正自动恢复/metadata/进程范围的表述。精确构建随后补跑，原整笔发布P1/全局fullDeliveryReady=false保留，继续最终提交与恢复。


## P3e6e3 原操作最终发布及完成回执

同事务写product、原根complete+completion及唯一commit proof；复核当前媒体、全部暂存、原版本/actor/source/TTL，未决Changed/Removed拒绝。历史重放经原proof核对，只读且不会使已下架商品重新上线。补普通managed图片内容稳定守卫，名称和既有mutex保留。56新增，381相关、5585全量、Node202597、19types/E2E/SDK/六文件Biome通过；27源码故障101重叠失败+2SDK-only/五SHA恢复，399实际SDK最终15操作/三写及九ACK回滚、丢确认恢复。真实PNG五进程发布200/重开0写/编译admin下架404/分类字节保留及自有夹具清理通过；移除保护另实际复现商品200/图404。首次缺主图夹具被正确拒绝；改用完整warm手工夹具，不冒充来源时钟。SDK递归脚本别名、截止测试时点和冗余codec负例缺口均有记录。详见[P3e6e3](P3e6e3_OWN_PUBLICATION.zh-CN.md)。人工审阅六代码/测试文件与四文档，把当前成功/历史完成分开。精确产物后补，正式UI原P1、fullDeliveryReady=false及真实验收继续。


## P3e6e4 原根可信永久退役

当前admin按原scope核对服务器owner/root/input，仅过期、撤权/缺失owner、输入失效可退役；健康只读、complete核对commit proof历史只读，原owner不会被替换。原根首次cancel与唯一cancel proof同事务，审计actor/reason/at仅服务器产生，精确重复0写。review补了资格读与最后product/proof读两处时钟窗口，共四反例先红后修。48新增（DB40/JSON8），394相关/5633全量/2645Node20，19types/E2E/standingSDK/四文件Biome通过。最终30故障85重叠失败+3SDK-only、四SHA恢复，441安装SDK恢复后重跑通过；真实80root满槽→可信退役一项→原第81页续接保留80pending/effective0，不冒充自动清理。四进程真实PNG重开审计/旧owner拒绝/分类私有字节保留及夹具清理通过。详见[P3e6e4](P3e6e4_TRUSTED_OPERATION_RECOVERY.zh-CN.md)，记录冗余保护未检出反例与类型收窄修正。人工审阅两生产/两测试/四文档并纠正恢复≠接管发布的措辞。精确构建待提交后补充；原UI P1、server caller、liveedit/review/真实provider/P95/三时钟20件验收继续，fullDeliveryReady=false。


## P3e7a 有界操作状态入口

既有鉴权/rollout下增加独立公开start/get/cancel，DB index facade严格映射到原内核；旧workflow不改，全部内部命令拒绝保留。start沿原256KiB预算支持正常长描述；shared响应白名单4096字节，仅进度/身份/时间/小回执，无大根/来源/patch。complete与current分开、cancelledAt/expired可查询，取消与查询不保存或发布。53新增（17shared/9DB/27实际Admin+JSON），315相关、5686全量、Node202698、19types/E2E/SDK/九文件Biome通过；12故障46重叠失败/四SHA恢复，459安装SDK包含18新raw+真实indexfacade ACK/丢回应/捕获与历史控制。初版旧workflow类型扩散、两个错误夹具、strict/进度反例与实际原版Zod3合约核对详见[P3e7a](P3e7a_OPERATION_STATUS_API.zh-CN.md)。人工审阅九代码/测试/配置与四文档并纠正历史完成措辞。精确编译产物后补；客户UI接线、满槽caller/liveedit/review/provider/P95/三时钟20件及原UI P1继续，fullDeliveryReady=false。


## P3e7b 生产入口的有界满槽恢复

index真实调用恢复封装器，仅PENDING_FULL hint触发；重查自身scope/版本/冻结页，完整验证实际图账本，每次最多3根，原可信恢复事务判资格，终局后只重试原页。完整ledger哈希游标可续接，变化重置，未知IO/权限失败停止，12s单调预算覆盖所有异步边界。38新增（DB37/JSON1），441相关/5724全量/2736Node20/19types/E2E/SDK/七文件Biome通过；20故障56重叠失败+2SDK-only/五SHA恢复，474安装SDK含正常页88操作零发现、六ACK回滚、取消提交丢回应及候选读故障。actualJSON80根自动旧根退役→原81页续接保持80pending/effective0；物理PNG四进程为2真实根+79合成，重开与取消回退/privateSHA/category/fixturecleanup通过。首次脚本把inputDigest带入get被正确拒绝，修正夹具后通过。详见[P3e7b](P3e7b_BOUNDED_REFERENCE_RECOVERY.zh-CN.md)并保留模拟调度/实际资格/混合编译/真实云的界限。人工审阅五生产/两测试/四文档，纠正全部自动清理措辞；客户continue/UI仍未接，原UI P1/fullDeliveryReady=false继续。


## P3e7c1 原提交与服务器补全冻结

公开 start 记录原提交摘要，可信服务器仅补 supplierDecisions，冻结实际 withAdminEditsKept 输出；精确保存约束保留。同原提交重放首次决定，来源变化/并发/提交丢回应均不重算；旧根严格兼容，公开摘要注入拒绝。原 256 KiB 容量完整保留，独立最坏元数据 475 字节，无第二份大 patch。27 新增、495 相关/5751 全量/2763 Node20、19types/E2E/standingSDK/六文件Biome 通过。9 故障（15 重叠失败+1 SDK-only）/三源码 SHA 恢复，498 安装 SDK 控制通过。网站描述超限反例已提前到补全前并保留字段原因。人工核对三生产/三测试/四记录，纠正无 normalizer 摘要与旧类型诊断数量措辞；详见 [P3e7c1](P3e7c1_OWNED_START_NORMALIZATION.zh-CN.md)。精确产物后补，下一步接实际 Admin，原 UI P1/真实云/P95/三时钟20验收未关闭，fullDeliveryReady=false。


## P3e7c2 实际 Admin 开始与绑定草稿保存

Admin start调用既有keep规则；新save仅接受原scope/digest，从根取冻结patch并经原生事务保存商品/身份+回执，再返回小状态。已保存历史只读，publish意图仍只存草稿；无分类可保存。实际URL反例暴露底层只规范占用键，已提取原Admin纯身份规则到shared并在冻结前共用，旧根保留原稿/未规范reserved拒绝重写。37新增、555串联/5788整包/2823Node20、19types/E2E/SDK/11Biome通过；9故障33重叠失败+2SDK-only/四SHA恢复，518SDK含六ACK回滚和提交丢回应，普通无新图保存3笔事务3/7/3操作。独立无normalizer故障曾幸存，补真实facade控制后全重跑。详见[P3e7c2](P3e7c2_ADMIN_OWNED_DRAFT_SAVE.zh-CN.md)，保留测试路径/夹具/类型修正与真实云界限。人工检查11代码/测试及四记录，纠正字段规范化归属。精确提交产物后补；原UI P1/continue/live/review/真实provider/P95/三时钟20件验收未关闭，fullDeliveryReady=false。


## P3e7c3 来源准备接同根审批seed

实际Admin continue复用C2保存和source共享派生缓存，服务器完整读候选并在原根begin，不另起job；save-draft止于saved、publish止于staging，不发布/清审/导入新图。35新增（shared7/local28），593相关/5823整包/2858Node20、19types/E2E/standingSDK/八Biome通过；13故障15重叠失败+7SDK-only/五注入文件恢复及一读取文件SHA保持，551SDK保留原518且验证6/7(+6)事务操作与21配置外读。postseed取消/编辑曾返回失效进度，已红绿修复；facts夹具100假设按真实256契约改成101正例/257负例。manual/0/21/105SKU、原根/网站字段保留、预算8读/源码页续接、坏来源与丢回应恢复覆盖。详见[P3e7c3](P3e7c3_OWNED_APPROVAL_SEED.zh-CN.md)。人工review八代码/测试及四记录，明确整候选点读尚无跨请求游标，C3b需在启用客户producer前解决；原UI P1及真实验收未关闭/fullDeliveryReady=false。精确提交产物后补。


## P3e7c3b 复用完整来源候选

实际Admin seed复用本请求canonical来源计划，核对原根source五元组/商品，原native配置页继续核对实际数据。16新增/69相关/5839全包/Node202874/19types/E2E/standingSDK/七Biome通过；10故障76重叠失败/四SHA恢复，567SDK覆盖cold0/warm21/cold105及全native配置页、ACK/丢确认/坏读/篡改。修正native字段顺序导致指纹不同和新增parse丢失旧source-page原因两处回退；确认optionValues为生效选项后补真实篡改断言，未改业务规则。4096只验证初始化及缺缓存拒绝，不是全发布/P95。人工逐一核对七代码/测试及原native/root/只读SKU注册，具体措辞和未完成项见[P3e7c3b](P3e7c3b_SOURCE_CANDIDATE_REUSE.zh-CN.md)。全部源码恢复，完整来源/大量照片链接的真实provider预算仍未证实；原UI P1与完整continue/真实验收开放，fullDeliveryReady=false，精确产物后补。


## P3e7c4 自动推进原操作配置页

continue在原saved seed和staging重开均按持久cursor调用原native配置页；页后读回scope/current/进展，超时不追加，无进展ok拒绝。13新增/82相关/5852完整覆盖（5851全包后新增并发，受影响local913及Node202887重跑）、19types/E2E/standingSDK/两Biome通过；9故障71重叠失败/controllerSHA恢复，578SDK含六ACK回滚/页提交丢确认从下一页续接。cold0/21/105全页、同根双续接收敛21唯一配置、取消/编辑/撤权/预算与controller500合成边界通过。旧seed阶段断言按新行为调整且保留初始化独立检查和actualHTTP坏/缺缓存拒绝。人工核对两代码/测试和原native页/DTO/源绑定，纠正500与零写范围，详见[P3e7c4](P3e7c4_OWNED_CONFIGURATION_CONTINUE.zh-CN.md)。精确构建/12+2进程补充待提交后执行；完整媒体/引用/最终发布及真实验收继续，fullDeliveryReady=false。


## P3e7c5a 已有媒体就绪回执转交

全配置后通过原native命令转已有ready媒体回执，真实小状态读回才确认；缺ready保留staging，其他失败/未知IO不吞，已mediaReady跳过、预算到期不追加。16新增/98相关/5868当前完整覆盖（5863全包后补5例，受影响local929及Node202903重跑）/19types/E2E/standingSDK/两Biome通过；11故障40重叠/controllerSHA恢复，587SDK含6/12/6事务/root三ACK回滚和media丢commit零写重开。暖缓存/重建source后从saved seed转交、取消/编辑/撤权、坏/缺回执、原生错误原因与预算分支验证。metadata声明只验协议，实际PNG另用精确编译worker补充；SDKmock漏集合和预算初例冗余均已记录。人工核对两改动文件及native媒体/finish/DTO/源/worker，纠正“媒体完成”与实际字节范围，详见[P3e7c5 A段](P3e7c5_OWNED_MEDIA_CONTINUE.zh-CN.md)。冷媒体必须先准备再seed；completed旧seal与当前映射不符的恢复尚待复现，不能假称retry可解。精确产物后补，原UI/完整发布及真实验收继续，fullDeliveryReady=false。


## P3e7c5b 冷媒体与原审批任务串联

实际Admin continue复用签名preparation start/status/continue；先导入未绑定来源照片，下一请求重投影后同根seed，staging时同job分段检查并转真实ready回执。严格scope/current/TTL、10秒启动余量，异步等待后及invoke前重查；取消后已发出的worker最多写私有结果。共享响应增加4096预算内的continue/wait/retry/edit/repair提示，浏览器不能指定authority/invoker。57新增/154相关/5925完整覆盖（105图补例后local980、Node20 2960重跑）/19包类型+E2E类型/8Biome/standing SDK通过；10故障21重叠/三SHA恢复，592安装SDK通过。实际PNG105图与并发、503后原job恢复、丢回应和旧seal错集合已测试。修正文案“adapter restart”及错误retry断言，SDK零图、实际PNG、真实云范围分开，详见[P3e7c5 B段](P3e7c5_OWNED_MEDIA_CONTINUE.zh-CN.md)。旧seal需P5修复、慢DB wait需fallback，客户UI/最终发布与真实验收未关闭，fullDeliveryReady=false。


## P3e7c6 原任务引用页续接

实际continue在媒体ready后冻结原引用承诺、按真实staged逐页暂存，继承父剩余预算。明确MEDIA_BUSY返回有界恢复游标，下一请求携回，服务端重验实际页/账本摘要；客户端不控制图片列表、增量或预算。54新增/521相关/5979全包+脚本/Node20 3014/19类型+E2E/9Biome/standing SDK通过；11故障12重叠另1SDK、5SHA恢复，604安装SDK含88/36页事务、6ACK回滚、提交丢回应、证据读错误和实际Admin满80槽offset3续第四成员。真实21PNG20+1、零图、并发、取消/预算和公开HTTP404已测；105图组合保留。旧媒体阶段断言按新增引用阶段调整并保留无重复媒体写；相对路径/冗余类型判断/探针漏ID及变量范围错误记录于[P3e7c6](P3e7c6_OWNED_REFERENCE_CONTINUE.zh-CN.md)。当前仍只暂存私有引用，最终发布/UI/现场验收未关闭，fullDeliveryReady=false。


## P3e7c7a 最终事务核对分类目录

原native最终3写之前读取当前taxonomy，复用shared归属校验；非法赋值classify、损坏目录system-repair、未知IO不当缺行。空归属/已有archive/显式Headphones旧wired保留，目录不写入且不新增锁。3红→8新增/326native/529相关/5987全包/3022Node20/19类型+E2E/两Biome/standing SDK通过；5故障10重叠/单SHA恢复，610安装SDK含6分类控制，最终16文档操作仍3写，全套98。实际核对两文件、shared taxonomy及原分类保存/目录管理与最终回执，澄清旧Headphones正例带主分类，缺主类不自动补。精确产物停留d67cf6ab，下一完整caller小流程一并构建；未启用客户UI/未部署/真实验收未完成，详见[P3e7c7a](P3e7c7a_FINAL_CLASSIFICATION.zh-CN.md)。


## P3e7c7b 原任务最终发布调用

默认 manager 在配置/媒体/引用完成后调用原 native 最终事务，完成必须读回同 scope 和批准 revision；丢回应查原根，未知结果不猜成功，历史完成不重新发布。30 新增、584 相关、7 包和部署脚本 6017、Node20 3052、19 包类型/E2E/7 文件 Biome/standing SDK 通过。11 故障检出 16 重叠失败，3 源码 SHA 恢复；626 安装 SDK 保留最高 98 文档预算，最终仍 16 操作/3 写。实际 PNG 的本地 20 隔离手工商品 4 并发发布、逐件公开读回、实际 Admin 下架、共享引用归零及历史任务不复活通过；allSettled 确保清理前工作者全部结束。人工逐项核对 7 文件及 native/handler/DTO，把本地 20 与真实选品、准入预算与网络性能分开。精确产物留在本提交后按 SHA 验证；原 UI P1、review/live/新图/P5 和真实现场门槛未关闭，详见 [P3e7c7b](P3e7c7b_OWNED_FINAL_CONTINUE.zh-CN.md)，fullDeliveryReady=false。


## P3e7c8 最终事务同步确认供应商审阅

New/旧首次、手工 Edited、完整当前来源的 Changed/Removed 使用原最终事务同步确认标记与批准；当前 Keep 可批准，未应用 incoming/旧决定/新来源摘要拒绝并带 remedy。Admin/native 共享比较与 URL 规则；正常无标记零新增读，来源首次/已链接 Edited17 文档操作、27 照片44，仍3写/全套最高98。45新增/638关联/6062相关包和脚本/3097Node20/19类型+E2E/7Biome/standingSDK通过。人工review发现并修复已链接 Edited 误走手工提前返回的P2，先红再绿，受影响包重测；14故障25重叠/三SHA恢复，651安装SDK含9坏ACK整体验证及丢回应。实际审阅7文件、DEC规则、原快照/媒体/引用，澄清完整来源草稿与所有Removed、文档操作与读次数的范围。精确产物留本提交后；UI P1及其余交付门槛未关闭，详见[P3e7c8](P3e7c8_OWNED_SOURCE_REVIEW.zh-CN.md)，fullDeliveryReady=false。


## P3e7c9a 浏览器发布任务契约与原scope查询

新增单次公开RPC和严格发布状态客户端；固定UUID/深拷贝冻结输入，未知回应只查原根，双重失败保留不可变scope和两错误，明确issues保留。66新增含3条客户端模块↔真实Admin/JSON/PNG组合及实际下架/引用归零；默认fetch绑定也独立验证。17故障24重叠/两SHA恢复；site863、local1057、Node20最新完整关联3163、19类型/E2E/既有test类型/5Biome/site构建通过，其他未变相关包复用4e5证据，总6128。期间一次Node20旧JSON80夹具begin返回false，诊断重跑及3轮两控制均未复现，原因未建立，继续作为发版阻断；首轮raw被覆盖但工具输出失败摘录已留，后续日志独立命名。实际审阅5代码/测试，纠正明确错误与私有进度、模块串联与真实浏览器的措辞；未启用客户producer，原UI P1/JSON80未解释失败均未关闭，详见[P3e7c9a](P3e7c9a_PUBLICATION_CLIENT_CONTRACT.zh-CN.md)，fullDeliveryReady=false。


## P3e7c9b 单商品原发布任务协调

新建原scope协调器，恢复先查询，显式错误后核对已保存私有进度，媒体改走独立Human预算后续原发布，引用检查点按真实阶段保留/清除；120秒/64请求与无进展退避，回调失败暂停且迟到拒绝被处理。61新增（54控制+7实际Admin/JSON/PNG组合）、site924/local1057/Node203224、19包与E2E类型/既有测试类型/4Biome/15页构建通过；复用未变C8相关包证据合计6189，651安装SDK仍C8。14故障19重叠/SHA恢复；首轮旧游标故障幸存后补BUSY确认控制，再全轮检出。实际保存延迟2200毫秒触发inline预算耗尽，独立Human及丢回应恢复、105SKU、公开读回/实际撤回与保留原分类均本地通过；未当真实浏览器/云性能。人工审阅四代码/测试与原入口/DTO/循环，纠正committed与已公开、停止等待与服务器取消的措辞。客户producer未接，原UI P1/JSON80原因不明及其余现场门槛未关闭，详见[P3e7c9b](P3e7c9b_PUBLICATION_COORDINATOR.zh-CN.md)，fullDeliveryReady=false。


## P3e7c9c 浏览器原scope恢复记录

每操作分键并按actor/API环境隔离，首次请求前存ID、真实状态补digest，仅存指针和服务端游标；存储getter/读取/写删失败保留内存与明确状态，支持限量完整/指定scope导出及预检导入。共享checkpoint schema和协调器第二回调保留get省略的有效游标，已知进度写只点读自己的键。44新增（40记录/1检查点/1真实API刷新恢复/2实际Chromium+WebKit存储），site968/local1057/Node203266、19包/E2E/既有测试类型、7Biome/15页构建通过；未变C8证据合计6233，651安装SDK和精确后端仍C8。13故障13重叠/两SHA恢复；pending回滚、导入后部损坏、重复扫描及假完整导出均有红绿。实际审阅七代码/测试和session，纠正500准入/跨标签CAS及Storage行为范围；首轮假磁盘getter夹具已修正。发现原session泛storage监听和未保护getter，接UI前继续单独修复；客户producer未接，原UI P1/JSON80原因及现场门槛开放，详见[P3e7c9c](P3e7c9c_PUBLICATION_RECOVERY_RECORD.zh-CN.md)，fullDeliveryReady=false。


## P3e7c9c2 过滤恢复记录引起的无关会话通知

onAuthChange只转发token/user/clear的storage事件，本地auth事件保留，取消订阅移除实际闭包。两浏览器双标签原来3次而应1次，10控制和2增强浏览器测试先5过/7败再全绿；6故障12重叠/SHA恢复。site978、Node20客户端179、19包/E2E/既有测试类型、3Biome/15页构建通过；未变后端/契约核对C8哈希，完整Node203266仍67091f62基线，相关证据6243含复用包，651安装SDK未冒称本步重跑。实际审阅三个代码/测试和useSession/媒体负控制，将“所有刷新修复”改为“无关键不触发登录订阅”。storage泛监听启用阻断已关闭；getter失效、原UI P1/JSON80和现场门槛开放，详见[P3e7c9c2](P3e7c9c2_AUTH_STORAGE_EVENT_SCOPE.zh-CN.md)，fullDeliveryReady=false。


## P3e7d1 官网详情和原发布回执只读确认

新增checkPublication，两次同scope get夹住revision绑定的匿名公开GET，最后仍为同一complete/current才confirmed；结果类型强制回执/revision/名称。公开失败继续查原根识别撤回，所有恢复仅只读；8秒预算、共享1792KiB流上限、取消与解码失败清理。37新增（33控制+4实际Admin/JSON/PNG），site1015/Node20客户端216、19包/E2E/既有测试类型、3Biome/15页构建通过；未变C8证据合计6280，完整Node203266仍67091f62。15故障20重叠/两轮源码恢复；两条流/取消红测、默认POST/GET传输及加强非法输入断言均验证。实际review三代码/测试和公开路由/DTO/分页，澄清当前确认与后来撤回、只读恢复与重新发布。发现媒体5秒容差和原任务负age即过期的不一致，尚未归因JSON80，继续独立偏移对照；原UI/JSON80/其余现场门槛开放，详见[P3e7d1](P3e7d1_PUBLICATION_READBACK.zh-CN.md)，fullDeliveryReady=false。


## P3e7d1b 统一原发布任务的可信时间边界

媒体已有5秒容差而原任务拒绝所有负age，1/500/5000ms可信根会被误标过期。复用已有常量修复所有保存/get/媒体/引用/最终发布/取消/恢复的时间判断，NaN失败关闭、1小时上界不变；版本/prepared独立对照保持拒绝。18新增，6298相关回归、Node203331、19包/E2E类型/既有站点测试类型、5Biome/CloudBase合约通过，657安装SDK对照最高98文档操作。13故障18重叠/两SHA恢复；首次晚恢复finalAge遗漏有红测后修复。实际0/105SKU偏移2秒完成公开同revision读回与撤回/404/有效引用0/分类保留。review实际五代码/测试、媒体authority、删除保护和本文，纠正原JSON80原因归属，未将此独立复现当现场根因。精确构建待续，原UI/getter/JSON80/真实test门槛开放，详见[P3e7d1b](P3e7d1b_OPERATION_CLOCK_BOUNDARY.zh-CN.md)，fullDeliveryReady=false。


## P3e7d1c 同原任务恢复一次短暂冲突

原scope读回仍有效后，只对无具体字段证据或精确HTTP通用INPUT_CHANGED fallback的CONFLICT允许一次400ms恢复；重复冲突不重置，终态/版本/测量issue/身份/确认失败/observer/取消都阻止后续写。18新增，85子流程、site1033/Node203349、站点/E2E/既有测试类型、3Biome/15页构建通过；复用9efd824c未变包合计6316。实际0/105SKU在native begin一次拒绝后原任务发布/公开读回/实际撤回，分类保留/404/有效引用0。9故障40重叠/SHA恢复；首轮漏掉终态多等400ms的断言已补，HTTP通用issue差异与夹具测量合约修正保留红测。实际review三代码/测试、handler/shared/native守卫及措辞，原JSON80原因未明、未当现场根因；后端精确构建/657SDK/14进程仍9efd824c，真实test未做，详见[P3e7d1c](P3e7d1c_TRANSIENT_CONFLICT.zh-CN.md)，fullDeliveryReady=false。


## P3e7d1d 会话读取失败保护

getToken/getUser共用try内的真实存储读取，getter/getItem抛错、无浏览器存储都返回未登录；恢复后重新读新值，不缓存身份。7新控制+2增强真实Chromium/WebKit，先9项6红后含既有通知19全绿；2故障10重叠/SHA恢复。site1040/Node20客户端241、站点/E2E/既有测试类型、3Biome/15页构建通过，合计6323含未变基线。review实际三代码/测试与useSession/DashboardShell/AdminApp/AccountMenu，纠正“整个后台降级完成”的措辞：clearSession/setSession失败的反馈仍待处理，不能以读取局部绿测冒称完整流程成功。原正式UI/P5/JSON80及真实20件test发布恢复门槛开放，详见[P3e7d1d](P3e7d1d_SESSION_READ_FALLBACK.zh-CN.md)，fullDeliveryReady=false。


## P3e7d2 同页面共享批量发布队列

新增createPublicationBatch：20分组至100件、模块共享4、冻结选择、后台me确认及原token/actor/endpoint绑定，首次请求前持久指针，只有同scope/digest/revision的公开确认计成功。撤权/存储/observer/取消停后续写，活动worker全部settle后才返回，finally释放名额与单商品producer保护。35新增（32控制+3实际默认HTTP/Admin/JSON/PNG），20/100混合现有分类共图全部确认并按自己receipt撤回，字段存在性/分类保留、404/有效引用0；无主分类样本不补分类。旧20/100任务批量恢复均historical、无新start/公开GET且JSON不变。

site1075/Node20客户端276、站点/E2E/既有测试类型、3Biome/15页构建通过；6358相关证据含未变包，完整Node203349仍5024700b，后端657SDK/14进程仍9efd824c。12故障25重叠/SHA恢复；首轮游标断言被unknown捕获掩盖的缺口已移到外层修复。后台撤权和错误确认两红修复，原生组合身份对照纠正跨商品UUID过严约束，稀疏项拒绝。review实际三代码/测试及runner/check/journal/api/native身份/UI调用链，纠正模块共享4与跨标签全局锁、夹具耗时与云P95措辞。客户UI仍旧路径、旧JSON80原因与P5/真实test门槛开放，详见[P3e7d2](P3e7d2_SHARED_PUBLICATION_BATCH.zh-CN.md)，fullDeliveryReady=false。


## P3e7d3 会话存储失败反馈与旧回应保护

写/删失败转明确SessionApiError，原后台错误卡片可重试同一退出目标；两种AccountMenu在部分清除后转未登录仍有Retry sign out。检查中旧me成功/401回应不得覆盖或退出新账号，按绑定token/账号重查；错误消息和重试目标用同一状态类型，不伪称两次Storage调用原子。30新增＝8Node+20实际UI子流程+2浏览器父项；site1105/Node20客户端284、站点/E2E/既有测试类型、6Biome/15页通过，6388相关证据含未变包。

10故障29重叠/3SHA恢复；首轮第10项55秒看门狗未计通过、旧stdout缺口有工具摘要，增加可见性断言和超时留档后全轮检出。部分退出丢重试入口有明确红测后修复；30小流程最终全绿。16合成截图唯一r4目录/哈希，已看1280后台卡片与390部分退出；未冒称真实云账号或整站Header验收。review实际6代码/测试及调用者/React文档，纠正“所有账号切换/原子存储已修复”措辞：仅检查中的竞争，本已进入后台的表单/身份组合仍P4。后端SDK/精确进程仍9efd824c，原UI/P5/JSON80和真实test门槛开放，详见[P3e7d3](P3e7d3_SESSION_STORAGE_FEEDBACK.zh-CN.md)，fullDeliveryReady=false。


## P3e7d4 分类弹窗接入原操作发布

Save and publish 采用全部分类 saved 回执的 updatedAt 创建一次原尝试，重试保持 scope/digest/cursor；只读刷新核对原任务和匿名官网，不再从 published 行推断本次成功。重开已发布但结果不明的选品可通过独立恢复入口查询；有查询、继续、停止、导出。停止先核对原 digest，完成竞争不会误报撤回；存储故障阻止写入但允许原任务查询，恢复后沿用原尝试。分类 BUSY 每次发送前后校验最初会话，卸载中止后续浏览器请求。

32 新增＝14 Node + 16 实际浏览器子流程 + 2 父项；site1137/Node20最终改动核心46、类型、10Biome、15页构建通过。两引擎各20实际本地选品发布并撤回/404/有效引用0；响应丢失重开恢复不新增分类/start，单件坏图不阻断同批正常件，账号切换/并发改稿/仅保存/存储配额有验证。9故障14重叠、4SHA恢复；最终10截图唯一r6及哈希，实际看桌面恢复/390部分失败。首轮1134/1136中两条旧审批拦截已改为原 continue 暂停，保持1440/390新版本不可审批和JSON不变的断言。review补了无digest指针的交叉绑定校验并保留红测；文字修正单数和恢复时不发布草稿的误导提示。

本轮不冒称正式Astro旧拦截、混合分类保留、大批次UI、跨标签多任务/不存在任务fallback、P4/P5/JSON80以及实际云验收完成；Node20真实20/100集成48在review末次绑定补充之前，最终site重新覆盖。后端精确制品/657SDK/14进程仍9efd824c，详见[P3e7d4](P3e7d4_CLASSIFICATION_OWNED_PUBLICATION.zh-CN.md)，fullDeliveryReady=false。


## P3e7d5 分类正式流程、发布能力与冷共享图片

分类弹窗查询现有能力：关闭/失败/加载/旧缓存重查都禁发布，保留分类保存和只读重试。正式测试的update/approve拦截改为原start/continue/get，只在真实complete后丢回应；回执、读回失败、焦点与切区断点均保留，结束按自己operationId撤回。正式夹具补有效PNG及byteSize/SHA；未放宽生产校验。补元数据后真实暴露冷共享图片的worker rejected/BUSY仍queued但客户端停止，现仅对明确BUSY按同job新状态最多四次恢复，租约/attempt/创建时刻/当前性与原发布守卫保留，未知响应不重发。

20新增（12准备/1能力/6实际浏览器子流程/1冷20集成）；site1157、Node20核心163及4实际暖20/暖100/缺分类/冷20通过，冷20 UI两引擎完成后均恢复。最终正式后台8/8、关闭能力1/1，均无失败/skip；前序r7旧拦截1过1败6未跑留档。11故障22重叠、3SHA恢复；16最终截图/哈希，已看390缓存错误与1280冷20。类型、11Biome、15页构建通过。缓存StrictMode请求数红测未计产品缺陷，后续实际按钮enabled反例才是产品红测；文案明确记录、字节、BUSY三阶段，未把局部通过等同实际云完成。

实际review11文件与handler/工作流/共享队列/图片守卫。分类正式UI门槛关闭，其他P3/P4/P5及真实3时钟resync/20件test发布恢复、原JSON80归因和云性能仍开放；后端精确制品/SDK657/14进程仍9efd824c，详见[P3e7d5](P3e7d5_FORMAL_PUBLICATION_FLOW.zh-CN.md)，fullDeliveryReady=false。

P3e7d5 exact review（6359cc38）发现一处测试清理缺口：colliding readback gate 未登记到外层 finally，内层 try 前的断言失败可能卡住 unrouteAll，阻止恢复。已登记 release，正式构建后台 r11 八条再过，0 skip/flaky/retry；生产源码未变，保留本轮未部署状态。

## P3e7d6 保留各商品分类的发布入口（实施中）

场景：20件已有不同主/子分类的未发布商品，原弹窗只有统一 replace/append/clear，无法按用户要求保留各自分类发布。使用明确的本地 preserve 提交形状（kind、products原updatedAt、includeSavedRevision），不发 assignment、不伪造 saved 回执；原发布 attempt values={}，复用身份、journal、共享4及官网原回执读回。现有分类字段包含缺省/空数组/legacy值，在完成和撤回后逐字段及存在性核对。预览每件原分类；确认绑定选中版本，编辑冲突由原协议拒绝。红测为实际两引擎20件混合分类零assignment；另补缺分类部分失败、恢复和冲突，保留20件产品范围，不扩到100件UI。

P3e7d6 本地验收完成：新增13（4核心+8两引擎子流程+1正式20），site1169、最终浏览器32、Node20核心10、正式9/9；类型、5Biome、15页构建及3故障检出/SHA恢复。混合分类20件全过程无assignment、原回执/官网revision读回及撤回后分类存在性保留。r12夹具错误、r13外置JSON超时、r14根守卫、r16新测试hydration选择器错误均留档；相同源码/60秒断言的内部临时DB对照通过，非云P95。实际review五文件及CollectionView/协议/批次；详见[P3e7d6](P3e7d6_PRESERVE_CLASSIFICATION.zh-CN.md)。未部署、fullDeliveryReady=false。


## P3e7d7 创建草稿原回执与页面恢复（本地完成）

已落地 catalogProductCreate start/get：actor+attempt固定产品ID、输入摘要、原子create同存私有回执；不加集合或SDK方法。createRecord 商品入口改用该协议，未知结果先查原尝试；创建journal和发布namespace隔离，保存前确认持久化，重开可查回原商品，原输入更改/换账号会拒绝冒充原尝试。新ProductCreateForm接CollectionView，保留既有RecordForm和New归档选项；已恢复商品禁重复提交，未提交输入可先本地导出，再显式打开现有Edit。既有产品版本严格单调，不能以同毫秒时间碰撞为由再加一套版本机制。

本地：site1191、Admin638、Node20最终84、最终两浏览器10，正式后台10条及最后精确构建创建流程1条通过，无skip/flaky/retry；Astro0/0/8提示、测试/E2E/Admin类型、16Biome通过。最后导出UI改动仅重跑对应浏览器与正式创建流程，未伪称又全跑一次。四个突变检出/三SHA恢复；实际已看390恢复截图。r1 Name必填星号选择器、API类型死分支、初稿Archived兼容性红测均保留证据，已修正；真实商品没有变动。

Review16文件并对照原子身份、图片锁、权限、redact、journal、原Edit；将“创建完成”更正为“草稿本地单元完成”，未发布状态不从失败推测。完整说明见[P3e7d7](P3e7d7_CREATE_RECOVERY.zh-CN.md)。创建后发布旧路径及P4/P5/P6/P7仍开放，fullDeliveryReady=false，SDK/精确制品的最后完整证明仍为前序记录，不以本轮源码测试冒充新制品验收。当前会话原目录写入及本地监听已恢复，未重新挂载，原有148个提交与数据未丢。


## P3e7d8：创建后的原生发布与恢复

新商品完成创建后改走原 owned publication；补空 patch 原版本元数据，让最早的未到达请求按同 ID 显式继续/停止，Check只读。创建指针保留到打开已有商品前，未决任务先恢复；打开前重读商品，避免用旧快照覆盖后来编辑。真实浏览器抓到缺描述末端拒绝，现复用原规则在创建前提示，保留草稿、描述图片和询价兼容。另修 nonce 失败已保存上下文、关闭审批的不存在任务入口、未到达且过时的请求停止出口；缺失 root 最终读回失败必须保持未决。

site完整1219 pass / 0 fail / 1环境门控，门控图库浏览器另启用1/1；Node20相关271/271；两浏览器创建22/22（包含于site）；15页构建后后台11/11（含20件保留分类及恢复）。Astro 0errors/0warnings/8hints，site/E2E类型与19文件Biome通过。四故障四检出/SHA恢复。首轮故障选择器未选中、浏览器异步导航夹具、清理代码变量、构建上传凭证缺失、E2E导入站点类型边界等失败均留档并分别更正，未用最后绿测覆盖历史失败。

Review实际19代码/测试与原生事务、monotonicProductTime、validateProductPublication、既有界面调用者，纠正“未发布”和“构建上传已验收”的误导表达。构建新增用例用真实HTTP及已有合法PNG准备原任务并验收界面恢复，未模拟上传成功；真实上传仍待test/COS。已实看390px恢复截图。创建后发布本地单元完成；表格旧链、P4/P5/P6/P7与原JSON80归因仍开放，fullDeliveryReady=false。详见[P3e7d8](P3e7d8_NATIVE_PUBLICATION_ENTRYPOINTS.zh-CN.md)。


## P3e7d9：表格草稿发布与可恢复原任务（2026-10-20）

实现范围见[P3e7d9](P3e7d9_TABLE_PUBLICATION.zh-CN.md)。原checkout、原分支继续实施，没有新worktree、代理、PR或push。

本单元修复：表格单件/20件发布接入原生Root；整批输入和重试原记录在首个await之前捕获；没有原任务的发布重试不再重新取版本发送；已上线且不需刷新商品单列unchanged；刷新后仍能Check/Continue/Stop；停止未到达start的版本过期出口共用batch保护。已绑定Root不能走“未开始”出口。切换账号清除上一会话的界面结果，迟到回调不污染新会话；分类入口保留明确提示。

实际审查了`catalog-table-publication.ts`、`catalog-publication-batch.ts`、`catalog-product-publication.ts`、`api.ts`、`CollectionView.tsx`、`ProductPublicationInbox.tsx`、`ProductClassificationEditor.tsx`、`classification-publication.ts`与其测试，以及工程规范Frontend Islands/E2E/Review/Auth组、SDK部署边界。原表格组件和390px截图是UI依据。具体文案修正：把已上线未变更商品从“本次published”中分出“already enabled (unchanged)”；Stop说明它不会撤回已完成发布。截图复核还发现20张展开任务卡会把表格推得过远，现保留批量按钮并把单件任务放进可展开details，两个浏览器验证可展开、可折叠和恢复区高度。

已核对事实：原任务按actor+endpoint隔离；Checkpoint不含JWT/私有表单正文；匿名D1与原Root共同确认；缺分类不填分类；询价商品和不同主分类可并行；共享图片以有效账本计数；下架后D1为404；每个测试只恢复自己的临时商品。

验证：
- `table-site-full-r3.log`：1240通过、0失败、1环境开关图库项；后者`table-gallery-explicit.log`显式开启1/1，0跳过。
- `classification-formal-table-native-r3.log`：Astro实际构建15页，12/12完整后台流程，无重试或跳过，含原分类保留的20件Assign category和新增表格20件；恢复未发布及DB/runner/temp清理通过。
- 视觉收起单件任务列表后，`table-final-browser-api-r1.log`20/20与`classification-formal-table-final-fold.log`构建后1/1再次通过。表格浏览器仍覆盖真实Chromium与390px WebKit。
- `table-node20-r1.log`：79/79，0跳过；`table-e2e-types-r1.log`通过；`table-astro-check-r1.log`233文件0 errors/0 warnings/9 hints（含动态import函数可改async的建议，保留首await前的同步捕获）。
- `table-fault-proof.json`：4个保护被逐项移除时对应断言失败，原文件SHA逐项恢复。保留初始红测及两轮完整失败日志，不覆盖失败记录。

测试迁移说明：删除无生产消费者的旧分类发布桥接；原布尔值确认/重新取最新版本重试的断言由真实JWT/HTTP/PNG/native Root测试替代。下架、归档、普通编辑、分类版本保护、非商品batch的既有测试继续运行。没有调整服务端超时；批量UI测试从默认5秒改为30秒等待，匹配其20件操作而非单次点击反馈。此为本地观测，不等于云端P95。

限制：live-edit原生接线仍属P4，P5历史审计、P6精确后端制品与全门槛、P7 test三件真实resync/20件恢复及COS/性能尚未完成。未发布到test，未修改真实商品。本轮`fullDeliveryReady=false`。


## P4c1：原请求未到达时的原子停止（2026-10-20）

实现和边界见[P4c1](P4c1_ATOMIC_STOP.zh-CN.md)。增加已有Root协议的Stop动作；已有Root只取消自己、完成则只读；无Root在同一事务登记已取消的空记录，迟到start无法覆盖它。不保存编辑正文、不修改product/图片、不增加第二个审批系统。旧带digest取消继续兼容。当前仅服务端，随后接客户端和完整编辑。

实际检查4个代码/测试文件：`catalog-product-operation.ts`、`catalog-product-operation-workflow.ts`、`catalog-detail-staging.ts`、`catalog-product-operation-stop.test.ts`，并核对现有cancel、Root decoder、Node20 build、图片账本、Admin角色重验和消费者dispatch。文案把“停止会回退”改为“停止未来执行，已保存编辑保留，已完成发布只读”；实查11用例的product、image有效账本、actor/intent及匿名404/200，完成样本finally按本次回执恢复404。

结果：DB2254/2254、Admin638/638，Node20相关141/141，最终Stop11/11，无失败/跳过；Admin与local-server类型、4文件Biome、SDK gate、Admin node20 build通过。3个源码故障真实检出且SHA恢复，构建hash及4源码hash见`atomic-stop-verification.json`。初次类型检查指出新测试对complete联合类型访问cancelledAt，已用严格判别修正；没有放松生产schema。

未新增SDK调用、shim、云集合/环境变量；继续原分支。没有部署或真实商品变更，clientWired=false/fullDeliveryReady=false。精确提交审查另记本地侧车；当前全局pre-commit的Biome --silent参数错误仍存在，显式选文件检查才是lint证据。
