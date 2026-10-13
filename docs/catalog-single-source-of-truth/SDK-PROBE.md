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
