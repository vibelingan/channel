# Alibaba Wiring Closeout - Execution
Status: R1-R3 and late fixes implemented locally; final validation running. Commit, push, merge and deployment are authorized only after passing gates; none performed yet.
Branch: `feat/alibaba-wiring-closeout`

**Current phase:** `validate`.

**Current/next MIU:** R1-R3 implementation complete; collect final validation for source snapshots, frozen quarantine and Admin acknowledgement, then independently review the final tree.

Final review addendum: multi-source quarantine approval now retains all frozen
link checks while promoting only the frozen primary source. Both source orderings
and secondary-link changes are covered. The complete focused sync-function suite
passed 168 tests. Independent assumption and transaction/test reviews reported
no concrete remaining P1/P2 finding. The frozen final command is running all
package/script tests, types, lint, SDK verification and both local production-build
browser lanes; its results are not inferred from the earlier subset.

Date: 2026-09-15. The user approved continuing on September 15. This record
supersedes the old "R1-R3 open, await design approval" status, not the release
hold. See [REVIEW-AND-HANDOFF.md](REVIEW-AND-HANDOFF.md) for launch criteria and
the DNS, mail, certificate and separate AI-PR handoff.

## Authority and Evidence

- Base: main `78506d525eefcd6410ff0d85a1a020d834f4ab02`; worktree:
  `.claude/worktrees/alibaba-wiring-main`.
- Caller-reported reconstruction: 471 staged files, no new commit, no test-branch
  ancestry. The initial reconstruction matched accepted `9e3de08` / wiring
  `bcee8f2` except four retained main files: the gate baseline and three SEO
  documents. New implementation changes are closeout fixes only.
- Shared catalog-import and product UI dependencies belong to the accepted
  Alibaba implementation. Their presence is not permission to add unrelated
  features. AI PR [#53](https://github.com/vibelingan/channel/pull/53), reported
  latest head `5f6099f`, remains active and separate; do not merge it.
- The entries below summarize the current files actually read. Phase labels
  organize this handoff; they do not invent commit boundaries or separate
  approvals. No Git inspection was performed in this documentation pass.
- Tests present in source are coverage evidence, not proof of execution. The
  caller reports focused passes and full final tests running. Inspected saved
  output is identified separately below; no final suite totals are inferred.
- Only the two closeout Markdown files were written. No terminal, Git, cloud,
  DNS or browser operation was run, and no local pipeline pointer was changed.

## Completed Implementation Phases

### R1: Shared Atomic Product Identity

**What:** The shared
[packages/db/src/alibaba-product-identity.ts](../../packages/db/src/alibaba-product-identity.ts)
operation compares the expected product revision, primary source and exact link
identities before writing. Unlink clears Alibaba-owned fields and removes matching
links in one transaction. Link, pin, reconciliation, draft creation and promotion
share this operation; promotion additionally verifies lease ownership and expiry.
Legacy missing revision means zero; corrupt revisions and incomplete identities
fail closed. The explicit link limit is 40, with over-limit detection rather than
silent truncation.

**Why:** A product must not retain supplier pricing after its link is removed,
and a stale writer must not restore it after another operator relinks the product.
The former separate writes could fail halfway; reversing their order would only
change which partial state customers saw.

**Tests written:**
[apps/local-server/src/alibaba-product-identity.test.ts](../../apps/local-server/src/alibaba-product-identity.test.ts)
covers local and simulated-cloud behavior: rollback on write/commit failure,
unlink retry, conflicting relink/promotion, exact and excessive link sets,
malformed identities, draft/claim repair, pin validation, lease checks and
preservation of manual prices, media and publication.

**Validation result:** Implementation and regression assertions inspected;
focused validation reported by the caller. The cloud harness is a typed local
transaction double, not CloudBase acceptance. Final suites remain pending.

**Result:** Local implementation complete; not cloud validated.

**Engineering rationale:** Both
[packages/db/src/cloudbase-adapter.ts](../../packages/db/src/cloudbase-adapter.ts)
and [apps/local-server/src/json-adapter.ts](../../apps/local-server/src/json-adapter.ts)
execute the shared rules. The cloud adapter uses a native transaction and checks
write acknowledgements; the local adapter mutates a copy under its existing lock
and restores memory on persistence failure. Bounded link enumeration happens
outside the native transaction, followed by revision and per-link rereads inside.
This relies on every participating writer updating the same product revision;
a separate unlink-only lock would not protect against other writers.

**Build/deploy/runtime impact:** Shared DB code affects the sync function, Admin
and local server through the workspace package. Local adapter behavior and the
cloud adapter wrapper have executable tests; final consumer typechecks, packaged
function/runtime checks and live transaction behavior still require evidence.

### R1: Source Writers and Early Identity Snapshots

**What:**
[apps/functions/alibaba-catalog-sync/src/linking.ts](../../apps/functions/alibaba-catalog-sync/src/linking.ts)
routes link/unlink, draft creation/legacy claim repair, reconciliation and pin
through the atomic operation.
[apps/functions/alibaba-catalog-sync/src/promotion.ts](../../apps/functions/alibaba-catalog-sync/src/promotion.ts)
uses the same identity checks plus the current lease. Product/link expectations
are captured before reading supplier source/observation data and remain the
expected values for the later write.

**Why:** Capturing the revision after slow source reads could pair stale supplier
data with a newer revision and overwrite a promotion that had already completed.
All source writers must protect the same product, not just explicit unlink.

**Tests written:**
[apps/functions/alibaba-catalog-sync/src/linking.test.ts](../../apps/functions/alibaba-catalog-sync/src/linking.test.ts)
rejects direct-write bypasses, revision/membership/timestamp changes, malformed
links and oversized sets. Late regressions pause source or observation reads,
commit a newer promotion, and assert the stale link/draft operation fails without
overwriting it. Adapter tests cover concurrent draft repair, reconciliation and
pin. Existing drafts retain manual content and review state; new drafts remain
unpublished.

**Validation result:** Current ordering and tests inspected; focused passes
reported, full final tests pending.

**Result:** Caller paths implemented, including the late snapshot timing fix.

**Engineering rationale:** Hold the original expectation rather than refreshing
it to whatever revision happens to exist just before the write. Atomic draft/link
creation also avoids orphan claims; conservative conflicts require a fresh read
instead of silently adopting a concurrent operator's identity.

### R1: Frozen Quarantine Approval

**What:**
[apps/functions/alibaba-catalog-sync/src/runner.ts](../../apps/functions/alibaba-catalog-sync/src/runner.ts)
and [apps/functions/alibaba-catalog-sync/src/quarantine.ts](../../apps/functions/alibaba-catalog-sync/src/quarantine.ts)
use the versioned `alibaba-quarantine-identity-v2` hash. Candidates include the
product ID, revision, primary source and exact links, not just supplier keys.
Approval acquires the lease before verification and retains the verified
expectations for each promotion. It rejects changed identities and old-format
hashes; the final approved-status write also checks the lease.

**Why:** The same supplier key can be unlinked and relinked to the same product,
even with the same timestamp. A key-only hash misses that change. Re-reading a
fresh expectation after verification would also allow approval of a product the
operator did not originally approve.

**Tests written:**
[apps/functions/alibaba-catalog-sync/src/runner.test.ts](../../apps/functions/alibaba-catalog-sync/src/runner.test.ts)
covers relinks to the same or another product before approval, at lease
acquisition and after hash verification; legacy hashes; partial promotion retry;
lease takeover at product/final-status writes; and normal-promotion parity.
The success test distinguishes actually changed products from unchanged ones.

**Validation result:** The inspected red log demonstrates the prior incorrect
approval of stale candidates. The current implementation and regressions are
present; later focused passes are caller-reported. No full final or live-cloud
pass is asserted.

**Result:** Local frozen-identity fix implemented. Approval still does not apply
tombstones, meaning proposed supplier removals; those require a fresh full run.

**Engineering rationale:** Fail closed instead of upgrading old approval hashes
or refreshing expectations during retry. This is not a batch-wide transaction:
earlier product writes can remain if a later one fails. The run stays unapproved,
no success alert is sent, and its original hash prevents silent retry against
new revisions. Recovery is a fresh synchronization and review, not editing the
saved approval hash.

### Late Fix: Admin Review Acknowledgement

**What:**
[apps/functions/admin/src/handler.ts](../../apps/functions/admin/src/handler.ts)
passes expected Alibaba revision and primary source into the atomic catalog
product save for explicit acknowledgement and publish/archive acknowledgement.
[packages/db/src/adapter.ts](../../packages/db/src/adapter.ts) checks those
expectations against the current product before validation or identity writes.
Repeated acknowledgement preserves the first reviewer's timestamp and identity;
ordinary edits remain ordinary edits rather than acknowledging a new source.

**Why:** A separate read followed by an unconditional review write could mark a
new supplier source as reviewed, or overwrite another administrator's review.
Happy-path acknowledgement tests do not force that interleaving.

**Tests written:**
[apps/functions/admin/src/handler.test.ts](../../apps/functions/admin/src/handler.test.ts)
injects relinks and competing reviews at the write boundary for mark, publish and
archive; checks non-admin rejection, unrelated edits and legacy idempotence.
[packages/db/src/catalog-product-save-plan.test.ts](../../packages/db/src/catalog-product-save-plan.test.ts)
checks revision/source conflicts, corrupt revisions, first-review preservation
and legacy revision zero independently of the handler.

**Validation result:** A saved focused handler log was inspected and passed its
selected cases, but it predates additional cases visible in the current file.
Supplied terminal context also reports a DB typecheck exit of zero. Neither is
evidence that all current Admin/DB tests or workspace checks have completed.

**Result:** Late Admin fix implemented; final validation and live checks pending.

**Engineering rationale:** Use the existing transactional save so publication,
slug/SKU identity and review checks use the same current product. Do not add an
independent review write that can race the save or broaden acknowledgement to
unrelated product edits.

### R2: Fail-Closed Deployment Resource Checks

**What:**
[scripts/cloudbase-deploy-resources.mjs](../../scripts/cloudbase-deploy-resources.mjs),
imported by [scripts/deploy-cloudbase-test.mjs](../../scripts/deploy-cloudbase-test.mjs),
rejects explicit negative tool envelopes, requires known array-shaped route and
trigger readback, validates entries before mutation, and compares final timers by
name, type and schedule.

**Why:** A successful process exit is not proof that a cloud operation succeeded;
a same-name timer can still have the wrong schedule. Missing readback must not
become an empty list that authorizes a write or a false success.

**Tests written:**
[scripts/cloudbase-deploy-resources.test.mjs](../../scripts/cloudbase-deploy-resources.test.mjs)
covers negative query/create/delete results, malformed/missing lists and fields,
transport failures, timer drift, ineffective deletion and valid explicit empty
lists. Manual-only desired triggers remain manual-only.

**Validation result:** Implementation and mocked regressions inspected; focused
passes reported, final script suite pending. No gateway or timer was mutated.

**Result:** R2 implemented locally, not live exercised.

**Engineering rationale:** An injectable helper tests the actual deployment
decisions without requiring infrastructure credentials or intentionally failing
a live deployment. Compatibility with envelopes lacking `success` is retained
where the required readback is valid; explicit failure never becomes success.

**Build/deploy/runtime impact:** The deploy script now imports this helper. Final
script tests and delivery-context validation remain required; this changes deploy
control flow, not application feature flags or permission to enable scheduling.

### R3: Shared Test-Environment Serialization

**What:** [.github/workflows/e2e.yml](../../.github/workflows/e2e.yml) now shares
`cloudbase-deploy-test` and `cancel-in-progress: false` with
[.github/workflows/deploy-test.yml](../../.github/workflows/deploy-test.yml).

**Why:** Suite-specific E2E queues previously allowed independent writers to
overlap each other or a deployment in the same test environment.

**Tests written:**
[scripts/deploy-ci-gate.test.mjs](../../scripts/deploy-ci-gate.test.mjs) parses the
actual YAML and rejects suite/ref-based partitioning, cancellation and environment
mismatch while retaining same-SHA CI and acceptance-only deployment gates.

**Validation result:** Workflow values and executable regression inspected;
focused pass reported, final script/CI results pending. No workflow dispatched.

**Result:** R3 implemented locally.

**Engineering rationale:** One static environment-wide group covers both
workflows. This protects participating GitHub jobs, not arbitrary console or
local-script mutations; operations must still use the controlled delivery path.

## Deviations

| Area | What diverged and why | Conservative choice | Alternative not taken |
| --- | --- | --- | --- |
| Reconstruction scope | Accepted Alibaba behavior depends on shared catalog-import and product UI work; promoting only the raw-storage initializer would omit runtime dependencies. | Retain the coherent accepted implementation, exclude test history and retain main's four metadata/docs files. Validate sync, Admin, public API, local server, site and function artifacts in their real build contexts; final evidence pending. | Merge the test branch or cherry-pick an incomplete runtime slice; neither preserves the required ancestry and behavior. |
| R1 writer coverage | Protecting unlink alone would leave draft repair, pin, reconciliation, promotion and Admin acknowledgement able to race it. | Share identity/revision checks and capture source expectations early; keep ordinary edits and manual/publication ownership unchanged. | A lock ignored by other writers, or refreshing stale expectations immediately before writing. |
| Quarantine compatibility | Source-key-only hashes cannot prove which product identity was approved; partial writes also change revisions. | Reject legacy or superseded approvals and require fresh synchronization/review. | Rewrite stored hashes, silently upgrade old approval or claim batch-wide rollback that is not implemented. |
| Test-only provisional validation | Deterministic race and failure coverage uses typed adapters, cloned read snapshots and injected failures. Test-only fixture/harness corrections are provisional validation work, not runtime fixes or production proof. | Preserve failure assertions, distinguish red evidence from selected green output, and rerun the complete current tests plus real build/browser/cloud checks before release. | Soften expected conflicts, treat a repaired test double as a fixed production path, or claim full validation from a passing subset. |
| R2 readback strictness | Negative envelopes were not the only false-success path; unknown/malformed readback could look like no existing resources. | Reject unknown shapes before mutation, accept explicit empty arrays, retain known successful envelope compatibility. | Guess an empty state or reproduce failures by mutating live gateways/timers. |

These entries record scope and validation trade-offs, not new delivery approval.
No exact sequence of provisional test edits is inferred from the current file
contents. Final independent review must check the actual diff and test evidence.

## Validation Ledger

| Evidence | What it establishes | What it does not establish |
| --- | --- | --- |
| Accepted release `9e3de081180d51494cad3dffb674bef2911387b9`, full run [34820973421](https://github.com/vibelingan/channel/actions/runs/34820973421) | Prior cloud catalog/Admin acceptance, including a TEST ONLY RFQ handled manually with email disabled; recorded same-SHA CI | Deployment or cloud validation of any September 15 fix |
| Same accepted release, variant run [34823965208](https://github.com/vibelingan/channel/actions/runs/34823965208) | Prior selected four-product media acceptance; deployment deliberately skipped | Full-scope inquiry or final-source acceptance |
| Earlier baseline/static/test results retained in the prior handoff | Historical reconstructed-tree evidence | Current full-suite completion; filenames containing "final" are not a source boundary |
| Saved `/tmp/r1-owned-quarantine-red-fixed-7fe10906.log`, read here | Original stale approvals failed the new conflict assertions | A passing quarantine run; this is red evidence despite the filename |
| Saved `/tmp/admin-review-cas-v2-handler.log`, read here | Selected acknowledgement cases passed with explicit successful exit | All additional current handler cases, DB cases or all suites passing |
| Supplied terminal context: DB `tsc --noEmit -p packages/db/tsconfig.json`, exit zero | Reported DB typecheck result at that command's source state | All consumers/E2E typechecked after the last edits |
| Caller reports focused passes for implemented fixes | Implementation-session focused validation status | Independently inspected logs for every phase or live CloudBase behavior |
| Full final tests | Caller reports running at handoff | No final pass, counts or release blessing recorded |

Temporary logs are supplemental, machine-local evidence. The portable conclusions
and their limits are written above; a fresh clone must not require those logs to
understand status. Record final command output and exact tested source/commit
boundary here when available. Do not mark pending checks passed without it.

## Pending Release Gates

- Complete package and E2E typechecks, Biome, all script/package tests and
  `pnpm verify:cloudbase-sdk` on the final source. The configured linter is Biome.
- Complete function builds/packaging and artifact runtime smoke, production site
  build, and isolated browser acceptance for both catalog/Admin and formal RFQ.
  Prior tooling used direct equivalents because `npx pnpm` resolved an unexpected
  version; the repository pins pnpm 11.5.0. Record the actual final toolchain,
  rather than treating the earlier workaround as proof of CI parity.
- Independently review the final source. The user has authorized commit/push/merge
  after validation; bless the exact commit, require same-SHA CI and mergeability,
  and keep main ancestry and AI PR #53 separate.
- After authorized deployment through the existing gated path, verify
  live release identity and repeat both acceptance scopes against that release.
  Keep RFQ email disabled. Verify live password-reset mail separately.
- Carry forward the read-only DNS findings, user-login requirement for console
  page `50813`, unproven flattening, preserved mail records, certificate recheck
  and serious performance follow-up from the review/handoff document. No DNS,
  notification, certificate or performance change is part of this docs update.

**Handoff result:** The implementation record is current; release approval is
still withheld pending evidence. Next work is final validation and review, not
reimplementation of R1-R3 or merging the separate AI work.

## Frozen Validation Follow-Up

The all-package validation exposed one local-adapter test still using the legacy
source-only quarantine hash. Its fixture now uses the production identity-v2
snapshot and explicitly asserts the mutation was reached. Identity conflicts
retain the existing superseded mapping; other rejections retain their mappings.
The entire local identity suite passed 42/42 after this test-only correction.

Final package/E2E typechecks and Biome then passed (593 files; Astro 0 errors,
0 warnings, 8 hints). Production static build succeeded; browser tests are
running against its owned temporary database. Prior all-package output contained
the one obsolete-fixture failure and must not be called an all-green run.

## PR Submission Evidence

- The production-build catalog/Admin browser lane exited 0 and removed its
  temporary database. Public tests: 40 passed and one carousel case passed on
  retry; catalog/mobile 46 passed; font 1, seed 1, persisted Admin lifecycle 5,
  Admin editor 11 passed. The carousel retry is recorded, not a zero-retry claim.
- Subsequent form-safety fixes add explicit POST to three dynamic forms and
  meaningful skip metadata to opt-in local preview suites. SSR render regressions
  and a mounted inquiry-form regression passed; no skip predicates were relaxed.
- Final root/package/E2E typechecks passed. Biome checked 594 files without
  errors. All 150 deployment script tests and SDK contracts passed before the
  form-only follow-up; its focused checks and final types/lint passed afterward.
- The actual craft runner against the entire uncommitted branch change list
  exited 0: no new findings, no execution errors, 12 unchanged baseline items.
  No global gate, hook, exemption baseline or review override was changed.
- Independent final identity/transaction and form-delta reviews found no
  remaining concrete P1/P2 issue in the reviewed changes.
- A final recursive test command did not retain a complete terminal outcome;
  the process was absent when inspected and its log was partial. It is NOT
  counted as a final full-suite pass. The formal browser lane in that command
  therefore has no final evidence. Require complete same-commit PR CI, including
  both production-build browser lanes, packaging/runtime smoke and all tests,
  before merge. Do not weaken CI because local checks were partial.
- Live public-api and sync health still returned accepted release 9e3de08 before
  submission. HTTPS returned 200 with TLS 1.3; observed certificate expiry is
  2026-10-18T07:59:59Z. No September 15 fix is deployed at this point.
- DNS plan and nameservers are verified, but root flattening configuration is
  pending interactive account login. See DNS-ENTERPRISE-2026-09-15.md.

Submission is not launch completion: retain the DNS, real-mail, renewal ownership
and performance follow-ups. AI PR #53 remains separately owned and mutable.