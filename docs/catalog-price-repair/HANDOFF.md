# Catalog Price Repair Handoff

Status: investigation handoff only. No new repair implementation or live data
repair was performed for this handoff. Scope is the whole product catalog.
Owner instruction: fix and deploy completed price-repair work independently of
the separate subcategory and numbered-pagination feature.

## 1. Start Here

- Branch: `feat/catalog-price-repair-handoff` (implementation-ready branch, not
  the already merged Alibaba UI branch). Continue here or preserve its commits
  when handing work to another branch.
- Local worktree: `/Users/SeanCai/Desktop/projects/channel/.claude/worktrees/catalog-price-repair`.
- Starting main: `ba3cd6296cddf3eb0fd67866b0819cd7b0db33bd` (PR #55 merged).
- Last observed test: `75475b1bb1bf6f6b02f596909f57839a27d0f451`.
- Fetch current main/test before implementation and before every merge/push.
  Other agents can advance them. Preserve AI and catalog work. Never merge test
  into main; never force-push or reset someone else's worktree.
- Read repo AGENTS.md and the applicable engineering-craft/CloudBase contract
  rules. No worktree cleanup is authorized as part of this handoff.

## 2. User Scope and Non-Negotiables

The user explicitly corrected the earlier proposal to fix only five pictured
products. Those products are examples, NOT an execution allowlist or success
denominator. Inventory all products, across families and publication states;
classify archived/non-linked/manual/valid-source/no-price cases rather than
silently ignoring them. Repair every eligible affected record in bounded batches.

- Use each product's own valid Alibaba offers and existing offer-selection policy.
  Never guess an amount/currency, copy from a similar name, flatten a quantity
  tier into an unconditional price, or choose a different source/SKU silently.
- Never overwrite manual pricing, publication, images, classification, approved
  detail snapshots/receipts, source-link ownership or other curated fields.
- Missing pricing does not always mean a bug: explicit negotiable/unavailable
  source data or an incomplete manual override may legitimately require a quote.
  Report such outcomes; do not make every card show a number to pass acceptance.
- If a source/product/link/offer identity or revision changes after planning,
  stop the affected batch, record the conflict and replan. Missing/invalid quotes
  or unfinished/quarantined provenance must not be force-applied.
- Validate API output and real card/detail rendering after repair. Include all
  repaired records in machine verification and representative actual browser
  checks, not just the original screenshots.
- This turn authorizes writing/pushing the handoff. It does not execute repair,
  deployment, category changes, supplier sync, publication or cleanup.

## 3. Evidence and Confidence

### Reverified in this handoff

At `2026-09-17T01:47:29.364Z`, anonymous pagination read all **107 public products**.
The actual page size is 48. Product count is a current sample, not a future cap.
The following real public products had no exposed scalar/manual/source-pricing
fields, but did expose Alibaba linkage/status metadata:

| Public product ID | Name identifying the observed record |
| --- | --- |
| 0e18d7ff-8a92-45b8-aa3d-461634880ac8 | Adjustable Wired Over Ear Headphones With Mic, blue |
| 6938b213-f90d-4974-a571-74799cbaa292 | On-Ear Over-Ear Sports Wired Headphones, students |
| a7f1b2dd-3d68-46f5-a566-ae7add1c80f5 | KH3 New Original Kin, wired unicorn/cat-ear headphones |
| aa8e67be-0b92-4a14-a438-17840153abee | Over-Ear 3.5mm Plug Wired Music Earphones, kids |
| b0c5c97b-9557-408d-adfb-53bd4ebc3a2a | Earphones & Headphones Wired Headset 3.5mm Wired Kids |
| c4c02e11-89e6-4e24-abb0-594539690005 | Earphones & Headphones Wired Headset 3.5mm Wire Kids |

The last two are distinct matching records; do not assume which one was in the
original screenshot. The scan also found other matching-title source-linked
records without price fields, so the issue is not limited to this table.

Contrast: `0e0afdc26a68204700523563353480a1` has the same blue-headphone title and
public `unitPrice: 3.2`, `wholesalePrice: 3`. It is NOT the missing-price record
`0e18d7ff...` and is not an authorized price source for it.

Source inspection confirms the card deliberately displays an unavailable/quote
state when its pricing resolver cannot validate the source summary. Missing API
amounts cannot be fixed by increasing card height. A separate visual check is
still required for records whose API already has a valid amount.

### Prior conversation findings: reverify before any write

The previous session reported that five old products retained valid source offers
and approved details while product `alibabaCatalogPricing` was absent. It cited
completed September 3 sync provenance, G2 USD 2.90 and KH3 USD 3.95, and a local
replay that preserved curated fields. Those private-row snapshots and replay logs
were NOT found in this clean worktree or the narrow temporary-artifact search.
Treat these as reported leads, not executable fixtures, verified current prices,
or proof that a production-safe repair has already been implemented.

Before handoff changes this worktree was clean at main. The current input schema
still accepts only afterId; no product-ID-scoped extension or new repair code was
present. Do not report the earlier proposed extension as completed.

## 4. Current Code Path

| Owner | Existing behavior / why it matters |
| --- | --- |
| `packages/shared/src/catalog/resolve-pricing.ts` | Manual/source precedence. Invalid or empty explicit manual mode must not silently inherit a source price. |
| `packages/shared/src/catalog/alibaba-pricing-adapter.ts` | Public source-pricing validation and unavailable decision. Public shape differs from private offer provenance. |
| `packages/alibaba-catalog-sync/src/alibaba-pricing.ts` | Private materialized pricing schema: fixed/range/tiered/negotiable/unavailable, integer minor units, currency and tier constraints. |
| `apps/functions/public-api/src/handler.ts` | Public product projection; verify where the pricing summary and linkage are selected/redacted. |
| `apps/site/src/islands/shop/EffectiveCatalogPricingBlock.tsx` and `CatalogFamilyGrid.tsx` | List/card price presentation; compare with shared detail quote rendering. |
| `apps/functions/alibaba-catalog-sync/src/pricing-repair.ts` | Existing `repairMissingSourcePricing`, 20-product keyset batches using `_id > afterId`; obtains/renews/releases primary sync lease. |
| `apps/functions/alibaba-catalog-sync/src/handler.ts` | `repairSourcePricing` action behind current live-admin authorization and strict `PricingRepairInputSchema`. |
| `apps/functions/alibaba-catalog-sync/src/promotion.ts` | Loads current link/product/observation/offers, applies operator pin, builds candidate and calls fenced `mutateAlibabaProduct`. |
| `apps/functions/alibaba-catalog-sync/src/linking.ts` | Captures product/link expectations and builds source review from observations. |
| `packages/db/src/alibaba-product-identity.ts` | Transactional revision/link/lease validation and allowed product patches. |
| `apps/functions/alibaba-catalog-sync/src/pricing-repair.test.ts` | Existing synthetic repair/auth/idempotence test; not full-catalog or all-protected-field acceptance. |

Collections to inspect through the existing protected access path: products,
alibabaSourceProducts, alibabaProductLinks, alibabaSupplierOffers, alibabaSyncRuns,
and source observations used by the normalizer/promotion. Do not dump raw supplier
payloads, OAuth/session credentials or complete private product records into Git.

## 5. Do Not Run the Existing Repair Blindly

Observed limitations of the existing repair, to address or explicitly account for:

1. It skips any own alibabaCatalogPricing property, even null, malformed, stale or
   unavailable. A full audit must classify these separately rather than conclude
   all missing displays are repaired after filling absent fields.
2. It skips archived and unlinked products without per-record reasons. Whole
   inventory accounting must include them while preserving their no-write status.
3. It admits completed lastSeenRunId/lastChangedRunId evidence, then invokes
   promoteLinkedProduct(sourceKey), which rereads the link/product. Prove that the
   planned product cannot be replaced by a different linked product between scan
   and execution; bind original product ID, revision and link identity throughout.
4. Promotion also builds source-review, source-category, source-image and source-
   description-image updates. A generic promotion is NOT automatically a price-
   only patch. Missing observations can produce empty source-image arrays.
   Prove the patch allowlist meets preservation requirements or narrow the repair
   operation while reusing canonical offer selection and transactional protection.
5. It increments repaired for every successful promotion, not specifically a
   validated available-price change. An unavailable candidate/no-op must not count
   as restored card pricing. Report changed, already-correct and deferred outcomes.
6. The sync lease is renewed between items, not proof that all source/link/manual
   state stayed fixed. Transactional expectations and lease checks must be enforced
   at the write; no external side effects inside retryable transaction callbacks.
7. nextId can require an extra empty page at a batch boundary. Traverse until null,
   persist checkpoints, and re-audit after concurrent additions/edits. Do not use
   one page, a public-only list, or a hardcoded five-product denominator.

## 6. Implementation and Execution Sequence

1. Inventory without mutation. Scan the whole products collection using stable
   keyset paging. Separate read budget from total catalog scope; checkpoints allow
   arbitrarily many bounded batches without treating an old sample count as a cap.
2. Resolve each product's current pricing authority and linked source evidence.
   Classify: valid manual, invalid manual, valid source, absent summary with valid
   evidence, invalid/stale summary, legitimate quote-only, unlinked, archived,
   incomplete/quarantined run, invalid pin, identity conflict, or fetch failure.
3. Produce a dry-run manifest: product ID, expected revision and source/link/run
   identities, input/proposed hashes, candidate price/currency/tier provenance,
   intended allowlisted changes, protected-field hashes, and reason/status. Keep
   sensitive raw evidence in restricted local storage, not tracked documents.
4. Test original failing cases and all relevant classes before implementation.
   Keep any IDs option as diagnostic/replay convenience, not the user-facing scope.
   Add an auditable resumable whole-catalog operation, including per-row outcomes.
  Trace normal sync completion, initial linking/draft creation, raw replay and
  detail approval/publication separately: determine where these historical rows
  missed price materialization. Prevent the same omission on future writes using
  the existing pricing owner, without making detail approval mutate unrelated
  product fields. Do not close the incident with only a one-time backfill.
5. Deploy the minimal safe repair separately through normal CI/review/deployment.
   Verify exact release SHA and paused/idle sync constraints without changing
   scheduler configuration or running a fresh supplier sync as a hidden workaround.
6. Apply only currently eligible manifest entries through the authenticated repair
   path with fenced/revision-checked writes. Stop on lease loss, stale identity,
   ambiguous acknowledgements or invalid evidence. Re-read before retrying; never
   overwrite a manual edit that occurred since dry run.
7. Re-read every applied product, public projection for published records and
   private preview for drafts. Preserve all protected fields byte-for-byte apart
   from an explicitly documented internal concurrency revision/timestamp change.
8. Run browser checks on real repaired cards/details at desktop and mobile widths,
   all product families represented, and all supported price modes. Test manual
   controls and same-name distinct products, currency/unit/tier labels and overflow.
9. Repeat the inventory. Account for every initial record and new/changed records:
   repaired, unchanged/manual, legitimate quote-only, deferred/review-required,
   conflict or error. Zero unexplained eligible missing prices is the objective,
   not an impossible requirement that every supplier publish a numeric price.

## 7. Required Regression and Acceptance Coverage

- Absent versus present-null/invalid summary; valid source fixed/range/tiered;
  negotiable/unavailable; missing currency; invalid/overlapping tiers; unsupported
  precision; zero versus unknown; conflicting currencies; inactive offers/pins.
- Existing manual tier/scalar/explicit manual-empty mode unchanged; explicit
  source mode obeys its policy; same-name records never share prices by inference.
- Current source/link/run identity, relink-to-another-product, unlink/relink ABA,
  concurrent manual edit and lease expiry/takeover between planning and write.
- Completed versus incomplete/quarantined/changed provenance; missing observation
  does not clear image/category/review metadata. Price patch never changes approved
  detail content or receipt, even if the generic promotion would rebuild metadata.
- More than 20/48/100 products, empty final page, retries/resume, newly added rows,
  stable cursor, changed-after-plan rows, partial success and uncertain transport.
- Permission revoked after login; invalid inputs; audit outcomes and changed/no-op
  counts; second run idempotent; failed page cannot be reported as full completion.
- Final API amount matches effective card resolver and approved detail authority.
  No exposing private offer/source identifiers just to make frontend validation pass.

## 8. Tools, Validation and Delivery

- Existing focused check from `apps/functions/alibaba-catalog-sync`:
  `node_modules/.bin/tsx --test src/pricing-repair.test.ts`.
- Use the repo's existing pnpm and inspect installed metadata first. Root scripts
  invoking npx pnpm may resolve a different major. Do not reinstall another active
  worktree's node_modules or change global toolchain settings.
- Run root/E2E types, affected package tests, Astro checks, Biome, deployment
  contract tests and normal craft/review gates. CloudBase SDK changes additionally
  require official docs plus installed-package verification per repo policy.
- Deploy via the existing test workflow only after review and same-SHA CI. Recheck
  remote main/test and shared deployment activity immediately before each push.
  Preserve already merged AI services/site configuration and all other work.
- Prove actual cloud API/UI results; an installed tool or green local mock is not
  evidence a repair ran. Keep deploy logs, manifest/result totals and screenshots.
- Merge the main-based feature through its PR after acceptance. Report each scope
  and outstanding deferred record honestly; do not wait for unrelated UI features.

## 9. Handoff Validation Record

- Original `pricing-repair.test.ts`: 1 passed, 0 failed, 0 skipped, executed in
  this worktree on Node 24.14.1. It covers synthetic completed-source repair,
  existing-price/quarantine behavior, selected curated fields, permission checks
  and repeat execution. It does not establish all-record production safety.
- Root TypeScript and E2E TypeScript passed; repository Biome checked 711 files
  with no errors. Documentation diagnostics found no errors.
- The only file added by the handoff is this Markdown document. No application
  code, fixtures, environment configuration, hooks or gate baselines changed.
- Public evidence was read anonymously; no live admin/data mutation, repair,
  deploy, workflow dispatch, main/test update or worktree deletion occurred.
- No new price-repair tests or code are implied by this documentation commit.
  The previous five-sample replay remains reported/unverified until its evidence
  is rebuilt. The next agent owns implementation and full acceptance.