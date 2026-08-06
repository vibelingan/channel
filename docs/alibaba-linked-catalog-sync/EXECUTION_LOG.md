# Execution Log — feature/alibaba-linked-catalog-sync

Chronological record of MIU execution. Newest entries at the bottom.

## MIU 0 — Baseline and live contract evidence

**Started:** 2026-08-06 (UTC)

### Baseline

- Branch: `feature/alibaba-linked-catalog-sync`
- Created from: `origin/main @ 2f79a6188730043c24fc357faa1ac548d5c0c850`
  (`docs(sdk): record the probe rows the upgrade should have written`)
- Documentation baseline referenced by this doc set: `main @ 5c14193b93cf023ed791086902bc4423fd077198` — verified an ancestor of the
  actual starting commit, 6 commits behind. The 6 intervening commits are
  CloudBase SDK upload fixes (PUT contract) and docs/learnings only; none touch
  pricing, the product registry, or the public API surface.
- Worktree: `channel-alibaba-linked-catalog-sync` (sibling of the main checkout)
- `pnpm install --frozen-lockfile`: clean (pnpm 11.5.0)

### Secrets handling

- `ALI_APP_KEY` / `ALI_APP_SECRET` stored in gitignored `.env` only.
  `.env.example` receives placeholder entries (no real values) in this branch.
- Raw values that had been pasted into the main checkout's uncommitted
  `.env.example` were moved into `.env` and the example file restored, so the
  secret cannot reach git history from any session.

### Upstream platform contract evidence

- Prior verified research: `docs/accio-alibaba-integration/REPORT.md`
  (2026-07-28, parked on `main`) confirms:
  - Platform: Alibaba.com International Station Open Platform
    (`open.alibaba.com`), NOT 1688/Taobao/AliExpress.
  - Product APIs: `alibaba.icbu.product.list` (30/page, 5,000-item query cap,
    `gmt_modified_from/to` windows), `alibaba.icbu.product.get`,
    `alibaba.icbu.product.schema.render` — matching ARCHITECTURE.md §11's
    windowed bisection enumeration contract.
  - OAuth 2.0 authorization-code flow; server-side token create/refresh;
    signed API calls (app key + timestamp + HMAC signature).
  - Products/orders are classified user-privacy data → OAuth mandatory.
- App registration: self-developed app, App Key `511630` (secret in `.env`).
- Remaining external gates (permission approval state, live response fixtures,
  signature golden vector against the live gateway) are recorded per-MIU below
  as they are exercised.

### Baseline verification runs

`pnpm test` on the untouched worktree at `2f79a61`: **420 tests, 0 failures**.

| Package | Tests |
|---|---|
| packages/media-storage | 26 |
| packages/shared | 75 |
| packages/db | 23 |
| packages/auth | 2 |
| apps/site | 105 |
| apps/functions/public-api | 42 |
| apps/functions/admin | 147 |

`pnpm typecheck` baseline: **green** (all packages `tsc --noEmit` clean; `astro
check` 0 errors / 0 warnings across 98 files; e2e tsconfig clean).

Local invocation note: the root `typecheck` script shells out to `npx pnpm`,
which under this machine's corepack resolves a pnpm newer than the repo's
`packageManager` pin and aborts. Equivalent local form that honors the pin:

```bash
corepack pnpm -r --filter "./packages/**" --filter "./apps/**" typecheck && corepack pnpm typecheck:e2e
```

### Independent design review (MIU 0 gate) — 2026-08-06

Six review lenses ran against the actual repo at `2f79a61` (12 agents total:
6 subsystem mappers + 6 reviewers with file:line evidence requirements).
Result: **40 findings, all accepted, one architecture amendment** (the fenced
conditional-write primitive). Full traceability in `REVISION_R1.md`; every
amendment is folded into the doc set with R1 markers.

Protected-surface inventory (EXECUTION_HANDOFF §3) was performed as part of
lens A: live render sites for legacy prices are HeadphonesProductCard
(unitPrice badge), HeadphonesProductDetail (moq + unitPrice spec rows,
PriceBlock), admin PreviewModal (all four price rows); the public allowlist
`PUBLIC_CATALOG_FIELDS` is shared products+overstock; `canSeeVipPricing` gates
only the additive `vipPrice` projection; `clearancePrice` added to the grep
list (R1).

External gates that could NOT be exercised in this session (total network
outage on the dev machine — only the agent API tunnel was up): live Alibaba
OAuth endpoint verification and official-doc confirmation of the GOP
endpoints. Handled per ARCHITECTURE §8.2: endpoint constants centralized with
env override; live verification is a mandatory MIU 15 smoke gate. The
platform variant itself IS pinned (Alibaba.com International) by the verified
2026-07-28 research in `docs/accio-alibaba-integration/REPORT.md`.

CloudBase contract evidence at the real baseline: wx-server-sdk 4.0.2 +
@cloudbase/node-sdk 3.17.2 installed and probed by CI
(`scripts/verify-cloudbase-sdk-contract.mjs`); node-sdk `runTransaction`
supports in-transaction get/set/create/remove (create is runtime-only,
unprobed — MIU 4 extends the probes); deploy path hardcodes
`timeout: 20, memorySize: 256` (MIU 14 manifest owns these per R1); no timer
tooling exists in-repo (MIU 0 probe deferred to MIU 14 implementation since
it requires live CloudBase access).

**MIU 0 status: complete** except the explicitly-deferred external gates
listed above (deferral is the documented R1 path, not a silent skip).

## MIU 1 — Pricing types and money parser (commit b889378)

**What:** `packages/alibaba-catalog-sync` created; `parseDecimalToMinorUnits`
(BigInt string math, strict grammar, unsafe-integer rejection) and
`validateAlibabaCatalogPricing` (R1 per-mode field matrix, optional currency
for negotiable/unavailable, strict unknown-key rejection, tier
ordering/overlap/open-ended/MOQ rules).
**Tests:** 37 (golden, float-trap lexemes, MAX_SAFE_INTEGER boundary, matrix,
tier edges). **Result:** green; typecheck/lint clean.
**Rationale:** strictness serves canonical candidate hashing (§12) — two
writers can never emit different shapes for the same commercial fact.

## MIU 2 — Signature, client, contracts, enumeration (commit e7f5bf9)

**What:** GOP signature canonicalization + pinned golden vector;
lossless-JSON parser (numbers preserved as lexemes; hand-rolled, offline
constraint documented); signed HTTP client (timeouts, caps, retry policy,
secret redaction, delimiter-safe fingerprints); guarded endpoint resolution
(HTTPS + *.alibaba.com overrides); table-driven tolerant list/detail
extraction; serializable bisection work-stack (adjacent-second partition,
BLOCKED_UNSTABLE_TIE, JSON round-trip for checkpoints).
**Tests:** 82 package total. **Result:** green.
**Notable fix during TDD:** adjacent-second window split previously
non-terminating (midpoint aligned back to fromMs); caught by the 1-second
block test.

## MIU 3 — Registry collections + additive fields + adminAccess (commit af4d7b0)

**What:** `adminAccess` on CollectionDef; ten collections registered; five
read-only product fields; registry-aware gates
`canRead/canEditRegisteredCollection` in collections.ts (auth.ts untouched —
reverse import is a TDZ cycle; trio precedence regression-tested); admin
handler switched at seven gate sites; `collections` dump filtered;
NON_QUERYABLE_FIELDS additions; ten ADMINONLY provisioning entries.
**Tests:** shared 84, admin 153, deploy-smoke 15, full repo green; full
typecheck green.
**Protected surfaces:** legacy pricing defs pinned byte-identical by snapshot
test; overstock asserted Alibaba-free.

## MIU 4 — Deterministic writes + fenced sync lease (commit 1fca497)

**What:** pure fenced-lease state machine shared by all adapters;
createDocWithId/upsertDocWithId; `updateDocWithAlibabaLease` (R1 E2 —
lease recheck inside the transaction/critical section); CloudBase impl on
in-transaction `doc.set` full-replace upsert (contract pinned from installed
@cloudbase/database 1.4.3 source, static + runtime probes added to
verify-cloudbase-sdk-contract.mjs); local JSON impl under withMutationLock;
throwing facades with input validation.
**Tests:** 38 db tests incl. exactly-one-winner races and fence-takeover
stale-write rejection; SDK contract script green; full repo suite + 10
package typechecks green.
**Deviation noted:** existing adapters' `create()` caller-supplied-`_id`
quirk left untouched (behavior-change risk); all new code uses the explicit
`createDocWithId` path instead.

## MIU 5 — OAuth + encrypted connection + new function (commit b8ca432)

**What:** apps/functions/alibaba-catalog-sync created (package/tsup/tsconfig
mirroring admin). R1 §8.1 flow: Bearer/JSON oauthStart returning
{authorizeUrl}; unauthenticated state-bound GET callback with 302 back to
the site admin page; sha256-hashed single-use states (incrementField CAS);
AES-256-GCM envelope (64-hex key, lazy validation, not_configured
fail-closed); live-admin-role gating; reserve-first callback rate limiting;
lazy refresh + authorization_expired alerting; WeCom alert sender with
visible console fallback; guarded endpoint overrides.
**Tests:** 12 (flow end-to-end incl. replay, redaction, rate limit, refresh
rotation); typecheck/lint green; tsup bundle builds.
**.env.example** corrected: key is 64 hex chars (openssl rand -hex 32), not
base64; endpoint-override placeholders added.

## MIU 6 — Raw payload evidence + normalization (commit 2765799)

**What:** hash-addressed `alibaba-raw` media-storage namespace; payload
metadata row id = response sha256 (single-winner dedupe); raw-before-parse
with abort-on-raw-failure; normalizeProductDetail (deterministic keys,
SKU/ladder/fob pricing derivation, validate-or-degrade, CST→UTC, RMB→CNY,
unsupported-currency flag); ingest with idempotent mirror upserts +
product-scoped offer sweep. **Deviation (accepted per R1 E7):** mirror rows
are last-write-wins; promotion is the fenced surface.
**Tests:** 93 domain + 18 function green.

## MIU 7 — Linking + unpublished drafts (commit 74cecec)

**What:** link rows keyed by sourceKey with single-winner create-if-absent
(race-tested one-source-one-product); admin link/unlink actions
(live-admin-gated) touching only Alibaba-owned fields; unlink restores the
legacy path byte-identically; category-mapped draft creation with
claim-first crash repair; runtime published:false verification; no fuzzy
matching, no auto images. **Tests:** 27 function green.

## MIU 8 — Offer selection + fenced promotion (commit c618711)

**What:** R1 M2 total-order selectPrimaryOffer; buildPromotionCandidate
(Alibaba-fields-only patch; canonical unavailable on source deletion);
>30% price-move audit; canonical candidate hash; promoteLinkedProduct with
link-identity recheck + updateDocWithAlibabaLease fenced write.
**Tests:** stale-fence rejection, byte-identical protected fields,
determinism under permutation; 103 domain + 33 function green.

**Task 3 (MIU 0-8) complete.** Remaining: MIU 9 (API), 10 (renderer),
11 (runner), 12 (media import), 13 (admin UI), 14 (manifest/deploy),
15 (activation — network-gated parts deferred).

## MIU 9 — Public API projection (commit ccdb218)

Allowlist gains the four public fields (never the offer key); nested pricing
sub-projected (provenance stripped, R1 H1); site DTO + linked/unlinked
factories. Contract tests: unlinked payloads alibaba-free, anon==auth
deep-equality, VIP unchanged, overstock pinned. 46 public-api + 105 site
tests green.

## MIU 10 — Renderer + full-site routing (commit cb15587)

AlibabaCatalogPricingBlock (5 modes, minor-unit CNY/USD formatter,
quote-required for missing pricing); link-identity routing at ALL legacy
price render sites (card badge/moq, spec-sheet unitPrice/moq, PriceBlock
swap); PriceBlock ownership comment. Stage E matrix proven in render tests
(117 site tests). i18n note: block ships EN defaults + label overrides —
typed content group is a follow-up.

## MIU 11 — Resumable runner (commit 84dc061)

Missed-tick-proof due math; lease-first bounded slices; enumerate→promote→
tombstone stages; quarantine gate BEFORE promotion with frozen-candidate
hash + approval supersession check; per-candidate tombstone confirmation;
runNow (interactive slice) + approveQuarantine actions; timer routing.
TDD caught the mid-bucket budget-death item-loss bug. 113 domain + 39
function tests green.

## MIU 12 — SSRF-safe media import (commit 4520816)

Full SSRF pipeline (allowlist, DNS matrix, hop-validated redirects,
streaming cap, magic-byte MIME, sha256 dedupe); candidates land active+
refcount-0+sentinel-owned; dedicated removal action. **Deviation:** the
images.checksumSha256 provisioning index deferred to MIU 15 (live images
collection permission risk vs unindexed lookup).

## MIU 13 — Admin operations UI (commit 6cd6f29)

Custom admin-only dashboard section (connection panel with callback banner,
quarantine review/approve, explicit link/unlink, run table via generic
list); alibaba-api client mirroring the admin envelope; category mappings as
plain CRUD section; local-server route mirror for dev parity. 122 site
tests green.

## MIU 14 — Function manifest (commit 5fdcfb6)

cloudbase-function-manifest.mjs owns names/routes/timeouts/env/timer
desired-state; five consumers switched in lockstep; per-function timeout
threaded through BOTH deploy paths (alibaba 900s/512MB); test-env
trigger-absence hard-fail in deploy AND smoke; env byte-parity pinned by
function-manifest.test.mjs; workflow secret pass-through + scan names.
All three functions build/package/pass stub-env cold-start smoke; 21
deploy-smoke tests green.

**Tasks 3+4 (MIU 0-14) complete.**

## Review round 2 — pre-push adversarial branch review (2026-08-06)

26-agent adversarial workflow over the finished branch: 21 raw findings,
12 CONFIRMED (3 HIGH), 9 refuted. All 12 fixed in one hardening commit:

1. **HIGH media-import removal lifecycle**: `removeImportedCandidate` now
   mirrors abandonUpload — image mutation lock, re-read under lock,
   status must be `active`, full cursor-paginated `imageIds` reference
   scan across registered collections (an UNPUBLISHED draft blocks
   removal even at refcount 0), and a storage-delete failure is TERMINAL
   (doc survives; retry-able) instead of silently orphaning the object.
2. **HIGH runner slot wedge**: the run-overdue / missing-run failure path
   now vacates `activeRunId` (previously every later tick re-resumed the
   dead run forever); plus self-heal — a terminal run stuck in the slot
   (lease lost during completion) is cleared, not resumed.
3. **HIGH quarantine approvability**: `recomputeCandidates` is mode-aware
   (incremental runs freeze an EMPTY tombstone set) and both sides hash
   stable `_id` lists instead of full mutable docs — quarantined
   incremental runs were permanently unapprovable.
4. Tombstone flips ride `updateDocWithAlibabaLease` (fence re-verified in
   the write tx), not unfenced `updateDoc` after a keepLease check.
5. `completeRun`/`clearActiveRun` order the fenced checkpoint write FIRST
   and surface `lease-lost` instead of discarding the boolean.
6. Token refresh is single-flight: the runner resolves the access token
   AFTER lease acquisition via a `getAccessToken` thunk (two concurrent
   ticks could race the rotating refresh token).
7. A refresh TRANSPORT outage returns retryable `refresh-unavailable` —
   never flips the terminal `authorization_expired` state (that is
   reserved for an actual refresh rejection).
8. A count response missing `total_item` quarantines as
   `response-contract-failed` instead of silently degrading the count.
9. Public API ships constant `'linked'` for `alibabaPrimarySourceKey` —
   the real value is an unsalted sha256 over a small input space
   (brute-forceable back to the supplier listing).
10. Linked cards with a null price summary render the explicit
    quote-required label (`data-alibaba-card-unavailable`) instead of an
    empty slot.
11. Admin callback notice maps a CLOSED status set — attacker-crafted
    `?alibaba=` values collapse to a generic line, never echoed.

Post-fix gates: 640 recursive tests + 16 script tests green, all
typechecks + astro clean, biome clean, SDK contract verify pass, 3
artifact cold-start smokes pass, site builds (18 pages).
