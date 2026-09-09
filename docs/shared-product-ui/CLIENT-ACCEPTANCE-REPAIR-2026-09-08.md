# Client acceptance repair — 2026-09-08

Status: CA-01–04 fixes implemented and verified locally; CA-05 formal detail/RFQ integration remains unfinished. No commit/push/release or live product changes in this pass. Baseline branch: `fix/alibaba-sync-storage-wiring@0094048`.

## Observed failure and delivery boundary

The live public response for product `0aa9d459-159c-4ffa-a5c0-db9a8e7c642f`
contains MOQ 2, unitPrice 5.7 and a USD manual tier starting at 1000 (380 minor
units), but no alibabaCatalogPricing. The linked-product renderer suppresses
manual prices. This is not proof that the supplier has no quotation.
The shared detail route is explicitly DEV-only. Local preview acceptance is not
acceptance of the built production route. Live functions report a manually
deployed r2 release, not the last test workflow SHA; frontend/backend release
identity is inconsistent. All subsequent deployment must use CI/CD.

## Independently verifiable repair units

| Unit | User-visible requirement | Verification before release |
| --- | --- | --- |
| CA-01 | Selected products publish with per-record validation and visible failures | Existing 0094048 HTTP/persistence tests plus built-site mixed batch |
| CA-02 | All Products can assign a website main category to selected products | Browser action → actual admin HTTP → persisted family; optional earphone facet cleared only when incompatible; no auto-publication |
| CA-03 | Import the available source gallery, not only the first image | Bounded/deduplicated imports, partial failures/retry, no dropped successes, no capacity overflow; save/reopen |
| CA-04 | Edit clearly displays existing source MOQ and complete quote tiers | Real-shaped review data render; malformed input safe; website overrides remain distinct, never silently overwritten |
| CA-05 | Formal detail displays the agreed structured UI and correct prices | Production build with no preview URL, old and imported records, real handler data; SKU/approval/RFQ boundaries retained |
| CA-06 | One tested release, not a frontend/backend split | Exact commit CI → test deploy → release identity and five live checks; no direct function deployment |

## Decisions already settled

- Website main categories: Headphones, AI Gadgets, Toys, Misc.
- `category_id` is Alibaba taxonomy; persisted rules and per-product overrides
  map it to `productFamily`. The old wired/office/bluetooth field is only an
  optional Headphones filter, not the website main classification.
- Classification must not publish a draft or overwrite price/media edits.
- Source quotes and manually configured website prices must be labelled as
  distinct data. Do not synthesize unit/wholesale/VIP prices from a lowest tier.
- Private raw evidence, source identifiers and unapproved SKU observations do
  not become public merely to make the new UI render.
- Industrial/non-electronic exceptions remain drafts per the client decision.

## Remaining release risk

The shared UI's production approval and route integration is unfinished; flipping
the DEV condition alone would expose an incomplete journey. Preserve that boundary
until its real production data producers, approval and read paths are verified.

## Root causes and implemented changes

1. **Bulk Publish:** the generic backend batch action deliberately rejects products
   (`Products must be updated individually`); the UI nevertheless called it and hid
   the error. Commit `0094048` already replaced that path with bounded per-product
   calls to the existing validated update action. This is not a disabled publish
   feature or a reason to relax classification/media validation. Mixed batches
   report accepted/rejected/not-attempted rows; failures remain selected.
2. **Classification:** source `category_id`, website `productFamily`, and the legacy
   Headphones facet `category` are separate fields. All Products now has selected-row
   main-category assignment, with explicit confirmation. Main-category labels are
   Headphones / AI Gadgets / Toys / Misc, including the edit dropdown and table.
   The optional facet is labelled Headphone type. Batch assignment uses the same
   server validation/persistence as individual edits, without publishing drafts or
   overwriting prices/images. The approved rule backfill remains a separate,
   preview-and-confirm operation after CI/CD; it has not been applied online.
3. **Gallery:** RecordForm selected only source URL `[0]`. The new bounded coordinator
   imports distinct allowed URLs through the existing authenticated server importer,
   retains existing images/order, and caps the final gallery at nine. Individual
   invalid-image failures can be retried; expired authentication/unconfirmed results
   stop further calls. Confirmed successes stay attached to the form and must be
   saved; cancellation retains the existing orphan-candidate cleanup path.
4. **Price edit vs public output:** source review MOQ/tiers and manually entered
   website fields are different models. The form now shows the source quotation
   explicitly instead of suggesting that blank manual inputs mean missing source
   data. It does not flatten a SKU quotation into unit/wholesale/VIP price fields.
   Separately, the first-sync promote stage created new linked drafts *after* its
   existing-product promotion loop, leaving `alibabaCatalogPricing` absent until
   a later source change. Fixed: after a clean quarantine gate, create draft and
   promote the source quote in the same run. Quarantined runs still write no products.
5. **Large-SKU pricing:** promotion itself read only the first 100 offers. An operator
   pin at row 105 incorrectly selected row 1 instead. It now reuses the established
   complete `_id` cursor walk; failure never becomes a truncated successful read.

### Existing missing quotes: controlled repair, not another full sync

`repairSourcePricing` is an admin-only action in the existing sync function. It scans
20 products per page under the shared sync lease, admits only clean completed source
run provenance, and reuses the fenced promotion primitive. It skips any existing
quote field (even an intentional unavailable/null value), archived/unlinked products,
and quarantined/unfinished evidence. No Alibaba API calls, no schema migration,
no changes to manual prices, website classification, image IDs, or publication state.

The Admin action requires explicit confirmation because it can restore a source
quotation on an already-published product. It reports checked/repaired/deferred counts,
validates advancing cursors, and stops on an unconfirmed response. Restart is
idempotent; it does not blindly retry an uncertain page. It remains **not deployed
and not run against customer records** in this pass.

### Why the website is still old despite prior backend updates

- Latest observed test CI run `33611104382` and Deploy Test `33611104387` succeeded
  for `73fd85b420037e1dc15f73cebb11cd2d05c96080` on 2026-09-02.
- Live public health reports `cui06d-60b051b-20260907-r2`, the subsequent function-only
  update. No corresponding new static frontend release was observed.
- In addition, the working-tree shared-detail and family adapters are explicitly
  DEV-only. Simply deploying the current frontend would still retain the old public
  route. This is not a cache diagnosis or proof of a finished release.
- Formal canonical candidate production/approval (including large SKU sets), route
  selection, and RFQ transport still need the planned integration. The current
  approved-only read contract must not silently fall back to raw source data.

## Business decision confirmed — 2026-09-09 supersedes the question

The user confirmed **manual website pricing wins when the admin intervenes**.
Valid manual tiers, then legacy wholesale/unit price, then source quote are the
compatibility order. Explicitly restoring source mode preserves but ignores manual
values. VIP remains retired. The current implementation and fresh acceptance live
in [CA-07 closeout](CLIENT-CLOSEOUT-2026-09-09.md); the readonly source card alone
does not fulfill the client's editing expectation. Source quotes are not orders,
invoices or checkout totals; no new payment/email behavior is included.

## Verification evidence and boundaries

- Real generated browser payload → actual admin HTTP adapter/handler/JWT/schema →
  JsonFileAdapter → reopen: valid publish, invalid mixed batch, demoted user, image
  reference counts, and main-category persistence with unchanged prices/images.
- Real local browser (4330) → local backend (3008): two labelled private fixtures
  batch-assigned to Misc; both remained unpublished. Screenshot:
  `output/playwright/client-batch-category-20260908.png`. This is not a live DB audit.
- Browser gallery test: first/second/duplicate/third source URL, one failed import,
  retry, save, reload/reopen, four final images including the pre-existing primary.
  This test mocks the HTTP image transport; it does not claim a cloud upload.
- The existing disposable catalog acceptance runner now **builds and previews** the
  production artifact in its own temporary output directory, instead of running
  Astro dev. It explicitly clears CloudBase media configuration, verifies loopback
  API/database ownership, and deletes only its owned generated DB/media/build after
  the run. Both spawn-failure cleanup cases remain tested.
- Production artifact → actual local HTTP/backend/file DB, no mocked admin route:
  selected main-category batch → mixed valid/invalid Publish → public-list read →
  reload → unpublish passed. The same run passed the seed audit and all existing
  category/publication lifecycle cases (5 cases total). An initial test selected
  the native Select fallback before hydration; the locator now waits for the actual
  enhanced button, without forced clicks or sleeps. This was a test timing issue,
  not evidence of a permanently blocked user-facing Select.
- Real-shaped three-tier mirror → repair → file DB reopen → public projection:
  570/500/380 minor units survive, private source IDs are stripped, manual fields
  remain byte-identical. First-sync and >100-SKU failures were reproduced before fixing.
- CloudBase SDK gate passed without changing SDK methods or runtime configuration.
  Node test flags affect only the local test runner, not the deployed runtime.
- Final regression logs use `/tmp/channel-client-final-*-20260908.log` and
  `/tmp/channel-client-production-build-20260908.log`; exact final counts below.

### Final local results

- Full workspace: **1,434 tests passed, 0 failed, 0 skipped** (final run exit 0).
- Full workspace typecheck and E2E typecheck passed; lint passed (542 files).
- Production build passed (15 pages).
- Built-site form/category regression: **8 passed**, including partial gallery
  import/retry/save/reopen (mock image transport).
- Separate built-site + real local backend + owned disposable DB: **5 passed**,
  including selected main-category assignment, mixed publication, public visibility,
  persistence after reload and unpublish; no admin API mocking in this lane.
- Sync function package: **123 passed**, including first-sync quote projection,
  source quarantine, lease/fencing, complete offer pagination and repair provenance.
- No new source/gallery SDK or runtime changes. No cloud DB writes, category apply,
  price repair, customer product publication, email, push or deployment performed.

The test runner cleaned up only its generated temporary database/media/build
directories. Existing user sample databases and the running 4328/4330 previews were
not reset. The standalone built preview at `http://127.0.0.1:4333` remains local.

## Exact next steps / release gate

1. Price priority is confirmed and implemented in CA-07. Next complete 09B.2 candidate
   production/approval and 09C/09D formal UI/API/RFQ integration using the existing
   unified contract. Do not clone/rewrite the approved UI against legacy raw fields.
2. Test **production artifacts without `preview=shared`**: selected publish, main
   category batch, gallery save/reopen, source/manual price cases, public tier table,
   SKU selection and inquiry → Admin follow-up. Local preview E2E alone is insufficient.
3. Review dependency-closed changes, commit/push this workstream, pass exact-SHA CI,
   then integrate test and deploy resources/functions/config/frontend through CI/CD.
   No direct MCP deployment, no blanket checkout of another dirty worktree.
4. Recheck release identity and read-only legacy regressions. Perform the approved
   classification preview/apply and missing-price repair with fresh counts. Any live
   sample publication/RFQ/email test must have an explicit sample/recipient scope.

No claim of "all five fixed online" or "ready for immediate test merge" is valid yet.
