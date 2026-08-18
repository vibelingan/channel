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

## Review round 3 — verification of the round-2 fixes (2026-08-06)

A 4-lens adversarial pass over commit 47d64ee alone (does the fix commit
break anything?) found **6 confirmed regressions, 3 HIGH — introduced by
the round-2 fixes themselves**. All fixed:

1. **HIGH phantom run (3 findings, one root cause).** Moving token
   resolution under the lease put it AFTER the run row + checkpoint slot
   were written, so a disconnected/expired connection created a run that
   held the slot for the full 24h run-age window, then died as a false
   `run-overdue` with an operator page — every cycle, forever. The token
   now resolves at the last point before real work in each branch: after
   the resume pre-checks (self-heal and overdue cleanup need no token, so
   a dead connection must not block them) and BEFORE the start branch
   writes anything. Reproduced and pinned by two tests, including a
   101-tick loop asserting zero run rows and zero alerts.
2. **HIGH refresh 4xx misclassified as transient.** `callApi` returns
   `{ok:false, kind:'http', status}` for every non-2xx, so treating all
   `!result.ok` as retryable orphaned the entire HTTP-rejection class: a
   revoked app or elapsed `refresh_expires_in` left the connection
   reporting `active` forever with no alert. Now mirrors the client's own
   retry rule — 4xx except 429 is terminal (`authorization_expired` +
   alert); network/timeout/429/5xx/oversized-body stay retryable.
3. **HIGH prototype-chain lookup in `callbackNotice`.** The closed-set
   object literal resolved `?alibaba=__proto__` through
   `Object.prototype`, putting a non-string into React's children and
   blanking the whole (unguarded) dashboard island; `?alibaba=toString`
   silently rendered nothing. Now a `Map`, pinned by a test over the five
   inherited keys.
4. **MEDIUM `runNow` reported `idle` for a dead credential.** The runner
   short-circuits before the token when nothing is due, so a broken
   connection returned a success-shaped tick — the primary diagnostic in
   the timer-less test env. `runNow` now runs a READ-ONLY `probeConnection`
   first (reads the doc, verifies the envelope decrypts, never refreshes,
   so it cannot race the rotating refresh token outside the lease).

Gates after round 3: 646 recursive + 21 script tests green, 11 typechecks
+ astro (0 errors), biome clean, SDK contract verify, 3 artifact
cold-start smokes, site build (18 pages).

**Lesson recorded:** a fix commit deserves the same adversarial review as
the original implementation — 3 of the 6 regressions were HIGH and every
one of them was introduced by a correct-in-isolation fix that moved an
operation across a state-mutation boundary.

## Review round 4 — verification of the round-3 fixes (2026-08-06)

A 3-lens pass over commit 69c4b20 confirmed the runner restructure and the
`Map` notice fix clean, but found **2 findings (one root cause)** in the
refresh classifier that round 3 introduced — with a diagnosis worth
recording verbatim:

> Copying a retry-policy predicate into a state-destruction predicate is a
> category error. In the client, "not retryable" means return a failure —
> harmless. In `getConnectionAccessToken` the same predicate means destroy
> connection state and require a human merchant re-authorization.

Round 3 had made every non-429 4xx on the refresh endpoint terminal. But
`apiBaseUrl` + `tokenRefreshPath` are ASSUMED-UNVERIFIED until the MIU 15
live smoke, so a moved path, an edge 403, or a 408 would irreversibly kill
a healthy authorization — and because reconnect uses a *different* path
(`tokenCreatePath`), it would succeed, run for one access-token lifetime,
and die again: a daily page loop from a config fault that fixes itself the
moment the endpoint is corrected. A verifying agent reproduced exactly
that: statuses 400/403/404/408/425/451 each destroyed the connection, and
three reconnect cycles each produced another page.

**Final policy — terminality now requires evidence, never inference:**
- Terminal (`authorization_expired` + re-connect page): no refresh token at
  all; the stored `refreshTokenExpiresAt` has ELAPSED (the gateway's own
  earlier statement, so no call is even attempted); or a 2xx whose body is
  not a grant (the gateway parsed the request and refused).
- Retryable (`refresh-unavailable`, status untouched): every transport-level
  failure, whatever the status code. The current access token is still used
  if valid; otherwise the outage is recorded and alerted EXACTLY ONCE per
  outage (`lastAuthErrorAt`, cleared by the next success), so a 15-minute
  timer cannot page 96 times a day and the failure is never silent — which
  was the legitimate concern behind the terminal flip.

Gates after round 4: 647 recursive + 21 script tests green, 11 typechecks +
astro (0 errors), biome clean, SDK contract verify, 3 artifact cold-start
smokes, site build (18 pages).

**Rounds 2→4 summary:** 12 findings fixed, those fixes introduced 6
regressions (3 HIGH), that fix introduced 1 more (2 reports). Each round
was strictly smaller; round 4's fix is confined to one function's failure
policy and is the first that removes a state-destroying write rather than
adding one.

## Review round 5 — verification of the round-4 policy (2026-08-06)

Round 4 swung too far the other way. 4 findings (2 HIGH):

1. **HIGH — a real revocation went silent.** RFC 6749 §5.2 encodes a revoked
   refresh token as HTTP 400 + `error=invalid_grant`, which round 4 had just
   blessed as non-terminal. A revoked merchant grant therefore produced ONE
   page that explicitly said "still authorized — no action needed", then
   permanent silence, with the panel rendering "Connected" and an access-token
   expiry already in the past. `lastAuthErrorAt` was the only moving field and
   it had **zero render sites** in the admin UI.
2. **HIGH — the "own record" evidence was stale by construction.** A refresh
   that rotates the token but omits `refresh_expires_in` left the PREVIOUS
   token's deadline attached to a brand-new credential; the round-4 terminal
   branch then destroyed a healthy connection without even placing a call.
   Every refresh fixture in our own suite omits that field.
3. MEDIUM — the outage alert asserted "the connection is still authorized",
   a claim the code had no evidence for (the mirror of round 3's error).
4. MEDIUM — `lastAuthErrorAt` was overwritten every tick, destroying the
   outage START, so no duration-based escalation was even constructible.

**Final policy — the gateway is the authority, the record only corroborates:**
- `alibaba-client` now PRESERVES the response body on an `http` failure
  (previously discarded), because the error code is the only direct evidence
  distinguishing "your credential is dead" from "wrong path / edge rule".
- Terminal: an allowlisted rejection code in the body (`invalid_grant`,
  `invalid_token`, …) at ANY status; a failed call that corroborates an
  elapsed stored expiry; no refresh token; or a 2xx that is not a grant. The
  call is now ALWAYS attempted — a working gateway always wins over our record.
- A rotation that omits the new expiry CLEARS the stored one, so a deadline
  never outlives the token it described.
- Otherwise: retryable, status untouched, with `firstAuthErrorAt` written once
  per outage (duration stays computable) and pages every 6h through the first
  day then daily — bounded both ways: never 96 pages, never silent.
- The admin panel now renders "Token refresh failing since X — sync is paused"
  for an `active` connection, so a degraded state is visible at all.

Gates: 649 recursive + 21 script tests green, 11 typechecks + astro (0
errors), biome clean, SDK contract verify, 3 artifact smokes, site build.

**Loop shape so far:** 12 findings → 6 regressions → 2 → 4. Round 5 is the
first to change a package outside the function (the client's failure shape),
because the real defect was upstream: the evidence needed to make this
decision correctly was being thrown away before the decision was reached.

## Review round 6 — verification of the round-5 policy (2026-08-06)

5 reports, **2 distinct defects** — and, unlike rounds 3→5, both are
localized implementation errors *inside* the agreed design rather than
another reversal of it. The design (evidence-based terminality + escalating,
visible outages) was not challenged.

1. **HIGH — two entries on the rejection allowlist name the APP, not the
   credential.** RFC 6749 §5.2 defines `unauthorized_client` as the
   authenticated *client* being unauthorized for the grant type, and
   `access_denied` is an authorization-endpoint code that a signed gateway
   overloads for "this app lacks permission for this API path". Both describe
   provisioning faults a merchant re-authorization cannot repair — so
   treating them as terminal recreated round 3's destroy → re-authorize →
   destroy loop, this time through two strings in a list. A verifier
   reproduced it, including the control case proving the status code alone
   was not doing the work. Removed; they now fall through to the outage path,
   which still escalates within 6h if the gateway keeps refusing. Removing
   them costs nothing: a real revocation is `invalid_grant` per spec.
2. **HIGH (reported by 3 lenses) — `firstAuthErrorAt` outlived its outage.**
   It was cleared on a successful refresh but not by `handleOAuthCallback`
   (whose `upsertDocWithId` MERGES) or `markAuthorizationExpired`. So the one
   indicator added in round 5 to make a degraded connection visible
   false-alarmed on a freshly reconnected healthy one — "Token refresh
   failing since X — sync is paused" under "Connected", clearable only by the
   next successful lazy refresh up to an access-token lifetime away. Worse,
   the next genuine outage inherited the stale start time, which skipped the
   6h escalation band straight to 24h and misreported the duration. Both
   paths now clear the whole window.

Gates: 651 recursive + 21 script tests green, 11 typechecks + astro (0
errors), biome clean, SDK contract verify, 3 artifact smokes, site build.

**Loop assessment.** Finding counts: 12 → 6 → 2 → 4 → 5. The count did not
fall monotonically, but the *kind* changed decisively at round 6: rounds 3-5
were successive over-corrections of the same design decision (when is a
credential dead?), while round 6 found only data/omission bugs in an
otherwise settled design, each with a surgical, provably-narrowing fix. That
is the signal to stop iterating on this surface.

## Blessing gate (`/dev-pipeline:review`) — BLOCKED, then fixed (2026-08-06)

The repo's pre-push hook refuses any SHA the pipeline's own review has not
blessed. That gate ran 7 reviewer lenses over the whole 107-file diff and
**blocked with 9 P1 + 11 P2 confirmed findings** — after seven self-directed
adversarial rounds had come back clean. The lenses were different, and that is
the entire lesson: my rounds were diff-scoped, so they could not see invariants
carried by code the diff never touched.

### P1 fixes

1. **CloudBase nested-object writes were a MERGE, not a replace (4 findings,
   one root cause).** `update` flattens `{pricing:{mode,amountMinor}}` into
   dot-paths, so (a) writing over a field currently holding `null` never lands
   and (b) a patch that omits a sub-key leaves the PREVIOUS value's keys
   behind — a `tiered → fixed` transition yielded a document carrying both
   modes. The local JSON adapter shallow-spreads, so **every test passed while
   production would have diverged**. All three adapter write paths now wrap
   plain objects in `command.set()`. Probed against the real driver: the raw
   path emits `$set:{"pricing.mode":…}`, the wrapped path `$set:{"pricing":{…}}`.
2. **`pageSize: 500` silently clamped to 100** at four call sites. `list()`
   returns no truncation signal and echoes the clamped size back, so promotion
   candidates, tombstone candidates and the quarantine recomputation all
   silently truncated — and because the runner and the approval path must
   produce byte-identical sets, a >100-row mirror could never be approved. All
   four now share one `listAllDocs` cursor walk that throws rather than
   truncates.
3. **An incremental run clobbered the weekly full-run deadline.** Both
   `completeRun` and `clearActiveRun` recomputed BOTH watermarks from `now`, so
   an incremental run spanning the Sunday full-run time pushed it out another
   week — indefinitely. Watermark advance is now scoped to the mode that ran.
4. **Tombstone flip and product demotion were two writes with no repair
   path.** A lease loss between them left the source tombstoned while the
   storefront kept selling the removed offer forever. The flip now opens a
   `demotedAt: ''` repair window that closes only after the demotion lands, and
   `repairTombstones()` re-drives any pair left open by an earlier run.
5. **The sync self-pinned.** `alibabaPrimaryOfferKey` was both the selection
   OUTPUT and the pin INPUT, so run 1's auto-choice froze forever and §5's
   total order never re-evaluated: a supplier re-pricing could never move the
   storefront to the cheaper offer. Added the contract-mandated
   `setAlibabaPrimaryOffer` action (MIU_BREAKDOWN R1 L4, previously
   unimplemented) writing a DISTINCT `alibabaPinnedOfferKey`, validated to be
   an ACTIVE offer on the product's own source; empty clears it.

Gates: 654 recursive + 21 script tests, 11 typechecks + astro (0 errors),
biome clean, SDK contract verify (48 assertions), 3 artifact smokes, site build.

### P2 fixes (the gate blocks at 4+, and two were already closed by the P1 work)

6. **`runNow` deviated from the frozen §10 clause** — three reviewers read the
   doc and correctly called the code wrong. Resolved as a RECORDED AMENDMENT
   (§10.1) rather than a silent deviation: mark-due-and-return cannot work in
   the test env, which hard-fails on any timer trigger by design, so `runNow`
   would have nothing to drive it and the feature would be unverifiable before
   production. The amendment also makes its own claim true — the interactive
   path now passes `maxAttempts: 1` and a 5s per-call timeout, so retry
   backoff cannot stretch a manual slice past the gateway envelope.
7. **`createDraftForSource` had no production caller.** It was fully
   implemented and tested, but nothing invoked it — so an unlinked source
   never became a draft and the whole category-mapping feature never ran.
   Wired into the promote stage, with an alert naming how many sources were
   skipped for want of a mapping (operators cannot act on what they cannot
   see).
8. **The OAuth rate-limit ledger never GC'd.** It was a faithful copy of the
   admin limiter minus its bounded sweep, so every callback hit was a
   permanent row — and since the ceiling check is a filtered `total` over that
   same collection, unbounded growth degrades the check guarding an
   unauthenticated endpoint. Sweep restored.
9. **The enumerate stage could outlive its own lease.** Up to 30 detail calls
   run between bucket-level renewals; at the client's worst-case ~46.5s per
   call, four slow items exceed the 180s TTL, after which every fenced write
   fails and the run makes no progress. `keepLease()` now runs inside the
   detail loop (it self-throttles, so the extra transactions are cheap).
10. **Three test gaps, each proven by mutation** — the reviewer broke the
    source and the suite stayed green:
    - the fenced conditional write's PRODUCTION implementations had zero
      coverage (every lease assertion ran against a test-only adapter that
      re-implements the guard); the SDK contract script now asserts by AST
      that all six lease/write methods do their read-and-write inside
      `runTransaction`, and that the fenced write re-verifies `holdsAlibabaLease`;
    - the candidate-hash supersession check's RECOMPUTE arm was unbound —
      only the operator-submitted-hash arm was tested;
    - the still-valid-token degradation arm was unbound: deleting the branch
      that keeps serving a valid token through a refresh outage changed
      nothing.

Gates after the P2 fixes: 655 recursive + 21 script tests, 11 typechecks +
astro (0 errors), biome clean, SDK contract verify (57 assertions), 3 artifact
smokes, site build.

## Blessing gate, round 2 — my own fixes regressed (2026-08-06)

Re-running the gate on the fixed HEAD found **4 P1 + 9 P2**, almost all
introduced by the round-1 fixes. This also ran the external-classes lens for
the first time (its agent died mid-response last round — a crashed reviewer is
not a pass).

1. **HIGH — removing the pageSize clamp unbounded the promote stage.** The old
   silent 100-row cap was *masking* a stage with no lease renewal and no budget
   check: with the real set, a catalog at the documented 5,000-item scale needs
   thousands of sequential round-trips before the first fenced write, so the
   180s lease expires and every write fails. A verifier reproduced it — 9,064
   round trips, 181s, `lease-lost`, zero promotions, no checkpoint, no release,
   repeating every tick until the 24h overdue timer, then again each cycle.
   `keepLease()` + `budgetExhausted()` now run inside the walk (mirroring the
   fix this same commit applied to the enumerate stage, which the promote stage
   was left out of).
2. **HIGH — draft creation landed on the WRONG SIDE of the quarantine gate.**
   `createDraftForSource` writes `products` rows, and I had put it before
   `evaluateQuarantine` — contradicting the stage's own banner, the module
   docstring and ARCHITECTURE §12. A run whose mirror was demonstrably
   untrustworthy would have left drafts behind that no approval path rolls
   back. Moved after the gate; the new links become ordinary candidates next
   run, so the frozen candidate hash still matches what approval recomputes.
3. **HIGH — the surge guard would trip on every full run.** `candidateChanges`
   counted every linked source SEEN, which the 100-row clamp had been hiding.
   §12 means candidates that CHANGED, so ingest now stores a content
   fingerprint and stamps `lastChangedRunId` only when the mirrored content
   actually differs.
4. **`runNow` could not START a run** — `decideTick` answers `idle` unless
   something is due, so §10.1's justification ("repeated runNow calls drive a
   run to completion in the test env") was false. A manual trigger now marks
   itself due, which is what the ORIGINAL §10 clause asked for; the amendment
   text was corrected to match.
5. Smaller: `callTuning` reached only 1 of 3 API call sites, so §10.1's bound
   claim was also false (now all three); the terminal-run self-heal passed
   `mode: null` on a premise that is false precisely in the case that reaches
   it; `unlinkProduct` did not clear the new `alibabaPinnedOfferKey`, so a
   relink could silently rebind a stale offer; and MIU_BREAKDOWN + REVISION_R1
   still asserted the superseded mark-due-and-return behavior with no pointer
   to §10.1.

Gates: 657 recursive + 21 script tests, 11 typechecks + astro (0 errors),
biome clean, SDK contract verify, 3 artifact smokes, site build.

## Blessing gate, round 3 — my round-2 fixes were defective again (2026-08-06)

3 P1 (2 unique) + 7 P2, essentially all in code written during the round-2
fixes. Recorded plainly because the PATTERN now matters more than the bugs.

1. **The content fingerprint was a no-op.** It excluded run/time stamps but
   NOT `fetchedAt` and `syncedAt`, which the normalizer writes with the
   caller's clock on every ingest — so the hash never repeated, `changed` was
   always true, and `changedCandidates` was bit-for-bit the value it replaced.
   The §12 surge guard still tripped on every full run. A fix that did not fix,
   and the log claimed otherwise. Every existing ingest test passes ONE frozen
   `NOW`, which is exactly why it shipped; the new tests vary the clock.
2. **The promote stage's mid-walk budget exit had no cursor.** `saveCheckpoint`
   persists stage + enumerationState and nothing about walk position, so a
   continuation replayed the same prefix and the stage could never finish —
   burning continuations until the 24h overdue timer, forever. REVERTED rather
   than patched: `keepLease()` (which fixed the real lease-expiry P1) stays;
   the budget exit goes. Same for the deferred draft loop, whose `break` then
   fell through to `completeRun` and advanced `committedCursor` past sources
   that never got a draft.
3. **`callTuning` on the tombstone confirmation was actively harmful.** One
   transient 5s timeout on a manual slice quarantined an entire full run — into
   a branch that writes no `candidateHash`, making that quarantine
   *unapprovable*. That call keeps the client's default retry budget; §10.1 is
   about slice wall-clock, and the tombstone loop already exits on budget.
4. **`manualStart` could destroy a pending quarantine.** "Run now" over a
   quarantined run re-ingests its frozen sources, rewrites `lastSeenRunId`, and
   makes the approval recomputation mismatch forever. Manual starts now refuse
   while a quarantine awaits approval — via a single-row existence probe on the
   MANUAL path only (querying `alibabaSyncRuns` on every 15-minute tick would
   be an unbounded cost on the idle path; the idle-tick test caught that).

Gates: 661 recursive + 21 script tests, 11 typechecks + astro (0 errors),
biome clean, SDK contract verify, 3 artifact smokes, site build.

### Process finding — the real root cause of this whole loop

`~/.claude/skills/engineering-craft/checklists/impl-time-gates.md` was
consulted only as a REVIEW filter (blessing-gate STEP 1.5), never while
implementing. Its section 1 is "Sibling twins — did you join a family?" and its
closing section is titled *"Why this is a one-pass gate, not a review loop"*:

> the same classes recur *within* a single PR across review rounds — a reviewer
> finds one instance, the fix lands, the next round finds the twin. That is the
> signature of a class-level defect being handled instance-by-instance.

That is a precise description of rounds 2-9 here. The worst single defect (the
promote stage missing the lease renewal its sibling enumerate stage carried, in
the same file, added in the same commit) is section 1 verbatim. The knowledge
was on disk, indexed, and derived from 1,011 external findings. It was not
consulted at the point it was written for.

## Blessing gate, round 4 (2026-08-07)

The run reported 0 P1 / 0 P2, but one verifier died on a network error and the
lens it was checking had raised a P1 and a contract contradiction. A crashed
agent is not a pass, so those were assessed directly.

1. **My round-3 manual-start guard contradicted the frozen contract and was
   reverted.** ARCHITECTURE §12 says plainly: *"new incremental runs may start
   while the quarantine is pending (the quarantined candidate stays frozen)...
   approving a superseded candidate is rejected."* Supersession is the DESIGNED
   outcome. A round-3 reviewer described it as a bug ("Run now destroys a
   pending quarantine") and I implemented the fix without checking §12. The
   guard also blocked on ANY quarantined row with no reject/dismiss path, so a
   single unapprovable quarantine would have permanently blocked "Run now" —
   the only way to drive a run in the test environment, which has no timer.
   **Lesson: check a review finding against the frozen contract before acting
   on it. A reviewer can describe intended behavior as a defect.**
2. **`payloadId` excluded from the content fingerprint.** It is the sha256 of
   the ENTIRE raw response body, i.e. provenance, not content. Any per-response
   request id or server timestamp the real gateway includes would change it on
   every call and make the fingerprint a no-op again — the exact defect round 3
   caught, surviving in a second form. New test proves two responses with
   different request ids but identical product content do not advance the
   change stamp.
3. **ARCHITECTURE §10.1 corrected.** It claimed the interactive per-call bound
   applies at every call site; the tombstone confirmation deliberately keeps
   the client's default retry budget, because it is the one call whose failure
   is terminal for the whole run. The text now says so and gives the reason.

Gates: 9/9 suites, 0 type errors, biome clean, 21 script tests, SDK contract
verify, 3 artifact smokes, site build.

### Known, unfixed — carried forward deliberately

- **The tombstone-confirmation quarantine branch writes no `candidateHash`**,
  so `approveQuarantinedRun` always answers `superseded` and that particular
  quarantine cannot be approved. Pre-existing since MIU 11, out of scope for
  the fix rounds, and no longer able to deadlock anything now that the manual
  guard is gone. Needs its own change.
- **The promote stage has no durable progress cursor.** It walks to completion
  under lease renewal, which is correct at test-environment scale but is a real
  limit at the 5,000-product catalog size §11 targets.
- **No production deploy exists.** `PRODUCTION_DESIRED_TIMER_TRIGGERS` is
  referenced only by a test; nothing applies the 15-minute timer.

## Root cause found — retired hostname (2026-08-16)

Alibaba support identified it: `oauth.alibaba.com` is the OLD domain. The
correct host is `open-api.alibaba.com`. Confirmed live the same day with a
credential-free control probe:

```text
open-api.alibaba.com + 511630    -> IncompleteSignature  (key RESOLVED)
open-api.alibaba.com + 999999999 -> InvalidAppKey        (control)
old oauth.alibaba.com/authorize  -> 302 to login, then fails after login
new open-api.../oauth/authorize  -> 200, renders the consent page
```

The app key was correctly provisioned all along. No Alibaba backend repair was
ever needed.

**My TOP conversion was reverted.** I inferred from the dotted method names
that ICBU ran on the Taobao Open Platform. Wrong: the Alibaba.com Open Platform
serves those same methods over its own REST gateway. The protocol never needed
changing — only the hostname. That is two incorrect protocol conclusions in
this feature (`sp=ICBU`, then TOP), both reached by reading documentation
instead of probing. The probe that settled it takes two curl commands and no
credentials.

**Why ten days passed.** The retired host answers and redirects to a login
page, so every unauthenticated check looked healthy; the failure only appeared
after a real merchant authenticated. Compounding it, an early probe used
`openapi-api.alibaba.com` — a different host from `open-api.alibaba.com` —
returned `InvalidAppKey`, and that false negative pointed the investigation at
Alibaba's backend.

The endpoint test now pins the exact host and fails on either retired name, so
this cannot silently regress.

Gates: 9/9 suites, 0 type errors, biome clean, 21 script tests, SDK contract
verify, 3 artifact smokes, site build.
