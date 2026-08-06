# MIU Breakdown — Channel Alibaba Open Platform Linked Catalog Sync

Each MIU is implemented, tested, reviewed, committed, and test-deployed independently where runtime-affecting.

R1 amendments are marked inline; see `REVISION_R1.md` for rationale and
evidence.

## MIU 0 — Baseline and live contract evidence

**Goal:** freeze the real starting point without changing runtime behavior.

- rebase branch on latest `origin/main`;
- copy docs to `docs/alibaba-linked-catalog-sync/`;
- record exact commit and current test counts;
- verify Alibaba app permissions, OAuth callback registration, gateway paths, signature vector, product list/detail response fixtures, pagination/window fields, money lexemes, and source IDs;
- verify current CloudBase transaction and timer-trigger deployment contracts;
- verify all protected legacy pricing surfaces remain present.
- R1: record the platform variant + OAuth endpoint evidence (ARCHITECTURE
  §8.2) — external gates that cannot be exercised offline are recorded as
  explicitly-deferred items with their MIU 15 verification step; probe and
  record the timer-trigger deploy mechanism (nothing in the repo manages
  triggers today); diff `5c14193..HEAD` and re-validate the storage upload
  contract facts at the real baseline.

**Done:** evidence file committed; no unresolved response-shape ambiguity; no runtime code edits.

## MIU 1 — Alibaba pricing types and money parser

**Files:** `packages/alibaba-catalog-sync/src/alibaba-money.ts`, `alibaba-pricing.ts`, tests.

- implement minor-unit parser;
- implement fixed/range/tiered/negotiable/unavailable validation;
- reject floating-point inputs and malformed tiers;
- define `AlibabaCatalogPricing` and `AlibabaPriceTier`.

**Done:** golden/edge/mutation tests green.

## MIU 2 — Alibaba signature, client, and enumeration

- signed request canonicalization and golden vector;
- timeout/retry/redaction policy;
- product list/detail contracts;
- 5,000-item range bisection and deterministic dedupe;
- redacted fixtures from granted API.

**Done:** no undocumented endpoint or scraping path; tests green.

## MIU 3 — Alibaba-prefixed registry collections and additive product fields

- add `adminAccess` registry policy;
- register all Alibaba-prefixed collections;
- add read-only Alibaba product fields;
- preserve every legacy pricing definition unchanged;
- add resource/index provisioning and contract tests.
- R1: enforcement lives in `canReadCollection`/`canEditCollection`
  (`packages/shared/src/auth.ts`) consulting `getCollection(name)?.adminAccess`;
  the hardcoded admin-only trio (`users`/`rateLimitHits`/`passwordResets`)
  is preserved with a regression test; the admin `collections` action
  filters out `adminAccess:'none'` defs (with test); non-crud collections set
  `hideFromNav`; hash/fingerprint fields (e.g. payload SHA-256, request
  fingerprints, encrypted envelope fields) join `NON_QUERYABLE_FIELDS`.

**Done:** generic admin access matrix green; legacy field snapshot test proves no deletion/rename/change.

## MIU 4 — DB deterministic writes and Alibaba sync lease

- `createDocWithId` and `upsertDocWithId`;
- provider-specific acquire/renew/release/assert lease methods;
- R1: the fenced conditional-write primitive `updateDocWithAlibabaLease`
  (ARCHITECTURE §9) — lease recheck inside the same transaction/critical
  section as the guarded write;
- CloudBase transactional implementation;
- local JSON parity (R1: each new method is ONE `withMutationLock` critical
  section; caller-supplied `_id` handling in both adapters' `create()` is
  made explicit rather than accidental);
- fencing and stale-holder tests;
- leave image mutation ownership unchanged.
- R1: all three DbAdapter implementations covered (cloudbase, local JSON,
  and the MemoryAdapter-style test fakes — new methods optional-with-throwing-
  facades per the `acquireImageMutation?` precedent, or fakes extended);
  `scripts/verify-cloudbase-sdk-contract.mjs` gains runtime probes for
  transaction-scoped set/create and the duplicate-`_id` error contract, and
  the `NodeSdkTransaction` structural type is extended accordingly (AGENTS.md
  SDK gate).

**Done:** concurrency tests prove one holder and stale promotion rejection.

## MIU 5 — OAuth and encrypted Alibaba connection

- admin-authenticated OAuth start;
- ten-minute single-use hashed state;
- replay-safe callback;
- AES-256-GCM token envelope;
- refresh/disconnect/authorization-expired state;
- secret redaction tests.
- R1 (ARCHITECTURE §8.1): start is a Bearer/JSON action returning
  `{authorizeUrl}` (no 302 start; localStorage sessions carry no ambient
  credential); connection lifecycle actions require live-revalidated
  role === `'admin'`; the new function's HTTP adapter replicates admin CORS/
  OPTIONS handling; state single-use via `createDocWithId` +
  `incrementField` CAS 0→1; callback 302s back to the site-origin admin page;
  callback + failed starts rate-limited (reserve-first ledger pattern);
  `ALI_TOKEN_ENCRYPTION_KEY_V1` = 64 hex chars, validated lazily,
  unconfigured → explicit `not_configured` state (never a cold-start crash);
  test env refreshes tokens lazily (no timer there).

**Done:** no plaintext token in DB/log/response/alert fixtures.

## MIU 6 — Exact raw payload storage and source normalization

- private object storage before parsing;
- hash-addressing/dedupe;
- redacted metadata in `alibabaSourcePayloads`;
- normalize into `alibabaSourceProducts` and `alibabaSupplierOffers`;
- deterministic document IDs;
- abort page on raw-write failure.
- R1: raw objects go through the shared media-storage facade via a new
  `alibaba-raw` namespace with a hash-addressed path rule (never bypass the
  path builders).

**Done:** rerun idempotency and raw-before-parse tests green.

## MIU 7 — Product linking and unpublished draft projection

- unique `alibabaProductLinks` claim;
- explicit existing-product link action;
- category mapping requirement;
- unpublished draft creation;
- no fuzzy match;
- no automatic public image selection;
- no legacy price field write.

**Done:** race and publication-invariant tests green.

## MIU 8 — Primary Alibaba offer selection and fenced product promotion

- deterministic primary offer selection;
- write only Alibaba-owned additive fields;
- preserve curated and legacy fields;
- source deletion/unavailable behavior;
- transaction rechecks lease/fence and link identity;
- candidate hash and quarantine.

**Done:** before/after document tests prove protected fields unchanged.

## MIU 9 — Additive public API projection

- expose safe Alibaba product fields;
- preserve existing field allowlist and VIP gating;
- anonymous/authenticated callers receive identical Alibaba pricing;
- no new source internals exposed;
- no JWT or legacy pricing changes.
- R1: public sub-projection strips `sourceOfferKey`/`sourceProductId`/
  `sourceSkuId` from `alibabaCatalogPricing` (ARCHITECTURE §6.1); the
  allowlist is shared with overstock — add a contract test pinning overstock
  payloads unchanged and asserting anonymous/authenticated deep-equality of
  `alibabaCatalogPricing`; extend the site `Product` DTO
  (`catalog-types.ts`) and the `createProduct` factory with all five fields
  (factory-completeness convention).

**Done:** legacy payload snapshot stays green; linked payload tests green.

## MIU 10 — Alibaba pricing renderer and compatibility routing

- add `AlibabaCatalogPricingBlock`;
- fixed/range/tiered/negotiable/unavailable rendering;
- correct CNY/USD labels;
- linked-product branch by `alibabaPrimarySourceKey`;
- no fallback to legacy values while linked;
- unlinked product legacy behavior unchanged;
- optional explanatory comment on `PriceBlock`; no deletion/refactor.
- R1: cover ALL legacy price render sites per the ARCHITECTURE §6.2 table —
  card unit-price badge, detail spec-sheet unit-price row, spec-sheet MOQ row
  (linked shows `sourceMoq`), and PriceBlock; dedicated minor-unit
  CNY/USD formatter (never the existing major-unit USD `formatPrice`).

**Done:** render/E2E matrix from compatibility plan green.

## MIU 11 — Resumable runner, checkpoints, and safety guards

- incremental/full/manual/continuation state machine;
- bounded 720-second invocation;
- page checkpoints and committed cursor;
- anomaly thresholds;
- quarantine approval;
- complete-full-run tombstoning only.
- R1: run statuses + quarantine lifecycle per ARCHITECTURE §12 (lease
  release, slot vacating, stopped clocks, approval validity); due-based
  scheduling per §10; acquire-lease → read-checkpoint → single-winner
  run-row ordering; manual "run now" only marks due and returns;
  `lastSeenRunId` seen-set; per-candidate tombstone confirmation and the
  zero-item quarantine trigger per §11/§12; guarded writes through
  `updateDocWithAlibabaLease`.

**Done:** duplicate/retry/continuation/partial-full tests green.

## MIU 12 — Media candidate import

- SSRF controls, redirects, DNS/IP validation, streaming cap, MIME+magic, checksum dedupe;
- existing media lifecycle and owner lock;
- candidate-only import;
- no automatic product image assignment.
- R1 (ARCHITECTURE §13): candidate = status `active` + `publishedRefCount 0`
  + unattached (`pending` would be orphan-swept in 24h); sentinel
  `uploadedByUserId: 'alibaba-catalog-sync'`; dedicated admin-only removal
  action for unreferenced imported candidates; `completeUpload`-equivalent
  verification; `images.checksumSha256` provisioned index for dedupe.

**Done:** adversarial URL/content tests and lifecycle parity green.

## MIU 13 — Admin operations UI

- Alibaba connection panel;
- manual run controls;
- run history/counters/errors;
- quarantine review;
- category mapping CRUD;
- product link action;
- secret-free UI payloads.
- R1: `setAlibabaPrimaryOffer` admin action (validates the offerKey against
  active `alibabaSupplierOffers`, writes the pin via the trusted update
  path) — the pin is otherwise unreachable since the field is read-only in
  generic CRUD; admin UI reaches the new function through a dedicated
  section (custom non-CollectionView page) with `alibabaCategoryMappings`
  additionally reachable as a plain collection section; mirror the new
  function's routes in `apps/local-server/src/main.ts` so the whole flow
  works against local dev.

**Done:** role/accessibility/browser tests green.

## MIU 14 — Function manifest, packaging, deploy, gateway, and timer

- one manifest includes `admin`, `public-api`, and `alibaba-catalog-sync`;
- package/smoke/deploy consume manifest;
- test env timer absent;
- production desired timer explicit;
- drift tests for function/env/route/trigger;
- preserve existing function deployment behavior.
- R1 (ARCHITECTURE §14): manifest owns per-function `timeout`/`memorySize`
  (`alibaba-catalog-sync` 900s/512MB) threaded through BOTH cloudbaserc
  generation and `updateFunctionConfig`; the enumerated manifest consumers
  (incl. `runtime-contract.test.mjs`) update in lockstep; admin/public-api
  env-map byte-equality snapshot test before the switch; deploy-test.yml
  secret pass-through + GH `test` environment provisioning + secret-name
  scan additions; trigger reconciliation tooling (test asserts/deletes,
  smoke asserts absence); production deploy path is explicitly new scope.

**Done:** all artifact/deploy contract tests green and manual test deployment succeeds.

## MIU 15 — Controlled activation and production readiness

- follow compatibility stages B–F;
- manual authorized incremental smoke;
- linked/unlinked product storefront checks;
- protected legacy field integrity report;
- rollback rehearsal;
- explicit approval before production timer;
- production incremental run and bounded full rehearsal (R1: production
  deployment is new scope — performed manually with recorded evidence unless
  a prod workflow is added first).
- R1: live verification of the Alibaba OAuth endpoints (§8.2) — authorize
  URL renders the Alibaba login/consent page with our app key, callback
  lands with a code, token exchange succeeds — recorded with redacted
  fixtures; endpoint defaults corrected in a follow-up doc revision if they
  differ.

**Done:** exact deployed commit, trigger state, run IDs, counts, residual limitations, and no-secret evidence recorded.
