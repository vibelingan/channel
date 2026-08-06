# Revision R1 — Independent Review Fold-In (2026-08-06)

Per `START_HERE.md` ("Confirmed findings are incorporated through an updated
document revision before code starts beyond MIU 0"), this revision folds the
independent review of the frozen contract against the actual repository
(`origin/main @ 2f79a61`) into the doc set. The review ran six lenses
(A additive-compat, B registry feasibility, C pricing/money/API, D OAuth flow,
E concurrency/runner, F deploy/media) with adversarial verification against
exact file/line evidence.

**Verdict: no architecture change.** All findings are precision fixes,
compatibility-scope enumerations, and repo-reality corrections. The additive
design, collections, data contracts, invariants, and MIU ordering stand.

Each finding below states its disposition and where the doc set changed.
Section references use the revised files.

## HIGH findings (all accepted)

| # | Lens | Finding | Doc change |
|---|---|---|---|
| H1 | C | `alibabaCatalogPricing` embeds `sourceOfferKey`/`sourceProductId`/`sourceSkuId`; the public API copies allowlisted fields whole, so raw supplier offer identifiers would ship to anonymous callers (visitors could buy direct from the source). | ARCHITECTURE §6.1: public sub-projection strips the three provenance fields; MIU 9 done-condition added. |
| H2 | A+C | The live product page renders legacy `unitPrice` at two sites outside `PriceBlock` (HeadphonesProductCard price badge, HeadphonesProductDetail spec-sheet row); the contract's single-renderer branch would leave stale manual prices visible on linked products. | ARCHITECTURE §6.2 + COMPATIBILITY Stage E + MIU 10: full render-site enumeration; suppression rules for linked products; MOQ display rule. |
| H3 | D | The new function's env was specified as only the five ALI_*/WECOM_* secrets, but session validation needs `JWT_SECRET`, DB init needs `TCB_ENV`, and browser calls need `CORS_ALLOWED_ORIGINS`; deploys REPLACE the function env wholesale. Without these the test-env connect flow is dead on arrival. | ARCHITECTURE §8 env table extended; MIU 14 manifest env spec. |
| H4 | D | OAuth start cannot be a 302-redirect endpoint: sessions live only in localStorage (no cookie), and the site/API origins differ (CORS). | ARCHITECTURE §8.1: OAuth start is an admin-authenticated JSON action returning `{authorizeUrl}`; browser navigates; callback is unauthenticated, state-bound, and 302s back to the site origin. |

## MEDIUM findings (all accepted)

| # | Lens | Finding | Doc change |
|---|---|---|---|
| M1 | C | `currency` is required on the pricing type, but `unavailable` must be constructible from currency-less sources; source-deletion had two allowed representations. | DESIGN_CHARTER §6.2: `currency` optional, allowed only with numeric amounts; canonical source-deleted form = object retained with `mode:'unavailable'`. |
| M2 | C | Primary-offer selection was a partial order (mixed CNY/USD incomparable without FX; negotiable/unavailable rank undefined). | ARCHITECTURE §5: total order (amount-bearing within highest-priority currency USD>CNY, then negotiable, then unavailable, lexical tie-break). |
| M3 | B | `adminAccess` enum can't express the existing role-dependent hardcoded gate; composition semantics undefined (contributor rights per level). | DESIGN_CHARTER §7 + MIU 3: `adminAccess` enforced inside `canReadCollection`/`canEditCollection`; existing hardcoded admin-only trio unchanged (regression-tested); `crud`/`readOnly` grant admin+contributor as today. |
| M4 | B | Admin `collections` action dumps the entire registry (incl. token/lease field schemas) to any admin/contributor session. | MIU 3: filter `collections` response by `adminAccess` (exclude `none`), with test. |
| M5 | D | No frozen gateway route path or callback URL shape; a path shadowed by public-api's `/api` prefix or mismatched with the registered callback breaks the flow. | DESIGN_CHARTER §2 + ARCHITECTURE §8.1: routePath frozen `/api/alibaba-catalog-sync`; test callback URL `https://<TCB_ENV_ID>.service.tcloudbase.com/api/alibaba-catalog-sync/oauth/callback`. |
| M6 | D | Alibaba platform variant/endpoints unpinned (implementation-blocking); official docs unreachable at review time. | ARCHITECTURE §8.2: platform pinned to Alibaba.com International Open Platform (per verified 2026-07-28 research in `docs/accio-alibaba-integration/REPORT.md`); endpoint constants centralized with env override + HTTPS/allowlist guard; live verification is a mandatory MIU 15 smoke gate. |
| M7 | D | GH secret plumbing omitted: deploy-test.yml env pass-through, GH `test` environment provisioning, and the built-site secret-name scan lists. | MIU 14 done-conditions enumerate all three. |
| M8 | F | `scripts/runtime-contract.test.mjs` pins function build configs and deploy-script AST facts; a naive manifest refactor fails it or lets the new function escape bundling assertions. | MIU 14: runtime-contract.test.mjs listed as a manifest consumer updated in lockstep. |
| M9 | F | Deploys REPLACE live function env wholesale; a manifest that fails to reproduce current admin/public-api env maps byte-for-byte silently un-sets live vars. | MIU 14: env-map snapshot equality contract test required before the deploy script switches to the manifest. |
| M10 | F | No trigger tooling exists anywhere in the repo; "test env timer absent" is unenforceable in either direction. | MIU 14: trigger reconciliation specified as new tooling (test deploy asserts/deletes, prod applies desired state, smoke asserts absence); MIU 0 probes the mechanism. |
| M11 | F | No production deploy path exists; MIU 15's production steps had no substrate. | MIU 15: production activation explicitly declared new scope / manual-with-evidence; not implied as existing. |
| M12 | F | "Candidate media" as status `pending` would be garbage-collected by the 24h orphan sweep. | ARCHITECTURE §13 + MIU 12: imported candidate = verified bytes, status `active`, `publishedRefCount 0`, not attached to product imageIds. |
| M13 | F | Media ownership: no session user for a worker; missing `uploadedByUserId` skips reference locks, a sentinel makes rows undeletable (only delete path checks uploader identity). | ARCHITECTURE §13 + MIU 12: fixed sentinel owner + dedicated admin-only removal action for unreferenced imported candidates. |

## LOW findings (all accepted)

| # | Lens | Finding | Doc change |
|---|---|---|---|
| L1 | C | Per-mode allowed-field matrix incomplete (validator divergence risk; candidate hashing needs canonical objects). | DESIGN_CHARTER §6.2 field matrix. |
| L2 | A | `clearancePrice` and Overstock render sites missing from the protected-surface grep list; PUBLIC_CATALOG_FIELDS is shared with overstock. | EXECUTION_HANDOFF §3 + MIU 9 (overstock payload contract test). |
| L3 | A | MOQ display for linked products unspecified (stale manual MOQ next to Alibaba pricing). | ARCHITECTURE §6.2: linked products show `pricing.sourceMoq`; legacy moq row suppressed while linked. |
| L4 | B | Operator pin of `alibabaPrimaryOfferKey` had no write path (read-only in generic CRUD). | MIU 13: dedicated `setAlibabaPrimaryOffer` admin action (validates offerKey against active offers; trusted write). |
| L5 | B | MIU 4 inventory incomplete: third DbAdapter implementation (MemoryAdapter test fake) + SDK-contract probe script. | MIU 4: MemoryAdapter strategy + verify-cloudbase-sdk-contract.mjs probes for create-with-id/transactional set. |
| L6 | D | Admin-role ambiguity (`canAccessAdmin` admits contributors). | ARCHITECTURE §8.1: connection lifecycle actions require live-revalidated role === 'admin'. |
| L7 | D | `ALI_TOKEN_ENCRYPTION_KEY_V1` format/absence behavior unspecified (cold-start crash risk). | ARCHITECTURE §8: 64-hex-char (32-byte) key; lazy validation; fail-closed "not configured"; all ALI_*/WECOM_* vars read via optionalEnv (cold start and health never require them). |
| L8 | D | OAuth callback is an unauthenticated endpoint with no abuse control (repo convention throttles all such endpoints). | ARCHITECTURE §8.1 + MIU 5: reserve-first rate limiting on callback and failed starts via the rateLimitHits pattern. |
| L9 | F | Raw-payload hash-addressed storage needs a media-storage namespace/path-builder extension the module layout didn't list. | ARCHITECTURE §2 + MIU 6: `alibaba-raw` namespace + hash-addressed path rule on the shared facade. |
| L10 | F | Doc baseline is 6 commits behind origin/main (storage upload contract changed post-baseline). | EXECUTION_LOG MIU 0 records actual HEAD + re-validated storage facts (done). |
| L11 | F | Frozen names lacked the gateway routePath. | DESIGN_CHARTER §2 (same change as M5). |
| L12 | F | Cold-start smoke runs every packaged function with stub env; requireEnv-at-module-load would crash it. | Same change as L7. |
| L13 | F | Module layout omitted the local-server route mirror (repo dev-parity convention). | ARCHITECTURE §2 + MIU 13/14 file lists. |

## Lens E findings (concurrency/lease/runner — all accepted)

| # | Sev | Finding | Doc change |
|---|---|---|---|
| E1 | HIGH | The deploy path hardcodes `timeout: 20, memorySize: 256` for every function in BOTH the generated cloudbaserc and `updateFunctionConfig` (re-applied on every deploy) — the 720-second runner would be killed at 20s on every tick, and a manually raised timeout regresses at the next deploy. | ARCHITECTURE §14: manifest schema gains per-function `timeout`/`memorySize`, threaded through both deploy paths; `alibaba-catalog-sync` set to 900s (SCF event ceiling; 720s soft deadline fits), existing functions keep 20s; covered by drift tests. |
| E2 | HIGH | Standalone `assertAlibabaSyncLease` + separate update is check-then-act: after the assert passes, the lease can expire/be fenced over during a stall and the stale write still lands. The enumerated adapter surface cannot implement "stale holders cannot promote after fence takeover". **This is R1's one architecture amendment** (approved under the user's delegated-judgment instruction): a fenced conditional-write primitive `updateDocWithAlibabaLease(collection, id, patch, {connectionId, holder, fence, now})` — CloudBase: one `runTransaction` reading the lease doc and writing the target; local JSON: one `withMutationLock` critical section. Used for product promotion, offer/source tombstone flips, and checkpoint advances. `assert` remains only as a cheap pre-check optimization. | ARCHITECTURE §9 method list amended. |
| E3 | MED | `createDocWithId`/`upsertDocWithId`/transactional lease-create rest on SDK surfaces the CI contract script never probes (in-transaction `doc.set` upsert semantics, runtime-only `doc.create`, duplicate-`_id` error contract). | MIU 4 done-conditions: extend `scripts/verify-cloudbase-sdk-contract.mjs` probes + `NodeSdkTransaction` typing. |
| E4 | MED | Run statuses were never enumerated; quarantine vs resume-first vs the 24h auto-fail interact contradictorily (a quarantined "active" run blocks all sync then auto-fails with approval undefined). | ARCHITECTURE §12: statuses enumerated (`running/continuing/quarantined/approved/failed/completed`); quarantine releases the lease and vacates the active slot; incremental runs may start while a quarantine is pending; the 24h/96-continuation clock stops at quarantine entry; approval validity window defined. |
| E5 | MED | Quarantine ratios had no denominators; 0/0 first-run cases undefined; a "successful" zero-item enumeration against a small mirror could tombstone 100% of the catalog under the absolute floors. | ARCHITECTURE §12: denominators pinned (changes / linked count at run start; tombstones / active sources at run start; parse failures / items processed); zero-denominator handling; new trigger: zero-item full enumeration with active sources > 0 → quarantine. |
| E6 | LOW | Scheduler text reads as tick-time equality; one missed 18:30 tick silently skips a week of tombstone detection. Cron evaluates in UTC+8 on SCF — safe for the tz-agnostic 15-min expression only. | ARCHITECTURE §10: due-based semantics (`nextFullDueAt`/`nextIncrementalDueAt` in the checkpoint, start highest-priority job with `dueAt <= now`, recompute from schedule not from now); weekly schedule never moves into the cron expression. |
| E7 | LOW | Fence recheck was scoped only to product promotion; stale holders could still overwrite offer/mirror/tombstone/checkpoint state. | ARCHITECTURE §9: those writes also go through the fenced primitive (E2). |
| E8 | LOW | A resumed, hours-long full enumeration over a mutating catalog is not a consistent snapshot; an item moving between scanned and unscanned ranges is falsely tombstoned. | ARCHITECTURE §11: each tombstone candidate is individually confirmed via a product-detail fetch (not-found/removed) before the flip; confirmation failures quarantine. |

Lens E also **confirmed feasibility**: the pinned `@cloudbase/node-sdk 3.17.2`
transaction lineage supports everything the lease needs (in-transaction
get/set/create/remove, upsert-style `doc.set`, retry only on
`DATABASE_TRANSACTION_CONFLICT`), and the scheduler math checks out
(`0 */15 * * * * *` valid 7-field SCF cron; 96 × 15 min = the 24h bound;
lease TTL 180s / renew 60s spans the tick gap — with an explicit lease release
at soft-deadline exit). Operational notes carried into MIUs 4/11: acquire
lease → read checkpoint → single-winner run-row creation ordering; manual
"run now" is mark-due + short HTTP response (the gateway envelope stays ~20s — **(Superseded by ARCHITECTURE §10.1.)**
the raised timeout applies to timer invocations, and interactive OAuth routes
share the function); tombstone seen-set via `lastSeenRunId` stamping, not
checkpoint accumulation.

## Implementation notes carried forward (non-defect)

The reviewers' verified insertion points and call shapes are recorded in
`EXECUTION_LOG.md` per-MIU as they are consumed. Highlights: PUBLIC_CATALOG_FIELDS
at `apps/functions/public-api/src/handler.ts:131`; registry insertion at
`packages/shared/src/collections.ts` (products def + COLLECTIONS array);
access seam at `packages/shared/src/auth.ts` `canReadCollection`/
`canEditCollection`; OAuth state single-use via `createDocWithId` +
`incrementField` CAS 0→1 (passwordResets precedent); session validation mirror
of `apps/functions/public-api/src/handler.ts:70-91`; storage via
`mediaStorage().putObject` with the new namespace; deterministic-ID hazards in
both adapters' `create()` spread order; NON_QUERYABLE_FIELDS additions for
hash/fingerprint fields; nosql-resources entries for all ten collections.
