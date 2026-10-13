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
