# Design as built

How the catalog works now (2026-10-09), area by area: the rule, why it is that
way, and where it lives. Decision numbers refer to [DESIGN.md](../DESIGN.md);
work units (MIU-n) to [MIU_BREAKDOWN.md](../MIU_BREAKDOWN.md).

## 1. One approved version per product

**Rule.** A buyer only ever sees what an admin approved. Each product has one
approved version: the product header (name, photos, description, facts), one
row per configuration with its own price tiers, and a price summary for the
card. Every approval replaces it with a new revision. The product list, the
product page and the quote request all ask one shared rule which version is
public (DEC-1), so they cannot disagree.

**Why.** The 21 wrong prices came from the list and the page reading two
different copies. The owner's principle (10-06): "Product detail and product
list should be the same, exactly the same thing … What gets approved can be
displayed."

```
Alibaba sync / admin edits ──► product row (working data, never shown to buyers
                                for an approved product)
                                     │ Publish = approve this product
                                     ▼
                          approved version (header + configuration rows
                          + price summary), one per product
                                     │ shared rule (resolvePublicVersion)
               ┌─────────────────────┼─────────────────────┐
               ▼                     ▼                     ▼
          product list          product page          quote request
```

**Where.** `packages/shared/src/catalog/public-version.ts` (rule);
`apps/functions/public-api/src/handler.ts` (`publicItem`: list, item, slug),
`catalog-detail.ts` (page), `packages/db/src/catalog-quote.ts` (quote).

## 2. Prices

- **Configurations carry their own prices.** A configuration (SKU) is one full
  combination of options (colour + plug + mic…). Selecting one on the page
  shows its own tiers.
- **Card price = price summary**, worked out at approval from the same
  configuration prices (DEC-2): the website price if an admin set one; else
  the cheapest configuration's lowest orderable tier (USD first, then CNY);
  else the product-level price; else "Request a quote" with the MOQ (DEC-16).
  Stored beside the page data in the same approved record (the page's schema
  rejects unknown fields inside the header, which is the only reason it sits
  beside it).
- **Alibaba's headline price** is no longer stored as a price for wholesale
  products that have configurations (DEC-5); stored data was rebuilt from
  saved Alibaba payloads without calling Alibaba (R2: 471 removed).
- **Tiers below the minimum order are never shown** (`71272a6`).
- Products sold by lot, kg or set, or priced in other currencies, show
  "Request a quote" rather than a possibly wrong price (owner: fine until a
  client needs otherwise).

## 3. Manual products

Manual products go through the same approval and get the same approved
version, API shape and page as synced ones (DEC-4, DEC-14); public responses
carry no field that tells the two apart. Their spec fields are part of the
approval fingerprint. Configurations for manual products are not supported
yet: approving a manual product that has them is refused with a clear message.

## 4. Publishing: one gate, every entry point

**Rule.** Nothing goes public without an approved version that matches the
product as it is now (DEC-15). The check runs only on writes that publish, so
editing a live product's price is saved and waits for the next approval
instead of being refused (MIU-31). Creating a product as already published is
refused while approval is on; the admin page creates a draft, then approves
and publishes it (MIU-37).

**Owner rule (10-09): publish is approval.** Every admin entry point that
publishes runs the approval itself; Edit is needed only for a real reason
(supplier changes to decide, or a missing category or photo).

| Entry point | What happens |
|---|---|
| Row Published switch | Approve + publish; a flagged product opens Edit |
| Batch Publish | Four at a time; flagged products are skipped and named |
| Edit → Save with Published ticked | Approve + publish |
| Classification "Save and publish" (single and batch) | Category saved, then guarded approve + publish carrying the saved revision (P0 fix) |
| Preview "Review changes" | Opens Edit on the Supplier changes panel |
| Create with Published ticked | Draft created, then approved and published; on failure the draft is kept and the reason shown |

**Roles.** Only admins approve. A contributor's edit to a live product is
saved as a draft change and flags the product "Edited" (OWN-1); contributors
cannot change family, category, URL slug or SKU of a live product (the public
site reads those from the row), and cannot save or publish a product flagged
"Changed" or "Removed".

## 5. Supplier changes after approval

**Flag.** Each approval records a digest of the supplier data a buyer would
see. When a later sync brings different data, the product is flagged
"Changed" (or "Removed"), with the reason shown on the admin list (DEC-6/7).
The live page keeps showing the approved version until an admin publishes
again (DEC-9). Unpublishing does not clear the flag; archiving does (DEC-11).

**Whose data wins (DEC-18 → DEC-19).** First built as "approval takes the
supplier's new text and photos unless an admin edited them". The owner
reversed it the same evening: never apply supplier text or photo changes
silently, edited or not. As built:

- **Text and photos** (description, gallery, description photos): Edit shows
  a Supplier changes panel with the website version and Alibaba's new one side
  by side, where the website version came from, and Keep / Use Alibaba's per
  part. Each decision is stored with a digest of the exact incoming value
  (`supplierDecisions`), so a newer change asks again. The flag stays until
  every part is decided.
- **Prices, configurations and specifications** always take Alibaba's latest
  on approval (stale supplier prices cause wrong quotes); the panel lists them
  old → new.

**Audit.** `auditChangesSinceApproval` / `scripts/catalog-change-audit.mjs`
compares every approved product with its supplier data (R6 flagged 9).

## 6. Configuration photos

- Tapping a photo that belongs to exactly one configuration selects it; a
  photo shared by several, or by none, only changes the big photo.
- Some listings give colours no photo of their own. In Edit, "Photos for each
  configuration" lets the admin pick gallery photos per configuration
  (`configurationPhotos`, up to 9 each); approval publishes them like any
  configuration photo (DEC-20). Existing approvals stay valid because the
  field joins the fingerprint only once set.

## 7. Speed

- **Cause:** each CloudBase request costs 0.6–3 s from outside mainland China,
  and a publish made 8–9 of them in a row.
- **One-request approval:** `catalogDetailApproval {action:'approve'}` runs
  prepare → review → begin → pages → finish inside the function (12 s budget
  within the 20 s timeout). If photos must be imported first or time runs
  out, it hands back and the browser continues the same job step by step.
- **Batch publish** runs four products at once; after an uncertain result or
  a refused session no new product starts; results keep the selection order.
- Result: about 2 s per approval, 4–6 s per publish (was 15–25 s).

## 8. Photos come with the product (PT-G and "one product, one unit")

**Rule.** A product and its photos are one unit, approved once. Photos are
copied from Alibaba into our storage on the server after each sync, before an
admin ever sees the draft, so publishing never waits for photos and never
fails on them. Admins only add or remove photos.

**A draft's states.**

| State | When | Visible to admins? |
|---|---|---|
| Preparing | New draft with photos; or a sync changed the photos of a draft whose photos are still the sync's own | No (`alibabaPhotosPending`) |
| Ready | Every photo of every part is in our storage, or known to be unavailable from Alibaba | Yes |
| Waiting | A copy failed for a reason that may pass (timeout, network error) | Nothing is written; tried again by the next photo run at least 10 minutes later; after 6 failed tries the photo counts as unavailable |
| Busy | Another product is saving the same supplier photo, or the product changed meanwhile | Nothing is written; picked up by the next photo run |
| Admin-owned | An admin edited the gallery or description photos | Sync never touches that part again |
| Approved / published | Has an approval receipt or is live | Photo job never touches it; supplier photo changes go through the Supplier changes panel |

**All or nothing per product.** The job copies every photo a product needs
first, and only then writes the product, in one guarded save (it fails if
the product changed meanwhile, was approved, or was published). If any copy
is "waiting", nothing is written for that product and the next product is
processed as normal. Photos Alibaba cannot provide (404/410, invalid or
disallowed address, too large, not an image) are skipped and listed as
"photos Alibaba could not provide", so one dead link never blocks a product.

**Why not one database transaction for fields and photos.** Copying a photo is
a download of up to several seconds; a product can have 30+ photos.
CloudBase transactions are short and limited to 100 operations, and must not
wait on downloads. So the sync writes the product's fields first and keeps
the draft hidden; the photo step makes it visible in one save once
everything is in. An admin never sees a half-prepared draft.

**When the photo job runs.** After every sync started from the Alibaba Sync
page (Run now, Create missing drafts, sync one product), when that page
opens (hidden drafts only), and on "Copy photos now". The 15-minute sync
timer is off, so a waiting product is retried only when one of these
happens; nothing retries it while nobody uses the Sync page.

**Limits.** Gallery: first 9 photos. Description: first 18; more are listed
in Edit and can be added one by one. Configuration photos are copied (not
attached) so approval finds them in storage. Approval accepts at most 46
distinct images per product; no current draft exceeds it.

**Where.** `apps/functions/alibaba-catalog-sync/src/photo-preparation.ts`
(job), `media-import.ts` (download, reasons), `packages/db/src/alibaba-product-identity.ts`
(`photosRefresh`), Admin → Alibaba Sync → "Product photos" (runs after each
sync; "Copy photos now").

## 9. Operations

| Tool | Purpose | Runs where |
|---|---|---|
| `scripts/catalog-consistency-audit.mjs --api <base>` | Card vs page for every listed product; exit 0 = consistent | Read-only, against production API |
| `scripts/catalog-price-summary-backfill.mjs` + admin action | Gave older approvals their card price (R4) | Server writes, operator-driven |
| `scripts/catalog-change-audit.mjs` + `auditChangesSinceApproval` | Flag approved products whose supplier data changed (R6) | Server |
| Alibaba Sync → observation replay | Rebuild stored offers from saved payloads (R2) | Admin page |
| `prepareAlibabaPhotos`, `photoPreparationStatus` | Photo job and its counts | Admin page / server |

**Deploy.** Merge or fast-forward the feature branch into `test` (no PR);
the Deploy Test workflow deploys functions first, then the site, about an
hour in total. Rollback = move `test` back and redeploy.

## 10. Open

- R7: owner reviews the 9 "Changed" products.
- Panel follow-ups: Alibaba description previews don't load; an old notice
  overlaps the panel; it loads in 5–10 s.
- The sync timer is off, so "Removed" and new drafts are noticed only when
  someone runs a sync; photo copying runs from the Sync page.
- Dianxiaomi import `makePublic` publishes without approval (task offered).
- Hermes / WeCom importer: should create drafts (OWN-2), not investigated now.
- Faster, tag-based deploys (deferred by the owner until this ships).
