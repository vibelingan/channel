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
