# Admin bulk Publish: HTTP 400 incident

Date: 2026-09-08. Scope: the existing product admin's Publish/Disable actions.
This is not approval of the new canonical storefront or RFQ release.

## Diagnosis

The reported payload uses `action: batchUpdate`, `collection: products`, IDs and
`values: { published: true }`. The IDs and boolean are not the contract mismatch:
the product collection explicitly rejects the generic batch action with
`BAD_REQUEST: Products must be updated individually.` The same guard exists in
the current branch and `origin/test`.

`CollectionView` called the generic batch action and did not render the batch
mutation error. Single-row update errors were also invisible unless its edit
dialog was open. Together these produced HTTP 400 with no actionable feedback.

The guard is intentional. Product writes use individual validation, catalog
identity transactions and image-reference handling. Removing the guard would
bypass the safe product write path. Classification is a separate publication
requirement; it is not why this generic request was rejected.

The live admin was inspected without modifying products. The selected Headphones
rows show Alibaba source image previews. A source preview is not an attached,
managed `imageIds` gallery. A product still needs its required fields and an
imported primary image before it can publish. The existing Edit action supports
Import primary image, followed by Save. The hotfix does not auto-import images,
relax publication rules or publish any real inventory.

## Fix

- Products use the existing authenticated `update` action, one product at a time.
  IDs are deduplicated, bounded to the existing 20-row page, and the operation is
  restricted to a boolean publication change. Other collections retain their
  existing batch protocol.
- Known business rejections are reported per product. Confirmed successes remain
  saved; only their selection is cleared. Failed items remain selected.
- Authentication rejection stops the batch. A timeout, transport/server failure
  or mismatched response is **unconfirmed**, not evidence of rollback; remaining
  items are not attempted. No automatic retry is made.
- The admin displays progress, the success count and the affected product names
  and reasons. Single-row errors are visible on the list. Conflicting row
  Publish/Edit/Delete controls are disabled while a batch is in flight.

No backend, schema, CloudBase SDK or authentication protocol change is part of
this fix. Classification and RFQ work already present in the dirty workspace is
kept separate.

## Verification performed

The new API and component tests were first observed failing before the fix.
The integration test uses the real function HTTP adapter, handler, JWT verifier,
business validation and file-backed database; only the network boundary is
bridged. It proves the old request returns HTTP 400 and the new flow persists one
valid product while retaining missing-category and missing-image drafts. It
reopens the database, checks image public-reference counts on publish/disable,
and confirms a suspended operator cannot continue writing.

Additional cases cover duplicate IDs, empty/oversized batches, invalid values,
mixed outcomes, authentication expiry, lost response, mismatched success response,
and unchanged non-product behavior.

Local browser acceptance used only synthetic records on ports 4330/3008:

1. A rejected draft shows its name and missing description/image reasons.
2. A mixed batch shows `1 published · 1 need attention`; the failed item remains
   selected and the ready row changes to Published.
3. The ready fixture was subsequently disabled through the UI. Both test records
   were verified unpublished in the local persisted database afterward.

Evidence: `/tmp/channel-publish-browser-20260908.png` and
`/tmp/channel-publish-browser-acceptance-20260908.txt` (local-only synthetic data).

The staged hotfix was exported to `/tmp/channel-publish-index-K50Kfy` and installed
with its committed frozen lockfile, excluding unrelated uncommitted changes:

- Full tests: 1,249 passed, zero failures/skips.
- Site tests within that snapshot: 259 passed.
- Repository lint and full typecheck: passed.
- Production site build: 15 pages, passed.
- Current combined working tree site tests: 340 passed (different scope).

These are local results, not cloud deployment acceptance. Local Node 25 used
`--no-experimental-webstorage`; the production cloud runtime is not Node 25.

## Release gate — not yet deployed

Observed remote state before release:

- `origin/test`: `73fd85b420037e1dc15f73cebb11cd2d05c96080`.
- Current source baseline: `60b051b` on `fix/alibaba-sync-storage-wiring`.
- Live admin/public-api health: `cui06d-60b051b-20260907-r2`, built
  `2026-09-07T03:58:42.295Z`. That earlier release included uncommitted code.
- The existing Deploy Test workflow deploys resources, all functions and the
  whole frontend. It does not offer an admin-static-only scope.

Blindly pushing an integration to test would risk replacing newer live functions
or including unfinished UI/RFQ/category work. No direct MCP/CLI cloud deployment
was performed. No cloud product was published for testing.

Recommended release exception, requiring confirmation of the narrower pipeline:
run same-SHA CI, build an explicitly reviewed admin-only artifact, upload its
hashed dependencies first and switch only the admin entrypoint last. Retain old
assets and the prior entrypoint for rollback. Do not deploy functions, resource
migrations, public product pages, feature flags or secrets. Verify the existing
admin actions and unchanged backend release IDs after deployment. This pipeline
does not exist yet; do not mistake this recommendation for a completed release.

## Token question

`token` is the website operator's session JWT, not an Alibaba access token, app
secret or JWT signing secret. It is signed (not encrypted), carries identity
claims, defaults to 12 hours and is checked server-side together with the current
account state. Seeing one's own credential in DevTools is expected. The JSON POST
body is transported over HTTPS; moving it to Authorization alone would neither
hide it from DevTools nor solve browser storage exposure.

The full bearer credential must not be shared in screenshots, HAR files or logs.
This investigation did not copy the real token into code or reports. Source review
found no deliberate request-body/JWT logging in the function entrypoints; cloud
gateway/logging configuration was not independently audited.

Existing `localStorage` session storage remains a real XSS/extension exposure
risk. A separate coordinated authentication change should consider server-managed
HttpOnly/Secure/SameSite cookies plus CSRF protection. Do not silently change the
frontend transport alone: the current backend expects the body token.

References: [OWASP Web Storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/HTML5_Security_Cheat_Sheet.html#local-storage),
[OWASP logging exclusions](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html#data-to-exclude).
