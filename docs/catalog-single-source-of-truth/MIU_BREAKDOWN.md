# Catalog single source of truth — MIU breakdown

Design and decisions: [DESIGN.md](DESIGN.md). Progress: [EXECUTION_LOG.md](EXECUTION_LOG.md).
Branch: `feat/catalog-alibaba-price-tiers` (continue here until it merges to `main`).

Each MIU goes through test-first → implement → simplify → review → validate →
commit on its own. MIUs marked **Pending owner review** must not start until the
owner confirms the decision they implement (README "Open decisions"). None is
pending now: DEC-12 was confirmed on 2026-10-08 (MIU-25, MIU-35 built).

Validation commands used below (repo root):

```bash
pnpm lint
pnpm typecheck
NODE_OPTIONS=--no-experimental-webstorage pnpm test
pnpm build
pnpm package:functions && pnpm smoke:functions
```

`NODE_OPTIONS=--no-experimental-webstorage` is needed only on local Node 25 (its
built-in `localStorage` breaks some admin tests); CI uses Node 22.

---

## Level 1 — product tasks

| ID | Product task (what a buyer or admin notices) | MIUs |
|---|---|---|
| PT-0 | Product page shows Alibaba-style tier prices (done: PR #64 to `test`, commits `5913f20`, `7984dea`; review fix `71272a6` hides tiers below the MOQ) | — |
| PT-A | A product's headline Alibaba price is never shown as a fixed price | 1, 2, 36 |
| PT-B | List card, product page and quote always show the same approved data | 3–14 |
| PT-C | Admins see which products changed since approval and approve them in one action | 15–25, 35, 38 |
| PT-D | The 21 products are restored and consistency is proven on the live site | 26 + runbook |
| PT-E | Manual products look and behave exactly like synced ones (same version, API keys, page, quote) | 27–34, 37 |

## Dependency order and deploy batches

```
PT-A   1 → 2 → 36
PT-B   3 → 4
       3 → 6 → 7
       3 → 5 → 8, 9, 10
       3 → 11 → 12 → 13
       8, 12 → 14
PT-C   15 → 21, 23 → 24, 25;  15 → 35
       16 → 17 → 18
       15, 16, 18 → 19 → 20
       15, 18 → 22;  16, 22 → 38
       16, 19, 24 → 39
PT-D   3, 8 → 26
PT-E   4 → 27 → 28 → 29, 30 → 31 → 37;  15 → 37
       30 → 32
       33 (none)
       8, 9, 10, 27–30, 32, 33 → 34
```

Contracts come first: MIU-3 (price summary schema), MIU-5 (public version rule),
MIU-15 (review reason field), MIU-16 (source digest) and MIU-27 (manual draft)
define shapes that later MIUs consume.

| Batch | MIUs | Deployed state after the batch |
|---|---|---|
| 1 | 1, 2, 36 | Headline no longer a price; stored offers rebuilt by replay (runbook R2) |
| 2a | 3 | Functions can **read** a publication with a price summary (nothing writes one yet). Makes later rollbacks safe |
| 2b | 4, 6, 7 | Every approval stores a price summary; existing versions backfilled (R4). **Public reads unchanged** |
| 3 | 5, 8–14, 26, 33 | All public surfaces read the one version; consistency audit passes (R5). MIU-33 moved here from 5a (batch 3 review #9) so card and page both show an MOQ-only quote |
| 4 | 15–25, 35, 38, 39 | "Changed" flag live; audit flags stale products (R6, run before admins use Save); admin re-approves (R7) |
| 5a | 27–30, 32, 34 | Manual products approvable; admin approves the 7 live ones (R9) |
| 5b | 31, 37 | Publish gate for every product (after R9); audit shows 0 products on the row fallback (R10) |

Order: implement and validate batches locally first (DEC-13), run R1, then
deploy. Owner 2026-10-08: batches 1–3 deploy as soon as they pass local
validation. The 21 are then fixed by R2 and a re-approval (Publish) of each,
after stage B (R7 below, done early). Batches 4–5 follow when done.

Batches 1, 2a and 2b ship as **one deploy (stage A)**, batch 3 as a second
(stage B). Batch 2a was planned alone (batch 2 review #2) so that no approval
could write a `priceSummary` that a not-yet-updated function cannot read.
Within one deploy run the pipeline updates `admin` (the writer) before
`public-api` (a reader), so the rule becomes: **no approvals while stage A
deploys** (the operator holds them; nothing approves automatically), and R4
writes summaries only after stage A is verified. From then on the only rollback
target is stage A itself, which reads summaries. Never roll back past stage A
once any approval or R4 has written a summary (every approval after stage A
writes one, and the older reader then treats the product as not approved).
Each stage: pushed (fast-forward) to `test` → Deploy Test → runbook checks. No PR into `test` (owner 2026-10-08: PRs are only for merging into `main`). Operator scripts
(backfill, audit) always run from the branch head, not from a stage branch.

**What each deploy contains.** Some fixes were committed after later work, so
stage A is *not* a plain prefix of the branch. It is `bcfac0a` (batches 1, 2a,
2b and the batch 1 fix `c2e0bdb`) plus these files, **applied top to bottom**:
each file is byte-identical in the tree built so far and at its source commit's
parent (checked 2026-10-08). Out of order, `de87798` would overwrite the three
`8958d90` files and silently drop `variantCount`. Built as `7e1b20c` → `ae5d81d`,
then merged with `main` (`d4ee7c1`) and `test` (`b5f50c9`):

| From | Files | Why |
|---|---|---|
| `de87798` | its nine code files (`git show --name-only de87798 -- ':!docs'`) | batch 2 review fixes |
| `8958d90` | `packages/db/src/catalog-price-summary-backfill{,.test}.ts`, `apps/functions/admin/src/handler.test.ts` | plan rows carry `variantCount`, which the R4 review needs |
| `95ee994` | `tests/fixtures/seed-raw-catalog.ts`, `tests/e2e/catalog-formal-journey.spec.ts` without its `[data-quote-moq]` lines | MIU-1 removed the fixture's headline price; MIU-33 (the MOQ line) arrives in stage B |

Each stage branch is then merged with `origin/main` and `origin/test` (conflicts:
the price block and its test, the formal journey, the admin handler test and
five test-only docs; in each, the branch side is the newer version) and pushed
to `test`. Check before the push: the stage tree differs from `main`
only in the stage's own files. Stage B is the reviewed branch head, recorded in
EXECUTION_LOG when it ships.

The pipeline always deploys functions before the site, so during each deploy an
open old browser bundle can read the new list for a few minutes (approved cards
show "Request a quote"). Accepted (MIU-8).

---

## PT-A — Headline price is not a fixed price

### MIU-1: `normalizeProductDetail` — omit the wholesale headline offer when SKUs exist

```
Block:      BACKEND
Files:      packages/alibaba-catalog-sync/src/alibaba-normalizer.ts
            packages/alibaba-catalog-sync/src/alibaba-raw-completeness.test.ts
            packages/alibaba-catalog-sync/src/alibaba-normalizer.test.ts
Type:       modify-existing
Depends on: none
```

**What it does**
- In the product-level offer block (today `alibaba-normalizer.ts:317-364`), stop
  emitting the `'@product'` offer for `productType === 'wholesale'` when
  `detail.skus.length > 0`. The wholesale headline
  (`wholesaleTrade.priceLexeme`) is Alibaba's cheapest-tier summary, not a price
  (DESIGN §2.3).
- Products **without** SKUs: if Alibaba sends a product-level ladder, use it
  (tiered) — today the wholesale branch runs first (`alibaba-normalizer.ts:327-341`)
  and stores the headline as fixed even when a ladder exists, the same defect.
  Only a wholesale product with neither SKUs nor a ladder keeps the headline as
  its fixed price. FOB → range unchanged. Sourcing (FOB) products **with** SKUs
  are unchanged.
- Return type `NormalizeResult` unchanged; only the `offers` array content changes.
- Keep the headline amount available for audit only if a caller needs it (no new
  field unless a test requires it).

**Build/Deploy/Runtime impact**
- Package is bundled by `tsup` into `apps/functions/alibaba-catalog-sync`; no new
  dependency. Verify `pnpm package:functions && pnpm smoke:functions`.
- Changes the source content hash for affected products on their next ingest;
  handled by MIU-2 (replay stores the new hash) and runbook R2.
- No CloudBase index or env change.

**Test plan (write first)**
- `alibaba-raw-completeness.test.ts:359-409` (headline 390 next to SKU tiers):
  assert `offers` has **no** `sourceSkuId === '@product'` entry and every SKU offer
  keeps its tiers.
- `:329-357` (headline only, SKU invalid): assert no `'@product'` offer and SKU
  pricing `mode === 'unavailable'` (product shows "Request a quote").
- `:498-514` captured wire fixture: update the "both price scopes" expectation to
  SKU scope only.
- Wholesale, zero SKUs, product ladder present → one `'@product'` **tiered** offer
  from the ladder (new test).
- Wholesale, zero SKUs, no ladder → one `'@product'` fixed offer (the existing loop
  at `alibaba-raw-completeness.test.ts:343-357` stays green).
- A sourcing product with SKUs still yields its FOB range offer.

**Done when**
- All test-plan assertions pass; all `packages/alibaba-catalog-sync` tests pass.
- `pnpm typecheck` and `pnpm package:functions && pnpm smoke:functions` pass.

### MIU-2: raw replay — accept and deactivate a dropped `'@product'` offer; store the new content hash

```
Block:      BACKEND
Files:      apps/functions/alibaba-catalog-sync/src/raw-replay.ts
            apps/functions/alibaba-catalog-sync/src/raw-replay.test.ts
            apps/functions/alibaba-catalog-sync/src/ingest.ts
Type:       modify-existing
Depends on: MIU-1
```

**What it does**
- Bump `REPLAY_PARSER_VERSION` (`raw-replay.ts:35`, today
  `'alibaba-content-media-v5'`) to `'alibaba-content-media-v6'`.
- Extend the one-way key exception (`raw-replay.ts:606-621`): when the existing
  active set equals the replayed set **plus** exactly the `'@product'` offer, the
  product is accepted instead of failing with `offer-set-mismatch`. Any other
  difference still fails.
- The replay result today is `{counts, priceModes, failures[]}`
  (`raw-replay.ts:165-208`). Add `counts.productHeadlineDropped` (number of
  products whose headline offer will be / was deactivated). The admin page
  decodes this result strictly (`alibaba-api.ts`: result interface `:341-349`, strict counts decoder `REPLAY_COUNT_KEYS` / `hasExactKeys` `:399-428`, `emptyReplayCounts` `:573-581`), so the
  decoder and display change in MIU-36, deployed in the same batch.
- On apply (`raw-replay.ts:706-769`), set `active: false` on that `'@product'`
  offer in the same guarded write as the rebuilt SKU offers.
- Export `contentFingerprint` from `ingest.ts` (no behaviour change) and have apply
  write the recomputed `alibabaSourceProducts.contentHash`, so the next ingest
  compares like with like and does not count the product as changed (surge guard:
  `runner.ts:708`).
- Still never writes `products`, `catalogDetailPublication` or
  `catalogDetailVariants`; still never calls Alibaba.

**Build/Deploy/Runtime impact**
- Function code only (`alibaba-catalog-sync`). Writes one more field on
  `alibabaSourceProducts`; no index change. Runs only when an admin triggers replay
  (admin page "Alibaba observation replay").

**Test plan (write first)**
- Existing active offers = SKU offers + `'@product'`; replayed = SKU offers only →
  dry run: no failure, `counts.productHeadlineDropped === 1`.
- Apply on that row: SKU offers rebuilt; `'@product'` offer `active === false`;
  `alibabaSourceProducts.contentHash` equals `contentFingerprint(...)` of the
  replayed result; no `products` write captured.
- Negative: replay set missing a **SKU** offer → still `offer-set-mismatch`, nothing
  written.
- `raw-replay.test.ts:74` add-only exception still passes.
- Update the pinned parser version expectation (`raw-replay.test.ts:348`,
  `'alibaba-content-media-v5'` → `v6`).

**Done when**
- All `raw-replay` tests pass; `apps/functions/alibaba-catalog-sync` tests pass.
- `pnpm typecheck`, `pnpm package:functions && pnpm smoke:functions` pass.

### MIU-36: replay admin page accepts and shows `productHeadlineDropped`

```
Block:      FRONTEND
Files:      apps/site/src/islands/admin/alibaba-catalog-sync/alibaba-api.ts
            apps/site/src/islands/admin/alibaba-catalog-sync/AlibabaObservationReplay.tsx
            apps/site/src/islands/admin/alibaba-catalog-sync/alibaba-observation-replay.test.ts
Type:       modify-existing
Depends on: MIU-2
```

**What it does**
- The replay result decoder (`alibaba-api.ts`: result interface `:341-349`, strict counts decoder `REPLAY_COUNT_KEYS` / `hasExactKeys` `:399-428`, `emptyReplayCounts` `:573-581`) accepts the
  new `counts.productHeadlineDropped` (non-negative integer) and still rejects any
  other unknown key.
- The replay page shows it next to the existing counts: "Headline prices removed:
  N", so the admin sees in the dry run how many products are affected (runbook R2).

**Build/Deploy/Runtime impact**
- Admin island bundle. Must ship in the **same deploy** as MIU-2, or the replay
  page rejects the new response.

**Test plan (write first)**
- Response with `productHeadlineDropped: 3` → decodes; the page renders "3".
- Response with an unknown extra key → still rejected.

**Done when**
- Tests pass; `pnpm typecheck`; `pnpm build`.

---

## PT-B — One public version for list, page and quote

### MIU-3: `CatalogPriceSummarySchema` + `derivePriceSummary` + optional `priceSummary` on the publication

```
Block:      BACKEND (shared contract)
Files:      packages/shared/src/catalog/price-summary.ts        (new)
            packages/shared/src/catalog/price-summary.test.ts   (new)
            packages/shared/src/catalog/product-detail.ts
Type:       new-file + modify-existing
Depends on: none
```

**What it does**
- Contract (consumed by MIU-4, 6, 8, 11, 12):
  ```ts
  CatalogPriceSummarySchema = z.object({
    source: z.enum(['website', 'sku', 'product']),
    variantId: z.string().min(1).max(200).optional(), // SKU that supplied it
    pricing: <existing offer pricing schema from offer-pricing.ts>,
  }).strict();
  ```
- `CatalogDetailPublicationSchema` (`product-detail.ts:88-116`) gains
  `priceSummary: CatalogPriceSummarySchema.optional()` at **top level**. The strict
  `CatalogDetailHeaderSchema` is **not** changed (a header key would break every
  product page decode).
- `derivePriceSummary({ websitePricing?, offers, variants: {id, offers}[] })
  → CatalogPriceSummary | undefined`, pure, never throws:
  1. `websitePricing` with an amount-bearing mode, **or** an `unavailable` /
     `negotiable` website price that carries `minimumOrderQuantity` (DEC-16) →
     `source: 'website'`.
  2. Else the amount-bearing SKU offer with the lowest minimum unit amount;
     currency preference USD, then CNY, then others alphabetically; ties → earliest
     SKU position → `source: 'sku'`, `variantId`.
  3. Else an amount-bearing product-level offer → `source: 'product'`.
  4. Else a "request a quote" that still states a minimum order (product-level
     first, then the first SKU) → so the card can show the MOQ like the page
     (DEC-16; added in the batch 2 review).
  5. Else `undefined` (card shows "Request a quote").
  Tiers ending below the minimum order are ignored (the page ignores them too);
  currency ranking ignores letter case.
- Wiring: `@vibelingan-channel/shared` lists its exports explicitly
  (`packages/shared/package.json`; `./catalog-detail` → `product-detail.ts`).
  Re-export the schema, type and `derivePriceSummary` from `product-detail.ts`, so
  db, public-api and the site import them from `@vibelingan-channel/shared/catalog-detail`
  without a new package entry. `price-summary.ts` imports only `offer-pricing.ts`
  (never `product-detail.ts`) and declares its input structurally, so there is no
  import cycle.

**Build/Deploy/Runtime impact**
- `@vibelingan-channel/shared` is consumed raw-TS by the site (Astro/Vite) and
  bundled by `tsup` into every function. No new dependency. Verify `pnpm build`
  and `pnpm package:functions && pnpm smoke:functions`.
- Adding an optional key to a strict schema: existing stored publications (no key)
  still decode.

**Test plan (write first)**
- Website tiered pricing present → `{source: 'website', pricing: <that pricing>}`.
- SKUs A (tiers 130/122/120 USD) and B (fixed 125 USD) → `source: 'sku'`,
  `variantId: 'A'` (minimum 120 < 125).
- SKU USD 500 and SKU CNY 300 → picks the USD one (currency preference over amount).
- All SKUs `unavailable`, header fixed 400 → `source: 'product'`.
- Website price `unavailable` with MOQ 50 → `{source: 'website'}` with that
  pricing (the card shows "Request a quote" and MOQ 50).
- Everything else unavailable/negotiable, no MOQ → `undefined`.
- Schema: a publication without `priceSummary` decodes; one with an unknown key
  inside `priceSummary` is rejected; a header with `priceSummary` is still rejected.

**Done when**
- Tests pass; `pnpm typecheck` passes for all packages and the e2e project.
- `pnpm build` and `pnpm package:functions && pnpm smoke:functions` pass.

### MIU-4: `planCatalogDetailApproval` stores `priceSummary` on every new approval

```
Block:      BACKEND
Files:      packages/shared/src/catalog/detail-approval.ts
            packages/shared/src/catalog/detail-approval.test.ts
            packages/db/src/catalog-detail-staging.test.ts
Type:       modify-existing
Depends on: MIU-3
```

**What it does**
- After the variants are planned (`detail-approval.ts` ~146) and before the
  publication object is built (~159-167), call `derivePriceSummary` with
  `header.websitePricing`, `header.offers` and the full planned `variants` and set
  `publication.priceSummary` when defined.
- All approval paths inherit it: staged prepare (`catalog-detail-staging.ts:119-169`,
  stored in `job.publication`), single-transaction commit, workflow review and the
  local rehearsal. `stageApprovalPage` re-plans one page of ≤20 rows and uses only
  `.variants`; the derivation must not throw on that partial set (its summary is
  discarded there).
- `finishStagedApproval` copies `job.publication` unchanged
  (`catalog-detail-staging.ts:323-326`) — no change needed there.
- `catalogApprovalDigest` hashes the plan (`catalog-detail-commit.ts:81`), so every
  open review digest changes once. Expected; see DESIGN §8.

**Build/Deploy/Runtime impact**
- Shared package (site + functions, as MIU-3). Job documents grow by one small
  object (512 KB cap at `catalog-detail-staging.ts:164` unaffected).
- Deploy when no admin review is open (one CONFLICT otherwise).

**Test plan (write first)**
- `planCatalogDetailApproval` with two SKUs (tiers min 120, fixed 125) →
  `publication.priceSummary` = `{source: 'sku', variantId: <first>, ...}`.
- With manual website pricing → `priceSummary.source === 'website'`.
- One-page partial plan (stage path) does not throw.
- `catalog-detail-staging.test.ts`: after begin → page → finish, the product's
  `catalogDetailPublication.priceSummary` equals the prepared job's summary and the
  revision is the job's revision.

**Done when**
- Tests pass; existing approval/staging/commit tests pass (update pinned digests
  only where the new field changes them, and say so in the commit).
- `pnpm typecheck`, `pnpm package:functions && pnpm smoke:functions` pass.

### MIU-5: `resolvePublicVersion` — the shared rule for which version is public

```
Block:      BACKEND (shared contract)
Files:      packages/shared/src/catalog/public-version.ts        (new)
            packages/shared/src/catalog/public-version.test.ts   (new)
            packages/shared/package.json   (new subpath export)
Type:       new-file + modify-existing
Depends on: MIU-3
```

**What it does**
- `resolvePublicVersion(product: unknown, opts: { detailEnabled: boolean })
  → { kind: 'approved'; publication: CatalogDetailPublication } | { kind: 'row' }`.
- Returns `approved` only when all hold: `opts.detailEnabled`;
  `catalogDetailPublication` decodes with `CatalogDetailPublicationSchema`;
  `header._id === product._id`. **The Alibaba link is not checked** (DEC-1,
  DEC-4): synced and manual products with an approved version are treated the same,
  and a product linked or unlinked after approval keeps its approved version.
- Everything else (never approved yet, feature off) → `row`, the temporary fallback
  that the consistency audit counts.
- Pure; never throws. Published as its own subpath
  `@vibelingan-channel/shared/catalog-public-version`. Not re-exported from
  `catalog/index.ts`: `product-detail.ts` imports that index at load time
  (`PublicProductSchema.pick`), so re-exporting a module that imports
  `product-detail.ts` from it would read `PublicProductSchema` before it exists.

**Build/Deploy/Runtime impact**
- Shared package, as MIU-3. None beyond build verification.

**Test plan (write first)**
- Linked + valid publication + enabled → `approved` with the decoded publication.
- Manual (no `alibabaPrimarySourceKey`) + valid publication + enabled → `approved`.
- Unlinked after approval + valid publication → `approved` (keeps its version).
- Same products with `detailEnabled: false` → `row`.
- Malformed publication / header `_id` mismatch → `row`.
- Manual product never approved → `row`.

**Done when**
- Tests pass; `pnpm typecheck` passes.

### MIU-6: price summary backfill (db) for existing approved versions

```
Block:      BACKEND
Files:      packages/db/src/catalog-price-summary-backfill.ts        (new)
            packages/db/src/catalog-price-summary-backfill.test.ts   (new)
            packages/db/src/catalog-detail-staging.ts
Type:       new-file + modify-existing
Depends on: MIU-3
```

**What it does**
- `planPriceSummaryBackfill({ afterId?, pageSize ≤ 20 })` pages `products` by
  `_id asc`, keeps those with a decodable `catalogDetailPublication` and no
  `priceSummary`, reads their approved SKU rows by storage mode
  (`catalogDetailVariants` filtered by `productId` + `catalogDetailRevision` for
  `immutable-v1`, else `productVariants.catalogDetailApproved`, same as
  `catalog-detail.ts:43-48`), and returns a manifest row per product:
  `{productId, revision, proposedSummary | null, reason}`.
- Apply: the db adapter has no generic transaction; each transactional write is a
  purpose-built command (`adapter.ts:491-571`, dispatched through
  `persistCatalogDetailApproval`). Add a command
  `{action: 'price-summary-backfill', productId, revision, priceSummary}` to
  `PersistenceCommandSchema` and its dispatch (`catalog-detail-staging.ts:64-75, 372`).
  - In one transaction it re-reads the product and requires the same publication
    `revision` (else `revision-changed`, no write).
  - It writes the product row back (transaction `set` replaces the row) with only
    `catalogDetailPublication.priceSummary` added.
  - It never changes `revision`, receipts, `published` or any other field.
  - Idempotent: a product that already has a summary is skipped.
  - Result type: extend `ApprovalStageResult` (`catalog-detail-staging.ts:46-61`,
    today `Progress | Failure`) with
    `{ ok: true, backfill: 'applied' | 'skipped', reason? }`. (Not `kind`: the
    review result is identified by `kind: 'review'` and callers narrow with
    `'kind' in result`.)
- No new CloudBase SDK surface (`pnpm verify:cloudbase-sdk` unaffected).

**Build/Deploy/Runtime impact**
- `packages/db` is bundled into the admin function. No index change: paging by
  `_id` uses the default index; SKU reads use `approved_variant_page` /
  `variant_product_position` (declared in `scripts/cloudbase-nosql-resources.mjs`).

**Test plan (write first)**
- Immutable-v1 product with two SKUs → manifest proposes the cheapest SKU summary.
- Legacy-storage product (`productVariants.catalogDetailApproved`) → same rule.
- Product whose revision changes between plan and apply → `revision-changed`, no
  write captured.
- After apply, the stored row equals the row before except at
  `catalogDetailPublication.priceSummary` (deep-equal after deleting that path);
  a second apply is a no-op.

**Done when**
- Tests pass; `pnpm typecheck`; `pnpm package:functions && pnpm smoke:functions`.

### MIU-7: admin action + script to run the backfill

```
Block:      BACKEND
Files:      apps/functions/admin/src/handler.ts
            apps/functions/admin/src/handler.test.ts
            scripts/catalog-price-summary-backfill.mjs   (new)
Type:       modify-existing + new-file
Depends on: MIU-6
```

**What it does**
- Admin-only action `backfillPublicationPriceSummary { mode: 'plan' | 'apply',
  afterId?, manifest? }` → plan returns the manifest page and `nextAfterId`; apply
  takes the reviewed manifest rows back and returns per-row outcomes.
- Script mirrors `scripts/catalog-price-repair.mjs` (same auth/env handling): pages
  through `plan`, writes the manifest to a local file, and only in `apply` mode
  (`plan|apply <manifest> <api-origin>`, token in `CHANNEL_ADMIN_TOKEN`) calls `apply`. Prints totals: eligible, applied, skipped by
  reason.
- Non-admin roles → `FORBIDDEN`.

**Build/Deploy/Runtime impact**
- New action on the admin function; no env, index or trigger change. Script runs
  locally against the deployed function (same as the price repair script).

**Test plan (write first)**
- Plan as admin returns manifest rows from MIU-6 with `nextAfterId`.
- Apply as admin returns per-row outcomes; as contributor → `FORBIDDEN`, no write.
- Script dry run (mocked fetch) writes a manifest file and makes no apply call.

**Done when**
- Tests pass; `pnpm typecheck`; `pnpm package:functions && pnpm smoke:functions`.

### MIU-8: public list / item / slug projection reads the one version

```
Block:      BACKEND
Files:      apps/functions/public-api/src/handler.ts
            apps/functions/public-api/src/http-adapter.ts   (one-line field move)
            apps/functions/public-api/src/http-adapter.test.ts
Type:       modify-existing
Depends on: MIU-3, MIU-5
```

**What it does**
- Move `enableCatalogDetail?: boolean` from `PublicHttpConfig`
  (`http-adapter.ts:27`) to `PublicApiConfig` (`handler.ts:42-51`).
  `PublicHttpConfig extends PublicApiConfig`, and the same config object is
  already passed to `listCatalog` / `getCatalogItem` / `getCatalogItemBySlug`
  (`http-adapter.ts:367, 378, 389`), so no other wiring changes.
- In `publicDoc` (`handler.ts:296-341`), call
  `resolvePublicVersion(doc, { detailEnabled: config.enableCatalogDetail === true })`.
- `approved` →
  - `name` = `header.name`
  - `images` = `header.images` made absolute exactly like today's row images
    (`apiBaseUrl` + path, ≤9, `handler.ts:128-140`)
  - `description` = `header.descriptionText` (omit if absent)
  - `priceSummary` = `publication.priceSummary` (new allowlisted key)
  - `moq` = the summary's MOQ (first tier `minimumQuantity` or
    `minimumOrderQuantity`), omitted if unknown
  - **omit** `alibabaCatalogPricing`, `unitPrice`, `wholesalePrice`,
    `manualCatalogPricing` (sync and row prices must not reach the card)
  - **omit** the Alibaba markers `alibabaPrimarySourceKey`, `alibabaSourceStatus`,
    `alibabaSourceLastSyncedAt` (DEC-14).
- Row `variants` are attached **outside** `publicDoc`: `attachVariants`
  (`handler.ts:257-284`) is called from `listCatalog` (`:409, :416`) and
  `withVariants` (`:459-466`). Both call sites must skip approved items. Keep
  `publicDoc(doc, config): CollectionDoc` unchanged in signature (it is imported by
  public-api `handler.test.ts`, local-server `catalog-manual-price-publication.test.ts`
  and alibaba-catalog-sync `pricing-repair*.test.ts`) and add a wrapper
  `publicItem(doc, config) → { doc, kind: 'approved' | 'row' }` for the two call
  sites. The site never
  renders list `variants` (checked by grep).
- `row` (not yet approved) → today's projection, byte-identical.
- Applies to `listCatalog` (`handler.ts:348-422`), item (`:424-439`) and slug
  (`:441-456`) because all three use `publicDoc`. Filters, sort, paging, search and
  `attachVariants` unchanged.

**Build/Deploy/Runtime impact**
- Public function response shape gains `priceSummary` and loses row price keys for
  approved products. The site must ship MIU-11/12 in the **same** deploy (Deploy
  Test deploys site and functions together). Old cached site bundles ignore
  `priceSummary` and show "Request a quote" for those cards until reload — accepted.
- `scripts/smoke-cloudbase-deploy.mjs` checks (`productFamily`, `images` ≤9,
  forbidden keys) still hold; run it after deploy.
- No index or query change.

**Test plan (write first)**
- Approved linked product: list item has `name/images/description` from the header,
  `priceSummary` equal to the stored one, and **no** `alibabaCatalogPricing`,
  `unitPrice`, `wholesalePrice`, `manualCatalogPricing`.
- Same product with `enableCatalogDetail: false` → today's row projection.
- **Parity:** an approved synced product and an approved manual product built
  from the same optional fixture fields (e.g. both with `series`, both without
  `modType`) produce identical key sets, and neither has any `alibaba*` key or
  `variants`. (Real products may still differ in optional row fields such as
  series, model, type or product code — allowed by DEC-14.)
- Manual product not yet approved → byte-identical to today
  (`http-adapter.test.ts:459` allowlist test unchanged).
- Images: absolute URLs, ≤9, header order.
- Item and slug endpoints return the same projection as the list for the same product.

**Done when**
- Updated public-api tests pass (`http-adapter.test.ts`; existing
  `handler.test.ts` and `catalog-variants.test.ts` stay green).
- `pnpm typecheck`, `pnpm package:functions && pnpm smoke:functions` pass.

### MIU-9: product page endpoint uses the shared rule

```
Block:      BACKEND
Files:      apps/functions/public-api/src/catalog-detail.ts
            apps/functions/public-api/src/catalog-detail.test.ts   (new; today the
            endpoint is only covered through apps/local-server tests)
Type:       modify-existing + new-test
Depends on: MIU-5
```

**What it does**
- `getProductDetail` replaces its own publication check (`catalog-detail.ts:38-41`)
  with `resolvePublicVersion(product, { detailEnabled: true })` (the route exists
  only when the feature is on). `row` → `NOT_FOUND 'Detail not available'`, which
  sends the site to the legacy page that reads the same row as the card (temporary
  fallback for products not yet approved).
- The check is the same function the list uses, so list and page can never pick
  different versions.
- Everything after the check (variant paging, revision checks, decode) unchanged.

**Build/Deploy/Runtime impact**
- Public function only. Today's behaviour is unchanged for every live product (the
  existing check already ignores the link); the change makes the rule shared.

**Test plan (write first)**
- Linked approved product → same response as today (snapshot).
- Approved manual product (zero configurations, website price) → full detail
  response with `variants.total === 0` and the header's `websitePricing`.
- Manual product not yet approved → `NOT_FOUND` as today.

**Done when**
- Tests pass, including `apps/local-server/src/catalog-detail-staging.test.ts`;
  `pnpm typecheck`; `pnpm package:functions && pnpm smoke:functions`.

### MIU-10: quote request uses the shared rule

```
Block:      BACKEND
Files:      packages/db/src/catalog-quote.ts
            packages/db/src/catalog-quote.test.ts
Type:       modify-existing
Depends on: MIU-5
```

**What it does**
- Replace the publication parse at `catalog-quote.ts:37-45` with
  `resolvePublicVersion(product, { detailEnabled: true })`; `row` → the existing
  "not available" failure. The snapshot (`header.name`, `header.images`,
  `header.offers`, `header.websitePricing`, selected SKU) is unchanged.
- Add `priceSummary` to the stored snapshot only if the inquiry schema already
  allows extra keys; otherwise leave the snapshot as is (no schema change here).

**Build/Deploy/Runtime impact**
- `packages/db` bundled into public-api / admin functions. No storage change.

**Test plan (write first)**
- Approved linked product + valid SKU → record created with the same snapshot as today.
- Approved manual product, no configuration selected (customization intent) →
  record created with the header snapshot and `websitePricing`.
- Product not yet approved → failure, no record written.

**Done when**
- Tests pass; `pnpm typecheck`; `pnpm package:functions && pnpm smoke:functions`.

### MIU-11: site list decoder and `Product` type accept `priceSummary`

```
Block:      FRONTEND
Files:      apps/site/src/islands/shop/catalog-types.ts
            apps/site/src/islands/shop/api.ts
            apps/site/src/islands/shop/api.test.ts
Type:       modify-existing
Depends on: MIU-3 (contract: packages/shared/src/catalog/price-summary.ts)
```

> **As built** (EXECUTION_LOG): `Product.priceSummary` is typed `unknown`; the helper `readPriceSummary` lives in `catalog-pricing.ts`; `api.ts` needed no change.

**What it does**
- `Product` (`catalog-types.ts:45-77`) gains `priceSummary?: CatalogPriceSummary`
  (type imported from the MIU-3 contract).
- `isProduct` (`api.ts:152-209`) is a boolean type guard used in three places
  (`:215, :288, :313`) and cannot strip keys. So it does **not** check
  `priceSummary` at all: a bad summary can never fail the whole page
  (`isCatalogPage`, `api.ts:211-220`).
- New helper `readPriceSummary(product) → CatalogPriceSummary | undefined`, in
  `catalog-types.ts` (not `api.ts`: `api.ts` already imports `catalog-pricing.ts`,
  which will use the helper, so placing it in `api.ts` would create a cycle). It runs
  `CatalogPriceSummarySchema.safeParse` at use time; an invalid summary reads as
  absent. MIU-12 and MIU-13 read the summary only through this helper.

**Build/Deploy/Runtime impact**
- Site bundle only. Ships in the same deploy as MIU-8.

**Test plan (write first)**
- Valid summary → `readPriceSummary` returns it.
- Malformed summary (unknown key / bad pricing) → page still decodes;
  `readPriceSummary` returns `undefined`.
- Product without summary → unchanged behaviour.

**Done when**
- Tests pass; `pnpm typecheck`; `pnpm build`.

### MIU-12: card price and MOQ read the summary

```
Block:      FRONTEND
Files:      apps/site/src/islands/shop/EffectiveCatalogPricingBlock.tsx
            apps/site/src/islands/shop/catalog-pricing.ts
            apps/site/src/islands/shop/catalog-family-render.test.ts
Type:       modify-existing
Depends on: MIU-11
```

> **As built** (EXECUTION_LOG): `lowestOrderableAmountMinor` and `priceSummaryMoq` are shared exports of `price-summary.ts`, also used by the public API's `moq`. Batch 3 review: an equal-ended range shows one price; the row-page price block also shows the summary.

**What it does**
- `effectiveCatalogPriceSummary` and `effectiveCatalogMoq`
  (`EffectiveCatalogPricingBlock.tsx:11-22`, `catalog-pricing.ts:15-22`): when
  `readPriceSummary(product)` (MIU-11) returns a summary it is the only price
  input. Card text:
  - tiered → "From <lowest tier>"
  - fixed → the amount
  - range → "From <min>"
  - unavailable / negotiable (MOQ-only, DEC-16) → the existing quote label
  - MOQ from the summary
- USD/CNY use the existing card formatter ("$7.67"); any other currency uses the
  product page formatter (`formatCatalogQuoteAmount`, "EUR 7.67").
- No `priceSummary` → today's row logic (manual products), unchanged.

**Build/Deploy/Runtime impact**
- Site bundle only; same deploy as MIU-8.

**Test plan (write first)**
- Summary tiered 130/122/120 USD → card shows "From $1.20" and MOQ 10.
- Summary fixed EUR 1200 → "EUR 12.00".
- Product with summary **and** stale `alibabaCatalogPricing` (old cached API) →
  summary wins.
- Approved manual product (summary `source: 'website'`, tiers 118.31…) and approved
  synced product with the same summary → identical card markup.
- Product not yet approved (row fallback, no summary) → existing
  `catalog-family-render.test.ts:137,254` expectations unchanged.

**Done when**
- Tests pass; `pnpm typecheck`; `pnpm build`.

### MIU-13: hub "featured" strip shows the effective MOQ

```
Block:      FRONTEND
Files:      apps/site/src/islands/shop/FeaturedProducts.tsx
            apps/site/src/islands/shop/featured-products.test.ts (new, or the existing render test)
Type:       modify-existing
Depends on: MIU-12
```

> **As built** (EXECUTION_LOG): the card markup moved into an exported `FeaturedProductCard` for testing; `featured-products.test.ts` is new.

**What it does**
- Replace the raw `product.moq` read (`FeaturedProducts.tsx:105-108`) with
  `effectiveCatalogMoq(product)` (MIU-12) so the hub matches the card.
- The strip still shows no price (unchanged); only the MOQ source changes. Products
  without any MOQ keep rendering no MOQ line.

**Build/Deploy/Runtime impact**
- Site bundle only.

**Test plan (write first)**
- Approved product (payload `moq` already taken from the summary by MIU-8, e.g.
  10) with a summary MOQ 10 → strip shows 10.
- Product on the row fallback with manual tiers starting at 20 and row `moq` 2 →
  strip shows 20 (effective MOQ, as the card does), not the raw 2.

**Done when**
- Tests pass; `pnpm typecheck`; `pnpm build`.

### MIU-14: e2e — configuration switch changes the price; card matches page

```
Block:      TESTING
Files:      tests/e2e/sku-detail.spec.ts
Type:       modify-existing
Depends on: MIU-8, MIU-12
```

> **As built** (EXECUTION_LOG): a separate test opens the product from its card on `/toys/` and fails on any unmocked API call.

**What it does**
- `sku-detail.spec.ts:836-870` already asserts per-configuration tiers and the
  White fallback in one scenario; extend that file rather than duplicating it.
- Mocked-API test: product with SKU "Black" (tiers 2–99 $6.61, 100–999 $5.55,
  ≥1,000 $4.76) and SKU "White" (≥1,000 $4.30). Selecting each configuration shows
  that configuration's own tiers in `[data-price-tier]`.
- Card test: list item with `priceSummary` from "White" → card shows "From $4.30";
  opening the product shows the cheapest configuration's price when it is selected.

**Build/Deploy/Runtime impact**
- Test only. Runs in the existing e2e lane against a local or deployed site.

**Test plan (this MIU is the test)**
- `[data-price-tier]` texts equal Black's three tiers after selecting Black, and
  `['USD 4.30 ≥1,000 pieces']` after selecting White.
- Card text contains "From $4.30".

**Done when**
- `pnpm exec playwright test tests/e2e/sku-detail.spec.ts --project=chromium`
  passes locally (with `NODE_OPTIONS=--no-experimental-webstorage` on Node 25).
- All existing `sku-detail.spec.ts` scenarios stay green; `pnpm typecheck` (e2e
  project) passes.

---

## PT-C — Changed products are flagged and approved in one action

### MIU-15: `alibabaReviewReason` field and identity rules

```
Block:      BACKEND (shared contract + db)
Files:      packages/shared/src/collections.ts
            packages/db/src/alibaba-product-identity.ts
            packages/shared/src/alibaba-collections.test.ts
Type:       modify-existing
Depends on: none
```

**What it does**
- New read-only product field
  `alibabaReviewReason: 'new' | 'changed' | 'removed' | 'edited' | null`
  (`'edited'`: a contributor's save on a published product, OWN-1, MIU-37)
  next to `alibabaReviewPending` (`collections.ts:439-445`), in the pinned field
  list (`alibaba-collections.test.ts:77-91`).
- `alibaba-product-identity.ts`: add to `writableFields` / `clearedFields`
  (`:86-114`); create-draft sets `alibabaReviewReason: 'new'` with
  `alibabaReviewPending: true` (`:326`); `reconciliationPatch` (`:130-139`) sets
  `'new'` only when it sets pending `true`, `null` when `false`; unlink clears it.
- No index (the list is not sorted or filtered by reason).

**Build/Deploy/Runtime impact**
- Shared + db packages (site, functions). Existing rows have no reason: treated as
  `'new'` when `alibabaReviewPending === true` (absent field is a state —
  `docs/ENGINEERING_CRAFT.md`).

**Test plan (write first)**
- Field list test includes `alibabaReviewReason` as read-only; a generic write of
  it is rejected.
- Create-draft → `{alibabaReviewPending: true, alibabaReviewReason: 'new'}`.
- Unlink → both cleared to `null`.

**Done when**
- Tests pass; `pnpm typecheck`; `pnpm package:functions && pnpm smoke:functions`.

### MIU-16: `publicSourceDigest` — stable hash of what a buyer would see

```
Block:      BACKEND (shared contract)
Files:      packages/shared/src/catalog/public-source-digest.ts        (new)
            packages/shared/src/catalog/public-source-digest.test.ts   (new)
            packages/shared/package.json   (new export entry)
Type:       new-file + modify-existing
Depends on: none
```

> **As built** (EXECUTION_LOG): each SKU's own photos are hashed too (DEC-6 counts photos); the parity test lives in `catalog-import`. See DEC-18 (proposed) on what should count.

**What it does**
- `publicSourceDigest(observation: PublicSourceDigestInput) → string` (sha256 hex).
  `PublicSourceDigestInput` is a structural type defined here (the
  `catalog-import` observation satisfies it; `packages/db` depends only on
  `shared`, so the helper cannot live in `catalog-import`).
- Canonical JSON over DEC-6 content only:
  - each SKU (by `sourceVariantKey`): option name/value pairs and offer `pricing`
  - the product-level offer pricing
  - ordered media `sourceUrl`s
  - identity attributes
  - trimmed description text
- Excludes: `observedAt`, `captureMode`, evidence/payload ids, inventory/stock,
  `sourceUpdatedAt`, pricing `syncedAt`, title.

**Build/Deploy/Runtime impact**
- Shared package. It is the first file in `shared` to use `node:crypto`, so it
  gets its own export entry `./catalog-source-digest` in
  `packages/shared/package.json` and is never re-exported from a module the site
  imports (`./catalog`, `./catalog-detail`). Consumers: `packages/db` (MIU-17),
  the sync function (MIU-19) and the admin function (MIU-38), all server-side.
- The helper picks fields explicitly (never hashes a whole object), because the
  db path hashes the stored observation and the sync path hashes the
  `validateCatalogSourceObservation` result (`linking.ts:297-310`); extra or
  defaulted keys must not change the digest.

**Test plan (write first)**
- Same observation with different `observedAt`, `captureMode`, stock and
  `syncedAt` → identical digest.
- One SKU tier amount changed → different digest.
- SKU added / option value changed / media order changed → different digest.
- Title changed → identical digest.
- Parity: one stored observation hashed raw and after
  `validateCatalogSourceObservation` → identical digest (otherwise every product
  would be flagged "changed" on its first sync).

**Done when**
- Tests pass; `pnpm typecheck`; `pnpm package:functions && pnpm smoke:functions`.

### MIU-17: prepare records the source digest of the candidate it builds

```
Block:      BACKEND
Files:      packages/db/src/catalog-source-staging.ts
            packages/db/src/catalog-source-staging.test.ts
Type:       modify-existing
Depends on: MIU-16
```

**What it does**
- Where prepare reads the observation in the transaction
  (`catalog-source-staging.ts:66-72`) and writes `detailSourceReady` /
  `detailSourceCandidate` (`:136-137`), also write
  `detailSourcePublicDigest = publicSourceDigest(observed.observation)`.
- Field is internal (not projected publicly; add to the read-only admin field list
  if the collection registry requires it).

**Build/Deploy/Runtime impact**
- db package; one extra field on `products`. No index.

**Test plan (write first)**
- Prepare → product has `detailSourcePublicDigest` equal to
  `publicSourceDigest(observation)`.
- Re-prepare after a price change in the observation → digest changes.

**Done when**
- Tests pass; `pnpm typecheck`.

### MIU-18: approval receipt carries the source digest

```
Block:      BACKEND
Files:      packages/db/src/catalog-detail-staging.ts
            packages/db/src/catalog-detail-staging.test.ts
Type:       modify-existing
Depends on: MIU-17
```

**What it does**
- `prepareStagedApproval` copies the product's `detailSourcePublicDigest` into the
  job (extend strict `JobSchema`, `catalog-detail-staging.ts:25-42`).
- `finishStagedApproval` writes it into `catalogDetailApprovalReceipt.sourceDigest`
  (receipt at `:346-358`). The existing product fingerprint check already
  guarantees the candidate did not change between prepare and finish.
- Missing digest (product prepared before MIU-17) → receipt without `sourceDigest`
  (handled by the MIU-22 audit).

**Build/Deploy/Runtime impact**
- db package; receipt grows by one string. In-flight jobs created before deploy lack
  the key → still valid (optional).

**Test plan (write first)**
- begin → page → finish → receipt `sourceDigest` equals the product's
  `detailSourcePublicDigest` at prepare.
- Job created without a digest → finish succeeds, receipt has no `sourceDigest`.

**Done when**
- Tests pass; `pnpm typecheck`; `pnpm package:functions && pnpm smoke:functions`.

### MIU-19: sync promote step flags "changed" / "removed"

```
Block:      BACKEND
Files:      apps/functions/alibaba-catalog-sync/src/promotion.ts
            packages/db/src/alibaba-product-identity.ts
            apps/functions/alibaba-catalog-sync/src/promotion.test.ts
Type:       modify-existing
Depends on: MIU-15, MIU-16, MIU-18
```

**What it does**
- In `promoteLinkedProduct` (`promotion.ts:68-168`), compute
  `publicSourceDigest(observation)` (observation already loaded) and pass it to the
  fenced promote mutation.
- In the promote transaction (`alibaba-product-identity.ts:473-516`), re-read the
  product. If it has `catalogDetailApprovalReceipt.sourceDigest`, is not archived,
  and either the digest differs **or** the source is inactive → set
  `alibabaReviewPending: true` and `alibabaReviewReason` to `'changed'` or
  `'removed'`.
- Never clears a pending flag. Never touches `catalogDetailPublication`.

**Build/Deploy/Runtime impact**
- Sync function + db package. One extra read-free comparison inside an existing
  transaction (no extra operations against the 100-op limit beyond the existing
  product read). "Removed" only fires on full runs; the timer is off (DESIGN §9).

**Test plan (write first)**
- Receipt digest D1, observation digest D2 → product flagged
  `{pending: true, reason: 'changed'}`.
- Same digest → no flag change (assert the update has no review fields).
- Inactive source with receipt → `reason: 'removed'`.
- No receipt digest → no flag (audit handles it).
- Archived product → no flag.

**Done when**
- Tests pass; `apps/functions/alibaba-catalog-sync` tests pass; `pnpm typecheck`;
  `pnpm package:functions && pnpm smoke:functions`.

### MIU-20: quarantine approval uses the same flag rule; keep "never resurrect as New", add the "changed" rule

```
Block:      BACKEND
Files:      apps/functions/alibaba-catalog-sync/src/quarantine.ts
            apps/functions/alibaba-catalog-sync/src/linking.test.ts
            docs/alibaba-linked-catalog-sync/NEW-PRODUCT-REVIEW-QUEUE-MIU-2026-09-04.md
Type:       modify-existing
Depends on: MIU-19
```

**What it does**
- Quarantine approval builds its own promote patch (`quarantine.ts:136-210`); route
  it through the same digest comparison and pass the digest to the promote mutation.
- `linking.test.ts:731-748` pins "a draft retry never reopens a product an admin
  already reviewed"; the review-queue doc (`NEW-PRODUCT-REVIEW-QUEUE-MIU-2026-09-04.md:37`)
  states the broader "never resurrect as New" rule. Keep both for **New** (nothing
  sets reason `'new'` on a reviewed product), and add the new rule: a sync whose
  digest differs from the approved one sets `'changed'`.
- Add a dated note to the review-queue doc pointing to this design.

**Build/Deploy/Runtime impact**
- Sync function only.

**Test plan (write first)**
- Quarantined candidate approved with a changed digest → `reason: 'changed'`.
- Refresh of a reviewed product with an unchanged digest → stays
  `{pending: false}`.

**Done when**
- Tests pass; `pnpm typecheck`; `pnpm package:functions && pnpm smoke:functions`.

### MIU-21: approving or acknowledging clears the reason

```
Block:      BACKEND
Files:      apps/functions/admin/src/handler.ts
            packages/db/src/adapter.ts
            apps/functions/admin/src/handler.test.ts
Type:       modify-existing
Depends on: MIU-15
```

**What it does**
- `acknowledgeAlibabaProductReview` (`handler.ts:1468-1510`) writes
  `alibabaReviewReason: null` with `alibabaReviewPending: false`.
- `markProductReviewed` (`handler.ts:1532-1551`) is allowed only when the reason is
  `'new'` or absent (DEC-11); for `'changed'` / `'removed'` / `'edited'` it returns
  `CONFLICT 'Review and publish the supplier changes, or archive the product.'`
- Clearing rule (DEC-11): the flag clears on **publish** and **archive** (the
  existing acknowledge triggers, `handler.ts:1929-1938, 1956-1957`) and **never on
  unpublish**. Pin this with a test so a later change cannot add unpublish as a
  trigger.
- `adapter.ts:190-201` no-op strip treats the reason like the reviewer fields
  (already-reviewed rows stay idempotent).
- `rejectPendingReview` (`adapter.ts:179-184`) unchanged: it already stops
  publishing a product that became pending meanwhile.

**Build/Deploy/Runtime impact**
- Admin function + db package.

**Test plan (write first)**
- Publish of a `'changed'` product through the update path → pending `false`,
  reason `null`.
- Unpublish (`published: false`) of a `'changed'` product → pending stays `true`,
  reason stays `'changed'`.
- Archive of a `'changed'` product → pending `false`, reason `null`.
- Mark reviewed on `'new'` → cleared; on `'changed'` → `CONFLICT`, no write.
- Re-acknowledging an already-reviewed product → unchanged row (idempotent).

**Done when**
- Tests pass; `pnpm typecheck`; `pnpm package:functions && pnpm smoke:functions`.

### MIU-22: `change-audit-mark` db command (writes for the one-time audit)

```
Block:      BACKEND
Files:      packages/db/src/catalog-change-audit-store.ts        (new)
            packages/db/src/catalog-change-audit-store.test.ts   (new)
            packages/db/src/catalog-detail-staging.ts
Type:       new-file + modify-existing
Depends on: MIU-15, MIU-18
```

> **As built** (EXECUTION_LOG): also skips archived products; the "unchanged needs a digest" rule is checked in the command (a refined schema cannot join the persistence union).

**What it does**
- New persistence command
  `{action: 'change-audit-mark', productId, revision, outcome: 'unchanged' | 'changed', sourceDigest?}`
  in `PersistenceCommandSchema` and its dispatch (`catalog-detail-staging.ts:64-75, 372`).
  The db adapter has no generic transaction; this follows the existing command
  pattern.
- One transaction: re-read the product; require the same publication `revision`
  and no existing receipt `sourceDigest` (else skipped, no write).
  - `unchanged` → write the row back with receipt `sourceDigest` set.
  - `changed` → write it back with `alibabaReviewPending: true`,
    `alibabaReviewReason: 'changed'`.
- Result: the same `{ ok: true, backfill: 'applied' | 'skipped', reason? }` shape
  added in MIU-6 (reuse it; reasons extended with this command's skip reasons).

**Build/Deploy/Runtime impact**
- db package; admin function. No index; no new SDK surface.

**Test plan (write first)**
- `unchanged` → stored row equals the previous row except receipt `sourceDigest`.
- `changed` → only the two review fields differ.
- Revision changed / digest already present → skipped, no write.

**Done when**
- Tests pass; `pnpm typecheck`; `pnpm package:functions && pnpm smoke:functions`.

### MIU-38: admin action `auditChangesSinceApproval` (plan / apply)

```
Block:      BACKEND
Files:      apps/functions/admin/src/catalog-change-audit.ts        (new)
            apps/functions/admin/src/catalog-change-audit.test.ts   (new)
            apps/functions/admin/src/handler.ts
Type:       new-file + modify-existing
Depends on: MIU-16, MIU-22
```

> **As built** (EXECUTION_LOG): apply re-plans each row on the server and takes the digest from there (stricter than the spec); operator script `scripts/catalog-change-audit.mjs`.

**What it does**
- Admin-only action `auditChangesSinceApproval { mode: 'plan' | 'apply', afterId? }`
  for linked, non-archived products that have an approved version but no receipt
  `sourceDigest`.
- Plan: read the current observation; build the candidate in memory with
  `buildCatalogDetailCandidate` (no staging writes); compare with the approved
  version on DEC-6 content that both sides express:
  - per-SKU offer pricing and option values
  - SKU set
  - facts
  - description text
  - product-level offers (`header.offers`): an approval from before batch 1 can
    hold the retired wholesale headline there, and the card's summary rule 3
    would show it (batch 3 review #7)
  - **Not compared:** images, because approved rows hold image IDs and the source
    holds URLs.

  Manifest row: `{productId, revision, outcome: 'unchanged' | 'changed', diffSummary}`.
- Apply: send each reviewed manifest row to the MIU-22 command (`unchanged` with
  `sourceDigest = publicSourceDigest(observation)` as the baseline, or `changed`).

**Build/Deploy/Runtime impact**
- Admin function (depends on `catalog-import` and `shared`, already dependencies).
  Paged ≤20 products per call; no index change.

**Test plan (write first)**
- Approved SKU tiers = `unavailable`, observation SKU tiers = 130/122/120 →
  `changed` with a diff naming the SKU.
- Identical pricing/options → `unchanged`; apply writes only the receipt digest.
- Revision changed between plan and apply → skipped, no write.
- Contributor role → `FORBIDDEN`.

**Done when**
- Tests pass; `pnpm typecheck`; `pnpm package:functions && pnpm smoke:functions`.

### MIU-23: admin badge and preview chip show the reason

```
Block:      FRONTEND
Files:      apps/site/src/islands/admin/CollectionView.tsx
            apps/site/src/islands/admin/PreviewModal.tsx
            apps/site/src/islands/admin/review-badge.test.ts   (new, or existing admin render test)
Type:       modify-existing
Depends on: MIU-15
```

**What it does**
- `ProductThumbnail` badge (`CollectionView.tsx:1154-1161`) text by reason:
  - `'new'` or absent → "New"
  - `'changed'` → "Changed"
  - `'removed'` → "Removed"
  - `'edited'` → "Edited" (contributor draft waiting for an admin, OWN-1)

  Same amber style.
- Category tab markers (`CollectionView.tsx:529,537`) read "• Needs review" instead
  of "• New" (counts unchanged: they count `alibabaReviewPending`).
- `PreviewModal` chip (`:135-139`) shows the same text; "Mark reviewed"
  (`:334-342`) renders only for `'new'` / absent.

**Build/Deploy/Runtime impact**
- Site (admin island) bundle only.

**Test plan (write first)**
- Badge renders "Changed" for `{pending: true, reason: 'changed'}`, "New" for
  `{pending: true}` without reason, nothing for `{pending: false}`.
- Mark reviewed button absent for `'changed'`, present for `'new'`.

**Done when**
- Tests pass; `pnpm typecheck`; `pnpm build`.

### MIU-24: "Approve changes" for a flagged, already-published product

```
Block:      FRONTEND
Files:      apps/site/src/islands/admin/PreviewModal.tsx
            apps/site/src/islands/admin/CollectionView.tsx
            apps/site/src/islands/admin/catalog-detail-approval-api.test.ts
Type:       modify-existing
Depends on: MIU-21, MIU-23
```

> **As built** (EXECUTION_LOG): no before/after price diff; a "Compare with the live page" link sits next to the button instead. The button reuses `updateRecord(…, {published: true})`, whose call order is tested in `catalog-detail-approval-api.test.ts`; the button test checks the wiring.

**What it does**
- In the preview of a product with `published === true` and reason
  `'changed'` / `'removed'` / `'edited'`, show **"Approve changes"**. It calls the existing
  `updateRecord(..., { published: true })` (`apps/site/src/islands/admin/api.ts:258-377`),
  which already runs prepare → begin/page/finish → publish and, on the server,
  clears the flag (MIU-21).
- For `'removed'`, the modal also offers **Unpublish** (existing update with
  `published: false`).
- Show the per-SKU price difference from the preview data next to the button, so
  the admin sees what they are approving.

**Build/Deploy/Runtime impact**
- Admin island bundle only; no new endpoint.

**Test plan (write first)**
- Clicking "Approve changes" calls the approval sequence once and then the publish
  update (assert call order with mocked API).
- Button absent for unflagged or unpublished products (Publish covers those).

**Done when**
- Tests pass; `pnpm typecheck`; `pnpm build`; local admin e2e `pnpm test:e2e:catalog-admin-local`
  passes.

### MIU-25: edit form shows pending Alibaba changes before Save (DEC-12, confirmed 2026-10-08)

```
Block:      FRONTEND
Files:      apps/site/src/islands/admin/RecordForm.tsx
            apps/site/src/islands/admin/PreviewModal.tsx
            apps/site/src/islands/admin/review-badge.test.ts
Type:       modify-existing
Depends on: MIU-15, MIU-23
```

**What it does** (DEC-12)
- Save keeps today's behaviour: on an already-published Alibaba product the edit
  form's Save runs the approval sequence in `updateRecord` (`api.ts:283-367`) and
  the product stays live with its latest data. No unpublish, no extra step.
- When the product is flagged `'changed'` / `'removed'`, the form shows a notice
  directly above Save (`RecordForm.tsx:581`): "Alibaba data changed since the
  last approval. Saving publishes these changes too." with a "See changes" button
  that opens the preview (`PreviewModal`, which shows the per-configuration
  differences from MIU-24).
- After a successful Save the flag is cleared by the server (MIU-21); the notice
  disappears.
- `updateRecord` itself is unchanged by this MIU.

**Build/Deploy/Runtime impact**
- Admin island bundle only. No endpoint change.

**Test plan (write first)**
- Form for a published product with `{pending: true, reason: 'changed'}` → notice
  and "See changes" render above Save.
- Form for an unflagged product, or a `'new'` draft → no notice.
- Clicking "See changes" opens the preview for that product.

**Done when**
- Tests pass; `pnpm typecheck`; `pnpm build`.
- `pnpm test:e2e:catalog-admin-local` passes.

### MIU-35: batch "Assign category" confirms before publishing pending changes (DEC-12, confirmed 2026-10-08)

> **As built** (EXECUTION_LOG): the confirmation sits on the batch bar's
> **Publish**, not on "Assign category". The component named below is no longer
> used; bulk classification publishes drafts only and cannot change a live
> product's family, so batch Publish is the one batch path that re-approves live
> products.

```
Block:      FRONTEND
Files:      apps/site/src/islands/admin/BatchCategoryAssignment.tsx
            apps/site/src/islands/admin/CollectionView.tsx
            apps/site/src/islands/admin/product-batch-update.test.ts
Type:       modify-existing
Depends on: MIU-15
```

**What it does** (DEC-12)
- The batch family bar (`BatchCategoryAssignment.tsx` → `batchUpdateRecords` →
  `updateRecord`, which re-approves published Alibaba products from their latest
  data, `api.ts:264-276`) shows no product details, so it is the one place an
  admin could publish Alibaba changes without seeing them.
- Before calling `batchUpdateRecords`, if any selected published product is
  flagged `'changed'` / `'removed'`, show a confirmation listing those products:
  "Assigning a category also publishes their pending Alibaba changes."
  - **Continue** — all selected products.
  - **Skip those** — only the unflagged ones; the flagged ones are listed as
    skipped in `BatchUpdateFeedback`.
- No flagged products → no dialog, today's behaviour.

**Build/Deploy/Runtime impact**
- Admin island bundle only.

**Test plan (write first)**
- Selection with one flagged published product → dialog lists it; Continue sends
  all ids; Skip sends the others and reports the skipped one.
- Selection without flagged products → no dialog, `batchUpdateRecords` called
  once with all ids (`product-batch-update.test.ts:107-150` unchanged).

**Done when**
- Tests pass; `pnpm typecheck`; `pnpm build`.
- `pnpm test:e2e:catalog-admin-local` passes.

### MIU-39: approval takes the supplier's new description and photos unless an admin changed them (DEC-18)

```
Block:      BACKEND + FRONTEND
Files:      packages/db/src/catalog-detail-staging.ts            (receipt baseline)
            packages/shared/src/catalog/detail-approval.ts        (which parts match the supplier)
            apps/functions/admin/src/catalog-supplier-adoption.ts (new: read-only plan)
            apps/functions/admin/src/handler.ts                   (action wiring)
            apps/site/src/islands/admin/api.ts                    (approval flow)
            apps/site/src/islands/admin/PreviewModal.tsx           (one line in the preview)
            + tests next to each
Type:       modify-existing + new
Depends on: MIU-16, MIU-19, MIU-24
```

**Why** (DEC-18, owner 2026-10-08). Approval publishes our own copy of the
description and photos: the product row's `description`, `imageIds` and
`descriptionImageIds` (`detail-approval.ts:143-163`). The sync never changes
those after it creates the draft; it only refreshes the supplier's text (in the
stored observation) and photo links (`alibabaSourceImageUrls`,
`alibabaDescriptionImageUrls`). So today a supplier description or photo change
raises "Changed" (DEC-6), but approving publishes nothing new. The owner wants one
flag on the product and approval to apply everything, including description and
photos. The assumption recorded with the decision: if an admin changed the
description or photos, the admin's version stays.

**Rule.** Three parts are judged separately: description text, main gallery,
description images. At approval, a part is replaced by the supplier's current
version when both hold:
1. at the last approval that part was the supplier's own (recorded baseline, below);
2. it has not been edited since (the row's part equals the approved version's).
Otherwise the row's part is kept. A part that already equals the supplier's
current version needs nothing.

**Baseline.** `finish` records in `catalogDetailApprovalReceipt.supplierParts`
`{ description, gallery, descriptionImages }` (booleans): whether each row part
equalled the supplier's version at this approval. Description: trimmed row text
equals the source `descriptionText` (the same test that keeps the structured
content, `detail-approval.ts:176`). Gallery: the row's `imageIds` equal, in
order, the image ids linked to the source gallery URLs (the `url → imageId` map
`prepareCatalogSource` already builds from `catalogSourceLinks`), at most nine.
Description images: the same with the description image URLs, at most 18.

Approvals made before this MIU have no baseline: description counts as the
supplier's when the approved version kept the structured content (it is kept only
when the texts matched); gallery and description images count as the admin's
(kept). The admin can still re-import the supplier gallery in Edit.

**Flow.** In `updateRecord`'s linked branch, after saving the form's own values
and before `prepareCatalogSource`:
- call the new read-only admin action `planSupplierAdoption(productId)`; it
  returns, for each adoptable part that differs, the supplier text or URLs;
- photos: import through the existing `importAlibabaGallery` (all-or-nothing:
  any failure stops before approval with `MEDIA_NOT_READY`, as today);
- one `update` with the new `description` / `imageIds` / `descriptionImageIds`,
  guarded by the product's `updatedAt`;
- then the approval runs as today, so the approved version and the edit form show
  the same text and photos.
The preview (MIU-24) adds one line when a part will be replaced: "Approving also
updates the description and photos from Alibaba."

**Not changed.** The product name stays the admin's (DEC-6). Manual products have
no supplier and are untouched. The source fingerprint and the one-time audit keep
counting description and photos (DEC-6): approval now publishes them, so the flag
can be resolved.

**Test plan (write first)**
- `finish` writes `supplierParts` true/false per part (each part both ways).
- Plan: adoptable when baseline true and row equals approved; not adoptable when
  the admin edited the text, removed or reordered a photo, or uploaded their own;
  legacy receipts follow the rule above; manual products return nothing;
  contributors get FORBIDDEN.
- `updateRecord`: for a live flagged product calls plan → import → update →
  prepare in that order; an admin-edited description is never overwritten; an
  image import failure stops before any write.
- Approval of a product whose supplier changed only its description publishes the
  new text and keeps the structured content.

**Done when**
- Tests pass; `pnpm typecheck`; `pnpm lint`; `pnpm build`;
  `pnpm package:functions && pnpm smoke:functions`; local admin e2e.
- Ships with batch 4 (before R6/R7).

---

## PT-D — Restore and prove

### MIU-26: `catalog-consistency-audit` script (list vs product page)

```
Block:      TESTING
Files:      scripts/catalog-consistency-audit.mjs        (new)
            scripts/catalog-consistency-audit.test.mjs   (new)
Type:       new-file + new-test
Depends on: MIU-3, MIU-8 (reads the card summary shape and re-applies the
            `derivePriceSummary` rule to the detail)
```

> **As built** (EXECUTION_LOG): reads the unfiltered list once (every family); imports `derivePriceSummary` instead of copying it; also compares the MOQ and rejects row price fields on approved cards; only "Detail not available" counts as fallback. Run with `node --experimental-strip-types … --api https://API-ORIGIN`.

**What it does**
- `node scripts/catalog-consistency-audit.mjs --api <public api base>` reads every
  family list page, then each product's detail (bounded concurrency 8).
- For approved products it compares:
  - name
  - main photo id
  - card price summary vs the price derived from the detail with the same rule as
    `derivePriceSummary`
- Reports products with no detail (not yet approved, served from the row fallback)
  separately, with their IDs; `--require-no-fallback` makes a non-zero count fail
  (used in R10 once all manual products are approved).
- Exits 1 on any mismatch; prints counts and the first 20 mismatches. Read-only.

**Build/Deploy/Runtime impact**
- Script only (`node:test` like other `scripts/*.test.mjs`, run by
  `pnpm test:deploy-smoke`). Not part of deploy.

**Test plan (write first)**
- Fixture where list and detail agree → exit 0.
- Fixture with a price mismatch → exit 1 and the product named.
- Detail 404 for a not-yet-approved product → counted as fallback, not a mismatch;
  with `--require-no-fallback` → exit 1.
- Parity: for a fixture detail, the script's price equals `derivePriceSummary`'s
  result (imported from the shared package).

**Done when**
- `pnpm test:deploy-smoke` passes.
- Run against the local server with seeded products, the script exits 0 and prints
  the expected product count.

---

## PT-E — Manual products are first-class approved versions (DEC-4, DEC-14–16)

### MIU-27: manual draft, spec facts and MOQ-only price in the approval planner

```
Block:      BACKEND (shared contract)
Files:      packages/shared/src/catalog/manual-detail.ts        (new)
            packages/shared/src/catalog/manual-detail.test.ts   (new)
            packages/shared/src/catalog/detail-approval.ts
Type:       new-file + modify-existing
Depends on: MIU-4
```

**What it does**
- `manualDetailCandidate(product) → CatalogDetailHeader` stub:
  `{schemaVersion: 'catalog-product-detail-v1', _id, name, images: [], facts: [], offers: []}`.
  The planner already replaces name, images, description and website price from
  the row (`detail-approval.ts:119-138`).
- `manualFacts(product)` → `[{name: 'SKU', value: skuCode}, {name: 'Series', ...},
  {name: 'Model', value: modName}, {name: 'Type', value: modType}]`, trimmed, empty
  values dropped, labels as on the legacy page (`SkuDetailPage.tsx:55-62`).
- `planCatalogDetailApproval`: when `detailSourceOwner` starts with `manual:`,
  `header.facts = manualFacts(product)`. `productInput` (`detail-approval.ts:20-43`)
  accepts optional `skuCode`, `series`, `modName`, `modType`.
- DEC-16: for a `manual:` owner whose manual pricing resolves to `inherit` /
  `empty-manual` and whose row `moq` is a positive integer, `websitePricing` =
  `{basis: 'website-manual', pricing: {mode: 'unavailable', minimumOrderQuantity: moq}}`.
- Invalid manual pricing still throws (approval refused with `VALIDATION_ERROR`,
  `detail-approval.ts:48`).

**Build/Deploy/Runtime impact**
- Shared package (site + functions). Changes the plan for manual owners only;
  linked plans are byte-identical (review digests for linked products unchanged).

**Test plan (write first)**
- Manual tiered pricing → `websitePricing` tiered, `priceSummary.source === 'website'`.
- Scalar price + MOQ 2 → fixed with `minimumOrderQuantity: 2`.
- No price + MOQ 50 → `unavailable` with MOQ 50; no price + no MOQ → no
  `websitePricing`.
- Facts: `series: '  S1 '`, `modName: ''` → `[{SKU…}, {Series: 'S1'}, {Type…}]`.
- Linked owner → facts from the draft, unchanged.

**Done when**
- Tests pass; existing `detail-approval.test.ts` passes; `pnpm typecheck`;
  `pnpm package:functions && pnpm smoke:functions`.

### MIU-28: `manual-source` prepare command (db) and spec fields in the approval fingerprint

```
Block:      BACKEND
Files:      packages/db/src/catalog-manual-staging.ts        (new)
            packages/db/src/catalog-manual-staging.test.ts   (new)
            packages/db/src/catalog-detail-staging.ts
Type:       new-file + modify-existing
Depends on: MIU-27
```

**What it does**
- New persistence command `{action: 'manual-source', productId}` added to
  `PersistenceCommandSchema` and its dispatch (`catalog-detail-staging.ts:64-75, 372`).
- One transaction (3 operations: actor get, product get, product set):
  - actor is an active admin;
  - product exists, not archived, and has **no** `alibabaPrimarySourceKey`;
  - the product has **no** active `productVariants` rows — otherwise refuse with
    "This product has configurations; approving manual configurations is not
    supported yet." (only the not-yet-production Excel import creates them; never
    drop them silently, DESIGN §5.2);
  - writes `detailSourceOwner: 'manual:<id>'`,
    `detailSourceRevision = sourceDigest(['manual', id, 'v1'])`,
    `detailSourceManifest {revision, variantIds: []}`, `detailSourceNextPage: 1`,
    `detailSourceReady: true`, `detailSourceCandidate = manualDetailCandidate(product)`,
    and content / noteBlocks `null`.
- Returns the same strict progress object the Alibaba prepare returns
  (`catalog-detail-approval-api.ts:4-13`):
  `{ok: true, jobId, revision, nextPage: 1, pages: 1, complete: true}`, with
  `jobId` built the same way `stageSourcePage` builds it. The browser's prepare
  loop (`catalog-detail-approval-api.ts:49-61`) then goes straight to review.
- `approvalProductFingerprint` (`catalog-detail-staging.ts:89-114`) adds `skuCode`,
  `series`, `modName`, `modType`, so a spec edit between begin and finish is a
  CONFLICT.

**Build/Deploy/Runtime impact**
- db package (admin function, local server). Uses the existing transaction adapter
  only; no new CloudBase SDK surface (`pnpm verify:cloudbase-sdk` unaffected).

**Test plan (write first)**
- Manual product → all fields above written; the response passes the strict
  `progress` schema with `complete: true`.
- Linked product → refused (wrong owner), nothing written.
- Manual product with one active `productVariants` row → refused with the
  configurations message, nothing written.
- Archived product or contributor actor → refused, nothing written.
- Edit `series` between begin and finish → finish returns CONFLICT.
- Full sequence prepare → review → begin → finish on a manual product produces a
  publication with zero configuration rows.

**Done when**
- Tests pass; `packages/db` and `apps/local-server` tests pass; `pnpm typecheck`;
  `pnpm package:functions && pnpm smoke:functions`.

### MIU-29: publication receipt fingerprint covers spec fields for manual owners

```
Block:      BACKEND
Files:      packages/db/src/catalog-publication-fingerprint.ts
            packages/db/src/catalog-publication-fingerprint.test.ts   (new)
Type:       modify-existing + new-test
Depends on: MIU-28
```

**What it does**
- `publicationContentFingerprint` (`catalog-publication-fingerprint.ts:5-27`) adds
  `skuCode`, `series`, `modName`, `modType` **only when the owner starts with
  `manual:`**, using the file's existing conditional-push pattern (`:23`). The
  publish gate then notices a spec edit made after approval.
- Linked receipts are unchanged, so no existing approval becomes invalid.

**Build/Deploy/Runtime impact**
- db package. No stored data change.

**Test plan (write first)**
- Manual owner: changing `series` changes the fingerprint.
- Linked owner: changing `series` leaves the fingerprint unchanged (snapshot of a
  current receipt still matches).

**Done when**
- Tests pass; `pnpm typecheck`.

### MIU-30: admin `prepareCatalogSource` — manual branch

```
Block:      BACKEND
Files:      apps/functions/admin/src/catalog-detail-source.ts
            apps/functions/admin/src/catalog-detail-source.test.ts   (new)
Type:       modify-existing + new-test
Depends on: MIU-28
```

**What it does**
- Replace the `SOURCE_NOT_READY` early return for products without
  `alibabaPrimarySourceKey` (`catalog-detail-source.ts:27-29`) with
  `persistCatalogDetailApproval({action: 'manual-source', productId})`, returning
  the same response shape as the Alibaba prepare.
- The Alibaba branch is unchanged.

**Build/Deploy/Runtime impact**
- Admin function only.

**Test plan (write first)**
- Manual product → a progress object with `complete: true`; manual command called
  once.
- Linked product → existing Alibaba prepare path, manual command not called.

**Done when**
- Tests pass; `pnpm typecheck`; `pnpm package:functions && pnpm smoke:functions`.

### MIU-31: publish gate for every product on update

```
Block:      BACKEND
Files:      packages/db/src/adapter.ts
            packages/db/src/catalog-product-save-plan.test.ts
            apps/functions/admin/src/handler.ts
Type:       modify-existing
Depends on: MIU-29, MIU-30
```

**What it does** (DEC-15)
- `planCatalogProductSave` (`adapter.ts:236-256`) checks the approval receipt for
  every product, not only Alibaba-linked ones (drop the
  `typeof doc.alibabaPrimarySourceKey === 'string'` condition).
- In `'publication-or-pricing'` mode it checks only when the write **publishes**
  (`data.published === true`), no longer when a price field changes. After batch
  3 every public surface reads the approved version, so a price typed into the
  row of a published product cannot reach buyers before approval. Today the
  price trigger refuses the browser's own "save draft fields first" step
  (`api.ts:289-293`) on published products, so admins must unpublish to change
  a price. Removing it lets the edit form's Save change a price and re-approve in
  one go, for synced and manual products alike.
  `requireDetailApproval === true` (classification assignment) is unchanged.
- A refused publish surfaces as today's `INVALID_PRODUCT` error
  (`catalog-product-identities.ts` ~100); no new error code.
- Only when `CATALOG_DETAIL_APPROVAL_ENABLED === '1'`, as today.
- Create is gated separately (MIU-37).

**Build/Deploy/Runtime impact**
- db package + admin function. **Refuses raw-API publishing** (Hermes, scripts)
  for manual products. Decided (OWN-2): Hermes creates drafts and an admin
  publishes; Hermes's import currently fails per the client and is not
  investigated now, so it is adjusted when that is fixed.
- Must deploy **after** R9 (the 7 live manual products approved), so every
  published product already has an approved version when the gate starts
  applying to manual products.

**Test plan (write first)**
- Manual product, no receipt, `update {published: true}` → refused (`INVALID_PRODUCT`).
- Manual product with matching receipt → published.
- Manual product with receipt, `series` edited, then publish → refused (MIU-29).
- Published product (manual or synced) with a receipt: draft save that changes
  `manualCatalogPricing` without `published` → accepted (row only; public
  version unchanged until approval).

**Done when**
- Tests pass; `pnpm typecheck`; `pnpm package:functions && pnpm smoke:functions`.
- `pnpm test:e2e:catalog-admin-local` re-run (the manual-product e2e from MIU-34
  must still pass with the gate on).

### MIU-37: gate on creating a product that is already published

```
Block:      BACKEND
Files:      apps/functions/admin/src/catalog-product-identities.ts
            apps/functions/admin/src/handler.ts
            apps/functions/admin/src/handler.test.ts
Type:       modify-existing
Depends on: MIU-15, MIU-31
```

**What it does** (DEC-15)
- `createCatalogProductRecord` (`catalog-product-identities.ts:121-126`) gains the
  same `requireDetailApproval` option as the update path. `createAction(req, claims)`
  (`handler.ts:652, 1850-1873`) takes no `config` today (`updateAction` does,
  `:655, 1894`); thread `config` through so it can pass `'publication-or-pricing'`
  when approval is enabled. A new product has no approved version, so `create` with
  `published: true` is refused (`INVALID_PRODUCT`).
- `create` without `published` (a draft) is unchanged.
- The contributor test at `handler.test.ts:1383-1395` ("contributor can
  publish…") is rewritten per OWN-1.
- OWN-1 (decided): in `updateAction` (`handler.ts:1940-1967`) a contributor's
  save on a published product writes the draft fields without `published` and
  sets `alibabaReviewPending: true, alibabaReviewReason: 'edited'`, so an admin
  sees it.

**Build/Deploy/Runtime impact**
- Admin function. Same rollout constraint as MIU-31 (after R9).
- Re-run `pnpm test:e2e:catalog-admin-local` after this MIU.

**Test plan (write first)**
- `create {published: true}` with approval enabled → refused, nothing stored.
- `create` draft → stored unpublished.
- Approval disabled → today's behaviour.
- Contributor save on a published product (OWN-1) → draft fields saved, product
  flagged `'edited'`, public version unchanged.

**Done when**
- Tests pass; `pnpm typecheck`; `pnpm package:functions && pnpm smoke:functions`.

### MIU-32: admin publish flow and preview include manual products

```
Block:      FRONTEND
Files:      apps/site/src/islands/admin/api.ts
            apps/site/src/islands/admin/PreviewModal.tsx
            apps/site/src/islands/admin/catalog-detail-approval-api.test.ts
Type:       modify-existing
Depends on: MIU-30
```

**What it does**
- `updateRecord` (`api.ts:258-377`): the approval branch and the
  `refreshPublishedDetail` save path apply to every product when approval is
  enabled, not only linked ones (`api.ts:271, 283`).
- For manual products: skip the Alibaba gallery and description-image imports
  (`api.ts:299-355`); if `imageIds` is empty, stop before prepare with
  "Add at least one product image before publishing." (as built; the admin attention list matches on "image")
- `PreviewModal.tsx:39` shows the shared detail preview for manual products too.

**Build/Deploy/Runtime impact**
- Admin island bundle only.

**Test plan (write first)**
- Manual product Publish → manual prepare → approve → `{published: true}`, in that
  order; no Alibaba import calls.
- Manual product without photos → error before any prepare call.
- Category-only save on a published manual product → refresh approval (admin
  edits are the source).
- Linked product → today's call sequence unchanged.

**Done when**
- Tests pass; `pnpm typecheck`; `pnpm build`; `pnpm test:e2e:catalog-admin-local` passes.

### MIU-33: product page shows the MOQ when there is no price

```
Block:      FRONTEND
Files:      apps/site/src/catalog/presentation/CatalogCompactPrice.tsx
            apps/site/src/catalog/presentation/catalog-compact-quote.test.ts
Type:       modify-existing
Depends on: none
```

> **Moved to batch 3** (batch 3 review #9). As built: any stated MOQ on a price with nothing orderable (also a tiered price whose tiers all end below it); the product's own quote first, then the selected configuration's. The card takes the first configuration that states one, so on the configuration the page opens on, the two differ only when it states none (DEC-17).

**What it does** (DEC-16)
- When the scope that would be shown has no usable price but its pricing carries
  `minimumOrderQuantity` (`unavailable` / `negotiable`), render "Request a quote"
  with the same quantity line style underneath: "≥50 pieces".
- No MOQ → unchanged ("Request a quote" only). Applies to synced and manual
  products alike; no new copy keys (reuses the existing piece labels).

**Build/Deploy/Runtime impact**
- Site bundle only.

**Test plan (write first)**
- Website pricing `{mode: 'unavailable', minimumOrderQuantity: 50}` → "Request a
  quote" and "≥50 pieces".
- Unavailable without MOQ → existing assertions unchanged
  (`catalog-compact-quote.test.ts` "unknown configuration prices…").

**Done when**
- Tests pass; `pnpm typecheck`; `pnpm build`.

### MIU-34: manual product end-to-end (local) and admin e2e updates

```
Block:      TESTING
Files:      apps/local-server/src/catalog-manual-approval.test.ts   (new)
            tests/e2e/catalog-admin.spec.ts
Type:       new-test + modify-existing
Depends on: MIU-8, MIU-9, MIU-10, MIU-27, MIU-28, MIU-29, MIU-30, MIU-32, MIU-33
```

**What it does**
- Local-server test, end to end:
  1. Create a manual product (tiered price, 2 stored photos, series/model).
  2. Run prepare → review → begin → finish → publish.
  3. Check:
     - the list item has no `alibaba*` key or `variants`, and the same key set as
       an approved synced item built from the same optional fixture fields;
     - the card summary equals the page price;
     - the page has the spec facts and zero configurations;
     - a customization quote is recorded.
- `catalog-admin.spec.ts`:
  - The manual-product tests (`:357-600`) publish through the UI approval
    instead of a raw `update`.
  - They expect the shared product page (`[data-shared-catalog-detail]`) with
    the tier block.
  - The legacy-image fixture expects a clear refusal before approval.

**Build/Deploy/Runtime impact**
- Tests only. The admin e2e runs in `pnpm test:e2e:catalog-admin-local`. On a
  machine whose temp folder is on another disk, set `TMPDIR` to the worktree's
  disk (Astro moves build files with rename; `EXDEV` otherwise).

**Test plan (this MIU is the test)**
- Local server: with the same optional fixture fields, list item keys of the
  approved manual product equal those of an approved synced product, with no
  `alibaba*` key; card summary equals the page price.
- Local server: page facts are SKU / Series / Model / Type; `variants.total === 0`;
  a customization quote request is stored with the header snapshot.
- E2E: manual product published via the UI shows `[data-shared-catalog-detail]`
  and the tier block; a product with a legacy embedded image is refused before
  approval with a clear message.

**Done when**
- `E2E_CATALOG_FORMAL=1 node scripts/run-catalog-admin-local-e2e.mjs` passes
  (set `TMPDIR` on the same disk if needed).
- The local-server test passes; `pnpm typecheck` passes.

---

## PT-F — Supplier review and configuration photos (DEC-19, DEC-20; owner 2026-10-09)

Decisions (owner approved the recommendations): a supplier change never
reaches the website text or photos without the admin. When a product is
flagged Changed or Removed, the edit form shows a **Supplier changes** panel:
for description, gallery and description photos, the website value and the
incoming value side by side, labelled "from Alibaba (last approval)", "edited
here" or "website version" (approved before baselines existed), with **Keep**
or **Use incoming**. Prices, configurations and specifications come straight
from Alibaba on synced products (there is no admin copy), so approval always
takes the latest and the panel shows old → new. The Changed flag stays until
every listed field has a decision. Batch Publish skips flagged products.
Contributors can view a flagged product but cannot save or publish it.
DEC-20: an admin can assign gallery photos to configurations; approval
publishes the mapping like any configuration photo.

### MIU-40: product fields `supplierDecisions` and `configurationPhotos`
Strict write schemas in `packages/shared/src/collections.ts`:
`supplierDecisions` = per part (`description`, `gallery`, `descriptionImages`)
`{ choice: 'keep' | 'incoming', incomingDigest: sha256 hex }`;
`configurationPhotos` = configuration id → up to 9 image ids (at most 500
configurations). Done when: invalid shapes are rejected by the generic update.

### MIU-41: read-only `supplier-review` (admin action)
`catalogDetailApproval {action: 'supplier-review', productId}` returns, for a
linked product: each part whose incoming value differs from the website value
(website value, incoming value with linked image ids, origin label, whether a
decision for exactly this incoming value exists, `incomingDigest`); price,
configuration and specification changes since the approved version (old →
new, from the same comparison as the change audit); and the configurations
with their supplier photos (for DEC-20). Replaces the unused
`supplier-adoption` plan. Done when: unit tests per part, origin label,
decided state, price pairs, admin-only, writes nothing.

### MIU-42: the flag stays until every listed part is decided
Publishing a flagged product (the acknowledge path) clears the flag only when
no part is pending (incoming differs from the website and no decision matches
its `incomingDigest`); otherwise it publishes and keeps "Changed". Decisions
are written with the same update (admins only). Done when: tests for pending
→ kept, decided → cleared, Use incoming (website equals incoming) → cleared.

### MIU-43: contributors cannot save or publish a flagged product
Server refuses any contributor update of a product flagged Changed or Removed;
the edit form shows why and disables Save. Done when: handler test + render test.

### MIU-44: Supplier changes panel in the edit form
Panel for flagged linked products: per part Keep / Use incoming (Use incoming
sets the description, or imports the supplier photos and sets the gallery /
description photos); decisions sent with Save; prices, configurations and
specifications listed old → new; a note when parts are still undecided (the
flag stays). The preview's "Approve changes" opens the edit form. Done when:
render tests, api tests, local admin e2e.

### MIU-45: batch Publish skips flagged products
Changed or Removed products in a batch Publish are skipped and listed ("review
each in Edit"); replaces the MIU-35 confirmation. Done when: unit tests.

### MIU-46: configuration photos in approval
Prepare uses `configurationPhotos` for a configuration when set (only ids in
the product gallery); the mapping is part of the gallery digest and the
approval fingerprint, so editing it re-prepares and conflicts with an
in-flight approval. Done when: staging/prepare tests.

### MIU-47: "Photos for each configuration" in the edit form
For linked products with configurations: choose gallery photos per
configuration (from `supplier-review`'s configuration list); Save stores the
mapping and, on a live product, re-approves. Done when: render test, local
admin e2e.

## Rollout runbook (operations, not code)

Each step needs the batch before it deployed to `test`. Steps marked ⚠ write
production data and need the owner's go-ahead at the time.

| Step | When | What | Check |
|---|---|---|---|
| R1 ⚠ | After batches 1–3 pass local validation, before the first deploy (DEC-13; owner 2026-10-08) | Unpublish the 21 products (list in EXECUTION_LOG) via admin. Their "changed" flag (set later by R6) is not cleared by unpublishing (DEC-11) | Their list/detail URLs return not found |
| R2 ⚠ | After batch 1 | Alibaba observation replay: Validate (dry run, made **after** the deploy — dry runs made before it fail safely with `page-changed` because the page hash inputs changed) → check counts ("Headline prices removed", price modes) and failures → Apply. Also count wholesale products without SKUs that now use their ladder (MIU-1). Run R3 **before** this step. Note: replay never writes `products`; a product row's sync price (`alibabaCatalogPricing`) changes only when a later run sees and re-promotes that product ("Run now" is incremental). After batch 3 no public surface reads that field, and re-approval (R7) reads the replayed observations, so this lag affects only admin views | No `offer-set-mismatch` failures; next "Run now" counts no surge; re-running the same Apply is safe (repeat-safe since the batch 1 review) |
| R3 | **Before R2** | Count products with `alibabaPinnedOfferKey`, and especially any pin pointing at a product-level (`'@product'`) offer that R2 would retire (pricing repair would then report `invalid-pin` and promotion would silently pick another offer) | 0 → continue; >0 → stop and ask (DESIGN §9) |
| R4 ⚠ | After batch 2b; **hard gate for batch 3** | Check no `catalogDetailApprovals` job is in `staging` (a job begun before the deploy finishes without a summary). Then backfill plan → review → `apply` (`CHANNEL_ADMIN_TOKEN=… node scripts/catalog-price-summary-backfill.mjs plan\|apply <manifest> https://API-ORIGIN`; no admin screen calls this action). In the review of the **saved plan** (before apply; the `plan` step prints them as `productPriceWithConfigurations`), list rows with `priceSummary.source === 'product'` and `variantCount > 0`: their card price comes from a product-level offer although the product has configurations, possibly the retired wholesale headline (batch 3 review #7). Unpublish or re-approve those after R2 before batch 3. Re-run the plan right before the batch 3 deploy | Re-plan: 0 `ready` rows. `no-price` rows are accepted (their page also says "Request a quote"); `invalid-variant-rows` rows are listed (their page already shows an error) and each is re-approved (Publish) or unpublished before batch 3, because R5 counts their page error as a failure. An approved version without a summary shows "Request a quote" on its card, never a row or sync price (DESIGN §8) |
| R5 | Before and after batch 3 | **Before:** count (a) unlinked products with an old publication; run the audit with `--only-fields name,mainPhoto`: it lists every card that changes to its approved name/photo at batch 3 (2026-10-08 production: 0). **After:** `node --experimental-strip-types scripts/catalog-consistency-audit.mjs --api https://API-ORIGIN`; (b) = its `fallbackIds` that are linked (counted with the shared rule, not by field presence) | Exit 0: 0 mismatches, 0 errors (a 404 other than "Detail not available" is an error). Fallback = products with no approved version, expected ≈ the 7 manual products; the 21 are unpublished, so not listed |
| R6 ⚠ | Right after batch 4, before admins use Save on published products | `auditChangesSinceApproval` plan → review → apply (MIU-38), run as `CHANNEL_ADMIN_TOKEN=… node scripts/catalog-change-audit.mjs plan\|apply <manifest> https://API-ORIGIN` (the plan prints each changed product's differences; done when the re-plan shows no `unchanged` row; `changed` rows stay listed until R7 re-approves them). Rehearse the plan on the test environment's largest products first (the admin function has a 20-second limit and a plan page handles 20 products). After the first "Run now" that follows R6, check how many products the sync flagged before telling admins (real supplier data may change more than the tests show). Until it runs, products have no baseline digest and are never flagged, so DEC-12 cannot hold back their supplier changes | Products changed since their approval appear as `changed` (the 21 only if not yet re-approved); others get a baseline digest |
| R7 | After R6 | Admin approves each flagged product ("Approve changes" or Publish). If a quarantined sync run is pending, a flag can stay after approval; approve once more after the quarantine is approved. The preview shows the current source, not the approved version: open "Compare with the live page" next to "Approve changes" and compare prices before approving; the R6 plan manifest lists what differs for audit-flagged products | Flags cleared; products back in the list |
| R8 | After R7 | `node --experimental-strip-types scripts/catalog-consistency-audit.mjs --api https://API-ORIGIN`; browser check at 390px and 1440px: one multi-tier, one single-tier, one website-price, one "Request a quote" product; switch configurations | 0 mismatches; each configuration shows its own price |
| R9 ⚠ | After batch 5a, before 5b | Admin approves each of the 7 live manual products (they are already published, so: Edit → Save; with MIU-32, Save on a published product runs the approval). Before each, check in Edit the three rules approval enforces: at most 9 photos, photos uploaded to storage (not legacy embedded images), prices with at most 2 decimals. A refusal shows a generic message ("The catalog approval could not be completed." or the media-not-ready text), so check these three first | All 7 have an approved version |
| R10 | After batch 5b | `node --experimental-strip-types scripts/catalog-consistency-audit.mjs --api https://API-ORIGIN --require-no-fallback`; browser check of one manual product next to a synced one | 0 mismatches, 0 products on the row fallback; the two pages look alike |

---

## PT-G — Alibaba photos copied ahead; drafts appear ready (owner 2026-10-09)

**Why.** Photos were copied only at publish time, through the admin's browser
(1–3 s per photo from outside China; a draft with 9 + 18 photos took 30–80 s to
publish), or by the Edit "Import" buttons. Owner: photos come with the product
and its single approval; they should already be in our storage, never block
publishing, and drafts an admin sees should be ready to work on.

**Decisions (owner 2026-10-09).**
- Untouched drafts follow Alibaba: when a later sync brings new photos and nobody
  has edited the draft's photos, they are refreshed. Once an admin edits them, or
  the product has been approved or published, they never change on their own
  (DEC-18; live products get supplier photos only via Supplier changes, DEC-19).
- New drafts stay hidden from the admin list until their photos are in
  (`alibabaPhotosPending`), so nobody works on a half-prepared draft.
- One-time catch-up for all existing drafts (about 11,200 unique photos,
  about 3.7 GB at the measured 347 KB average). Existing drafts stay visible;
  each changes in one save; admin edits always win (optimistic save).
- Copying starts automatically after each sync, draft creation or single-product
  sync from the Alibaba Sync page; the page also finishes hidden drafts when it
  opens. (The 15-minute timer is off; when it is enabled, the tick must run the
  same preparation.)

**Rules per product and part** (gallery: first 9 sources; description: first 18):
eligible = Alibaba-linked, not archived, not published, never approved — checked
again inside the save (`requireUnapprovedDraft`), because approval does not change
the revision. A part is the sync's while its field was never set, or still equals
what the sync filled (marker `alibabaAutoPhotos`, with the sources copied and the
ones still missing); an emptied list is the admin's. A photo that cannot be
copied is left out, noted for a day (`catalogSourceLinks.failedAt`), then tried
again; a part where nothing copies keeps what it had. Configuration (SKU) photos
are copied too (copy only), so approval finds them in our storage. Every call
downloads at least one batch, so it always progresses. Review of `609b362`
(no P1; five P2) fixed in the commit after it.

| MIU | What | Check |
|---|---|---|
| 48 | Shared `alibabaPhotoSources` (source URL normalization, moved from the site); product fields `alibabaPhotosPending`, `alibabaAutoPhotos` (read-only); identity writable/cleared fields | unit tests |
| 49 | Pure plan `photoPreparationPlan(product)` | unit tests for every rule |
| 50 | Server page `prepareAlibabaPhotos` (copy with link reuse, 4 at a time, 12 s budget, resumable; one optimistic save with image locks; clears the hidden flag) | tests with in-memory db and fake importer |
| 51 | New drafts start hidden when they have photo sources | runner, selected sync, materialize tests |
| 52 | Admin list, review counts exclude hidden drafts (db option `hidePreparing`) | db adapter + handler tests |
| 53 | Admin actions `prepareAlibabaPhotos`, `photoPreparationStatus` | handler tests |
| 54 | Alibaba Sync page: Product photos section, automatic run after sync / drafts / single sync, finishes hidden drafts on open | site tests |
| 55 | One product, one unit (owner 2026-10-09, `5fd7752`): a product is written only when every photo of every part is copied or known unavailable; any temporary failure writes nothing and the product is retried after 10 minutes (6 tries, then unavailable); 404/410, invalid or disallowed address, too large, not an image are skipped as unavailable; a sync that changes a sync-owned part's photo sources hides the draft until re-copied (`photosRefresh`) | photo-preparation tests (19), `alibaba-photos-refresh.test.ts`, media-import 404 test, formal lane: prepared Alibaba draft published by "Assign category → Save and publish" |

**Revised 2026-10-09 (MIU-55), replacing "noted for a day" and "a part where
nothing copies keeps what it had" above.** Owner: "see a product's everything
as a whole, success then all should success, fail then all fail and retry
later, but don't affect later other product's data". The job now copies
everything a product needs first and then makes one guarded save; a temporary
failure leaves the product untouched (hidden if it was hidden) and moves on
to the next product. Fields synced from Alibaba are written by the sync before
the photo step, but the draft stays hidden until that step finishes, so no
admin sees a half-prepared product. One database transaction across both is
not possible: photo downloads take seconds each and CloudBase transactions are
short and capped at 100 operations.
