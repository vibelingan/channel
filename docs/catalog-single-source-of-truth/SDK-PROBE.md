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


## P1h5: complete-page byte budgets and pinned paging

Installed TypeScript signature resolution over added call sites found 46 reused third-party methods. Exact package versions and declarations below come from the resolved installed package, not a guessed API. No CloudBase method, shim, storage transport or dependency version changes. Context7 is unavailable. [Playwright Locator](https://playwright.dev/docs/api/class-locator) and [LocatorAssertions](https://playwright.dev/docs/api/class-locatorassertions) were read; latest docs contain newer methods, so the installed 1.61.1 contracts remain authoritative. The v3.zod.dev page returned no body and is not counted as read contract text.

All Zod outputs narrow with success/data or throw into existing validation handling; no typed cast manufactures a trusted result. Playwright locator methods return locators, actions/assertions are awaited, APIResponse.json is assigned to unknown and decoded with the shared detail decoder; screenshot bytes are unused while the owned file is recorded. Actual evidence: 2437 local tests, nine consumer type checks, built browser groups 41+90+11+8+1=151 and verified disposable DB removal; 25 one-defect mutations each failed with positive controls and zero skips. This proves local usage, not vendor limits, cloud races or test deployment.

| package@version | method | installed signature and return shape | declaration / call site |
| --- | --- | --- | --- |
| zod@3.25.76 | max | `(value: number, message?: ErrMessage \| undefined): ZodNumber` | `node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/types.d.cts:322`; `packages/shared/src/catalog/pagination.ts:15` |
| zod@3.25.76 | min | `(value: number, message?: ErrMessage \| undefined): ZodNumber` | `node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/types.d.cts:319`; `packages/shared/src/catalog/pagination.ts:15` |
| zod@3.25.76 | int | `(message?: ErrMessage \| undefined): ZodNumber` | `node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/types.d.cts:326`; `packages/shared/src/catalog/pagination.ts:15` |
| zod@3.25.76 | number | `(params?: ({ errorMap?: ZodErrorMap \| undefined; invalid_type_error?: string \| undefined; required_error?: string \| undefined; message?: string \| undefined; description?: string \| undefined; } & { ...; }) \| undefined): ZodNumber` | `node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/types.d.cts:979`; `packages/shared/src/catalog/pagination.ts:15` |
| zod@3.25.76 | default | `(def: number): ZodDefault<ZodNumber>` | `node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/types.d.cts:88`; `packages/db/src/catalog-detail-workflow.ts:38` |
| zod@3.25.76 | parse | `(data: unknown, params?: InexactPartial<ParseParams> \| undefined): { options: { value: string; name: string; }[]; inventory: { state: "unknown"; } \| { state: "conflict"; } \| { ...; }; images: string[]; offers: { ...; }[]; id: string; sku?: string \| undefined; }` | `node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/types.d.cts:64`; `packages/shared/src/catalog/pagination.test.ts:158` |
| zod@3.25.76 | optional | `(): ZodOptional<ZodNumber>` | `node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/types.d.cts:80`; `packages/db/src/catalog-detail-staging.ts:61` |
| playwright@1.61.1 | test | `(title: string, body: TestBody<PlaywrightTestArgs & PlaywrightTestOptions & PlaywrightWorkerArgs & PlaywrightWorkerOptions>): void` | `node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/types/test.d.ts:2792`; `tests/e2e/catalog-formal-journey.spec.ts:1453` |
| playwright@1.61.1 | setTimeout | `(timeout: number): void` | `node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/types/test.d.ts:5809`; `tests/e2e/catalog-formal-journey.spec.ts:1457` |
| playwright@1.61.1 | toHaveLength | `(expected: number): void` | `node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/types/test.d.ts:8332`; `tests/e2e/catalog-formal-journey.spec.ts:1577` |
| playwright@1.61.1 | expect | `(actual: unknown[], messageOrOptions?: string \| { message?: string; } \| undefined): MakeMatchers<void, unknown[], {}>` | `node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/types/test.d.ts:8587`; `tests/e2e/catalog-formal-journey.spec.ts:1616` |
| playwright@1.61.1 | toBe | `(expected: unknown): void` | `node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/types/test.d.ts:8045`; `tests/e2e/catalog-formal-journey.spec.ts:1609` |
| playwright@1.61.1 | toBeLessThan | `(expected: number \| bigint): void` | `node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/types/test.d.ts:8140`; `tests/e2e/catalog-formal-journey.spec.ts:1565` |
| playwright-core@1.61.1 | on | `(event: "pageerror", listener: (error: Error) => any): Page` | `node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core/types/types.d.ts:1101`; `tests/e2e/catalog-formal-journey.spec.ts:1503` |
| playwright-core@1.61.1 | goto | `(url: string, options?: { referer?: string; timeout?: number; waitUntil?: "commit" \| "domcontentloaded" \| "load" \| "networkidle"; } \| undefined): Promise<Response \| null>` | `node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core/types/types.d.ts:3238`; `tests/e2e/catalog-formal-journey.spec.ts:1593` |
| playwright-core@1.61.1 | fill | `(value: string, options?: { force?: boolean; noWaitAfter?: boolean; timeout?: number; } \| undefined): Promise<void>` | `node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core/types/types.d.ts:13798`; `tests/e2e/catalog-formal-journey.spec.ts:1510` |
| playwright-core@1.61.1 | getByLabel | `(text: string \| RegExp, options?: { exact?: boolean; } \| undefined): Locator` | `node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core/types/types.d.ts:2873`; `tests/e2e/catalog-formal-journey.spec.ts:1506` |
| playwright-core@1.61.1 | click | `(options?: { button?: "left" \| "right" \| "middle"; clickCount?: number; delay?: number; force?: boolean; modifiers?: ("Alt" \| "Control" \| "ControlOrMeta" \| "Meta" \| "Shift")[]; noWaitAfter?: boolean; position?: { ...; }; steps?: number; timeout?: number; trial?: boolean; } \| undefined): Promise<...>` | `node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core/types/types.d.ts:13315`; `tests/e2e/catalog-formal-journey.spec.ts:1544` |
| playwright-core@1.61.1 | getByRole | `(role: "status" \| "code" \| "heading" \| "paragraph" \| "none" \| "row" \| "list" \| "note" \| "dialog" \| "alert" \| "alertdialog" \| "application" \| "article" \| "banner" \| "blockquote" \| "button" \| ... 65 more ... \| "treeitem", options?: { ...; } \| undefined): Locator` | `node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core/types/types.d.ts:14059`; `tests/e2e/catalog-formal-journey.spec.ts:1544` |
| playwright@1.61.1 | toHaveURL | `(url: string \| RegExp \| ((url: URL) => boolean), options?: { ignoreCase?: boolean; timeout?: number; } \| undefined): Promise<void>` | `node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/types/test.d.ts:9831`; `tests/e2e/catalog-formal-journey.spec.ts:1586` |
| playwright-core@1.61.1 | getByPlaceholder | `(text: string \| RegExp, options?: { exact?: boolean; } \| undefined): Locator` | `node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core/types/types.d.ts:2903`; `tests/e2e/catalog-formal-journey.spec.ts:1510` |
| playwright-core@1.61.1 | filter | `(options?: { has?: Locator; hasNot?: Locator; hasNotText?: string \| RegExp; hasText?: string \| RegExp; visible?: boolean; } \| undefined): Locator` | `node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core/types/types.d.ts:13836`; `tests/e2e/catalog-formal-journey.spec.ts:1512` |
| playwright@1.61.1 | toBeVisible | `(options?: { timeout?: number; visible?: boolean; } \| undefined): Promise<void>` | `node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/types/test.d.ts:8949`; `tests/e2e/catalog-formal-journey.spec.ts:1541` |
| playwright-core@1.61.1 | locator | `(selectorOrLocator: string \| Locator, options?: { has?: Locator; hasNot?: Locator; hasNotText?: string \| RegExp; hasText?: string \| RegExp; } \| undefined): Locator` | `node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core/types/types.d.ts:14573`; `tests/e2e/catalog-formal-journey.spec.ts:1581` |
| playwright@1.61.1 | toContainText | `(expected: string \| RegExp \| readonly (string \| RegExp)[], options?: { ignoreCase?: boolean; timeout?: number; useInnerText?: boolean; } \| undefined): Promise<void>` | `node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/types/test.d.ts:9056`; `tests/e2e/catalog-formal-journey.spec.ts:1536` |
| playwright@1.61.1 | toBeDisabled | `(options?: { timeout?: number; } \| undefined): Promise<void>` | `node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/types/test.d.ts:8783`; `tests/e2e/catalog-formal-journey.spec.ts:1520` |
| playwright-core@1.61.1 | first | `(): Locator` | `node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core/types/types.d.ts:13882`; `tests/e2e/catalog-formal-journey.spec.ts:1523` |
| playwright@1.61.1 | toEqual | `(expected: unknown): void` | `node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/types/test.d.ts:8317`; `tests/e2e/catalog-formal-journey.spec.ts:1616` |
| playwright-core@1.61.1 | check | `(options?: { force?: boolean; noWaitAfter?: boolean; position?: { x: number; y: number; }; timeout?: number; trial?: boolean; } \| undefined): Promise<void>` | `node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core/types/types.d.ts:13194`; `tests/e2e/catalog-formal-journey.spec.ts:1533` |
| playwright-core@1.61.1 | and | `(locator: Locator): Locator` | `node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core/types/types.d.ts:13018`; `tests/e2e/catalog-formal-journey.spec.ts:1537` |
| playwright-core@1.61.1 | get | `(url: string, options?: { data?: any; failOnStatusCode?: boolean; form?: FormData \| { [key: string]: string \| number \| boolean; }; headers?: { [key: string]: string; }; ignoreHTTPSErrors?: boolean; ... 4 more ...; timeout?: number; } \| undefined): Promise<...>` | `node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core/types/types.d.ts:17748`; `tests/e2e/catalog-formal-journey.spec.ts:1611` |
| playwright-core@1.61.1 | status | `(): number` | `node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core/types/types.d.ts:18367`; `tests/e2e/catalog-formal-journey.spec.ts:1610` |
| playwright-core@1.61.1 | body | `(): Promise<Buffer<ArrayBufferLike>>` | `node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core/types/types.d.ts:18278`; `tests/e2e/catalog-formal-journey.spec.ts:1565` |
| playwright-core@1.61.1 | json | `(): Promise<any>` | `node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core/types/types.d.ts:18311`; `tests/e2e/catalog-formal-journey.spec.ts:1566` |
| playwright-core@1.61.1 | setViewportSize | `(viewportSize: { width: number; height: number; }): Promise<void>` | `node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core/types/types.d.ts:4501`; `tests/e2e/catalog-formal-journey.spec.ts:1578` |
| playwright@1.61.1 | toHaveCount | `(count: number, options?: { timeout?: number; } \| undefined): Promise<void>` | `node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/types/test.d.ts:9257`; `tests/e2e/catalog-formal-journey.spec.ts:1581` |
| playwright-core@1.61.1 | selectOption | `(values: string \| readonly string[] \| ElementHandle<Node> \| { value?: string; label?: string; index?: number; } \| readonly ElementHandle<Node>[] \| readonly { value?: string; label?: string; index?: number; }[] \| null, options?: { ...; } \| undefined): Promise<...>` | `node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core/types/types.d.ts:14866`; `tests/e2e/catalog-formal-journey.spec.ts:1584` |
| playwright@1.61.1 | toHaveValue | `(value: string \| RegExp, options?: { timeout?: number; } \| undefined): Promise<void>` | `node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/types/test.d.ts:9630`; `tests/e2e/catalog-formal-journey.spec.ts:1585` |
| playwright-core@1.61.1 | screenshot | `(options?: PageScreenshotOptions \| undefined): Promise<Buffer<ArrayBufferLike>>` | `node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core/types/types.d.ts:4159`; `tests/e2e/catalog-formal-journey.spec.ts:1587` |
| playwright@1.61.1 | outputPath | `(...pathSegments: readonly string[]): string` | `node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/types/test.d.ts:2366`; `tests/e2e/catalog-formal-journey.spec.ts:1588` |
| zod@3.25.76 | strict | `(message?: ErrMessage \| undefined): ZodObject<{ policyVersion: ZodLiteral<"catalog-detail-pagination-v1">; revision: ZodEffects<ZodString, string, string>; pageSize: ZodNumber; }, "strict", ZodTypeAny, { ...; }, { ...; }>` | `node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/types.d.cts:537`; `packages/shared/src/catalog/pagination.ts:7` |
| zod@3.25.76 | object | `(shape: { policyVersion: ZodLiteral<"catalog-detail-pagination-v1">; revision: ZodEffects<ZodString, string, string>; pageSize: ZodNumber; }, params?: RawCreateParams): ZodObject<...>` | `node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/types.d.cts:1000`; `packages/shared/src/catalog/pagination.ts:7` |
| zod@3.25.76 | literal | `(value: "catalog-detail-pagination-v1", params?: RawCreateParams): ZodLiteral<"catalog-detail-pagination-v1">` | `node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/types.d.cts:1011`; `packages/shared/src/catalog/pagination.ts:9` |
| zod@3.25.76 | refine | `(check: (arg: string) => unknown, message?: string \| Partial<Omit<ZodCustomIssue, "code">> \| ((arg: string) => Partial<Omit<ZodCustomIssue, "code">>) \| undefined): ZodEffects<...>` | `node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/types.d.cts:72`; `packages/shared/src/catalog/pagination.ts:10` |
| zod@3.25.76 | string | `(params?: ({ errorMap?: ZodErrorMap \| undefined; invalid_type_error?: string \| undefined; required_error?: string \| undefined; message?: string \| undefined; description?: string \| undefined; } & { ...; }) \| undefined): ZodString` | `node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/types.d.cts:976`; `packages/shared/src/catalog/pagination.ts:10` |
| zod@3.25.76 | safeParse | `(data: unknown, params?: InexactPartial<ParseParams> \| undefined): SafeParseReturnType<{ revision: string; pageSize: number; policyVersion: "catalog-detail-pagination-v1"; }, { ...; }>` | `node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/types.d.cts:65`; `packages/shared/src/catalog/pagination.ts:24` |


## P2d4: fresh unsealed inspection and owned read-transport resilience

18 distinct installed call signatures and 6 explicit import-facade aliases make 24 package/method pairs. TypeScript extraction includes calls whose argument span changed, so an option added to an existing call is not missed. @playwright/test@1.61.1 index.d.ts:17 re-exports playwright/test; playwright/types/test.d.ts:18-19 imports and re-exports playwright-core. The facade rows are instance methods on those exported types, not invented top-level exports. No CloudBase SDK call, shim, dependency version, auth provider or storage transport is changed.

Zod3.25.76 schemas reject unknown/malformed inputs, safeParse branches narrow data, parse returns the actual controlled issue shape. Official v3 docs returned no text; installed types and positive/negative execution remain authoritative. Latest [Route.fetch](https://playwright.dev/docs/api/class-route#route-fetch) and [APIRequestContext](https://playwright.dev/docs/api/class-apirequestcontext#api-request-context-post) document maxRetries as ECONNRESET-only, default0, with no HTTP-status retries; installed coreBundle.js confirms the exact retry guard and Route.fetch forwarding into the same request._innerFetch sender. No newer 1.62 signal option is used.

Actual loopback requests through the unchanged API helper owner prove get/list recover after one reset, persistent reads stop at two attempts, write actions are attempted once, and400/503 are not retried. Three deliberately wrong policies fail with positive controls. The real browser classification detector still fails on an injected mismatch-ignore bug (1failed/2controls/5notrun), source restored byte-for-byte and owned DB removed; the restored151-case full browser run passes. APIContext.dispose returns Promise<void>; optional chaining at cleanup can also yield undefined before context creation, both safely awaited. No application-side transport recovery or cloud deployment is claimed by this test-only resilience fix.

| package@version | method | resolved call signature and result | installed declaration / actual call |
| --- | --- | --- | --- |
| playwright@1.61.1 | test | `(title: string, body: TestBody<PlaywrightTestArgs & PlaywrightTestOptions & PlaywrightWorkerArgs & PlaywrightWorkerOptions>): void` | `node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/types/test.d.ts:2792`; `tests/e2e/admin-subcategory-visibility.spec.ts:495` |
| playwright-core@1.61.1 | route | `(url: string \| RegExp \| ((url: URL) => boolean), handler: (route: Route, request: Request) => any, options?: { times?: number; } \| undefined): Promise<Disposable>` | `node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core/types/types.d.ts:4072`; `tests/e2e/admin-subcategory-visibility.spec.ts:583` |
| playwright-core@1.61.1 | fetch | `(options?: { headers?: { [key: string]: string; }; maxRedirects?: number; maxRetries?: number; method?: string; postData?: any; timeout?: number; url?: string; } \| undefined): Promise<APIResponse>` | `node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core/types/types.d.ts:20867`; `tests/e2e/admin-subcategory-visibility.spec.ts:589` |
| playwright-core@1.61.1 | post | `(url: string, options?: { data?: any; failOnStatusCode?: boolean; form?: { [key: string]: string \| number \| boolean; } \| FormData; headers?: { [key: string]: string; }; ignoreHTTPSErrors?: boolean; ... 4 more ...; timeout?: number; } \| undefined): Promise<...>` | `node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core/types/types.d.ts:18048`; `tests/e2e/helpers/admin-api.ts:94` |
| zod@3.25.76 | strict | `(message?: ErrMessage \| undefined): ZodObject<{ productId: ZodString; }, "strict", ZodTypeAny, { productId: string; }, { productId: string; }>` | `node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/types.d.cts:537`; `apps/functions/admin/src/catalog-preparation-inspect.ts:26` |
| zod@3.25.76 | object | `(shape: { productId: ZodString; }, params?: RawCreateParams): ZodObject<{ productId: ZodString; }, "strip", ZodTypeAny, { productId: string; }, { ...; }>` | `node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/types.d.cts:1000`; `apps/functions/admin/src/catalog-preparation-inspect.ts:26` |
| zod@3.25.76 | max | `(maxLength: number, message?: ErrMessage \| undefined): ZodString` | `node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/types.d.cts:256`; `apps/functions/admin/src/catalog-preparation-inspect.ts:26` |
| zod@3.25.76 | min | `(minLength: number, message?: ErrMessage \| undefined): ZodString` | `node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/types.d.cts:255`; `apps/functions/admin/src/catalog-preparation-inspect.ts:26` |
| zod@3.25.76 | trim | `(): ZodString` | `node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/types.d.cts:262`; `apps/functions/admin/src/catalog-preparation-inspect.ts:26` |
| zod@3.25.76 | string | `(params?: ({ errorMap?: ZodErrorMap \| undefined; invalid_type_error?: string \| undefined; required_error?: string \| undefined; message?: string \| undefined; description?: string \| undefined; } & { ...; }) \| undefined): ZodString` | `node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/types.d.cts:976`; `apps/functions/admin/src/catalog-preparation-inspect.ts:26` |
| zod@3.25.76 | safe | `(message?: ErrMessage \| undefined): ZodNumber` | `node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/types.d.cts:334`; `apps/functions/admin/src/catalog-preparation-inspect.ts:27` |
| zod@3.25.76 | nonnegative | `(message?: ErrMessage \| undefined): ZodNumber` | `node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/types.d.cts:330`; `apps/functions/admin/src/catalog-preparation-inspect.ts:27` |
| zod@3.25.76 | int | `(message?: ErrMessage \| undefined): ZodNumber` | `node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/types.d.cts:326`; `apps/functions/admin/src/catalog-preparation-inspect.ts:27` |
| zod@3.25.76 | number | `(params?: ({ errorMap?: ZodErrorMap \| undefined; invalid_type_error?: string \| undefined; required_error?: string \| undefined; message?: string \| undefined; description?: string \| undefined; } & { ...; }) \| undefined): ZodNumber` | `node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/types.d.cts:979`; `apps/functions/admin/src/catalog-preparation-inspect.ts:27` |
| zod@3.25.76 | safeParse | `(data: unknown, params?: InexactPartial<ParseParams> \| undefined): SafeParseReturnType<{ code: "REQUIRED" \| "INVALID_VALUE" \| "TOO_LONG" \| "TOO_MANY" \| "TOO_LARGE" \| ... 8 more ... \| "NOT_FOUND"; ... 5 more ...; observed?: { ...; } \| undefined; }, { ...; }>` | `node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/types.d.cts:65`; `apps/functions/admin/src/catalog-preparation-inspect.test.ts:94` |
| zod@3.25.76 | parse | `(data: unknown, params?: InexactPartial<ParseParams> \| undefined): { code: "REQUIRED" \| "INVALID_VALUE" \| "TOO_LONG" \| "TOO_MANY" \| "TOO_LARGE" \| "SOURCE_NOT_READY" \| ... 7 more ... \| "NOT_FOUND"; ... 5 more ...; observed?: { ...; } \| undefined; }` | `node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/types.d.cts:64`; `apps/functions/admin/src/catalog-preparation-inspect.ts:70` |
| playwright-core@1.61.1 | dispose | `(options?: { reason?: string; } \| undefined): Promise<void> \| undefined` | `node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core/types/types.d.ts:17587`; `apps/local-server/src/admin-read-transport.test.ts:42` |
| playwright-core@1.61.1 | newContext | `(options?: { baseURL?: string; clientCertificates?: { origin: string; certPath?: string; cert?: Buffer<ArrayBufferLike>; keyPath?: string; key?: Buffer<ArrayBufferLike>; pfxPath?: string; pfx?: Buffer<...>; passphrase?: string; }[]; ... 8 more ...; userAgent?: string; } \| undefined): Promise<...>` | `node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core/types/types.d.ts:17260`; `apps/local-server/src/admin-read-transport.test.ts:52` |
| @playwright/test@1.61.1 | test | `(title: string, body: TestBody<PlaywrightTestArgs & PlaywrightTestOptions & PlaywrightWorkerArgs & PlaywrightWorkerOptions>): void` | `node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/types/test.d.ts:2792`; `tests/e2e/admin-subcategory-visibility.spec.ts:495`; explicit installed re-export chain above |
| @playwright/test@1.61.1 | Page.route | `(url: string \| RegExp \| ((url: URL) => boolean), handler: (route: Route, request: Request) => any, options?: { times?: number; } \| undefined): Promise<Disposable>` | `node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core/types/types.d.ts:4072`; `tests/e2e/admin-subcategory-visibility.spec.ts:583`; explicit installed re-export chain above |
| @playwright/test@1.61.1 | Route.fetch | `(options?: { headers?: { [key: string]: string; }; maxRedirects?: number; maxRetries?: number; method?: string; postData?: any; timeout?: number; url?: string; } \| undefined): Promise<APIResponse>` | `node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core/types/types.d.ts:20867`; `tests/e2e/admin-subcategory-visibility.spec.ts:589`; explicit installed re-export chain above |
| @playwright/test@1.61.1 | APIRequestContext.post | `(url: string, options?: { data?: any; failOnStatusCode?: boolean; form?: { [key: string]: string \| number \| boolean; } \| FormData; headers?: { [key: string]: string; }; ignoreHTTPSErrors?: boolean; ... 4 more ...; timeout?: number; } \| undefined): Promise<...>` | `node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core/types/types.d.ts:18048`; `tests/e2e/helpers/admin-api.ts:94`; explicit installed re-export chain above |
| @playwright/test@1.61.1 | APIRequestContext.dispose | `(options?: { reason?: string; } \| undefined): Promise<void> \| undefined` | `node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core/types/types.d.ts:17587`; `apps/local-server/src/admin-read-transport.test.ts:42`; explicit installed re-export chain above |
| @playwright/test@1.61.1 | APIRequest.newContext | `(options?: { baseURL?: string; clientCertificates?: { origin: string; certPath?: string; cert?: Buffer<ArrayBufferLike>; keyPath?: string; key?: Buffer<ArrayBufferLike>; pfxPath?: string; pfx?: Buffer<...>; passphrase?: string; }[]; ... 8 more ...; userAgent?: string; } \| undefined): Promise<...>` | `node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core/types/types.d.ts:17260`; `apps/local-server/src/admin-read-transport.test.ts:52`; explicit installed re-export chain above |


## P2d7 — Durable image deletion and confirmed ownership writes

Context7 remains unavailable. Re-read official CloudBase `/database/transaction` through MCP on 2026-10-14 UTC: node-sdk only, first-read snapshot, writes conflict, reads do not lock, 100 operations/30 seconds, document-ID operations and no external calls. Its illustrative `update({data})` and wrapped result do not describe the installed package; production continues the verified native direct-patch/direct-callback-result contract. Official Zod v3 documentation at https://v3.zod.dev/?id=objects returned an empty extracted body; this is recorded, not treated as signature evidence. Installed Zod 3.25.76 types/runtime and strict parsing/fault tests supply the evidence. No SDK/dependency/shim method was invented.

14 package/method pairs were extracted from changed spans and every new TS file; seven native database methods were traced through the local structural type to installed `@cloudbase/database@1.4.3`. The 21-row table below is joined by package/method. String and array `max` receiver signatures were checked in installed declarations and their bounds exercised. The installed request-class probe in `verify-cloudbase-sdk-contract.mjs` exercises actual get/set/update/remove with transactionId and native ACK shapes. New production wrappers reuse that store: one image read plus one set/remove; bytes are deleted outside the transaction. Set confirms updated:1 or matching upsert ID, remove confirms deleted:1, and coded results throw. Lock acquire/release now confirm their update ACK. The standing gate follows each production adapter to the exact helper and checks ownership/confirmation inside its transaction callback. Eight scoped gate defects fail with 92 passing controls; the baseline has 93 passes. Native JSON uses its existing one-file mutation mutex, copy/atomic rename, and restores previous state on persistence failure.

Permanent file IDs remain opaque: case, encoding and spaces are preserved. Tencent [COS limits](https://cloud.tencent.com/document/product/436/14518) permit 850 UTF-8 bytes per object key; percent encoding can expand a key beyond 2,048 characters. The new intent accepts up to 8,192 characters per ID (at most two IDs) without changing upload/source URL limits. A >2,048-character encoded target red test and an actual local filename ending in a space both exposed incorrect restrictions/normalization, then passed. The 9,805-row historical image census omitted file IDs; it cannot prove actual pointer lengths or physical file health. Provider duplicate-delete/confirmed-absent behavior still needs the owned cloud object probe before deployment acceptance; no storage success is inferred from database metadata.

| Package | Method | Installed signature | Declaration; consumer |
|---|---|---|---|
| @cloudbase/node-sdk@3.17.2 | database | `(dbConfig?: ICloudBaseDBConfig): Db` | `node_modules/.pnpm/@cloudbase+node-sdk@3.17.2/node_modules/@cloudbase/node-sdk/types/index.d.ts:539`; `packages/db/src/cloudbase-adapter.ts:992` |
| zod@3.25.76 | parse | `(data: unknown, params?: InexactPartial<ParseParams> \| undefined): { uploadedByUserId: string; startedAt: string; operationId: string; schemaVersion: "image-deletion-v1"; storageProvider: string; storageFileIds: string[]; }` | `node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/types.d.cts:64`; `packages/db/src/image-deletion.ts:102` |
| zod@3.25.76 | refine | `(check: (arg: string) => unknown, message?: string \| Partial<Omit<ZodCustomIssue, "code">> \| ((arg: string) => Partial<Omit<ZodCustomIssue, "code">>) \| undefined): ZodEffects<...>` | `node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/types.d.cts:72`; `packages/db/src/image-deletion.ts:12` |
| zod@3.25.76 | max | `(maxLength: number, message?: ErrMessage \| undefined): ZodString` | `node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/types.d.cts:256`; `packages/db/src/image-deletion.ts:29` |
| zod@3.25.76 | min | `(minLength: number, message?: ErrMessage \| undefined): ZodString` | `node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/types.d.cts:255`; `packages/db/src/image-deletion.ts:29` |
| zod@3.25.76 | string | `(params?: ({ errorMap?: ZodErrorMap \| undefined; invalid_type_error?: string \| undefined; required_error?: string \| undefined; message?: string \| undefined; description?: string \| undefined; } & { ...; }) \| undefined): ZodString` | `node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/types.d.cts:976`; `packages/db/src/image-deletion.ts:29` |
| zod@3.25.76 | datetime | `(options?: string \| { message?: string \| undefined; precision?: number \| null; offset?: boolean; local?: boolean; } \| undefined): ZodString` | `node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/types.d.cts:236`; `packages/db/src/image-deletion.ts:12` |
| zod@3.25.76 | object | `(shape: { schemaVersion: ZodLiteral<"image-deletion-v1">; operationId: ZodEffects<ZodString, string, string>; uploadedByUserId: ZodEffects<ZodString, string, string>; startedAt: ZodEffects<...>; storageProvider: ZodString; storageFileIds: ZodArray<...>; }, params?: RawCreateParams): ZodObject<...>` | `node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/types.d.cts:1000`; `packages/db/src/image-deletion.ts:22` |
| zod@3.25.76 | discriminatedUnion | `(discriminator: "action", options: [ZodObject<{ imageId: ZodEffects<ZodString, string, string>; uploadedByUserId: ZodEffects<ZodString, string, string>; } & { ...; }, "strict", ZodTypeAny, { ...; }, { ...; }>, ZodObject<...>], params?: RawCreateParams): ZodDiscriminatedUnion<...>` | `node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/types.d.cts:624`; `packages/db/src/image-deletion.ts:17` |
| zod@3.25.76 | strict | `(message?: ErrMessage \| undefined): ZodObject<{ schemaVersion: ZodLiteral<"image-deletion-v1">; operationId: ZodEffects<ZodString, string, string>; uploadedByUserId: ZodEffects<...>; startedAt: ZodEffects<...>; storageProvider: ZodString; storageFileIds: ZodArray<...>; }, "strict", ZodTypeAny, { ...; }, { ...; }>` | `node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/types.d.cts:537`; `packages/db/src/image-deletion.ts:22` |
| zod@3.25.76 | extend | `(augmentation: { action: ZodLiteral<"finish">; operationId: ZodEffects<ZodString, string, string>; }): ZodObject<{ imageId: ZodEffects<ZodString, string, string>; uploadedByUserId: ZodEffects<...>; } & { ...; }, "strip", ZodTypeAny, { ...; }, { ...; }>` | `node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/types.d.cts:545`; `packages/db/src/image-deletion.ts:19` |
| zod@3.25.76 | literal | `(value: "image-deletion-v1", params?: RawCreateParams): ZodLiteral<"image-deletion-v1">` | `node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/types.d.cts:1011`; `packages/db/src/image-deletion.ts:24` |
| zod@3.25.76 | array | `(schema: ZodString, params?: RawCreateParams): ZodArray<ZodString, "many">` | `node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/types.d.cts:999`; `packages/db/src/image-deletion.ts:29` |
| zod@3.25.76 | safeParse | `(data: unknown, params?: InexactPartial<ParseParams> \| undefined): SafeParseReturnType<{ [x: string]: any; }, { [x: string]: any; }>` | `node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/types.d.cts:65`; `packages/db/src/image-deletion.test.ts:281` |
| @cloudbase/database@1.4.3 | runTransaction | `(callback: (transaction: Transaction) => void \| Promise<any>, times?: number): Promise<any>` | `node_modules/.pnpm/@cloudbase+database@1.4.3/node_modules/@cloudbase/databasedist/commonjs/transaction/index.d.ts:23`; `packages/db/src/cloudbase-adapter.ts:408-472` |
| @cloudbase/database@1.4.3 | collection | `(collName: string): CollectionReference` | `node_modules/.pnpm/@cloudbase+database@1.4.3/node_modules/@cloudbase/databasedist/commonjs/transaction/index.d.ts:16`; `packages/db/src/cloudbase-adapter.ts:408-472` |
| @cloudbase/database@1.4.3 | doc | `(docID: string \| number): DocumentReference` | `node_modules/.pnpm/@cloudbase+database@1.4.3/node_modules/@cloudbase/databasedist/commonjs/collection.d.ts:7`; `packages/db/src/cloudbase-adapter.ts:408-472` |
| @cloudbase/database@1.4.3 | get | `(): Promise<any>` | `node_modules/.pnpm/@cloudbase+database@1.4.3/node_modules/@cloudbase/databasedist/commonjs/document.d.ts:11`; `packages/db/src/cloudbase-adapter.ts:408-472` |
| @cloudbase/database@1.4.3 | set | `(data: Object): Promise<any>` | `node_modules/.pnpm/@cloudbase+database@1.4.3/node_modules/@cloudbase/databasedist/commonjs/document.d.ts:7`; `packages/db/src/cloudbase-adapter.ts:408-472` |
| @cloudbase/database@1.4.3 | update | `(data: Object): Promise<any>` | `node_modules/.pnpm/@cloudbase+database@1.4.3/node_modules/@cloudbase/databasedist/commonjs/document.d.ts:8`; `packages/db/src/cloudbase-adapter.ts:408-472` |
| @cloudbase/database@1.4.3 | remove | `(): Promise<any>` | `node_modules/.pnpm/@cloudbase+database@1.4.3/node_modules/@cloudbase/databasedist/commonjs/document.d.ts:10`; `packages/db/src/cloudbase-adapter.ts:408-472` |


## P4a0 — Retry button during classification read-back

Production UI adds one first-party optional busy prop; no React or SDK method/version changes. The modified E2E spans resolve to 13 installed Playwright1.61.1 package/method pairs, plus the two actual `@playwright/test` test/expect import facades below. Facades are proved by installed `index.d.ts:17`/`index.mjs:17` re-exports and a no-network runtime test/expect/poll probe; Locator/Route methods are declared in playwright-core, not invented named exports on @playwright/test.

Read official [locator assertions](https://playwright.dev/docs/api/class-locatorassertions), [polling](https://playwright.dev/docs/test-assertions#polling) and [Route](https://playwright.dev/docs/api/class-route) references. Timeout options and awaited Promise<void> assertions match installed types; current docs mention v1.62 AbortSignal options that installed1.61.1 lacks, and this change does not use those options. Request JSON is held as unknown and only narrowed fields are matched. The route gate is bounded by the test timeout and always released in finally; it applies only to the owned product-list read-back after simulated BUSY.

Actual original UI and an independently caller-disconnected temporary Astro build both fail the disabled-button assertion during held read-back. The normal fixed browser verifies disabled -> release -> enabled -> exactly one publish write -> persisted product/classification, then the disposable database is removed. The component baseline8 passes; dropping its read-back gate or mislabeling read-back as a retry each yields7controls/1failure/0skip. Build source hashes remain unchanged during the caller fault. Temporary Astro absolute-config resolution failure and the first root-cwd JSX failure are harness errors, not business-defect detections.

| Package | Method | Installed signature | Declaration; consumer |
|---|---|---|---|
| playwright@1.61.1 | test | `(title: string, body: TestBody<PlaywrightTestArgs & PlaywrightTestOptions & PlaywrightWorkerArgs & PlaywrightWorkerOptions>): void` | `node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/types/test.d.ts:2792`; `tests/e2e/admin-subcategory-visibility.spec.ts:957` |
| playwright-core@1.61.1 | route | `(url: string \| RegExp \| ((url: URL) => boolean), handler: (route: Route, request: Request) => any, options?: { times?: number; } \| undefined): Promise<Disposable>` | `node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core/types/types.d.ts:4072`; `tests/e2e/admin-subcategory-visibility.spec.ts:1298` |
| playwright-core@1.61.1 | postDataJSON | `(): any` | `node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core/types/types.d.ts:20326`; `tests/e2e/admin-subcategory-visibility.spec.ts:1299` |
| playwright-core@1.61.1 | request | `(): Request` | `node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core/types/types.d.ts:20975`; `tests/e2e/admin-subcategory-visibility.spec.ts:1299` |
| playwright-core@1.61.1 | getByRole | `(role: "article" \| "blockquote" \| "button" \| "caption" \| "code" \| "dialog" \| "figure" \| "form" \| "img" \| "link" \| "main" \| "menu" \| "menuitem" \| "meter" \| "option" \| "search" \| "strong" \| ... 64 more ... \| "treeitem", options?: { ...; } \| undefined): Locator` | `node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core/types/types.d.ts:14059`; `tests/e2e/admin-subcategory-visibility.spec.ts:1329` |
| playwright@1.61.1 | toBe | `(expected: unknown): void` | `node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/types/test.d.ts:8045`; `tests/e2e/admin-subcategory-visibility.spec.ts:1347` |
| playwright@1.61.1 | poll | `(actual: () => boolean \| Promise<boolean>, messageOrOptions?: string \| { message?: string; timeout?: number; intervals?: number[]; } \| undefined): PollMatchers<Promise<void>, boolean, {}>` | `node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/types/test.d.ts:8589`; `tests/e2e/admin-subcategory-visibility.spec.ts:1331` |
| playwright@1.61.1 | toBeVisible | `(options?: { timeout?: number; visible?: boolean; } \| undefined): Promise<void>` | `node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/types/test.d.ts:8949`; `tests/e2e/admin-subcategory-visibility.spec.ts:1332` |
| playwright@1.61.1 | expect | `(actual: number, messageOrOptions?: string \| { message?: string; } \| undefined): MakeMatchers<void, number, {}>` | `node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/types/test.d.ts:8587`; `tests/e2e/admin-subcategory-visibility.spec.ts:1347` |
| playwright-core@1.61.1 | getByText | `(text: string \| RegExp, options?: { exact?: boolean; } \| undefined): Locator` | `node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core/types/types.d.ts:14222`; `tests/e2e/admin-subcategory-visibility.spec.ts:1332` |
| playwright@1.61.1 | toBeDisabled | `(options?: { timeout?: number; } \| undefined): Promise<void>` | `node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/types/test.d.ts:8783`; `tests/e2e/admin-subcategory-visibility.spec.ts:1333` |
| playwright@1.61.1 | toBeEnabled | `(options?: { enabled?: boolean; timeout?: number; } \| undefined): Promise<void>` | `node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/types/test.d.ts:8843`; `tests/e2e/admin-subcategory-visibility.spec.ts:1339` |
| playwright-core@1.61.1 | click | `(options?: { button?: "left" \| "right" \| "middle"; clickCount?: number; delay?: number; force?: boolean; modifiers?: ("Alt" \| "Control" \| "ControlOrMeta" \| "Meta" \| "Shift")[]; noWaitAfter?: boolean; position?: { ...; }; steps?: number; timeout?: number; trial?: boolean; } \| undefined): Promise<...>` | `node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core/types/types.d.ts:13315`; `tests/e2e/admin-subcategory-visibility.spec.ts:1343` |
| @playwright/test@1.61.1 | test | `(title: string, body: TestBody<PlaywrightTestArgs & PlaywrightTestOptions & PlaywrightWorkerArgs & PlaywrightWorkerOptions>): void` | `node_modules/.pnpm/@playwright+test@1.61.1/node_modules/@playwright/test/index.d.ts:17`; `tests/e2e/admin-subcategory-visibility.spec.ts:957` |
| @playwright/test@1.61.1 | expect | `(actual: number, messageOrOptions?: string \| { message?: string; } \| undefined): MakeMatchers<void, number, {}>` | `node_modules/.pnpm/@playwright+test@1.61.1/node_modules/@playwright/test/index.d.ts:17`; `tests/e2e/admin-subcategory-visibility.spec.ts:1347` |

## P2d8a 上传检查点与服务器 PUT

基线 ed9eaf9；Context7 不可用。2026-10-15 重新读取官方 `/api-reference/server/node-sdk/storage`、安装 `@cloudbase/node-sdk@3.17.2` 的 `types/index.d.ts:268–374,554–578` 和 `src/storage/index.ts:54–132` / `dist/storage/index.js`。官方 COS PUT 200/空响应体契约见 <https://cloud.tencent.com/document/product/436/7749>。不发 x-cos-return-body。真实 SDK 无网络探针确认 Uint8Array 被入口 guard 拒绝；仅收紧本地接口，不新增 SDK 方法或 shim。

| package@version | method | signature | return shape (exact) | evidence |
| --- | --- | --- | --- | --- |
| @cloudbase/node-sdk@3.17.2 | uploadFile | ({cloudPath:string,fileContent:Buffer\|fs.ReadStream}, opts?:ICustomReqOpts) | Promise<IUploadFileResult>, fileID:string plus IBaseResult | installed d.ts:268,554; exact sender guard and raw PUT/headers gate; Uint8Array actual-runtime rejection; fs.ReadStream/Buffer/Uint8Array adapter tests |
| @cloudbase/node-sdk@3.17.2 | getUploadMetadata | ({cloudPath:string},opts?:ICustomReqOpts) | Promise<IGetUploadMetadataResult>, data:{url,token,authorization,fileId,cosFileId,download_url}:strings plus IBaseResult | d.ts:360,578; installed sender mints put then sends the five headers; tracked owned-wire tests mint once and checkpoint same fileId |
| @cloudbase/node-sdk@3.17.2 | downloadFile | ({fileID:string,tempFilePath?:string,urlType?:'COS_URL'},opts?:ICustomReqOpts) | Promise<IDownloadFileResult>, fileContent:string\|Buffer\|undefined, message:string | d.ts:280–290,558; unchanged adapter accepts Buffer only and verifies absence/wrong shape in existing tests |
| @cloudbase/node-sdk@3.17.2 | getTempFileURL | ({fileList:(string\|{fileID:string,maxAge?:number,urlType?:'COS_URL'})[]},opts?:ICustomReqOpts) | Promise<IGetFileUrlResult>, fileList:{code:string,fileID:string,tempFileURL:string}[] plus IBaseResult | d.ts:318–333,570; unchanged adapter union/maxAge/expiry tests; no new URL-delivery behavior |
| @cloudbase/node-sdk@3.17.2 | deleteFile | ({fileList:string[]},opts?:ICustomReqOpts) | Promise<IDeleteFileResult>, fileList:{code:string,fileID:string}[] plus IBaseResult | d.ts:308–317,566; unchanged strict per-file confirmation tests; real cloud confirmed-absent semantics still pending |

Native Node HTTPS request, IncomingMessage events, fs.ReadStream, Readable.from and pipeline are built-in runtime surfaces rather than third-party SDK rows. Their actual byte protocol is exercised against an owned HTTP server through an injected request function; production uses node:https.request and does not disable TLS verification. SDK protocol gate 98 checks; 10 injected defects fail with 96/97 other checks passing. Runtime storage tests 45; 11 runtime faults fail with controls and no skips, original files restored. This verifies the storage primitive; it does not certify importer activation, physical cloud health, Node20 runtime or 20-product acceptance.

## P2d8b 来源复制的原子绑定与恢复

基线32b935a，25个 package/method pair 在探针前写入 source-sdk-inventory.json。TypeScript checker 从真实调用解析16个Zod方法声明，另计实际z.infer类型facade与8个native DB依赖；不是对整个旧SDK文件重新猜测方法。Context7不可用。2026-10-15重新读取官方 `/database/transaction`：快照读取不加锁，写入加锁，最多100操作/30秒，仅文档操作。官方示例的 update({data}) 和包装返回值与安装1.4.3的平铺data及直接callbackRes不同；运行实现以锁定版本实际源码为准，未修改shim或借用wx方法。

| package@version | method | signature and return shape | evidence |
| --- | --- | --- | --- |
| @cloudbase/node-sdk@3.17.2 | database | (dbConfig:ICloudBaseDBConfig={}) → Db | installed types/index.d.ts:539; cloudStorageSdk().database() production AST gate |
| @cloudbase/database@1.4.3 | runTransaction | (callback:(transaction:Transaction) → void or Promise<any>,times?:number) → Promise<any>; resolves callbackRes after commit | transaction/index.d.ts:23; actual src/transaction/index.ts; original SDK request probe and source transaction replay tests |
| @cloudbase/database@1.4.3 | collection | (collName:string) → CollectionReference | index.d.ts:50 and transaction/index.d.ts:16; catalogRowStore callback native bridge |
| @cloudbase/database@1.4.3 | doc | (docID:string or number) → DocumentReference | collection.d.ts:7; exact document ID/native get tests |
| @cloudbase/database@1.4.3 | get | () → Promise<any>; observed data is object or array | document.d.ts:11; both actual bridge response shapes tested; foreign IDs rejected |
| @cloudbase/database@1.4.3 | set | (data:Object) → Promise<any>; flat fields, updated:1 or exact upserted ID confirms | document.d.ts:7; installed transaction set and standing native payload probe; throw/code/silent/wrong-ID negative tests |
| @cloudbase/database@1.4.3 | update | (data:Object) → Promise<any>; updated:1 confirms | document.d.ts:8; existing image mutation acquire physical write; installed flat payload probe |
| @cloudbase/database@1.4.3 | remove | () → Promise<any>; deleted:1 confirms | document.d.ts:10; checksum reservation removal rollback and committed-ACK replay |
| zod@3.25.76 | datetime | (options?:string or {message?,precision?,offset?,local?}) → ZodString | installed v3/types.d.cts:235; source command schema actual runtime tests |
| zod@3.25.76 | discriminatedUnion | (discriminator,objectOptions,params?) → ZodDiscriminatedUnion | installed v3/types.d.cts:615–627,1003; source command schema actual runtime tests |
| zod@3.25.76 | enum | (values:readonly nonempty string tuple,params?) → ZodEnum | installed v3/types.d.cts:759–760,1012; source command schema actual runtime tests |
| zod@3.25.76 | extend | (augmentation:ZodRawShape) → extended ZodObject | installed v3/types.d.cts:544; source command schema actual runtime tests |
| zod@3.25.76 | infer | TypeOf<T> = T["_output"]; type-only export alias | installed v3/types.d.cts:17,20; source command schema actual runtime tests |
| zod@3.25.76 | int | (message?) → ZodNumber | installed v3/types.d.cts:325; source command schema actual runtime tests |
| zod@3.25.76 | literal | (value:Primitive,params?) → ZodLiteral<Value> | installed v3/types.d.cts:1011; source command schema actual runtime tests |
| zod@3.25.76 | max | (maxLength:number,message?) → ZodString; (max:number,message?) → ZodNumber | installed v3/types.d.cts:255,322; source command schema actual runtime tests |
| zod@3.25.76 | min | (minLength:number,message?) → ZodString; (min:number,message?) → ZodNumber | installed v3/types.d.cts:254,319; source command schema actual runtime tests |
| zod@3.25.76 | number | (params?:RawCreateParams and {coerce?:boolean}) → ZodNumber | installed v3/types.d.cts:979; source command schema actual runtime tests |
| zod@3.25.76 | object | (shape:ZodRawShape,params?) → ZodObject with strip mode | installed v3/types.d.cts:1000; source command schema actual runtime tests |
| zod@3.25.76 | parse | (data:unknown,params?) → Output; throws ZodError for invalid input | installed v3/types.d.cts:63; installed runtime and strict command/target tests; source command schema actual runtime tests |
| zod@3.25.76 | refine | (check,message?) → ZodEffects<this,Output,Input> | installed v3/types.d.cts:71–72; source command schema actual runtime tests |
| zod@3.25.76 | regex | (regex:RegExp,message?) → ZodString | installed v3/types.d.cts:247; source command schema actual runtime tests |
| zod@3.25.76 | safeParse | (data:unknown,params?) → success/data or failure/error union | installed v3/types.d.cts:64; installed SafeParseReturnType; strict ownership/receipt tests; source command schema actual runtime tests |
| zod@3.25.76 | strict | (message?) → ZodObject with strict unknown-key mode | installed v3/types.d.cts:536; source command schema actual runtime tests |
| zod@3.25.76 | string | (params?:RawCreateParams and {coerce?:true}) → ZodString | installed v3/types.d.cts:976; source command schema actual runtime tests |

真实 SDK 请求类的离线契约探针与 standing gate 验证平铺 set/update、get 两种形状及写入确认；新 CloudBase bridge 测试同时覆盖两种get形状、失败回滚、未知commit结果重放、错误ID以及同值物理写入抵御并发退休。事务 mock 仅模拟已实际探测的快照语义，不冒充新云端实验。SDK100项；新增3个AST连接故障各保留99个正常控制并确实失败。原上传基础层10项故障在98检查基线执行，不改写其分母。Node20.19打包、离线产物加载与438项关键流程通过；这不是Linux云端文件或真实批量发布验收。

## P4a1 普通上传完成与过期清理协调

基线0c01a98。sdk-inventory.json在探针前记录28对：checker解析19个实际Zod方法、infer类型facade和8个nativeDB依赖。所有调用绑定均来自锁定版本，未新增SDK方法/依赖/shim。Context7不可用；复用本轮已重新读取的官方transaction文档、安装node-sdk3.17.2/database1.4.3真实平铺数据和callbackRes契约，以及实际request探针。图片下载/删除沿现有media-storage已核对的downloadFile/deleteFile边界，standing gate再验证。

| package@version | method | signature and return shape | evidence |
| --- | --- | --- | --- |
| @cloudbase/node-sdk@3.17.2 | database | (dbConfig:ICloudBaseDBConfig={}) → Db | installed types/index.d.ts:539; cloudStorageSdk().database() production AST gate |
| @cloudbase/database@1.4.3 | runTransaction | (callback:(transaction:Transaction) → void or Promise<any>,times?:number) → Promise<any>; resolves callbackRes after commit | transaction/index.d.ts:23; actual src/transaction/index.ts; original SDK request probe and source transaction replay tests |
| @cloudbase/database@1.4.3 | collection | (collName:string) → CollectionReference | index.d.ts:50 and transaction/index.d.ts:16; catalogRowStore callback native bridge |
| @cloudbase/database@1.4.3 | doc | (docID:string or number) → DocumentReference | collection.d.ts:7; exact document ID/native get tests |
| @cloudbase/database@1.4.3 | get | () → Promise<any>; observed data is object or array | document.d.ts:11; both actual bridge response shapes tested; foreign IDs rejected |
| @cloudbase/database@1.4.3 | set | (data:Object) → Promise<any>; flat fields, updated:1 or exact upserted ID confirms | document.d.ts:7; installed transaction set and standing native payload probe; throw/code/silent/wrong-ID negative tests |
| @cloudbase/database@1.4.3 | update | (data:Object) → Promise<any>; updated:1 confirms | document.d.ts:8; existing image mutation acquire physical write; installed flat payload probe |
| @cloudbase/database@1.4.3 | remove | () → Promise<any>; deleted:1 confirms | document.d.ts:10; checksum reservation removal rollback and committed-ACK replay |
| zod@3.25.76 | datetime | (options?:string or {message?,precision?,offset?,local?}) → ZodString | installed v3/types.d.cts:235; source command schema actual runtime tests |
| zod@3.25.76 | discriminatedUnion | (discriminator,objectOptions,params?) → ZodDiscriminatedUnion | installed v3/types.d.cts:615–627,1003; source command schema actual runtime tests |
| zod@3.25.76 | enum | (values:readonly nonempty string tuple,params?) → ZodEnum | installed v3/types.d.cts:759–760,1012; source command schema actual runtime tests |
| zod@3.25.76 | extend | (augmentation:ZodRawShape) → extended ZodObject | installed v3/types.d.cts:544; source command schema actual runtime tests |
| zod@3.25.76 | infer | TypeOf<T> = T["_output"]; type-only export alias | installed v3/types.d.cts:17,20; source command schema actual runtime tests |
| zod@3.25.76 | int | (message?) → ZodNumber | installed v3/types.d.cts:325; source command schema actual runtime tests |
| zod@3.25.76 | literal | (value:Primitive,params?) → ZodLiteral<Value> | installed v3/types.d.cts:1011; source command schema actual runtime tests |
| zod@3.25.76 | max | (maxLength:number,message?) → ZodString; (max:number,message?) → ZodNumber | installed v3/types.d.cts:255,322; source command schema actual runtime tests |
| zod@3.25.76 | min | (minLength:number,message?) → ZodString; (min:number,message?) → ZodNumber | installed v3/types.d.cts:254,319; source command schema actual runtime tests |
| zod@3.25.76 | number | (params?:RawCreateParams and {coerce?:boolean}) → ZodNumber | installed v3/types.d.cts:979; source command schema actual runtime tests |
| zod@3.25.76 | object | (shape:ZodRawShape,params?) → ZodObject with strip mode | installed v3/types.d.cts:1000; source command schema actual runtime tests |
| zod@3.25.76 | parse | (data:unknown,params?) → Output; throws ZodError for invalid input | installed v3/types.d.cts:63; installed runtime and strict command/target tests; source command schema actual runtime tests |
| zod@3.25.76 | refine | (check,message?) → ZodEffects<this,Output,Input> | installed v3/types.d.cts:71–72; source command schema actual runtime tests |
| zod@3.25.76 | regex | (regex:RegExp,message?) → ZodString | installed v3/types.d.cts:247; source command schema actual runtime tests |
| zod@3.25.76 | safeParse | (data:unknown,params?) → success/data or failure/error union | installed v3/types.d.cts:64; installed SafeParseReturnType; strict ownership/receipt tests; source command schema actual runtime tests |
| zod@3.25.76 | strict | (message?) → ZodObject with strict unknown-key mode | installed v3/types.d.cts:536; source command schema actual runtime tests |
| zod@3.25.76 | string | (params?:RawCreateParams and {coerce?:true}) → ZodString | installed v3/types.d.cts:976; source command schema actual runtime tests |
| zod@3.25.76 | array | (schema:ZodTypeAny,params?) → ZodArray<El> | installed v3/types.d.cts:999; image deletion target array schema existing contract reused |
| zod@3.25.76 | optional | () → ZodOptional<this> | installed v3/types.d.cts:80; absent uploader retained on legacy ownerless quarantine, no fabricated identity |
| zod@3.25.76 | never | (params?:RawCreateParams) → ZodNever | installed v3/types.d.cts:997; ownerless version forbids any invented uploader, original v1 uploader remains required |

新工厂/事务回调执行真实shared状态机，新增3个SDK断开/错误SDK/假decoy故障各102正常控制/1指定失败，当前standing103。两种nativeget形状、throw/silent/code/wrong-upsert写确认、未知commit重放和输入指纹均由实际bridge测试。Node20.19的483项关键组合和三函数产物加载/离线真实public读取通过。原生磁盘证明不代替CloudBase缺文件删除/像素/网关大文件或真实部署。

新增实际SDK请求序列化探针：undefined上传者在顶层与intent里都被省略，永久ID的大小写、编码和尾空格逐字保留；installed serializer/datatype.ts:70–85和DocumentReference.set真实发送参数互证。注入capture阶段的异常null字段，103检查中102控制/1指定失败；这是门禁wire形状负控，另列于24个生产运行缺陷。初版FakeRequest返回少data封套导致真实SDK抛错，只算探针工具错误，已按安装document.ts:200–219修正，非生产问题。

## P2d9a stored image byte evidence (2026-10-15)

No new direct third-party SDK surface, dependency, version or shim: added production calls are Node builtins and existing first-party DB/storage/shared facades. New direct SDK inventory is empty (0 pairs), not skipped. MediaStorageAdapter.getObjectAsBase64(fileId:string):Promise<{body:string;byteSize?:number}> is unchanged; CloudBase adapter uses installed node-sdk3.17.2 downloadFile({fileID}) with no encoding/tempFilePath, requires Buffer fileContent, emits canonical base64 plus actual byte length. Official https://docs.cloudbase.net/api-reference/server/node-sdk/storage refreshed; Context7 unavailable. Incorrect MCP document path was unavailable, not treated as documentation proof. Standing103 contract checks pass;63new behavior tests exercise exact default facade and opaquefileID;14runtime defects all detected with positive controls/0skip. No new vendor/network options asserted. Actual57cloud bytes were independently downloaded using temporary links with exact fileId equality, then local replay57passes; this does not prove this new helper's SDK download transport or a bounded network/memory contract. Local sharp0.34.5 pixels57pass is diagnostic only; no Sharp backend dependency or deployment packaging change. Health publication/list admission remain unsealed and incomplete.

## P2d9b bounded read SDK boundary (2026-10-15)

15 persisted pairs: node-sdk3.17.2 getTempFileURL plus existing downloadFile type/internal-sender comparison,12actual TypeScript5.9.3 namespace methods and Node.getText in the new gate. Context7 unavailable. Official https://docs.cloudbase.net/api-reference/server/node-sdk/storage refreshed; per-file COS_URL is confirmed by installed IGetFileUrlOptions and storage.getTempFileURL forwarding url_type, then by real Linux cloud reads. Do not infer public app.downloadFile wrapper forwarding from the internal storage.downloadFile body. Normal3reads, exactfileId/size/SHA, forbidden nonce, actual cap1 and timeout1ms (metadata settled145ms/zeroGET) passed in isolated nonce-protected Event probes. Both probe instances removed and absence verified; no business writes/application deployment. SDK106 and4faults with104-105positivecontrols/1-2namedfailures restore exact source; Unicode consumer proves the population check. HTTPGET and CloudBase factory option-branch AST are tied to the actual sender, not comments. 139localintegration/23runtime faults pass their stated expectations; no pixel/complete-readiness or whole-media-delivery claim.

| package@version | method | exact installed signature | used return shape | evidence |
| --- | --- | --- | --- | --- |
| typescript@5.9.3 | createSourceFile | (fileName: string, sourceText: string, languageVersionOrOptions: ScriptTarget \| CreateSourceFileOptions, setParentNodes?: boolean, scriptKind?: ScriptKind): SourceFile | SourceFile | node_modules/typescript/lib/typescript.d.ts:9192 |
| typescript@5.9.3 | forEachChild | <T>(node: Node, cbNode: (node: Node) => T, cbNodes?: (nodes: NodeArray<Node>) => T): T | T | node_modules/typescript/lib/typescript.d.ts:9191 |
| typescript@5.9.3 | isArrayLiteralExpression | (node: Node): node is ArrayLiteralExpression | boolean | node_modules/typescript/lib/typescript.d.ts:9019 |
| typescript@5.9.3 | isCallExpression | (node: Node): node is CallExpression | boolean | node_modules/typescript/lib/typescript.d.ts:9023 |
| typescript@5.9.3 | isFunctionDeclaration | (node: Node): node is FunctionDeclaration | boolean | node_modules/typescript/lib/typescript.d.ts:9074 |
| typescript@5.9.3 | isIdentifier | (node: Node): node is Identifier | boolean | node_modules/typescript/lib/typescript.d.ts:8972 |
| typescript@5.9.3 | isIfStatement | (node: Node): node is IfStatement | boolean | node_modules/typescript/lib/typescript.d.ts:9057 |
| typescript@5.9.3 | isMethodDeclaration | (node: Node): node is MethodDeclaration | boolean | node_modules/typescript/lib/typescript.d.ts:8984 |
| typescript@5.9.3 | isObjectLiteralExpression | (node: Node): node is ObjectLiteralExpression | boolean | node_modules/typescript/lib/typescript.d.ts:9020 |
| typescript@5.9.3 | isPropertyAccessExpression | (node: Node): node is PropertyAccessExpression | boolean | node_modules/typescript/lib/typescript.d.ts:9021 |
| typescript@5.9.3 | isPropertyAssignment | (node: Node): node is PropertyAssignment | boolean | node_modules/typescript/lib/typescript.d.ts:9121 |
| typescript@5.9.3 | isStringLiteral | (node: Node): node is StringLiteral | boolean | node_modules/typescript/lib/typescript.d.ts:8956 |
| typescript@5.9.3 | Node.getText | (sourceFile?: SourceFile): string | string | node_modules/typescript/lib/typescript.d.ts:4318 |
| @cloudbase/node-sdk@3.17.2 | getTempFileURL | ({ fileList }: IGetFileUrlOptions, opts?: ICustomReqOpts): Promise<IGetFileUrlResult> | Promise<IGetFileUrlResult>; used fileList entries: {code:string,fileID:string,tempFileURL:string} | packages/db/node_modules/@cloudbase/node-sdk/types/index.d.ts:570 |
| @cloudbase/node-sdk@3.17.2 | downloadFile | ({ fileID, tempFilePath }: IDownloadFileOptions, opts?: ICustomReqOpts): Promise<IDownloadFileResult> | Promise<IDownloadFileResult>; fileContent:string \| Buffer \| undefined; raw no-encoding path Buffer | packages/db/node_modules/@cloudbase/node-sdk/types/index.d.ts:558 |


## P2d9c — sharp0.35.5 actual pixels and Node20 imports

Persisted .claude/sdk-surfaces-pixels-pending.txt before exact-row join;10/10 installed and runtime-callable pairs,0missing. Actual declarations are dist/index.d.mts; a preliminary lib/index.d.ts-only filter yielded0 and was corrected before acceptance. Context7 unavailable. Official references: [sharp constructor](https://sharp.pixelplumbing.com/api-constructor/), [output/timeout](https://sharp.pixelplumbing.com/api-output/#timeout), [installation](https://sharp.pixelplumbing.com/install/), [security](https://sharp.pixelplumbing.com/security/), [0.35.5](https://sharp.pixelplumbing.com/changelog/v0.35.5/), [Node20.19.0 package imports](https://nodejs.org/download/release/v20.19.0/docs/api/packages.html#subpath-imports).

| package@version | method | exact installed signature | used return shape | evidence |
| --- | --- | --- | --- | --- |
| sharp@0.35.5 | gif | (options?: GifOptions \| undefined): Sharp | Sharp | node_modules/.pnpm/sharp@0.35.5_@types+node@22.19.21/node_modules/sharp/dist/index.d.mts:805 |
| sharp@0.35.5 | jpeg | (options?: JpegOptions \| undefined): Sharp | Sharp | node_modules/.pnpm/sharp@0.35.5_@types+node@22.19.21/node_modules/sharp/dist/index.d.mts:758 |
| sharp@0.35.5 | metadata | (): Promise<Metadata> | Promise<Metadata> | node_modules/.pnpm/sharp@0.35.5_@types+node@22.19.21/node_modules/sharp/dist/index.d.mts:326 |
| sharp@0.35.5 | png | (options?: PngOptions \| undefined): Sharp | Sharp | node_modules/.pnpm/sharp@0.35.5_@types+node@22.19.21/node_modules/sharp/dist/index.d.mts:788 |
| sharp@0.35.5 | raw | (options?: RawOptions \| undefined): Sharp | Sharp | node_modules/.pnpm/sharp@0.35.5_@types+node@22.19.21/node_modules/sharp/dist/index.d.mts:838 |
| sharp@0.35.5 | resize | (widthOrOptions?: number \| ResizeOptions \| null \| undefined, height?: number \| null \| undefined, options?: ResizeOptions \| undefined): Sharp | Sharp | node_modules/.pnpm/sharp@0.35.5_@types+node@22.19.21/node_modules/sharp/dist/index.d.mts:919 |
| sharp@0.35.5 | sharp | (options?: SharpOptions \| undefined): Sharp | Sharp | node_modules/.pnpm/sharp@0.35.5_@types+node@22.19.21/node_modules/sharp/dist/index.d.mts:1993 |
| sharp@0.35.5 | timeout | (options: TimeoutOptions): Sharp | Sharp | node_modules/.pnpm/sharp@0.35.5_@types+node@22.19.21/node_modules/sharp/dist/index.d.mts:880 |
| sharp@0.35.5 | toBuffer | (options?: { resolveWithObject: false; } \| undefined): Promise<Buffer<ArrayBuffer>> | Promise<Buffer<ArrayBuffer>> | node_modules/.pnpm/sharp@0.35.5_@types+node@22.19.21/node_modules/sharp/dist/index.d.mts:665 |
| sharp@0.35.5 | toFormat | (format: keyof FormatEnum \| AvailableFormatInfo \| "avif", options?: RawOptions \| OutputOptions \| JpegOptions \| PngOptions \| WebpOptions \| AvifOptions \| HeifOptions \| JxlOptions \| GifOptions \| Jp2Options \| TiffOptions \| undefined): Sharp | Sharp | node_modules/.pnpm/sharp@0.35.5_@types+node@22.19.21/node_modules/sharp/dist/index.d.mts:847 |

Official MCP2.35.2/manager-node5.8.8 source verifies parent-path adjustment and Event online-install filtering of root node_modules. Runtime probe uses the default private #catalog-image-decoder import mapped to vendor/image-decoder.mjs, with pinned Linux native packages; native archives match lockfile SHA-512. Final Linux x64 Node20.19.3 glibc2.28/256MB probe18: all outcomes correct,3actual image byteSize/checksum matches,expired synchronous budget starts0native work. Promise budget does not preempt synchronous CPU or promise hard cancellation of C++/libuv queue. 34local/173Node20 composed/3449full/17source faults/SDK106; all source hashes restored. No shim/vendor DB method/auth/env change. Full application packaging and readiness authority remain pending; fullDeliveryReady=false. See P2d9c and pixel-* evidence.


### P2d9c1 review correction

[PNG3 fdAT](https://www.w3.org/TR/png-3/#11fdAT) permits zero-length frame_data after the4-byte sequence; minimum chunk payload is4, not5. No SDK API/method change. Legal empty IDAT/fdAT plus later bytes now pass; entire empty frame and sequence shorter than4 still fail safely.37local,176Node20 composed,3452full,18source faults with controls/0skip and restored17hashes;21real Linux/default-loader cases;57actual frozen clock images locally replayed with original byteSize/SHA. Prior48d062c review was blocked; new candidate must be reviewed. Exact10sharp pairs unchanged, installed modern declaration still dist/index.d.mts; application packaging/admission remains pending.


### P2d9c2 exact overload and ordering correction

PNG3 Table7 permits first fcTL before acTL when both precede IDAT; final acTL/frame consistency checks remain. No new SDK pair. Current TypeScript census resolves415calls,0unresolved;10sharp pairs cover12used overload signatures, including both toBuffer return shapes. Complete exact installed declarations/returns are in output/pricing-clock-repair-2026-10-13/p2d9/pixel-revision2-sdk-inventory.json; this supplements the initial single-signature table.40local/179Node20/3455full/19runtime faults with controls;17frozen hashes match.24Linux/default-loader cases and owned-function absence verified. Application packaging and readiness remain pending.


### P2d9d function decoder artifact

13persisted pairs: prior10Sharp methods plus esbuild@0.27.7 buildSync,tsx/cjs/api@4.22.4 require,tsup@8.5.1 defineConfig. Installed exact declarations/return evidence and runtime callable checks are recorded in pixel-pack-sdk-inventory.json. Generated child-smoke Sharp calls are executed, not claimed fully TypeScript checked. Existing CloudBase SDK106 passed, no shim/API/auth/env change. Official pnpm mapping supportedArchitectures verified; newer pnpm12platform-list syntax is not used. DefaultLinux vendor126files/20,301,236bytes/6packages, native bytes equal independently verified archives; real Linux Node20.19.3 default-loader24outcomes and3actual clock checks match. Node20local23,deploy scripts485,7actual source faults with positive controls and restored8hashes; technical probe absent afterdelete. Formal production consumer and high-image/concurrency resource budget remain pending.


### P2d9e combined stored-health evidence

25inherited SDK/compiler pairs join exactly: prior15bounded-reader/compiler pairs plus10Sharp pairs. No newvendor method/shim. New ./pixels package export and internal typed inspection callback preserve the actual dependency; five backend typechecks/SDK106 pass. Real Linux Node20.19.3/512MiB probe executes default SDK initialization, DB get, bounded object GET and default pixel decoder for3actual clock images, with size/SHA and final-record consistency. SDK init/get source reviewed as read-only.

All resource counterexamples preserved:256MiB fourdistinct maximum PNGs had2timeouts, serial retry of those2stilltimedout; same default codec and budgets at512MiB decoded both serial and all4distinct with matchingSHAs. Only owned probe MemorySize changed using verified SCF UpdateFunctionConfiguration/2018-04-16 MemorySize512, currentenv namespace; active512readback confirmed. Actual sourceworker512MiB/900s read-onlyconfirmed; no application config/deployment/write. Synthetic probe evidence is not full-app P95 or hard memory proof.31new/135composed/210Node20/3486broad,12actual source faults,19restored hashes; owned technical instances12deleted and absence verified. Trusted producer/version seal and publish acceptance remain pending.


### P2d9e1 failure result projection

No SDK pair change. Structural extra fields on valid typed invalid/retry objects were reproduced in2failing tests; explicit status/reason projection removes them.137composed/33health,212Node20,3488broad,13actual runtime defects with controls99–136,19restored hashes. All57actual clock images verified via default DB/storage/decoder on Linux Node20.19.3/512MiB, original sizes/SHA match14,124,824bytes; current source/build hashes bound. Owned probe13deleted and absence verified; no application deployments/business writes. Earlier812649b remainsBLOCK history; new candidate requires exactreview.

## P2f1 preparation authority

Installed zod3.25.76 declarations packages/db/node_modules/zod/v3/types.d.ts (ZodType parse/safeParse/refine, ZodString regex/min/max, ZodNumber int/nonnegative/positive/max, ZodObject strict/extend, z.object/string/number/literal) match the actual module. Official version3 reference https://v3.zod.dev/ checked.66 real tests exercise strict unknown input and typed outputs; DB tsc passes without assertion shims. Node crypto createHmac/update/digest and timingSafeEqual use exact32-byte SHA256; independent signing/length negatives pass. No CloudBase SDK method/option is introduced. Existing CloudBase contract script remains green. Artifact/runtime integration is pending and not claimed by this module result.

## P2f2 durable preparation jobs

Context7 unavailable in current tool inventory. Read CloudBase official /database/transaction through MCP readDoc (web fetch timed out, MCP primary text succeeded). Installed @cloudbase/node-sdk3.17.2 + @cloudbase/database1.4.3 runtime methods runTransaction/collection/doc/get/set confirmed without network operations; source transaction/index.ts:98-152 awaits commit and returns callbackRes directly, retrying DATABASE_TRANSACTION_CONFLICT. Official page's example wrapped result is not the installed return shape; actual source and existing adapter contract control. No new shim or SDK option.

Reuse catalogRowStore: SDK get passes through sdkAnswer/normalizeSingle; set strips_id and requires confirmed updated/upserted identity; all failure shapes are executed in wrapper tests. Snapshot reads do not lock inputs, and no external network/codec work runs in tx. Job ownership writes the same job row; final readiness producer must atomically fence product/input as well. New zod3.25.76 enum/discriminatedUnion/unknown/datetime plus existing strict/refine/safeParse/parse methods compile and execute in113tests. CloudBase contract script remains green. Four backend typechecks and Node20 actual execution179tests pass; cloud acceptance not claimed.

## P2f3 leased candidate readers

No newly introduced third-party SDK method/option/type-shim. New calls are first-party access guards and DB manageCatalogPreparationJob facade from P2f2; existing zod Request.safeParse/candidate validators retain installed3.25.76 contracts. Human HTTP path supplies actual users-row checks; backend bridge supplies current lease renew and derives product scope from the validated job, never a JSON callback.76composed/183Node20 exercise actual shared readers and file persistence. Failure objects are explicitly projected at both callback and adapter boundaries; privateTrace red reproduced before fix. Inherited CloudBase contract gate rerun; livecloud worker integration remains pending.

## P2f4 image observations and shared metadata input

New third-party surface: zod3.25.76 nullable(): ZodNullable<this>, installed v3/types.d.ts:81; null-image diagnostic cases execute it, plus existing discriminatedUnion/enum/strict/refine/positive/max/safeParse methods. No newCloudBase method/option/shim. Both observation writes reuse catalogRowStore confirmedset and sdkAnswer(code retained); installed database1.4.3 transaction/index.ts retries code DATABASE_TRANSACTION_CONFLICT. No externalIO/nativecodec inside tx. Wrappers measure6operations withoutsource,9withsource; allreads before writes; four second-write failure shapes rollback bothrows.

Default LocalDiskMediaStorage put/byte finalize/default readStoredCatalogImageHealth/actual sharp0.35.5/persistent observation/reopen run without injected record/body/decoder. The testPNG comes programmatically from the already verified health fixture; dimensions24x16 and actualSHA match. Node20Mac343composed tests; not Linuxliveworker acceptance. Current CloudBase contract106/types and487deploy scripts pass. ADMINONLY resource declaration added, no actualcollectioncreation/authchange. Observations deliberately cannot parse asreadyreport and are not physicalimmutability seals.

## P2f5a source-media batch read

Only first-party backend list/get are reused. No new vendor method, type shim, SDK version or query DSL was introduced. Existing CloudBase list translates `_id in` via installed @cloudbase/database1.4.3 Command.in (src/command.ts:35; QueryCommand.toJSON outputs $in array), then count/orderBy('_id','asc')/skip/limit(100)/get. Explicit ID sorting avoids the adapter default createdAt ordering. count/get are separate snapshots; only matching returned IDs are consumed. Context7 remains unavailable; existing official query/transaction references and installed sources apply. Current SDK contract gate106, consumer types, complete1/100/101/205-image tests, actual JsonFileAdapter approval/readback/withdrawal and malformed binding tests pass. This is not live CloudBase query or worker acceptance evidence.

## P2f5 durable media cursor

No new CloudBase method/resource/shim. Existing transaction get/set through confirmed catalogRowStore; bound media plan uses at most6 source-backed operations and a step/observation commit9. Zod3.25.76 safe/nullable/strict/refine/parse/safeParse signatures are inherited from existing table rows (safe at v3/types.d.cts:334, nullable:81); new strict progress refinements exercised with invalid counts/cursor/receipt/integers. Context7 unavailable. Four consumer types and SDK106 current. Tests assert reads before writes and rollback both cursor/observation for thrown, silent, coded and wrong-ID ACKs. This is local SDK-shape evidence, not live-cloud MVCC or native worker deployment evidence.

## P2f6 worker and function consumer

New first-party fn-admin/catalog-preparation-worker subexport and fn-alibaba workspace edge; no vendor version upgrade, SDK method, shim or native fetch contract changed. Existing authority uses independent-purpose/env HMAC and randomUUID; actual Node20 source-main/signed-message/default LocalDisk+sharp flows exercise them. Existing CloudBase facade manages jobs through the same get/set transaction wrapper. Sharp default dynamic alias remains external and pinned0.35.5; Linux126-file package verified; same JS copied into Mac-target artifact and bare Node20/native four-format smokes pass. This does not prove the packaged worker executes against actual Linux CloudBase records. Context7 unavailable; prior installed SDK/native dependency probes retained, SDK106/current4types green. No async callFunction option or implicit background execution was invented; current bounded service entry is awaiting protected caller/resume/UI integration.

## P2f7a protected destination / broker separation

@cloudbase/node-sdk3.17.2 getUploadMetadata is the sole refactored vendor consumption; exact package/method join to the existing row is1/1. TypeScript-printer AST body of the old getUploadCredential mapper equals new private mintUploadCredential, including data shape/PUT/header/key mapping; executable proof stored in protected-media-path-sdk-mapper-proof.json. Existing beforeWrite/rawPUT and native uploadFile contracts unchanged; new protected namespace requires a checkpoint callback and goes through private tracked minter, while public broker rejects it before SDK mint. Callback presence is not a persistence proof. SDK106 and5consumer types, actualwire/LocalDisk/defaultworker/public-private delivery tests pass.

Context7 unavailable; reread official https://docs.cloudbase.net/api-reference/server/node-sdk/storage and storage OpenAPI via MCP; saved full content in protected-media-path-official-docs.json. OpenAPI cloudObjectId/cloudObjectMeta are not adopted as node SDK fileId/cosFileId fields. No method/ambient shim/version upgrade. Test cloud permissions and previously signed URL behavior, persistent attempt/final target switch and readiness producer remain unverified by this local path unit.
