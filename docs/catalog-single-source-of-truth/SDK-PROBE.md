# P3c SDK surface probe

Context7 is unavailable. CloudBase SDK methods and shims are unchanged in this MIU; the composed CloudBase contract script passed (`p3c-sdk-r2.log`). Installed packages, official docs and actual handler/browser execution were checked for the changed surfaces below.

| package@version | method | signature | return shape | evidence |
| --- | --- | --- | --- | --- |
| zod@3.25.76 | ZodType.nullable | `() -> ZodNullable<this>` | parsed input permits null; `.optional()` separately permits undefined | `apps/functions/admin/node_modules/zod/v3/types.d.ts:81`; [official nullable documentation](https://zod.dev/api?id=nullables); actual null handler/CAS tests |
| playwright-core@1.61.1 | Page.addInitScript | `(PageFunction<Arg>, arg?: Arg)` | `Promise<Disposable>`; return intentionally unused for the lifetime of this disposable page/context | `node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core/types/types.d.ts:8248`; [official Page documentation](https://playwright.dev/docs/api/class-page#page-add-init-script); actual editor journey |

The Zod latest docs describe v4; no v4-only option is used. The installed v3 signature and runtime acceptance are authoritative. The v3 docs URL could not be opened by the web tool. Playwright latest docs include v1.62 `exposeFunctions`; the installed v1.61.1 call only uses the existing two arguments. The init script writes the local fixture session only on the owned origin's admin path, including on subsequent navigation; it cannot seed a third-party frame. No credential is printed or recorded in traces.

Other browser locator/assertion calls reuse the lane's already exercised Playwright interfaces; e2e tsc and the full 150-case fourth run passed. JSON concurrency tests additionally use two real adapters and assert exactly one `saved` and one `stale`, because this DB API represents refusal as a fulfilled discriminated result rather than rejecting its Promise.

## P2b reused transaction surface

P2b introduces only the server-only first-party `@vibelingan-channel/db/catalog-product-state` export. It adds no SDK method, shim, query, transaction record or network call. Normal identity save, each Alibaba product writer and category assignment compute state inside their existing protected product write. Source invalidation retains the previously measured maximum six document operations including lease reads/writes. The CloudBase SDK contract script passed again (`p2b-sdk.log`); vendor race verification still requires management authentication and an approved isolated fixture scope.

The price repair consumer now computes its exact expected protected hash with the same first-party state planner. The original protected hash remains in the audit; the readback does not ignore readiness or generations. A post-commit generation change is refused, and deleting that comparison makes the new test fail.

## P2c1 catalog row transaction surface

Context7 is unavailable. The official CloudBase `/database/transaction` reference was re-read through MCP: server-only node-sdk transactions, doc-ID operations, snapshot isolation, 100 operations / 30 seconds, no external calls in the transaction. A read not taking the write lock is not assumed to prove lease takeover serialization; that vendor race remains a separate verification item.

The installed `@cloudbase/node-sdk@3.17.2` / `@cloudbase/database@1.4.3` get/set/remove contract is reused. The existing runtime fake-request probe exercises the real installed document methods and verifies transactionId and response shapes. No SDK method or shim is added. `doc.set(data)` excludes `_id` and replaces the document; successful ACK is `updated:1` or matching `upserted[]._id`; `doc.remove()` requires `deleted:1`. Coded answers go through sdkAnswer. Silent/incorrect ACKs throw so the outer transaction cannot report success.

`mutateCatalogRowInCloudBase` calls the shared first-party planner inside one runTransaction. Seven production adapter catalog branches delegate to it; the SDK gate inspects the actual `isCatalogRowCollection` branch AST, so a helper name elsewhere cannot satisfy it. The two lease writers reuse their existing transaction and guard before the shared body, with no nesting or extra global fence write.

Variant moves have three doc reads plus three doc writes (two distinct parent products); a lease adds one read. Tests count six operations for the real production helper, require all reads before writes, reject stale holders, and roll back parent/child together on write, ACK or delete failure. JSON uses one existing mutation lock and its normal disk reload; no recursive adapter.get or second lock is introduced. Generic source observation invalidation remains on its separate P2a path.

Mutation proofs: removing the parent write fails actual helper tests; dropping only bridge ACK confirmation fails silent/wrong-ID/coded-answer tests; disconnecting only production update's catalog branch fails the SDK gate even while six sibling helper calls remain. All finally restored. Final check results are recorded in IMPLEMENTATION_LOG.zh-CN.md.


## P2c2a bindings

The new db workspace dependency reuses catalog-import/observations (strict decoder and provider-scoped document ID), whose package depends on shared but not db. Only that subpath is imported; no provider collector/network entry is added. Source binding fixtures use the same decoder and pricing adapter. Five consumer type checks and 150 production-build browser checks passed.

Reused CloudBase query/transaction/get/set/remove contracts and Zod v3 object/string/regex/strict/safeParse/array/min/strip/parse are recorded in .claude/sdk-probes/p2c2a.md, with installed declaration references and actual execution. Semantic inventory contains 17 surfaces; mechanical join finds 17 matching rows, zero missing. Context7 unavailable; official transaction docs and installed runtime gate remain the reference. Complete SDK gate passed in p2c2a-sdk.log. No SDK shim or method was added.


## P2c2b source inputs

Reused source/input command parsing and changed Cloud observation/transaction bridges have a semantic inventory of 29 Zod v3 / CloudBase database surfaces, mechanically joined to .claude/sdk-probes/p2c2b.md. Exact installed declaration/runtime evidence includes update ACK and command.set full nested replacement; no method or ambient shim added. Five consumer type checks and installed SDK gate pass; vendor read-set/lease takeover is still a separate isolated release gate. Private nullable mirror fields are persistence missing-value sentinels; the pure normalized wire model and public pricing/detail schemas are unchanged.


## P1f1/P1f2: readonly preview boundaries

Only workspace DB functions are moved/reused; no CloudBase SDK method, shim, storage protocol, function configuration or vendor resource is changed. Inventory includes reused surfaces at the changed call sites and the shape getter, rather than claiming each method is newly introduced.

Installed contracts: zod@3.25.76 v3/types.d.ts:64-89,248,262,536-537,563-565,826-832 plus its types.cjs implementation; React19.2.7 / @types/react19.2.17 index.d.ts:1689-1697,1737-1761,1785 are checked by the site tsconfig; @playwright/test@1.61.1 delegates to playwright-core@1.61.1 types/types.d.ts:1137,1646,20308,20326 and playwright/types/test.d.ts's Expect/GenericAssertions. The actual test runner validates method()/postDataJSON()/on()/off() with real browser events. No ambient declarations or SDK-shaped fakes are added.

| package@version | method | signature / used result | evidence |
|---|---|---|---|
| zod@3.25.76 | object | `(shape, params?) -> ZodObject` | strict valid preview + invalid command/identity/digest/import-proof/approval-kind tests; admin/site types; focused50cases |
| zod@3.25.76 | literal | `(value, params?) -> ZodLiteral` | strict valid preview + invalid command/identity/digest/import-proof/approval-kind tests; admin/site types; focused50cases |
| zod@3.25.76 | string | `(params?) -> ZodString` | strict valid preview + invalid command/identity/digest/import-proof/approval-kind tests; admin/site types; focused50cases |
| zod@3.25.76 | unknown | `(params?) -> ZodUnknown` | strict valid preview + invalid command/identity/digest/import-proof/approval-kind tests; admin/site types; focused50cases |
| zod@3.25.76 | trim | `() -> ZodString` | strict valid preview + invalid command/identity/digest/import-proof/approval-kind tests; admin/site types; focused50cases |
| zod@3.25.76 | min | `(value, message?) -> this string/number schema` | strict valid preview + invalid command/identity/digest/import-proof/approval-kind tests; admin/site types; focused50cases |
| zod@3.25.76 | max | `(value, message?) -> this string/number schema` | strict valid preview + invalid command/identity/digest/import-proof/approval-kind tests; admin/site types; focused50cases |
| zod@3.25.76 | number | `(params?) -> ZodNumber` | strict valid preview + invalid command/identity/digest/import-proof/approval-kind tests; admin/site types; focused50cases |
| zod@3.25.76 | int | `(message?) -> ZodNumber` | strict valid preview + invalid command/identity/digest/import-proof/approval-kind tests; admin/site types; focused50cases |
| zod@3.25.76 | default | `(defaultValue) -> ZodDefault<this>` | strict valid preview + invalid command/identity/digest/import-proof/approval-kind tests; admin/site types; focused50cases |
| zod@3.25.76 | regex | `(RegExp, message?) -> ZodString` | strict valid preview + invalid command/identity/digest/import-proof/approval-kind tests; admin/site types; focused50cases |
| zod@3.25.76 | optional | `() -> ZodOptional<this>` | strict valid preview + invalid command/identity/digest/import-proof/approval-kind tests; admin/site types; focused50cases |
| zod@3.25.76 | strict | `(message?) -> ZodObject<T,strict>` | strict valid preview + invalid command/identity/digest/import-proof/approval-kind tests; admin/site types; focused50cases |
| zod@3.25.76 | safeParse | `(unknown, params?) -> success/data or failure/error.issues` | strict valid preview + invalid command/identity/digest/import-proof/approval-kind tests; admin/site types; focused50cases |
| zod@3.25.76 | parse | `(unknown, params?) -> Output or ZodError` | strict valid preview + invalid command/identity/digest/import-proof/approval-kind tests; admin/site types; focused50cases |
| zod@3.25.76 | unwrap | `ZodOptional<T>.unwrap() -> T` | strict valid preview + invalid command/identity/digest/import-proof/approval-kind tests; admin/site types; focused50cases |
| zod@3.25.76 | omit | `ZodObject<T>.omit(mask) -> ZodObject<Omit<T,keys>>` | strict valid preview + invalid command/identity/digest/import-proof/approval-kind tests; admin/site types; focused50cases |
| zod@3.25.76 | shape | `ZodObject<T>.shape getter -> T` | strict valid preview + invalid command/identity/digest/import-proof/approval-kind tests; admin/site types; focused50cases |
| react@19.2.7 | useState | `(initial?) -> [state, Dispatch<SetStateAction<S>>]` | site types; built private-preview/abort/retry/pagination flows |
| react@19.2.7 | useRef | `(initial) -> RefObject<T>` | site types; built private-preview/abort/retry/pagination flows |
| react@19.2.7 | useEffect | `(effect, dependencies?) -> void; cleanup runs on dependency change/unmount` | site types; built private-preview/abort/retry/pagination flows |
| @playwright/test@1.61.1 | on | `Page.on('request', listener: (Request) -> any) -> this` | E2E types; built browser readonly request capture + exact saved-row equality; no rate-limit weakening |
| @playwright/test@1.61.1 | off | `Page.off('request', sameListener) -> this` | E2E types; built browser readonly request capture + exact saved-row equality; no rate-limit weakening |
| @playwright/test@1.61.1 | method | `Request.method() -> string` | E2E types; built browser readonly request capture + exact saved-row equality; no rate-limit weakening |
| @playwright/test@1.61.1 | postDataJSON | `Request.postDataJSON() -> null or Serializable` | E2E types; built browser readonly request capture + exact saved-row equality; no rate-limit weakening |
| @playwright/test@1.61.1 | expect | `expect(actual, message?) -> assertion matchers` | E2E types; built browser readonly request capture + exact saved-row equality; no rate-limit weakening |
| @playwright/test@1.61.1 | toEqual | `toEqual(expected) -> void; label belongs to expect, not this matcher` | E2E types; built browser readonly request capture + exact saved-row equality; no rate-limit weakening |

Table and manifest contain27unique(package,method) rows. Additional CloudBase standing gate is unchanged and passed p1f2-sdk-final.log. E2E final round and broad final counts are recorded separately in IMPLEMENTATION_LOG; no test cloud/customer acceptance inferred here.

Context7 discovery returned no tool. Official references were freshly read: [Zod optional unwrap, shape and omit](https://zod.dev/api), [Playwright Request](https://playwright.dev/docs/api/class-request), [Page event contract](https://playwright.dev/docs/api/class-page), [React effect cleanup](https://react.dev/reference/react/useEffect). Latest Zod docs describe4.6; the installed3.25.76 implementation/types and actual parsing tests determine this version’s behavior, and no v4-only API or length semantics is adopted.


## P1g1: lossless configuration options

No CloudBase SDK/shim/query or persisted field changes. The existing optionValues string dictionary is decoded into an internal tuple array; the source candidate already stores the complete ordered option array. No new data copy or collection is stored. Changed third-party surfaces are Zod3.25.76 only; Node Object/Map builtins and workspace APIs are not vendor SDK calls.

Installed v3/types.d.ts:821,1005,1018,1030 and types.cjs:3339-3345 verify preprocessing returns the declared schema output. v3/helpers/parseUtil.cjs:102 independently confirms its object merger skips the __proto__ key; preprocessing to entries keeps it as a validated string rather than an object property. Latest official Zod docs arev4; installedv3/types/runtime and positive/negative actual tests determine behavior here.

| package@version | method | signature / used result | evidence |
|---|---|---|---|
| zod@3.25.76 | preprocess | `(preprocess: (unknown, RefinementCtx) -> unknown, schema) -> ZodEffects<I,I[output],unknown>` | dictionary/prototype/numeric/repeat/override regressions; native0/1/20/21/105-source approval/public paging/client selection/RFQ/withdrawal; eight consumer types |
| zod@3.25.76 | array | `(elementSchema, params?) -> ZodArray<Element>` | dictionary/prototype/numeric/repeat/override regressions; native0/1/20/21/105-source approval/public paging/client selection/RFQ/withdrawal; eight consumer types |
| zod@3.25.76 | tuple | `([ZodString,ZodString], params?) -> ZodTuple<[ZodString,ZodString],null>` | dictionary/prototype/numeric/repeat/override regressions; native0/1/20/21/105-source approval/public paging/client selection/RFQ/withdrawal; eight consumer types |
| zod@3.25.76 | string | `(params?) -> ZodString; rejects non-string option values` | dictionary/prototype/numeric/repeat/override regressions; native0/1/20/21/105-source approval/public paging/client selection/RFQ/withdrawal; eight consumer types |
| zod@3.25.76 | parse | `(unknown, params?) -> parsed data or ZodError` | dictionary/prototype/numeric/repeat/override regressions; native0/1/20/21/105-source approval/public paging/client selection/RFQ/withdrawal; eight consumer types |

5unique exact inventory/table rows. Source mirror equality is checked with Map key/value equality, preserving duplicate values and source order only when the canonical dictionary matches the source's last-value mirror. Differing legacy canonical overrides retain their existing precedence; source preparation still regenerates the provider mirror. Invalid values and non-JSON dictionaries remain refusals. No global Object prototype mutation or new fields.

Old job schemas remain readable. A legacy collapsed projection cannot accept newly complete pages; the unchanged page-hash guard refuses without a write, and a freshly reviewed operation can complete. Whole release still needs durable UI recovery, readiness/policy backfill and deployment cutover checks; this subunit does not claim transparent resumption of an older semantic plan or cloud20-product acceptance.


## P1f3: structured issues and existing repair actions


18 exact unique new/reused package-method surfaces in the changed code/tests. No CloudBase SDK/shim/query change. Installed Zod3.25.76 types.d.ts:65, React19.2.17 declarations and ReactDOM server declarations:122, Playwright1.61.1 types verify the used signatures. React and ReactDOM runtime19.2.7 remain pinned. Official React renderToStaticMarkup and Playwright Route references were freshly read; static HTML assertions are complemented by the built application's actual Edit callback and existing retry browser flow. No claim that static markup can verify button interaction.

| package@version | method | signature / used result | evidence |
|---|---|---|---|
| zod@3.25.76 | safeParse | `(unknown, params?) -> success/data or failure/error.issues` | 34 focused safe-response/panel/error cases; site types and 210 frontend cases |
| zod@3.25.76 | parse | `(unknown, params?) -> parsed output or ZodError` | 34 focused safe-response/panel/error cases; site types and 210 frontend cases |
| react@19.2.7 | useState | `(initial?) -> [state, Dispatch<SetStateAction<S>>]` | 34 focused safe-response/panel/error cases; site types and 210 frontend cases |
| react@19.2.7 | createElement | `(component, props, ...children) -> ReactElement` | 34 focused safe-response/panel/error cases; site types and 210 frontend cases |
| react-dom@19.2.7 | renderToStaticMarkup | `(ReactNode, options?) -> non-interactive HTML string; test only` | 34 focused safe-response/panel/error cases; site types and 210 frontend cases |
| @playwright/test@1.61.1 | route | `Page.route(url, handler, options?) -> Promise<void>` | E2E types; built150 including controlled no-DTO rejection, details expansion, exact existing Edit action and unchanged saved row |
| @playwright/test@1.61.1 | request | `Route.request() -> Request` | E2E types; built150 including controlled no-DTO rejection, details expansion, exact existing Edit action and unchanged saved row |
| @playwright/test@1.61.1 | postDataJSON | `Request.postDataJSON() -> null or Serializable` | E2E types; built150 including controlled no-DTO rejection, details expansion, exact existing Edit action and unchanged saved row |
| @playwright/test@1.61.1 | fulfill | `Route.fulfill({status,json,...}) -> Promise<void>` | E2E types; built150 including controlled no-DTO rejection, details expansion, exact existing Edit action and unchanged saved row |
| @playwright/test@1.61.1 | continue | `Route.continue(options?) -> Promise<void>` | E2E types; built150 including controlled no-DTO rejection, details expansion, exact existing Edit action and unchanged saved row |
| @playwright/test@1.61.1 | getByRole | `(role, options?) -> Locator` | E2E types; built150 including controlled no-DTO rejection, details expansion, exact existing Edit action and unchanged saved row |
| @playwright/test@1.61.1 | getByText | `(string or RegExp, options?) -> Locator` | E2E types; built150 including controlled no-DTO rejection, details expansion, exact existing Edit action and unchanged saved row |
| @playwright/test@1.61.1 | locator | `(selector, options?) -> Locator` | E2E types; built150 including controlled no-DTO rejection, details expansion, exact existing Edit action and unchanged saved row |
| @playwright/test@1.61.1 | click | `Locator.click(options?) -> Promise<void>` | E2E types; built150 including controlled no-DTO rejection, details expansion, exact existing Edit action and unchanged saved row |
| @playwright/test@1.61.1 | toBeVisible | `Locator assertion(options?) -> Promise<void>` | E2E types; built150 including controlled no-DTO rejection, details expansion, exact existing Edit action and unchanged saved row |
| @playwright/test@1.61.1 | toContainText | `Locator assertion(string or RegExp, options?) -> Promise<void>` | E2E types; built150 including controlled no-DTO rejection, details expansion, exact existing Edit action and unchanged saved row |
| @playwright/test@1.61.1 | toHaveText | `Locator assertion(string or RegExp, options?) -> Promise<void>` | E2E types; built150 including controlled no-DTO rejection, details expansion, exact existing Edit action and unchanged saved row |
| @playwright/test@1.61.1 | toHaveCount | `Locator assertion(number, options?) -> Promise<void>` | E2E types; built150 including controlled no-DTO rejection, details expansion, exact existing Edit action and unchanged saved row |

All rows join exactly to sdk-surfaces-p1f3.txt. SafeParse's failure branch owns its message rather than surfacing raw Zod received values. Unknown errors use an owned generic message. The issue schema bounds allowed paths/codes and capacity measurements; first50 entries only. Independent instrumented bundle mutants: unsafe wire parse1fail/26controls; issue guard bypass1fail/3controls; lost sign-in remedy1fail/2controls; arbitrary error exposure1fail/2controls. Workspace bytes unchanged. First TSX mutation loader did not instrument the panel and is excluded; corrected loader asserts instrumentation before running.

Official references: [React static markup](https://react.dev/reference/react-dom/server/renderToStaticMarkup), [Playwright Route](https://playwright.dev/docs/api/class-route). No Context7 tool is available. Latest official React docs describe19.3; installed declarations/runtime plus actual tests determine19.2 behavior.


## P1h1: complete source planning


Two exact reused Zod3.25.76 package-method surfaces, no new CloudBase SDK/shim/signature or query type. Complete plan now validates CatalogDetailHeaderSchema and every configuration separately; paged wire views still use the existing strict decoder. No new storage field, collection or global cache.

| package@version | method | signature / used result | evidence |
|---|---|---|---|
| zod@3.25.76 | safeParse | `(unknown, params?) -> success/data or failure/error.issues` | installed v3/types.d.ts:65; full header/all configurations, invalid saved photo choices, strict safe issue paths; 2284 consumers and eight types |
| zod@3.25.76 | parse | `(unknown, params?) -> parsed output or ZodError` | actual publication parse in 105-configuration comparison fixture; complete native local replay/approval/readback; 2284 consumers and eight types |

The existing installed v3 types/runtime and earlier primary https://zod.dev/api reference remain applicable; no v4-only method is used. Counter instrumentation proves compareWithApproved reads source SKU input once for105configurations; restoring the old paging loop yields3reads and one failing performance regression with10normal controls. Bad-photo fallback mutation1fail/8controls; dropping retained website context1fail/2normal complete-replay controls. Every mutation asserts actual bundle instrumentation and unchanged workspace bytes. CJS import.meta warnings belong to unselected workspace tests, not a claimed passing CLI mutation test.

SDK standing gate's first sandbox invocation failed on tsx IPC before verification; elevated scoped rerun p1h1-sdk-final-r2.log passes. No CloudBase runtime or vendor resource changes. Full delivery, cloud timing and deployment remain unverified.


## P1h2: request-scoped source reuse


Two exact reused Zod3.25.76 surfaces; no new vendor SDK/shim/query method. Installed v3 declarations/runtime remain authoritative and unchanged. SourcePageSchema still parses the complete internal page before native persistence; the public single-page route still reads a fresh source. Existing official Zod API reference and installed v3 probes apply; no v4-only operation is adopted.

| package@version | method | signature / used result | evidence |
|---|---|---|---|
| zod@3.25.76 | safeParse | `(unknown, params?) -> success/data or failure/error.issues` | actual source/page/choice schemas; 2292consumer cases,3consumer types; native105approval/readback/withdraw twice with a real Edit between |
| zod@3.25.76 | parse | `(unknown, params?) -> parsed output or ZodError` | controlled invalid-page issue and actual issue/publication schemas; final photo-merged byte budget rejects before staging; final suite |

Cache is created inside each approveInOneRequest default-dependency evaluation, keyed by actor/product, cleared at completion/failure/restart and never stored globally or in DB. Every native page rechecks raw observation/source/link/gallery/content generation/archive/admin. Actual105native-flow source-link reads drop636->106,<=8concurrent, two requests each read106 and second approval shows normally edited website title. This is local production-code path/read-count evidence, not cloud latency or an SLO result.

Eight instrumented in-memory bundle mutants are independently observed: final photo budget1fail/9controls; request reuse and each of six raw/gallery/generation/binding/actor/archive native checks1fail/6controls. Whole workspace bytes unchanged. Standing CloudBase SDK gate passes p1h2-sdk.log; native vendor transaction code is unchanged. Full release and remaining cloud races/timing/acceptance are still open.


P1h3：14个复用Zod3.25.76方法及1个Vite7.3.5 createServer(cacheDir)逐项证据见 .claude/sdk-probes/P1h3.md。完整计划六个摘要兼容、后页全媒体摘要/严格旧客户端、malformed review、时间边界和实际native续办均通过；13个审批mutation及独立hover mutation确实失败，正控保持。最终2317、八包类型及额外site、实际9文件Biome、standingSDK通过。built150在测试cache-only改动前通过；首次gallery模块加载失败及未证实根因完整保留，不当作已复现。无CloudBase新表面/资源或应用部署。

P1h3测试启动follow-up：同createServer调用新增安装Vite7.3.5支持的optimizeDeps.include/noDiscovery；完整列出的依赖预优化，阻止动态harness首次import时的优化reload。并行两child0、最终2317/0/0、类型/lint及原hover mutation重跑通过；d2add46的错误并行通过记录已纠正，精确review在修正前未bless。SDK表面仍15项，无app runtime改动。


P2d1：私有PreparationReport的19项Zod3.25.76表面逐项见 .claude/sdk-probes/P2d1.md。24严格契约/8managed-state及6nativeCloud/JSON保存路径、189focused、完整2355/0/0、四consumer types/实际8文件Biome/standingSDK通过；6独立mutation确实失败且正控保留。无CloudBaseSDK或shim变化。尚未生产报告/启用过滤，不把旧built150当新验收。

P2d1follow-up：datetime的超长合法语法反例实际70311byte被接受，精确review withheld后加内部checkedAt max40。最终25report cases/full2356/0/0、finalshared type/Biome及7独立mutants通过，19表面不变；不涉及来源截断或新存储拆分。

P2d2：六个Zod3.25.76与五个已安装@cloudbase/database1.4.3复用表面逐项见 .claude/sdk-probes/P2d2.md，native wrapper未更换。官方事务流程经MCP检索/读取，安装index实际选transaction/index并返回callbackRes；旧同级文件及文档包装示例不作契约。191focused/full2396/0/0、八consumer types、实际11-fileBiome/standingSDK/真实时钟副本清理通过；9独立mutants含ACK2fail/57正控。无新vendor race声明，新配对fence/报告CAS云race及重抓成本仍P6门槛；未接线自动producer/list rollout，无应用部署或客户变更。


#### P3a0 media-operation budget

No new SDK API or hand-written type. Existing staging bridge remains runTransaction -> collection/doc -> get/set with exact ACK checks. Official https://docs.cloudbase.net/database/transaction re-read 2026-10-14 confirms 100 operations, 30 seconds and doc-only/no where; local limit remains98. Installed database1.4.3 runtime callback/ACK/rollback probes via standing gate passed. Complete2397 consumers,43staging and three independently failing in-memory mutations passed their respective expectations. Full-reader/98-boundary CloudBase latency/races remain P6, not claimed from local transaction simulation. Context7 unavailable.


#### P1h4 complete capacity preflight

Reused Zod3.25.76 surfaces: parse/safeParse/shape; exact installed types and positive/negative behavior table: .claude/sdk-probes/P1h4.md. No new CloudBase API, wrapper or shim. Unknown stored generation is decoded through existing SourcePageSchema rather than asserted. All8consumer types,2403/0/0,101focused,built150+cleanup,standingSDK and10independent mutation expectations passed. Official Zod v3 URLs opened but web tool returned no body; not counted as primary contract text. Installed version types/runtime and existing source-schema contract tests establish exact semantics; Context7 unavailable. Real cloud operation budgets/performance and feature rollout remain gates.


#### P2d3a photo-state invalidation

Precise diff adds0third-party SDK calls/types; it only includes two existing product fields in the shared content hash and normalizes legacy completed flags. Native wrapper unchanged. Standing SDK contract passed; native ACK mutation51pass/10fail and JSON idempotence50/1 preserve original boundary sensitivity after test edits.148focused/2412all/4types/5fileBiome passed. No new cloud race, app deployment or browser milestone claim.
