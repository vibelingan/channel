# Catalog Price Repair - Live Repair, 2026-09-21

Status: Eligible catalog summary-price repair and post-repair acceptance completed. All 1062 eligible products repaired, including all 117 affected published products; zero eligible omissions remain. Eight classified deferred products remain private and unchanged. All 129 post-repair public tests passed. Final offer verification and sync/lease cleanup passed; PR delivery is the remaining administrative step. Approved SKU snapshots were intentionally preserved, not repriced.

**Current phase:** `deliver`.

**Current/next MIU:** commit and review the final evidence record, pass same-head PR checks, and merge PR #60 without importing test-only changes. No further cloud data mutation is needed. Separate SKU review/approval is not authorized automatically.

This is the current live-repair record linked from
[RELEASE-2026-09-21.md](RELEASE-2026-09-21.md). It supersedes that document's
historical missing-admin-access and repair-not-run statements. Results below
record saved evidence and the execution owner's latest observations; this
documentation update did not repeat live operations.
Feature branch `feat/catalog-price-repair-handoff` remains at
`df2a7017fd6ecfa751579b03f56f5595bde7104e`. The repair reused deployed release
`5a6317e62df4388bccf076dcd214e4ce65d71c35`; no fresh deployment was performed.
There is no new runtime change. Final evidence changes are limited to this report
and the linked release record. Unrelated dirty files in the root workspace are
untouched. Private evidence is excluded from Git.

## Authorization and Safety

Authorized app-admin access was recovered and used successfully for the full
repair. **Login is no longer a blocker.** No further user login, credential handoff
or access action is needed during the remaining authorized task; the user can
leave while the execution owner finishes the checks using the existing authorized
local runtime. The local loopback bridge used the admin token in memory; no token
was stored in the evidence. It was stopped at `2026-09-21T03:41:53.954Z`, clearing
the in-memory session and closing its listener. All evidence files, including
screenshots and local scripts, were verified as mode `0600` in a `0700` directory.
Screenshots are private, local and ignored;
neither evidence nor credentials belong in tracked files or public CI artifacts.

The full baseline contained **1116 products, 1109 sources and 4890 offers**.
The saved preflight showed no active sync run and a released lease, the lock
that prevents overlapping sync work. Repair scope was the whole catalog, not
only published products or browser samples.

**What / why:** replay each source's retained raw evidence into private offers,
then repair eligible missing/invalid product summaries from that product's own
validated evidence. Do not borrow a same-name product's price, flatten quantity
tiers, replace manual authority, publish drafts or approve details automatically.

## Observed Results and Truth Conditions

| Step | Observed result | Truth condition / boundary |
| --- | --- | --- |
| Full raw preflight | 56 pages; all 1109 sources valid and ready | Complete source coverage, each source's retained raw evidence passes validation; no sample-only inference |
| Raw apply | All 56 pages confirmed; replay state `applied` | Every page confirmed before advancing; this repairs private offers, not approved product details |
| Product re-read after raw replay | All 1116 products byte/value-identical across all fields | Raw replay alone changed no product field, publication state or approved receipt |
| Fresh summary audit | 1116 products: 1062 eligible, 9 manual, 7 quote-only, 37 valid, 1 incomplete run | `1062 + 9 + 7 + 37 + 1 = 1116`; use this new audit, not the earlier diagnostic inventory |
| Plan review | Own-product price evidence and expected product hash/revision and related evidence preconditions reviewed | Apply only the reviewed product's own current evidence; stale/conflicting plans must not write |
| Summary apply | All 56 pages confirmed; plan state `applied`; all 1062 repairs confirmed, zero uncertain: 945 drafts and 117 published | `945 + 117 = 1062`; all 117 published price comparisons passed before their checkpoints advanced |
| Product preservation | 1116 products re-read; zero protected-field mismatches | Each of the 1062 repaired products changed exactly the four allowed fields below; all other products unchanged |
| Final read-only audit | Complete 1116: 1099 valid, 9 manual, 7 quote-only, 1 incomplete run | `1099 + 9 + 7 + 1 = 1116`; zero eligible, errors, conflicts or stale results; `37 + 1062 = 1099` |
| Public inventory | 128 products: 119 source-available and 9 manual | All 117 previously missing public summaries restored and matched through the public API; all 9 manual prices unchanged; `119 + 9 = 128` |
| Public approved-detail reads | All pages for 121 approved public products read successfully | Each served revision matches its baseline; variant totals and unique variant counts are correct; no replacement approval |
| Ready repaired-draft preview reads | All pages for 24 stored previews read successfully: 21 tiered, 2 fixed, 1 range | `21 + 2 + 1 = 24`; read-only review, no prepare or approval calls; stored previews were not rebuilt |
| Offer after-inventory | Complete 4890 unique offers; identities and source/run ownership unchanged | 1661 previously unavailable offers became tiered numeric quotes; replay also updated offer timestamps and parser metadata |
| Post-repair public regression | 129 passed, 0 failed, exit 0, 4.2 minutes | Run after live repair at feature `df2a701` against deployed `5a6317e`; Chromium and mobile WebKit, no local retries |
| Final cleanup | No active sync run, primary lease released, local maintenance listener stopped | No forced lease release, scheduler change or browser logout; no credential retained in local evidence |

The only changed product fields were `alibabaCatalogPricing` (summary),
`alibabaPrimaryOfferKey` (selected offer), `alibabaLinkRevision` and `updatedAt`.
Publication, manual values/controls, images, categories, approved detail snapshots
and approval receipts were preserved; the approved receipts are unchanged.
A summary repair is not SKU-detail approval.

The read-only after-audit was interrupted after 660 products when the local
terminal was reused. It was resumed to the final complete 1116-product audit;
there was **no apply retry**. The interrupted prefix is not the completion record.
All apply results are confirmed, so there is no unresolved apply to retry. If a
later operation becomes ambiguous, retain its private attempts/responses and
reconcile reads under the release record's recovery procedure; do not replay an
old apply, force-release a lease or bypass approval. Final readback independently
confirmed `activeRunId` empty and primary lease fence 829 released at
`2026-09-21T02:28:11.619Z`; its expiry was `2026-09-21T02:31:11.129Z`.

Offer-mode counts changed from 1917 tiered, 1871 unavailable, 425 range and 677
fixed to 3578 tiered, 210 unavailable, 425 range and 677 fixed. All 4890 offer
identities, active states and source/run bindings were preserved. Offer `updatedAt`
changed on all 4890 records and `parserVersion` on 4876 records. These private
replay metadata changes are separate from the four-field canonical-product
allowlist. This independently confirms 1661 restored numeric offers, without claiming that unsupported quotes
became valid or that approved detail snapshots inherited those changes.

## Real Browser Acceptance

All **14 of 14 real public card checks passed**, without mocked responses:
seven samples at exact viewport widths **1440 and 390**. Coverage included fixed
and tiered pricing, AI products, G2, a same-name product comparison, manual scalar
and manual tiered pricing, and toys. Expected text came from the shared price
resolver. Each outcome verified the expected text, a decoded real image, no
horizontal overflow and no page error. The real-card JSON and screenshots are
saved in the ignored folder. The saved G2 mobile screenshot shows a `From` price
of `2.90` with MOQ `5`.

There was **no repaired public range-price sample**. One private range example
passed the stored draft-preview read below; that is not public range-card
acceptance. These 14 card checks do not prove selected-SKU UI behavior or newly
corrected SKU prices.

## Approved Details and Deferred Products

**Approved SKU-detail repricing was intentionally not performed.** The original
task explicitly required preserving approved snapshots and receipts, so a
separate SKU review/approval must not run automatically or be treated as missing
authorization for this eligible summary repair. Private raw offers were corrected,
but older approved SKU prices can remain different until an operator separately
reviews and explicitly approves a replacement through the normal workflow.

Read-only acceptance of **all 121 public approved details passed across every
page**: each served revision matched the baseline, with correct variant totals
and unique variant counts. **All 24 ready repaired-draft stored previews were
read successfully across every page**, covering 21 tiered, 2 fixed and 1 range
summary-price products. No prepare or approval action was called. Stored previews
were not rebuilt, so successful reads prove availability and preserved detail
state, **not a guarantee of newly corrected SKU prices** or complete SKU UI
acceptance. These draft reads cover 24 ready previews, not all 945 repaired drafts.

All **8 deferred products are private, unarchived and unchanged**: 7
source-unavailable / quote-only records and 1 incomplete-run record. Sale units
for the seven unavailable records were **not reconfirmed today**; do not label
them verified. For the remaining record, the private report confirms that GET
of the referenced run returned `NOT_FOUND` (remote HTTP 404; bridge HTTP 200).
This is missing provenance, not a quarantine finding. Do not invent a completed
run, approve unsupported detail content or force eligibility. The eligible
catalog summary repair is complete with these eight classified deferrals;
completion does not mean every product has a numeric price.

Exact follow-up for these eight records:

1. For each of the seven unavailable records, inspect its own retained source
   evidence privately. Verify the normal pricing contract: supported sale unit,
   currency and per-unit basis, valid numeric prices, MOQ and quantity tiers.
   Do not infer a unit or price from a title, sibling product or another offer.
   Keep genuinely nonnumeric or unsupported evidence quote-only and private.
2. For the missing-run record, reconcile the source reference against actual
   retained run history. Restore a reference only when authentic evidence proves
   it; never fabricate completion or relabel `NOT_FOUND` as quarantine. If the
   evidence cannot be recovered, use the normal separately authorized sync/import
   workflow to obtain real completed-run provenance, or leave the record deferred.
3. Where new evidence is needed, use the normal authorized source workflow, not
   a forced repair. Once provenance and the unit contract genuinely pass, verify
   sync inactivity and the released lease, rerun bounded raw preflight/replay as
   needed, create a fresh summary audit/plan and review its expected hashes and
   revisions before any separately authorized apply. Recheck preservation and
   public effects. Publication and detail approval remain explicit operator acts.

## Private Evidence Log

All artifact names below are relative to the existing ignored folder:

```text
output/catalog-price-repair/live-20260921/
```

Only filenames are recorded here, never private identifiers, source-offer details,
raw payloads or token values. These local artifacts do not travel with a clone;
the aggregate results and remaining work in this tracked report do.

| Evidence purpose | Artifact names |
| --- | --- |
| Authenticated access and full baseline | <code>access-proof.json</code>, <code>products-before.json</code>, <code>sources-before.json</code>, <code>offers-before.json</code> |
| Full raw preflight and applied replay | <code>raw-preflight-one.json</code> (56-page record despite its name) |
| Raw replay changed no product field | <code>products-after-replay.json</code>, <code>replay-preservation.json</code> |
| Reviewed summary plan and applied checkpoints | <code>pricing-plan-one.json</code> (56 pages, state <code>applied</code>, next apply index 56) |
| Full product preservation after apply | <code>products-after.json</code>, <code>comparison-products-before-products-after.json</code> |
| Final complete read-only classification | <code>pricing-after.json</code> (56 pages, audit state <code>ready</code>, next apply index 0; not another apply) |
| Public totals, restored prices and manual preservation | <code>public-after-repair.json</code> |
| Real browser results and private screenshots | <code>real-card-acceptance.json</code>; <code>public-card-1440-0.png</code> through <code>public-card-1440-6.png</code>; <code>public-card-390-0.png</code> through <code>public-card-390-6.png</code> |
| All-page approved-public-detail and stored draft-preview reads | <code>detail-acceptance.json</code> |
| Full offer readback and pricing changes | <code>offers-after.json</code>, <code>offer-replay-verification.json</code> |
| Full post-repair public regression | <code>post-repair-public-e2e.log</code> |
| Local listener/session cleanup and evidence permissions | <code>maintenance-cleanup.json</code> |
| Deferred evidence and missing-run classification | <code>private-readonly-pricing-evidence-report.md</code>, <code>private-readonly-deferred-run-summary.json</code> |
| Page request/response evidence for reconciliation | <code>request-*.json</code> (private per-request artifacts; individual identifiers intentionally omitted) |

## Final Acceptance and Delivery

The full post-repair regression completed at feature `df2a701` against live
`5a6317e`: **129 passed (4.2m), exit 0**. Invocation from the repair worktree:

```sh
E2E_SITE_URL=https://supplychainsai.com \
E2E_API_URL=https://diversity-123-d9grnqfux221323bb.service.tcloudbase.com \
E2E_RECORD_ARTIFACTS=0 node_modules/.bin/playwright test \
  tests/e2e/public.spec.ts tests/e2e/header-navigation.spec.ts \
  tests/e2e/catalog-hub.spec.ts tests/e2e/catalog-family-routes.spec.ts \
  tests/e2e/catalog-category.spec.ts tests/e2e/sku-detail.spec.ts
```

This regression includes mocked UI scenarios; actual data acceptance is supplied
separately by the all-record audits, 117 public-price comparisons, 121 approved
detail reads, 24 stored previews and 14 unmapped real-card browser checks above.
Offer readback and final cleanup are complete. Independent local evidence review
verified complete unique coverage, page hashes, acknowledgement consistency,
protection checks and private-file boundaries. Its permission exception on local
scripts/screenshots was corrected and rechecked before cleanup.

PR #60 delivery is still to be recorded after the final evidence commit passes
its checks. The deployed application runtime does not change with this docs-only
commit; merging the main-based repair branch must not import test-only work.

Keep the absent public range sample and the SKU-price boundaries above explicit.
Any replacement SKU preparation/review/approval is separate, explicitly authorized
work, not an automatic extension of this repair. The intermittent taxonomy-menu
issue remains unresolved; its evidence and next discriminating check remain in
[TAXONOMY-MENU-INVESTIGATION-2026-09-21.md](TAXONOMY-MENU-INVESTIGATION-2026-09-21.md).
Passing card/detail checks neither fixes nor waives that issue.

**Tests written:** none in this documentation-only task. Validation above records
the completed repair's saved evidence and execution-owner observations, not new
cloud reads or a newly run full test suite. This edit's validation is limited to
the scoped documentation diff check; it does not rerun type, lint or runtime tests.

**Engineering rationale:** replay private evidence before building a fresh summary
plan, then verify each published result before checkpointing. This separates
source normalization from public summary repair and from operator-owned detail
approval. Earlier deployment/public tests could pass while summaries were still
missing; neither those tests nor card checks prove approved-detail repricing.
The conservative boundary preserves manual authority and approval receipts while
making the remaining detail-price differences and deferred evidence visible.

## Deviations

The final read-only audit required resumption after local terminal reuse at 660
products. Resuming reads to full coverage was the conservative choice; repeating
apply was unnecessary and was not done. Approved-detail repricing was omitted by
design under the original preservation requirement, not silently treated as
completed. All-page detail/preview reads verify preserved state, not replacement
SKU preparation or approval.