# Architecture — Channel Alibaba Open Platform Linked Catalog Sync

## 1. System context

```text
Alibaba Open Platform
        │ OAuth + signed product APIs
        ▼
CloudBase `alibaba-catalog-sync` function
        ├── exact raw response object storage
        ├── Alibaba-prefixed source mirror and supplier offers
        ├── lease/checkpoint/run audit
        ├── candidate media import through existing media lifecycle
        └── fenced update of Alibaba-owned product fields
                 │
                 ▼
Existing `products` collection
        ├── existing legacy pricing fields remain
        └── additive `alibabaCatalogPricing`
                 │
                 ▼
Existing public API and Astro/React storefront
        ├── linked product → AlibabaCatalogPricingBlock
        └── unlinked product → existing PriceBlock/legacy behavior
```

## 2. Module layout

```text
packages/alibaba-catalog-sync/
├── src/alibaba-signature.ts
├── src/alibaba-client.ts
├── src/alibaba-contracts.ts
├── src/alibaba-enumeration.ts
├── src/alibaba-money.ts
├── src/alibaba-pricing.ts
├── src/alibaba-normalizer.ts
├── src/alibaba-merge-policy.ts
├── src/alibaba-run-state.ts
└── src/*.test.ts

apps/functions/alibaba-catalog-sync/
├── src/index.ts
├── src/http-adapter.ts
├── src/handler.ts
├── src/oauth.ts
├── src/runner.ts
├── src/scheduler.ts
├── src/media-import.ts
└── src/*.test.ts

apps/site/src/islands/admin/alibaba-catalog-sync/
├── AlibabaCatalogSyncPage.tsx
├── AlibabaConnectionPanel.tsx
├── AlibabaSyncRunTable.tsx
├── AlibabaQuarantineReview.tsx
└── AlibabaProductLinkAction.tsx

apps/site/src/islands/shop/
├── AlibabaCatalogPricingBlock.tsx
└── alibaba-catalog-pricing.test.ts

scripts/cloudbase-function-manifest.mjs
```

R1 — shared surfaces this feature additionally extends (repo-reality
completions of the layout above; each stays on its existing shared facade):

- `packages/shared/src/collections.ts` — `adminAccess` on `CollectionDef`, ten
  new collection defs, additive read-only product fields.
- `packages/shared/src/auth.ts` — `canReadCollection`/`canEditCollection`
  consult `adminAccess` (hardcoded admin-only trio preserved).
- `packages/db/src/adapter.ts` + `cloudbase-adapter.ts` +
  `apps/local-server/src/json-adapter.ts` — deterministic-ID writes, Alibaba
  sync lease, fenced conditional write (§9).
- `packages/media-storage` — `alibaba-raw` namespace and a hash-addressed
  object path rule beside the existing date-partitioned rule.
- `apps/local-server/src/main.ts` — mounts the new function's handler under
  `/api/alibaba-catalog-sync` for local dev parity (repo convention).
- `apps/site/src/islands/shop/catalog-types.ts` + `apps/site/src/test/factories/catalog.ts`
  — Product DTO and factory gain the five additive fields.
- `scripts/cloudbase-nosql-resources.mjs` — provisioning entries for the ten
  collections (+ an `images.checksumSha256` index for media dedupe).
- `scripts/verify-cloudbase-sdk-contract.mjs` — probes for the new
  transactional SDK surfaces (§9, MIU 4).
- `scripts/package-functions.mjs`, `scripts/smoke-function-artifacts.mjs`,
  `scripts/deploy-cloudbase-test.mjs`, `scripts/smoke-cloudbase-deploy.mjs`,
  `scripts/runtime-contract.test.mjs`, `.github/workflows/ci.yml`,
  `.github/workflows/deploy-test.yml` — manifest consumers (§14).

No generic integration framework is introduced. Shared repository primitives are extended only where required.

## 3. Data model

### 3.1 `alibabaConnections`

Stores connection identity and encrypted token envelope. Generic admin routes cannot read it.

### 3.2 `alibabaOAuthStates`

Document ID is `sha256(state)`. Stores requesting user, connection intent, expiry, and consumed time. Consume transactionally.

### 3.3 `alibabaSyncLeases`

```ts
interface AlibabaSyncLease {
  _id: string; // connectionId
  holder: string;
  fence: number;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
  releasedAt?: string;
}
```

### 3.4 `alibabaSyncCheckpoints`

Stores active run, mode, stage, page/range cursor, committed incremental cursor, due times, continuation count, and update time.

### 3.5 `alibabaSourcePayloads`

Stores metadata for exact raw response bytes held in private object storage: response SHA-256, byte length, endpoint ID, redacted request fingerprint, status, content type, object key, connection, run, and fetched time.

OAuth token responses are never raw-mirrored.

### 3.6 `alibabaSourceProducts`

```ts
interface AlibabaSourceProduct {
  _id: string; // sourceKey
  sourceKey: string;
  connectionId: string;
  sourceProductId: string;
  payloadId: string;
  sourceTitle?: string;
  sourceDescription?: string;
  sourceCategoryId?: string;
  sourceCategoryPath?: string[];
  sourceImageUrls: string[];
  sourceUpdatedAt?: string;
  fetchedAt: string;
  active: boolean;
  firstSeenRunId: string;
  lastSeenRunId: string;
  tombstonedAt?: string;
  parseVersion: 'alibaba-source-product-v1';
}
```

### 3.7 `alibabaProductLinks`

```ts
interface AlibabaProductLink {
  _id: string; // sourceKey
  sourceKey: string;
  connectionId: string;
  sourceProductId: string;
  productId: string;
  linkedByUserId?: string;
  linkedAt: string;
}
```

Create-if-absent enforces one source product to one Channel product. A Channel product may have multiple link rows.

### 3.8 `alibabaSupplierOffers`

One document per product/SKU offer.

```ts
interface AlibabaSupplierOffer {
  _id: string; // offerKey
  offerKey: string;
  sourceKey: string;
  connectionId: string;
  sourceProductId: string;
  sourceSkuId: string;
  active: boolean;
  sourceAttributes: Record<string, string>;
  sourceAvailability?: number;
  pricing: AlibabaCatalogPricing;
  sourceUpdatedAt?: string;
  syncedAt: string;
  lastSeenRunId: string;
}
```

### 3.9 `alibabaSyncRuns`

Stores mode, trigger, status, holder/fence, candidate hash, lifecycle timestamps, counters, redacted alerts, one-time approval, and normalized error summary.

### 3.10 Additive product fields

```ts
interface AlibabaLinkedCatalogFields {
  alibabaPrimarySourceKey?: string;
  alibabaPrimaryOfferKey?: string;
  alibabaCatalogPricing?: AlibabaCatalogPricing;
  alibabaSourceStatus?: 'available' | 'limited' | 'unavailable' | 'removed' | 'unknown';
  alibabaSourceLastSyncedAt?: string;
}
```

All are read-only in generic admin CRUD. Existing price fields remain writable/behaving exactly as today.

## 4. Money normalization

- preserve money lexemes as strings through a lossless JSON boundary;
- accept only strict decimal strings with at most two fractional digits for Phase 2;
- return integer minor units by string manipulation;
- reject signs, separators, exponent notation, extra decimals, unsafe integers, NaN, and Infinity;
- never use `parseFloat`, binary floating multiplication, or rounded conversion.

Tier rules:

- positive integer quantities;
- sorted ascending;
- no duplicate starts or overlaps;
- one optional open-ended final tier;
- one currency across all tiers;
- source MOQ compatible with first tier.

## 5. Primary offer and price materialization

Across active offers linked to one Channel product (R1 — total order; the
prior wording was undefined for mixed-currency and amount-less offer sets):

1. use operator-pinned `alibabaPrimaryOfferKey` when still valid;
2. otherwise consider only amount-bearing offers (`fixed`/`range`/`tiered`)
   in the highest-priority currency present (priority `USD` > `CNY`; FX
   conversion remains banned, so amounts are never compared across
   currencies) and choose the lowest valid minimum unit amount;
3. if no amount-bearing offer exists, `negotiable` offers rank above
   `unavailable`;
4. final tie-break by source key then SKU ID lexically. An all-`negotiable`
   set materializes the tie-break winner's negotiable pricing.

Materialize the selected offer into `products.alibabaCatalogPricing`.

Never write `unitPrice`, `wholesalePrice`, or `vipPrice`. Never fabricate a fixed amount from multiple SKUs; preserve range/tiered semantics.

## 6. Pricing presentation compatibility

### 6.1 API

- Keep existing public fields and VIP gating unchanged.
- Add `alibabaPrimarySourceKey`, `alibabaCatalogPricing`, `alibabaSourceStatus`,
  and `alibabaSourceLastSyncedAt` to the ungated public allowlist
  (`PUBLIC_CATALOG_FIELDS`); never add `alibabaPrimaryOfferKey`.
- R1 — public sub-projection: before attaching to a public payload,
  `alibabaCatalogPricing` is stripped of `sourceOfferKey`, `sourceProductId`,
  and `sourceSkuId` (offer provenance stays in the admin-read-only
  `alibabaSupplierOffers`/`alibabaProductLinks` records). The public shape
  keeps `schemaVersion`, `source`, `currency`, `mode`, amounts/tiers,
  `sourceMoq`, `sourceUpdatedAt`, `syncedAt`.
- Do not expose connection IDs, raw payload IDs, run IDs, private source URLs, or offer internals.
- Anonymous and authenticated users receive identical Alibaba pricing for a linked product.
- R1 — the allowlist is shared by `products` and `overstock`; overstock rows
  can never carry Alibaba fields (strict write schema), and a contract test
  pins overstock payloads unchanged.

### 6.2 UI

```tsx
product.alibabaPrimarySourceKey ? (
  <AlibabaCatalogPricingBlock pricing={product.alibabaCatalogPricing} />
) : (
  <PriceBlock /* existing props and behavior */ />
)
```

Rules:

- branch on link identity, not on the presence of a numeric amount;
- linked + missing pricing renders unavailable;
- never fall back to legacy fields while linked;
- unlinked behavior remains unchanged;
- existing `PriceBlock` may receive a comment identifying it as the legacy/manual compatibility renderer, but no code is removed.

R1 — complete legacy price render-site enumeration for `products` (the branch
above covers only the `PriceBlock` site; the live page renders legacy values
at two more sites that must also respect link identity):

| Render site | Unlinked product | Linked product |
|---|---|---|
| `HeadphonesProductCard` unit-price badge | unchanged (`unitPrice`) | Alibaba price summary or unavailable state — never `unitPrice` |
| `HeadphonesProductDetail` spec-sheet unit-price row | unchanged | suppressed (Alibaba pricing renders via `AlibabaCatalogPricingBlock`) |
| `HeadphonesProductDetail` spec-sheet MOQ row | unchanged (`product.moq`) | shows `alibabaCatalogPricing.sourceMoq` (legacy `moq` row suppressed) |
| `PriceBlock` (wholesale/VIP) | unchanged | replaced by `AlibabaCatalogPricingBlock` |

Dormant/unrouted islands (`ProductGrid`, `ProductCard`, `ProductDetail`,
overstock underscore pages) are out of scope. The admin `PreviewModal` price
rows are an admin-only cosmetic surface; linked products may additionally show
an Alibaba pricing row there, and the legacy rows remain (admin sees both).
Alibaba amounts render with a dedicated minor-unit formatter parameterized by
`currency` (`CNY`/`USD`); the existing `formatPrice` (major-unit, hardcoded
USD) is never reused for Alibaba values.

## 7. Merge policy

### New source product

- persist raw and normalized source data;
- require explicit category mapping;
- create unpublished draft with source suggestions and additive Alibaba fields;
- do not auto-select public images.

### Existing unlinked product

- no automatic match;
- admin links explicitly with side-by-side confirmation.

### Existing linked product

- update only Alibaba-owned fields;
- preserve curated and legacy pricing fields;
- alert large price moves;
- never change publication state.

### Source deletion

- tombstone source/offers after complete full pass;
- keep Channel product and legacy fields;
- set Alibaba source status to removed/unavailable;
- R1 (canonical form): retain the materialized object with
  `alibabaCatalogPricing.mode = 'unavailable'` (provenance and `syncedAt`
  survive); renderers treat an absent object identically as defense in depth;
- never auto-unpublish/delete;
- alert operations.

## 8. Raw evidence, OAuth, and secrets

- write exact catalog API response bytes before parsing;
- hash-address private objects and deduplicate by SHA-256;
- never persist auth headers, tokens, app secret, or full signed URL;
- OAuth start requires valid Channel admin session;
- generate 32 random bytes for state, store only SHA-256, 10-minute TTL, consume once;
- AES-256-GCM token envelope uses `ALI_TOKEN_ENCRYPTION_KEY_V1`;
- proactively refresh where a timer exists; on the test environment (no
  timer, R1) refresh lazily — at manual-run start and on auth-failure
  responses; mark `authorization_expired` and alert on non-recoverable auth
  failure.

Function environment (R1 — complete; deploys REPLACE a function's env
wholesale, so this list is the whole contract):

| Variable | Kind | Notes |
|---|---|---|
| `TCB_ENV` | shared, required | CloudBase env id (DB/storage init) |
| `JWT_SECRET` | shared, required | same value as admin/public-api; admin-session verification |
| `CORS_ALLOWED_ORIGINS` | shared, required | site origin(s), admin-function convention |
| `APP_ENV` | shared | environment tag (`test`/`prod`), mirrors existing functions |
| `ALI_APP_KEY` | feature | Alibaba app key |
| `ALI_APP_SECRET` | feature | Alibaba app secret |
| `ALI_OAUTH_CALLBACK_URL` | feature | exact registered callback URL (§8.1) |
| `ALI_TOKEN_ENCRYPTION_KEY_V1` | feature | 64 lowercase hex chars = 32 bytes |
| `WECOM_WEBHOOK_URL` | feature, optional | alerts fall back to structured logs |

R1 — all feature vars are read via `optionalEnv` and validated lazily in the
code paths that need them (public-api optional-`JWT_SECRET` precedent): cold
start and `/health` never require them; unconfigured state surfaces as an
explicit `not_configured` connection status, never a crash. The encryption
key's format is validated (exactly 32 bytes from hex) at first use; the `_V1`
suffix is the rotation version.

### 8.1 OAuth flow contract (R1)

Sessions live only in `localStorage` (no cookie) and the site and API origins
differ, so the flow is:

1. **Start** — `AlibabaConnectionPanel` sends an admin-authenticated JSON
   action (`{action:'oauthStart', token}` POST, admin-function convention) to
   the `alibaba-catalog-sync` function. The handler revalidates the session
   against the live users row and requires role === `'admin'` (not
   `canAccessAdmin`, which admits contributors) for every connection
   lifecycle action (start, disconnect, and the connection panel's state
   reads). It generates the 32-byte state, stores `sha256(state)` with the
   requesting user + intent + 10-minute expiry via `createDocWithId`, and
   RETURNS `{authorizeUrl}`. The browser performs `window.location =
   authorizeUrl`. The function's HTTP adapter replicates the admin adapter's
   CORS/OPTIONS handling driven by `CORS_ALLOWED_ORIGINS`.
2. **Callback** — Alibaba redirects to
   `ALI_OAUTH_CALLBACK_URL = https://<TCB_ENV_ID>.service.tcloudbase.com/api/alibaba-catalog-sync/oauth/callback`
   (test env shape; the path is the frozen gateway route + `/oauth/callback`).
   The callback is an unauthenticated GET bound solely by the stored state
   record: consume the state single-use via the `incrementField` CAS 0→1
   precedent (claim !== 1 → replay, reject), check expiry, exchange the code
   server-side, encrypt and store the token envelope, then 302 to the admin
   UI on the site origin with a status query parameter (the operator never
   strands on the API origin).
3. **Abuse control** — the callback and failed starts are rate-limited with
   the reserve-first `rateLimitHits` ledger pattern (per-source SHA-256 of IP
   + global fixed windows), matching the login/recover convention.
4. OAuth token responses are never raw-mirrored (§3.5); token values never
   appear in logs, alerts, API responses, or the browser.

### 8.2 Alibaba platform endpoints (R1)

Platform: **Alibaba.com International Station Open Platform**
(`open.alibaba.com`) — pinned by the verified 2026-07-28 research in
`docs/accio-alibaba-integration/REPORT.md` (ICBU product APIs
`alibaba.icbu.product.list/get/schema.render`, OAuth 2.0 authorization-code
with server-side token create/refresh, HMAC-signed calls). NOT 1688/Taobao.

Endpoint base URLs live in ONE module (`alibaba-endpoints.ts`) as documented
defaults, overridable via optional env (`ALI_AUTHORIZE_BASE_URL`,
`ALI_API_BASE_URL`) that must be HTTPS on an `*.alibaba.com` host.

Verification status (updated 2026-08-06 once connectivity returned):

- **CONFIRMED from official docs** — the ICBU authorize page:
  `https://oauth.alibaba.com/authorize?response_type=code&client_id=<appKey>&redirect_uri=<cb>&sp=ICBU&view=web&state=…`
  (the official example writes `State=` in the request while the callback
  echoes `state=`; the implementation sends BOTH casings and the callback
  accepts both). The GOP token protocol is also confirmed across the
  platform family: POST `/auth/token/create` `{code}` and
  `/auth/token/refresh` `{refresh_token}` on the signed `/rest` gateway,
  returning `access_token`/`refresh_token`/`expires_in` (seconds)/
  `refresh_expires_in`/`account`.
- **Still override-guarded** — the exact ICBU `/rest` gateway host (default
  `openapi-api.alibaba.com`) is behind the doc portal's login; the MIU 15
  live smoke confirms it, with `ALI_API_BASE_URL` as the no-redeploy
  correction path.

Signature canonicalization ships with golden-vector tests from the
documented spec; the signature module is endpoint-agnostic.

## 9. Lease and fencing

Add precise DB methods:

```ts
acquireAlibabaSyncLease(connectionId, holder, now, ttlMs): Promise<AlibabaLeaseGrant>;
renewAlibabaSyncLease(connectionId, holder, fence, now, ttlMs): Promise<boolean>;
releaseAlibabaSyncLease(connectionId, holder, fence): Promise<boolean>;
assertAlibabaSyncLease(connectionId, holder, fence, now): Promise<boolean>;
createDocWithId(collection, id, data): Promise<'created' | 'exists'>;
upsertDocWithId(collection, id, data): Promise<CollectionDoc>;
// R1 (architecture amendment, see REVISION_R1.md E2): fenced conditional
// write — the lease recheck happens INSIDE the same transaction/critical
// section as the write. assert-then-update at the facade is check-then-act
// and is forbidden for guarded writes; assertAlibabaSyncLease remains only
// as a cheap pre-check optimization.
updateDocWithAlibabaLease(collection, id, patch,
  guard: { connectionId, holder, fence, now }): Promise<boolean>;
```

CloudBase implements the lease methods and `updateDocWithAlibabaLease` as
single `@cloudbase/node-sdk` `runTransaction` calls (read lease doc → verify
holder + fence + non-expiry → write target doc). The local JSON adapter
implements each as ONE `withMutationLock` critical section (its per-process
promise-chain mutex; cross-process access is already excluded by the
owner-pid file). Transaction callbacks stay pure read-check-write — no side
effects outside the transaction (retries re-execute the callback on
`DATABASE_TRANSACTION_CONFLICT`).

- TTL 180 seconds;
- renew every 60 seconds and before long operations;
- fence increments on acquisition after release/expiry;
- R1 — ALL lease-guarded writes go through `updateDocWithAlibabaLease`:
  public product promotion, offer upserts on linked flows, source tombstone
  flips, and checkpoint advances (stale-seen stamps on mirror rows during
  page ingestion are accepted as last-write-wins — they only ever suppress a
  tombstone, and the next run repairs them);
- lost lease stops promotion immediately;
- release the lease explicitly at soft-deadline exit so the next tick resumes
  immediately instead of waiting out the TTL;
- existing image-mutation ownership remains unchanged.

## 10. Scheduling and bounded execution

Function timer expression:

```text
0 */15 * * * * *
```

UTC scheduler tick (R1 — due-based, missed-tick-proof; never wall-clock
equality):

- the checkpoint persists `nextFullDueAt` and `nextIncrementalDueAt`;
- each tick: resume the active run first; otherwise start the
  highest-priority job whose `dueAt <= now` (full sync outranks incremental);
  otherwise exit without Alibaba API calls;
- on completion the next due time is recomputed FROM THE SCHEDULE (full:
  next Sunday 18:30 UTC; incremental: next 4-hour boundary at minute :15),
  not from `now`;
- the weekly/4-hourly schedule lives in code as UTC computations and never
  migrates into the cron expression (SCF evaluates cron in UTC+8; the
  15-minute expression is timezone-agnostic and stays as-is).

Bounds per invocation:

- 720-second soft deadline (the function's deployed timeout is 900 seconds —
  §14; interactive HTTP routes sharing the function still answer fast, and
  the manual "run now" admin action only marks the run due / creates the run
  row and returns — it never executes the sync loop synchronously behind the
  gateway) — **AMENDED, see §10.1**;
- at most 200 source products or 50 API calls;
- checkpoint after every durable page;
- continuation resumes next tick;
- fail and alert after 24 hours from run start or 96 continuations;
- one active run per connection (lease first, then checkpoint read, then
  single-winner run-row creation via `createDocWithId` — the lease loser
  exits without touching anything);
- manual run uses same runner and lease.

### §10.1 Amendment — `runNow` executes a bounded slice inline

**Supersedes the "marks the run due and returns" clause in §10** (recorded
after the blessing-gate review flagged the divergence; three reviewers read
the original clause and correctly called the code a deviation).

The original design assumed a timer would always exist to pick up a
marked-due run. It does not in the **test environment**, where the deploy
hard-fails on any timer trigger by design (§14) — so mark-due-and-return
would leave `runNow` with nothing to drive it, and the feature would be
unverifiable in the only environment available before production.

`runNow` therefore MARKS THE RUN DUE (the original clause's intent) **and**
executes ONE bounded slice inline, returning its report. Mark-due is not
optional: without it `decideTick` answers `idle` whenever nothing happens to be
scheduled, so `runNow` could only ever continue a run something else had
started — and in the test env nothing else ever does.

The bound is what keeps the gateway envelope honest:

- `softDeadlineMs: 15_000`, `maxProducts: 20`, `maxApiCalls: 10`;
- the interactive path passes `maxAttempts: 1` and a 5-second per-call timeout
  to the API client for **enumeration and detail fetch**, so a stalled upstream
  cannot stretch one slice past the gateway envelope through retry backoff.
  The **tombstone confirmation keeps the client's default retry budget** on
  purpose: it is the one call whose failure is terminal for the whole run
  (§12), so absorbing a transient blip there is worth more than shaving
  seconds off an interactive slice;
- the slice runs under the SAME fenced lease as a timer tick, so a manual run
  and a timer tick can never interleave;
- a continuation is checkpointed exactly as a timer tick's would be, so
  repeated `runNow` calls drive a large run to completion in the test env.

Production keeps the 15-minute timer as the primary driver; `runNow` remains
an operator escape hatch there.


No timer in test environment.

## 11. Full and incremental behavior

Incremental:

- request after committed cursor;
- persist raw/source/offer state;
- validate candidate;
- promote healthy Alibaba-owned product fields;
- advance cursor only after durable page and promotion/quarantine decision.

Full:

- enumerate full authorized catalog using the documented 5,000-item bisection algorithm;
- record every seen source key by stamping `lastSeenRunId` on mirror rows
  during the pass (R1 — never accumulate the seen-set in the checkpoint
  document); tombstone candidates are `active && lastSeenRunId !== runId`
  after the completion flag;
- tombstone only after complete successful enumeration;
- R1 — a resumed multi-tick enumeration over a mutating catalog is not a
  consistent snapshot: before flipping any tombstone, confirm each candidate
  individually with a product-detail fetch returning not-found/removed; a
  confirmation fetch that errors (rather than confirming absence) quarantines
  the tombstone set instead of flipping it;
- R1 — a "complete" enumeration that saw zero items while the mirror has
  active sources quarantines instead of tombstoning (see §12).

## 12. Safety and quarantine

Run statuses (R1): `running | continuing | quarantined | approved | failed |
completed`. A run that enters `quarantined` RELEASES the lease and vacates
the active-run slot; new incremental runs may start while the quarantine is
pending (the quarantined candidate stays frozen); the 24-hour/96-continuation
clock stops at quarantine entry; an approval is valid until the next
completed run for the same connection supersedes the candidate (approving a
superseded candidate is rejected).

Quarantine before product promotion when (R1 — denominators pinned; a ratio
whose denominator is 0 never trips that guard, the absolute floor still can):

- candidate linked-product changes `>= 20` and ratio `> 30%` of the
  linked-product count at run start;
- tombstones `>= 5` and ratio `> 10%` of the active source count at run start;
- parse failures `>= 5` and ratio `> 5%` of items processed this run;
- full enumeration completed with zero items while active sources `> 0` (R1);
- signature vector fails;
- response contract fails;
- unsupported currency;
- raw evidence missing;
- lease/fence invalid.

Quarantine preserves raw and normalized candidates. Approval records actor, time, reason, run, and immutable candidate hash.

## 13. Media import

- HTTPS only;
- exact allowlist/suffix-safe hostname checks;
- validate every redirect target;
- resolve DNS and reject loopback/private/link-local/multicast/reserved IPv4/IPv6;
- connection/read/total timeout;
- streaming byte cap;
- MIME allowlist plus magic-byte validation;
- SHA-256 dedupe;
- import through existing media lifecycle as candidate media;
- never set public product image IDs automatically.

R1 — "candidate media" mapped onto the actual lifecycle (`pending` would be
reaped by the 24h orphan sweep):

- imported candidate = server-verified bytes written with status `active`,
  `publishedRefCount 0`, and NO product `imageIds` attachment — admin-visible
  via preview, public-invisible by the existing refcount gate; `pending`
  remains reserved for in-flight browser uploads;
- verification mirrors `completeUpload`: recompute byteSize + SHA-256 from
  the fetched bytes, magic-byte sniff against the declared MIME, enforce the
  catalog image MIME allowlist and byte cap; write the `images` row via the
  trusted create path; on any compensation path delete the storage object
  first, then the doc;
- ownership: imported images set the fixed sentinel
  `uploadedByUserId: 'alibaba-catalog-sync'` so reference locks engage; a
  dedicated admin-only action removes UNREFERENCED imported candidates
  (mirroring abandonUpload's checks minus the uploader-identity gate), since
  no admin's user id can match the sentinel;
- raw payloads use the new hash-addressed `alibaba-raw` media-storage
  namespace; image dedupe queries `images.checksumSha256` server-side (new
  provisioned index).

## 14. Deployment manifest

Replace duplicated hardcoded function arrays with one repository manifest that includes existing functions plus `alibaba-catalog-sync`.

The manifest must drive:

- workspace build selection;
- artifact packaging;
- cold-start smoke;
- environment variables;
- per-function `timeout` and `memorySize` (R1 — the deploy path currently
  hardcodes `timeout: 20, memorySize: 256` for every function in BOTH the
  generated cloudbaserc and `updateFunctionConfig`, which re-applies on every
  deploy; `alibaba-catalog-sync` requires 900s / 512MB, existing functions
  keep their current values);
- test/prod deployment;
- gateway route (frozen: `/api/alibaba-catalog-sync`; route creation stays
  create-if-missing and additive — existing admin/public-api routes are
  never updated or deleted);
- timer trigger desired state;
- drift tests.

This is the only intended shared deployment refactor. It must preserve existing `admin` and `public-api` behavior exactly.

R1 — repo-reality obligations for the refactor:

- Known manifest consumers updated in lockstep: `scripts/package-functions.mjs`,
  `scripts/smoke-function-artifacts.mjs`, `scripts/deploy-cloudbase-test.mjs`
  (functionDefs env maps + cloudbaserc generation + `updateFunctionConfig` +
  gateway ensure), `scripts/smoke-cloudbase-deploy.mjs`, and
  `scripts/runtime-contract.test.mjs` (whose AST/step-string assertions must
  stay green — keep the runtime literal singular and the pinned workflow step
  strings unchanged).
- Env preservation proof: a contract test snapshots the manifest-derived
  `envVariables` for `admin` and `public-api` and asserts byte-equality with
  the pre-refactor maps (including optional-var drop behavior) BEFORE the
  deploy script switches to the manifest — deploys replace function env
  wholesale, so any drift silently un-sets live vars.
- Secret plumbing: `.github/workflows/deploy-test.yml` Deploy-step env gains
  the five ALI_*/WECOM_* names (provisioned in the GitHub `test`
  environment); both workflows' built-site secret-name scan regexes gain
  `ALI_APP_KEY|ALI_APP_SECRET|ALI_OAUTH_CALLBACK_URL|ALI_TOKEN_ENCRYPTION_KEY_V1|WECOM_WEBHOOK_URL`;
  the deploy script's redaction helpers survive the refactor.
- Trigger reconciliation is NEW tooling (nothing in the repo manages
  triggers today): the test deploy lists timer triggers for
  `alibaba-catalog-sync` and deletes any found (or hard-fails); the
  production deploy applies the manifest's declared trigger; the deploy smoke
  asserts trigger absence on test. The concrete mechanism (CLI, cloudbaserc
  `triggers`, or MCP tool) is probed and recorded before MIU 14 freezes it.
- Production deployment is NEW SCOPE: the repo has a test-env path only.
  MIU 15's production activation is performed manually with recorded
  evidence unless a prod workflow is explicitly added first.
- Artifact cold-start smoke runs every function with stub env only — the
  ALI_*/WECOM_* vars are therefore optional at cold start by construction
  (§8).

## 15. Future Medusa seam

A future outbound projector may consume curated products, Alibaba offers, and Alibaba pricing. No current module imports Medusa and no Medusa-specific schema is added.
