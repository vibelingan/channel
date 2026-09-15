# CUI-09B.2 — bounded staged approval snapshots

Status: staged persistence, dedicated server workflow and read compatibility
implemented locally. **09B.2 as a whole remains in progress**: the production
source candidate producer and formal UI activation are not complete. Not a
deployment record; no push, cloud mutation or product publication in this pass.

## Runtime problem

`commitCatalogApproval` reads and writes every SKU in one transaction:
`3 + 2 * variantCount + 2 * imageCount > 98` rejects large products. Removing
that guard or publishing only the first page would violate the reviewed product.
Changing the live variant rows before the entire approval succeeds also makes
the previous approved revision unavailable.

## Data shape / ownership

- `catalogDetailApprovals`: private, actor-bound operation receipt, immutable
  prepared publication, expected page hashes, canonical IDs and advancing cursor.
- `catalogDetailVariants`: private immutable rows keyed by product/revision/SKU;
  these are approved-copy storage, not another source or new SKU identity.
- Product publication gains a storage discriminator; older snapshots retain the
  existing read path. Only final commit switches the product pointer.
- Source generations and operator-owned product fields are fingerprinted. Source
  materializers must mark incomplete before changing rows and seal the generation
  afterward. Canonical SKU editing is currently internal (`adminAccess: none`).

## Technology constraint

2026-09-09 official CloudBase `database/transaction.md` rechecked via MCP:
100 operations / 30 seconds, doc operations only. Existing installed node-sdk
transaction interface is reused; no remote fetch, media download or DDL in a
transaction. User CI/CD requirement overrides the skill's direct-resource setup.
New collections/indexes belong in the coordinated deploy preflight, not MCP writes.

## Design / flow

Server reads a complete candidate and checks the exact reviewed digest → begin
actor-bound job → validate/read/write at most 20 canonical SKUs per transaction →
seal cursor → revalidate product/source/actor/media and atomically switch pointer.
Intermediate rows remain private and the previous public revision remains readable.
Lost responses replay the same operation/page; a newer approval makes an old final
retry conflict. A changed source generation or product edit requires fresh review.
No operation publishes a draft or changes price/category/media ownership.

## Alternatives rejected

- One giant transaction: provider limit and cloud timeout.
- Overwrite the current approved SKU fields one page at a time: partial public data.
- Trust browser-submitted snapshots: bypasses source and ownership validation.
- Infer SKU IDs from labels: collisions and broken RFQ references; use bound IDs.

## Code translation / tests

The stage cursor and its immutable variant rows commit together. Final commit
reads the durable completed job, rather than trusting a browser `done` flag.
Tests cover >100 SKUs, per-transaction budget, partial failures, response loss,
concurrent approvals, wrong actor, mixed generations, stale product edits, broken
media, and immutable old revision. Add public/RFQ read compatibility before any
formal route activation. Local adapter persistence and CloudBase contract checks
are required; they do not replace the post-CI cloud acceptance.

## Implemented boundary and observed verification

- `catalog-detail-staging.ts`: 20-SKU transaction pages; actor-bound jobs;
  immutable revision/SKU rows; final product compare-and-swap; media readiness
  and lock checks. Concurrent jobs may stage, but only one can replace the same
  previous revision. A late retry cannot resurrect an older approval.
- `catalog-detail-workflow.ts`: strict review/begin/page/finish commands. Reads
  all manifest identities with at most eight concurrent DB reads, checks the
  source generation again, and derives the approved data on the server. Review
  pages are bounded to 50 rows and pinned by a digest. No browser snapshot input.
- `catalogDetailApproval` Admin action: current session/role validation, 4 KiB
  request bound, explicit validation/conflict responses. Rollout gate defaults
  off and is **not wired on in the cloud entrypoint** in this partial phase.
- Public detail and RFQ readers discriminate old in-place snapshots versus new
  immutable storage; return canonical SKU IDs, never private storage keys.
  Missing/misbound copies fail rather than produce a successful empty page.
- Local JSON adapter integration exercises authenticated Admin review → begin/page
  → injected final filesystem rename failure → retry → database reopen → finish
  → private draft gate → public pagination → RFQ save → Admin read after reopen.
- Two new collections are `ADMINONLY`, hidden from generic Admin CRUD. They and
  the exact product/revision/position/id index are declared in the normal CI/CD
  resource preflight; the explicit resource-count guard is now 23, not 21.
- A stale-review gap was exposed and fixed: the review digest now includes
  manual/source mode, manual tiers, scalar prices, MOQ and source-price projection.
- Visual regression inspection caught an unrelated-to-layout but material copy
  error: unsaved editor prices said “Currently shown on the website”. The existing
  price card now says “Website price preview” and explains that unsaved values
  are not live. Static rendering and browser assertions cover this distinction.
- The installed CloudBase database runtime was independently driven with an
  insert acknowledgement (`updated: 0`, `upsert_id`). It returns
  `upserted: [{ _id }]`; the adapter verifies that exact identity and aborts on
  missing/wrong acknowledgement. This is now an executable SDK contract probe.

Focused tests: 11 staged/workflow tests, the reopened local integration test and
the immutable CloudBase RFQ case passed. The local integration is a real handler
and file DB test, **not a browser or live CloudBase transaction test**.
The previous 15-case production-build Chromium repair suite was rerun successfully
with `CI=true`, including its eight controlled HTTP edge cases. It does not yet
cover a newly activated ordinary-route approval → buyer → Admin UI journey.

Final local verification after the editor-copy correction: **1,454 workspace and
deployment-contract tests passed, 0 failed, 0 skipped**; all workspace/E2E types
and Biome (553 files) passed. Astro reported 0 errors, 0 warnings and its existing
8 hints. The production-build Chromium suite passed all 15 cases again, and the
390px screenshot was visually inspected with the new preview label. The 105-SKU
fixture is synthetic contract-test data, not a newly synced live Alibaba product.

Logs: `/tmp/channel-staged-approval-20260909-tests.log`,
`/tmp/channel-staged-approval-20260909-types.log`,
`/tmp/channel-staged-approval-browser-20260909.log`,
`/tmp/channel-staged-approval-sdk-20260909.log`,
`/tmp/channel-staged-approval-functions-20260909.log`.
Bundled admin/public-api/sync cold-start and legacy catalog behavioral smoke
passed offline; no SDK-stub test is claimed as live persistence evidence.

## Remaining release-critical dependency closure

1. Production candidate producer for Alibaba and Excel observations, canonical
   SKU bindings and complete source-generation seals. Current ready candidates
   come from the local workspace pipeline, not ordinary cloud sync.
2. Durable source URL → owned image identity mapping. Do not guess a historical
   SKU image binding from gallery order. Preserve approved media visibility while
   an operator edits the next draft; integrate and test that reference lifecycle
   before enabling the immutable public path.
3. Carry the confirmed manual-price policy into the common approved detail/UI/RFQ
   contract. Current common `offers` are explicitly source quotes; a manual
   website price must not be relabeled as a supplier quote. The legacy formal
   resolver repair is already separate, local, tested work.
4. Normal list/detail URLs, authenticated Admin approval controls and public RFQ
   transport; production-build whole-journey and negative-case browser acceptance.
5. Commit the dependency-closed workstream, review and pass exact-SHA CI, integrate
   test, then deploy resources/functions/config/static frontend together. Finally
   verify live behavior and release IDs. No direct function-only deployment.

## Current website check (2026-09-09, read-only)

`https://supplychainsai.com/headphones/` returned HTTP 200. The served HTML's
Last-Modified was `Fri, 04 Sep 2026 09:25:40 GMT`; it loads
`CatalogFamilyPage.BtqDySZ7.js` and `Gallery.D3j5KK6G.js`. The latter already has
`tiered` and `range` rendering branches and a pricing-unavailable message. Thus
“the website has no range/tier UI at all” would be inaccurate. This proves code
presence only, not correct current data for every product; this pass has not
released the new pricing policy, data fixes or common-detail experience.
Web retrieval and browser-control initialization failed; ordinary HTTPS reads
provided the above evidence. No browser visual/live RFQ acceptance is claimed.
