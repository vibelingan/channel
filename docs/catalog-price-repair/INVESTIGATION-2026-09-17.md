# Catalog price investigation and repair

Status: implementation and local acceptance completed; private live evidence, deployment,
whole-catalog live audit/apply and post-deployment acceptance remain pending CloudBase access.
No live product, source, sync configuration, detail approval or publication was changed.

## Branch and evidence

- Wiring PR #55 is merged. `origin/main` is `ba3cd6296cddf3eb0fd67866b0819cd7b0db33bd`.
- Continue `feat/catalog-price-repair-handoff`, whose initial `4e403fc` adds only the handoff
  to that main. Its predecessor wiring branch need not be reopened.
- Worktree: `../channel-catalog-price-repair`. The originally configured checkout
  was absent; the separate dirty AI checkout was preserved.
- Read-only public scan at **2026-09-17T02:47:45.174Z**: 109 distinct published products.
  Counts below use the real shared pricing resolver, including manual tier/scalar precedence.
  This is a public snapshot, not the private catalog inventory or the repair denominator.

| Family | Available manual pricing | Unavailable source summary |
| --- | ---: | ---: |
| Headphones | 6 (one tiered, five scalar) | 95 |
| AI gadgets | 0 | 5 |
| Toys | 3 scalar | 0 |

Observed in the real browser and public API: blue G2 product
`0e18d7ff-8a92-45b8-aa3d-461634880ac8` has a source linkage marker/status but no
materialized price. Its card requests a quote. Its approved detail contains a
**product-level** supplier quote of **USD 2.90, MOQ 5** (revision
`f7feb08a-91e0-42a9-9fc3-529ef2e62a33`). A selected configuration can still request
an exact quote; a product-level quote is not evidence of a SKU-specific price.
The same-title product `0e0afdc26a68204700523563353480a1` has its own manual price;
it is a distinct record and must never be used as a substitute source.

The private source, active offers, original raw response and run records could not be
read because CloudBase reports `REQUIRED` authentication. Device login was initiated;
no completed login was observed. Historical handoff prices/run provenance remain leads,
not current repair inputs. Neither the detail quote nor the 100 unavailable public
summaries proves that all 100 currently have eligible private source offers.

## Cause traced through the system

| Layer | Finding and resulting action |
| --- | --- |
| Raw Alibaba data / normalization | Private live raw values remain unverified. Existing fixed/range/tiered/negotiable/unavailable validation and offer selection are reused. Never manufacture amounts, currencies or SKU matches. |
| Canonical product materialization | Reproduced: `materializeAlibabaDraftPage` created/reconciled a draft without writing a completed source quote. The admin initial-link action likewise only linked. Both now use the same completed-evidence, price-only writer. |
| Normal sync completion | Current main already promotes new drafts after its quarantine gate. Retain that path. It does not require this helper or a second lease inside the worker. |
| Raw replay | Deliberately updates private observations/offers only. Retain the separation; run a price audit afterwards. Draft catch-up and explicit linking now fill eligible missing summaries from completed evidence. |
| Detail approval | An approved immutable detail snapshot has a separate lifetime from the canonical product price summary. Approval does not backfill the list price. Preserve the snapshot and approval receipt. |
| Public API | Numeric summary fields survive the existing projection; private source/offer/SKU identities are redacted. No evidence of the API dropping an existing valid numeric summary. |
| UI | Cards correctly show quote/unavailable when their shared resolver has no usable summary. The G2 amount is absent from the API input, so a layout change would not fix this case. Existing components/rendering remain in use. |
| Previous repair function | Reproduced: generic promotion could clear reviewed source image/category metadata when observations were absent. It also skipped present-null/invalid summaries and counted successful promotion as repair even without a restored amount. Replaced with a dedicated price-only operation. |

These are reproduced systemic paths, not proof of the exact historical write that
created each live omission. Private record/run inspection is still needed to attribute
those rows to a particular import, replay or linking event.

## Repair contract

`repairSourcePricing` defaults to read-only `mode: "dry-run"`. `mode: "apply"` requires
its exact `expectedPageHash`. Each request scans at most 20 products by ascending `_id`;
clients continue until `nextId: null`, including an empty terminal page when necessary.
Every product is accounted for, including drafts, published, archived and unlinked rows.

The plan records original product/revision, exact link identities (including `linkedAt`),
source/run/selected-offer hashes, the complete offer-set hash, proposed quote and protected
field hash. It checks completed runs for source last-seen/last-changed and active offers,
source/offer identities, the canonical USD/CNY policy and an operator's valid pin.
Invalid/inactive pins defer instead of silently selecting another SKU.

Only eligible absent/null/invalid/non-numeric summaries backed by a valid own numeric
quote are written. Existing manual pricing (including zero and explicit empty manual
mode), archived/unlinked records and already-correct source prices are preserved.
Different existing numeric prices are `stale-source` for review, not automatically
repriced. Genuine negotiable/unavailable/no-offer cases are `quote-only` with no write.
Invalid source/offer/manual evidence, unfinished runs and identity conflicts have
separate outcomes. Failed reads stop the page rather than hide records.

Apply acquires the existing primary sync lease, replans the same page, then uses
`mutateAlibabaProduct(action: "repair-pricing")` for each original product. Inside the
native transaction it checks exact product/link revisions, evidence hashes, selected
quote and current wall-clock lease ownership. The patch allowlist is exactly
`alibabaCatalogPricing` and `alibabaPrimaryOfferKey`; the only additional changes are
internal `alibabaLinkRevision` and `updatedAt`. Images, classification, source-review
metadata, publication, manual controls, approved detail/receipt and source ownership
are retained. Product/price/protected-field readback must succeed before `repaired`
increases. Link/draft creation reports price uncertainty separately if its subsequent
price materialization cannot be confirmed.

All application mirror writers share the primary lease; the whole offer set is replanned
under that lease. The transaction rereads the selected offer/source/run documents rather
than querying inside a transaction. This relies on source mirror edits using their
existing fenced owner, not out-of-band database edits. The transaction has at most 40
link expectations and 48 evidence documents, within the documented 100-operation limit.
The current SDK transaction interface is unchanged. Checked against the installed
`wx-server-sdk` implementation and [CloudBase transaction documentation](https://docs.cloudbase.net/database/transaction).
The hosted transaction behavior remains part of live acceptance.

## Resumable operation

The existing Admin repair button now dry-runs/rechecks each page, validates acknowledgements,
reports quote-only/review outcomes and stops on stale or uncertain results. On a transport
failure it states that the last page may have saved and gives the last confirmed cursor.

For an auditable whole-catalog execution, use `scripts/catalog-price-repair.mjs`.
`CHANNEL_ADMIN_TOKEN` must be provided in the process environment from a current authorized
operator session; never pass it on the command line or put it in Git. Example commands:

```sh
node scripts/catalog-price-repair.mjs audit output/catalog-price-repair/manifest.json https://API-ORIGIN
node scripts/catalog-price-repair.mjs resume-audit output/catalog-price-repair/manifest.json https://API-ORIGIN
node scripts/catalog-price-repair.mjs apply output/catalog-price-repair/manifest.json https://API-ORIGIN
```

Create the ignored output directory first. Audit does not write cloud data. Each local
manifest/checkpoint is permission 0600 and binds the API origin. Apply reuses audited
page hashes; it verifies every changed published record through the public API before
advancing the local checkpoint. It finishes with a new full inventory in `.after.json`.
Remaining eligible records cause exit code 2; review/quote-only outcomes remain explicit.

A lost acknowledgement or changed page must be re-audited into a **new manifest** before
another apply. Do not bypass a hash, edit a stale manifest, or blindly advance a cursor.
Replaying the old manifest after a saved write safely conflicts. Partial results and
unchanged records stay in local evidence. Keep manifests/private identities local;
the repository is public and its workflows/artifacts are not a private evidence store.

## Verification

- The initial regression was red for missing catch-up draft pricing and unintended
  source-image/category edits. Both now pass against the real file adapter/mutation code.
- Alibaba function suite: 209 passed. Covers all price modes/zero, USD preference/CNY
  pin, real initial-link action, draft catch-up, absent/null/invalid summaries,
  manual authority, completed/quarantined runs, link ABA, lease expiry, changed evidence,
  illegal patches, all protected fields and 120-product pagination/idempotence.
- DB: 98 passed; shared: 146 passed; local API: 129 passed.
- Site suite: 423 passed, one existing skip; updated repair/draft decoder tests: four passed.
- Deployment/script contract tests: 409 passed, including five resumable CLI tests.
- All workspace types, E2E types, Astro check, Biome, SDK contract verification, site
  build, three function packages and packaged artifact smoke checks passed locally.
  Host Node is 25.6.1; `NODE_OPTIONS=--no-experimental-webstorage` avoids its synthetic
  global localStorage affecting browser unit tests. Bundles target Node 20; deployed
  Node 20 execution still needs the repository's same-SHA CI/deployment workflow.
- Actual local HTTP login → dry-run → apply → every public price readback → full re-audit:
  three synthetic products (headphones fixed USD 2.90, toys USD 5.00–7.50,
  AI gadgets USD tiers 5.70 at 10–99 / 3.80 at 100+) repaired; re-audit returns three
  `valid-source`, zero eligible. All protected fields and approval snapshots deep-equal
  before/after. No live data was imported into the fixture.
- Real browser acceptance uses the existing family routes and product details on desktop
  and 390px mobile. Source cards display fixed/range/"From" prices, MOQ and no horizontal
  mobile overflow. Approved G2 detail remains USD 2.90 before/after. Synthetic fixture
  lacks production hero images; expected image 404s are unrelated to pricing.
- Built-site catalog/Admin browser suite: **126 passed**, including public routes,
  family/detail routes, manual tier editing, draft visibility and Admin lifecycle.
- Evidence is local under ignored `output/catalog-price-repair/` and `output/playwright/`.

## Remaining live acceptance

After current CloudBase login is available: inspect private original-source, offer, link
and completed-run evidence; produce the full catalog dry-run; review deferred records;
use the existing reviewed same-SHA test deployment workflow; apply eligible bounded
pages and verify every changed record plus representative real desktop/mobile details;
then repeat the full inventory. Do not use a new supplier sync or publish/reapprove
products as a hidden price repair. No merge, PR, deployment or live repair is asserted
by this implementation record.
