# Catalog price investigation and repair

Status: CloudBase authorization and private read-only inventory completed. The initial
price-materialization repair and the follow-up SKU-currency/manual-save fixes are implemented
locally. Deployment, executable live repair audit/apply and post-deployment acceptance remain pending.
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
`f7feb08a-91e0-42a9-9fc3-529ef2e62a33`). The selected configuration requests an exact
quote. Subsequent private inspection below proves that this SKU also has real quantity
prices, which the currency mapping discarded. The product quote alone did not establish that.
The same-title product `0e0afdc26a68204700523563353480a1` has its own manual price;
it is a distinct record and must never be used as a substitute source.

CloudBase authentication is now `READY` and bound to the Channel environment. A read-only
inventory beginning **2026-09-17T04:36:23.353Z** retrieved 1,081 products, 1,074 source
products, 4,746 offers, 1,074 links and 11 sync runs. Collections were paged by `_id` with
narrow field projections. This is a sequential live snapshot, not a cross-collection
transaction; publication activity continued between the earlier public scan and this scan.

| Diagnostic outcome | All products | Published products |
| --- | ---: | ---: |
| Missing usable summary, own completed source evidence has a numeric quote | 1,064 | 119 |
| Manual pricing takes precedence | 9 | 9 |
| Current normalized source quote unavailable | 7 | 0 |
| Source run provenance not completed cleanly | 1 | 0 |

The 119 published omissions comprise 114 Headphones and 5 AI gadgets. Every one has its
own usable private numeric offer; no substitution from another product was used. Counts
are diagnostic classifications through the real planner over projected local copies.
They are **not an executable apply manifest**: a live audit must reread full records and
current revisions before writing. Private evidence remains in ignored local output.

## Original price evidence and the follow-up fixes

G2's current private source points to the preserved September 3 product.get response.
The complete 19,983-byte object was read through authenticated CloudBase storage; its
SHA-256 and byte length match the private payload metadata. This was **not a fresh Alibaba
request today**, and does not claim that the supplier's current asking price is unchanged.

| Original field / state | Current cloud mirror and public behavior | Cause |
| --- | --- | --- |
| `wholesale_trade.price = 2.9`, `normal`, `Piece`, MOQ 5 | Product-scoped USD 2.90 offer exists privately and in the approved detail | Source supplied a usable product quote |
| SKU bulk prices contain three positive, ordered quantity tiers; exact private values retained locally | SKU offer is `unavailable`, including in the approved detail | Normalizer did not supply the wholesale SKU currency when product.get omitted a currency field |
| Canonical product has no `alibabaCatalogPricing` | List API has no numeric source summary; card requests a quote | Source-to-product materialization omission, independently of the SKU bug |
| Description HTML / text | Stored and processed as content | Does not supply prices or participate in monetary calculations |

The official [product.add SKU contract](https://developer.alibaba.com/docs/api.htm?apiId=25347)
defines SKU prices in USD. The [product.get contract](https://developer.alibaba.com/docs/api.htm?apiId=25439)
returns quantity discounts under those SKUs without a currency field. The correction
interprets a normal, per-piece wholesale SKU's discount amounts in the documented SKU
currency. It does not infer currency for sourcing/unknown products, accept conflicting
currency metadata, turn batches or other units into pieces, replace invalid tier bounds,
or borrow the product reference amount for a SKU. G2's first SKU tier is more expensive
than its product reference; copying the product reference into that tier would be wrong.

The corrected normalizer replays G2 into all three exact USD tiers. The committed regression
uses synthetic amounts with the same wire shape; supplier records and exact raw bytes stay local.
An additional sourcing/USD raw control retains its original three valid SKU offers.
All seven quote-only raw responses were also read completely and hash-verified: five
use `Set`, one `Pole`, one `Acre`. **All seven contain amounts.** Their current unavailability
is an unsupported sale-unit contract, not proof that the supplier omitted prices. Two also
contain an invalid `start_quantity = -1`. They remain unpublished and deferred; supporting
those units requires preserving the unit through quantity calculation and display.

The mirror contains 1,808 USD tiered SKU offers and 1,864 unavailable SKU offers. These
are normalized-state counts, not a claim that all 1,864 share G2's currency cause; their
raw tier validity and sale units must be classified before any full replay is applied.

## Manual saving and why list/detail differ

Price is stored in dedicated numeric structures. `unitPrice`, `wholesalePrice` and
`manualCatalogPricing` are operator values; `alibabaCatalogPricing` is the product's
source-price summary. Approved detail `websitePricing` and `offers[].pricing` are also
numeric structures. `description` / `descriptionText` are unrelated content fields.
"Detail price" means a number returned by the product-detail API, not a price description.

The site chose separate lifetimes: lists read the canonical product and detail reads an
approved snapshot so a subsequent supplier import cannot silently replace reviewed public
content. Alibaba does not require this website list/detail split. Alibaba's product-level
quote versus SKU quantity prices is a separate distinction about what is being quoted.
The separate website paths predate this branch; the
[September 10 RCA](../shared-product-ui/DATA-CONSISTENCY-RCA-2026-09-10.md) already identifies
an unfinished migration between them. Sharing the manual pricing resolver in `105407e`
did not make persisted snapshots update automatically after every product save.

Observed manual data: all 9 published manual-price records contain usable amounts.
The 2 with approved detail snapshots have matching manual pricing in both paths. The other
7 are legacy records without a new detail snapshot; their new detail endpoint returns
`404 Detail not available`. The website retains a legacy fallback for this case. This
absence is not evidence that a manual save lost a price, nor that all nine use the new API.
An actual browser read confirms the legacy manual G2 page displays its own USD 3.00 price
after the new detail endpoint returns 404. The linked source G2 page currently shows the
product reference USD 2.90 and an unavailable selected configuration, as predicted above.

Using the real Admin handler and file-backed adapter reproduced two save behaviors:

1. The regular editor includes `published: true`. Changing a published linked product's
   price fails the existing review check; no price is saved. This is an explicit validation
   failure, not successful persistence followed by a missing UI update.
2. A price-only API patch omitted `published`, bypassed that check, and saved USD 8.50 while
   list read USD 8.50 and approved detail still read USD 3.00. This was a real consistency bug,
   but the current manual inventory does not prove that it caused a particular live omission.

The follow-up fix always enables the existing check when the approval feature is on;
the atomic save evaluates the resulting stored `published` value, including partial patches.
It does not add a new approval step or silently overwrite an approved snapshot. The regression
uses actual review/begin/page/finish actions, then publish and reload: initial USD 3.00,
rejected unreviewed changes through both request shapes, saved unpublished USD 8.50, and
approved/published USD 8.50 agree in the public list resolver and detail API. Description
text remains identical throughout.

## What was already present versus newly added

- Before this task, `dbf802b` already supplied a 20-product cursor repair, sync lease,
  completed-run checks and the existing manual/source precedence and detail approval model.
- This task's `04255c1` strengthened that repair with read-only plans, exact page/evidence
  hashes, a dedicated price-only transaction, persisted CLI checkpoints and public readback.
  It also wired source-price materialization into initial linking and draft catch-up.
- The authorization follow-up additionally fixes wholesale SKU currency and the partial
  manual-save check. These are implementation changes, not merely a proposed process.
- None of these changes has been deployed or applied to the live catalog by this task.
  "New flow" referred to repair-tool improvements, not a newly invented price model or
  approval requirement. The initial wording obscured this distinction.

## Cause traced through the system

| Layer | Finding and resulting action |
| --- | --- |
| Raw Alibaba data / normalization | G2 raw proves SKU tiers were discarded for missing currency context. Correct normal wholesale/Piece SKU USD interpretation; keep invalid quantity, conflicting currency and unsupported-unit cases explicit. |
| Canonical product materialization | Reproduced: `materializeAlibabaDraftPage` created/reconciled a draft without writing a completed source quote. The admin initial-link action likewise only linked. Both now use the same completed-evidence, price-only writer. |
| Normal sync completion | Current main already promotes new drafts after its quarantine gate. Retain that path. It does not require this helper or a second lease inside the worker. |
| Raw replay | Deliberately updates private observations/offers only. Retain the separation; run a price audit afterwards. Draft catch-up and explicit linking now fill eligible missing summaries from completed evidence. |
| Detail approval | An approved immutable detail snapshot has a separate lifetime from the canonical product price summary. Approval does not backfill the list price. Preserve the snapshot and approval receipt. |
| Manual save | Partial patches could update public list pricing while bypassing the existing approval check. The atomic save now receives the check regardless of whether the request includes `published`. |
| Public API | Numeric summary fields survive the existing projection; private source/offer/SKU identities are redacted. No evidence of the API dropping an existing valid numeric summary. |
| UI | Cards correctly show quote/unavailable when their shared resolver has no usable summary. The G2 amount is absent from the API input, so a layout change would not fix this case. Existing components/rendering remain in use. |
| Previous repair function | Reproduced: generic promotion could clear reviewed source image/category metadata when observations were absent. It also skipped present-null/invalid summaries and counted successful promotion as repair even without a restored amount. Replaced with a dedicated price-only operation. |

These are reproduced systemic paths. G2 source import precedes its September 4 link and
product creation; the price-only offer replay and September 15 detail approval did not
fill its list summary. Timestamps and current state support that sequence, but no retained
per-write event log proves the exact historical writer for every missing product field.

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

Follow-up after CloudBase authorization:

- Two raw-to-observation regressions failed on the original code (wholesale currency-less
  SKU tiers/fixed prices). Both now pass, including conflicting currency, unsupported unit,
  invalid threshold, missing trade context and no-price SKU boundaries.
- The real manual save/publication regression failed because a partial price patch was
  accepted. It now passes through durable review, approval, publish and both public read paths.
- Alibaba adapter: 149 passed. Admin function: 219 passed. Alibaba function suite passed.
  Local server: 130 passed. Type checks for the affected packages and Biome passed.
- Authenticated raw reads: G2, all 7 quote-only products and one working sourcing control;
  all 9 complete payloads match their stored length and SHA-256. No source request was made.
- The public API and Alibaba function health endpoints still report deployed release
  `75475b1bb1bf6f6b02f596909f57839a27d0f451`, not this branch's repair code.

Initial materialization repair verification (before the follow-up):

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

Use the existing reviewed same-SHA deployment workflow, then produce the full executable
catalog dry-run against current full records and review deferred outcomes. Apply eligible
bounded summary pages and verify every changed record plus representative real desktop/mobile
details; repeat the inventory. The projected diagnostic snapshot above cannot substitute
for that live audit. The SKU mapping correction additionally requires bounded replay of
verified raw evidence into private offers and detail candidates. An existing approved detail
will retain its old SKU quote until the corrected candidate is reviewed; summary repair alone
does not change it. Do not hide a supplier sync, publication or reapproval inside price repair.
No merge, PR, deployment or live repair is asserted by this implementation record.
