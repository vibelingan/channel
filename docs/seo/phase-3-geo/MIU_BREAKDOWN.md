# SEO Phase 3 GEO - Technical MIU Breakdown

This breakdown covers the implementable measurement and evidence foundation. It does not authorize a
paid AI run, page copy, Schema, `llms.txt`, infrastructure, or product-data implementation. The actual
AI-D0 runner receives a separate MIU after Decision 3 selects funded GeoLoop or a controlled provider
set. Each GEO-09 publishing hypothesis receives a separate validator-clean MIU after AI D0, content
approval, and page-contract approval.

## MIU 1: Ajv 2020 validation dependency

Block: INFRASTRUCTURE

Files: `package.json`, `pnpm-lock.yaml`, `scripts/runtime-contract.test.mjs`

Type: modify-existing

Depends on: none

What it does:
- Adds exact root development dependency `ajv@8.20.0`, aligning with the version already resolved
  transitively in `pnpm-lock.yaml` by `yaml-language-server`. Ajv v8 exposes JSON Schema 2020-12 via
  `ajv/dist/2020`; the GEO validator enables strict mode and `allErrors` diagnostics.
- Extends the existing runtime contract test to prove Ajv is root-development tooling and is absent
  as a direct dependency from Astro and CloudBase production package manifests/bundles. The test does
  not assert that no transitive Ajv copy exists anywhere in the workspace.

- Build/Deploy/Runtime impact:
- Changes root dependency installation and lockfile for local and PR-CI Node contexts.
- Does not enter site/function bundles; clean frozen-lockfile installation and package-boundary tests
  protect that separation.

Test plan (TDD - write FIRST):
- Assert root `package.json` declares exact `ajv: 8.20.0` and Node can import `ajv/dist/2020`.
- Assert every production workspace package omits Ajv as a direct dependency and function packaging
  output does not ship the root development dependency.

Done when:
- Frozen-lockfile install reuses/resolves Ajv 8.20.0 and the runtime contract test passes.
- Repository typecheck, lint, tests, and function artifact smoke remain green.

## MIU 2: Generic GEO JSON Schema validator CLI

Block: TESTING

Files: `scripts/validate-geo-evidence.mjs`, `scripts/validate-geo-evidence.test.mjs`, `package.json`

Type: new-file

Depends on: MIU 1

What it does:
- Implements `--schema <path> --data <path>` and `--help` using `ajv/dist/2020`, strict mode, and
  `allErrors`; diagnostics include instance path, schema path, keyword, and message.
- Adds `validate:geo-evidence` to root scripts and exports pure parse/compile/validate helpers.
- Uses temporary schema/data files in its own test, so it does not depend on later GEO artifacts.

Build/Deploy/Runtime impact:
- Adds a repository-only Node CLI and test in the existing deploy-smoke test glob.
- No site/function runtime, bundle, route, environment variable, or deployment change.

Test plan (TDD - write FIRST):
- Assert a temporary valid schema/data pair exits `0`; invalid data exits nonzero and names its
  instance path plus violated keyword.
- Assert malformed JSON, missing files, unknown flags, and invalid schema exit nonzero; `--help`
  exits `0` without loading canonical GEO files.

Done when:
- `node --test scripts/validate-geo-evidence.test.mjs` passes without later MIU artifacts.
- `pnpm validate:geo-evidence -- --help`, root typecheck, lint, and tests pass.

## MIU 3: Fact-register schema and fixtures

Block: TESTING

Files: `docs/seo/phase-3-geo/data/fact-register.schema.json`, `docs/seo/phase-3-geo/fixtures/facts.valid.json`, `docs/seo/phase-3-geo/fixtures/facts.invalid.json`

Type: new-file

Depends on: MIU 2

What it does:
- Defines fact identity, evidence source/hash, confidentiality, approver, lifecycle, review/expiry,
  withdrawal reason, and visible-page/Schema/`llms.txt` consumer records.
- Defines lifecycle enum `draft | blocked | approved | expired | withdrawn`; `blocked` requires a
  reason and cannot be consumed publicly.
- Supplies positive and multi-error negative fixtures against the exact schema contract above.

Build/Deploy/Runtime impact:
- Documentation/test data only; no production consumer or deployment change.
- Future consumers must pass the root GEO validator before publication.

Test plan (TDD - write FIRST):
- Assert `pnpm validate:geo-evidence -- --schema docs/seo/phase-3-geo/data/fact-register.schema.json
  --data docs/seo/phase-3-geo/fixtures/facts.valid.json` exits `0`.
- Assert the same command with `facts.invalid.json` exits nonzero for missing evidence/approver,
  invalid lifecycle, withdrawal without reason, and malformed consumer records.

Done when:
- Exact valid/invalid commands return expected exit codes and targeted schema diagnostics.
- Schema parsing, root typecheck, lint, and tests pass.

## MIU 4: Fact-register cross-record rules

Block: TESTING

Files: `scripts/validate-geo-evidence.mjs`, `scripts/validate-geo-evidence.test.mjs`

Type: modify-existing

Depends on: MIU 3

What it does:
- Adds `--facts <path>`, which resolves
  `docs/seo/phase-3-geo/data/fact-register.schema.json` and checks unique claim/evidence IDs, hashes,
  consumer references, lifecycle dates, and withdrawal reasons across records.
- Adds `--facts-snapshot <path>` for immutable canonical snapshots; recomputes SHA-256, verifies the
  snapshot ID/source revision, and rejects mutable/live-register references in archived AI evidence.
- Uses `fixtures/facts.valid.json` and `fixtures/facts.invalid.json` from MIU 3 as exact contract inputs.

Build/Deploy/Runtime impact:
- Repository validation only; no production build or runtime change.

Test plan (TDD - write FIRST):
- Assert `pnpm validate:geo-evidence -- --facts docs/seo/phase-3-geo/fixtures/facts.valid.json`
  exits `0`.
- Assert the invalid fixture exits nonzero and names duplicate IDs, bad hash/reference, missing consumer,
  inconsistent dates, and invalid withdrawal.
- Use temporary canonical snapshot bytes to prove a correct ID/hash exits `0`, tampering exits nonzero,
  and later live-register withdrawal does not alter validation of the immutable snapshot.
- Pin one byte-level `geo-facts-jcs-v1` test vector in the validator test: input facts, exact canonical
  UTF-8 bytes, and expected SHA-256. The hashed projection is the `facts` array only and excludes the
  snapshot envelope/hash field.

Done when:
- Specialized fact validation reports all independent fixture defects deterministically.
- Root typecheck, lint, tests, and function artifact smoke pass.

## MIU 5: Canonical GEO fact register

Block: TESTING

Files: `docs/seo/phase-3-geo/data/facts.json`, `docs/seo/phase-3-geo/data/fact-snapshots/initial.json`, `scripts/validate-geo-public-claims.test.mjs`

Type: new-file

Depends on: MIU 4

What it does:
- Records the auditable public-claim inventory and source file/field pointers directly in canonical
  `facts.json`; no second editable inventory authority is created.
- Creates `fact-snapshots/initial.json` from canonicalized approved facts with stable
  `factsSnapshotId`, source fact-register revision, `sourceFactsSha256`, and snapshot SHA-256 for AI D0.
- The test builds the site with `SITE_URL=https://supplychainsai.com` and `PUBLIC_CB_PROXY=0`, then
  parses rendered production-origin HTML for `/`, `/oem/`, `/portfolio/`, and `/headphones/`, including
  metadata and JSON-LD. Imported components and transitive content sources cannot bypass the inventory.
  Source files and build output are read-only inputs, not modified files.
- Inventories current public entity, history, facility, capability, certification, case, commercial,
  and official-profile claims under `data/fact-register.schema.json`.
- Records each claim as approved, blocked, or expired with owner/evidence and consumer references;
  approved entity records retain `Diversity Technology` and `Diversity Technology Limited`.

Build/Deploy/Runtime impact:
- Canonical documentation/data only; no page consumes it in this MIU.
- Publishing remains blocked for non-approved records.
- `scripts/*.test.mjs` means root `pnpm test` performs one additional production-origin Astro build
  before the later CI build step. Accept the duplicated build cost (approximately 15 seconds locally)
  in exchange for source-to-rendered-HTML claim coverage; the test must log its fixed origin.

Test plan (TDD - write FIRST):
- Assert `pnpm validate:geo-evidence -- --facts docs/seo/phase-3-geo/data/facts.json` exits `0`.
- Assert `node --test scripts/validate-geo-public-claims.test.mjs` builds/parses all four routes and maps
  every rendered numeric, commercial, certification, official-profile, and entity claim to exactly one
  fact record; stale source pointers, localhost canonical/JSON-LD URLs, unmapped rendered claims, and
  duplicate mappings fail.
- Assert `pnpm validate:geo-evidence -- --facts-snapshot
  docs/seo/phase-3-geo/data/fact-snapshots/initial.json` exits `0` and its hash matches canonical bytes.
- Assert the snapshot source revision and `sourceFactsSha256` match the approved-facts projection at
  creation; changing current approved facts makes the snapshot ineligible for a new AI D0 but does not
  invalidate an already completed historical run.

Done when:
- Canonical facts validate and the inventory has no silent unknown status.
- No page content changes; root typecheck, lint, and tests pass.

## MIU 6: AI-run schema and contract fixtures

Block: TESTING

Files: `docs/seo/phase-3-geo/data/ai-run.schema.json`, `docs/seo/phase-3-geo/fixtures/ai-run.valid.json`, `docs/seo/phase-3-geo/fixtures/ai-run.invalid.json`

Type: new-file

Depends on: MIU 2, MIU 5

What it does:
- Defines manifests with provider routing, requested model/returned revision, tools, attempts,
  retry/backoff, request IDs, usage/billing, raw evidence, citations, scores, aggregation,
  `factsSnapshotId`, `factsSnapshotSha256`, selected models, required cells, and sample indices.
- Supplies positive and negative schema fixtures; the valid fixture references approved claim IDs from
  the immutable snapshot created in MIU 5 for factual scoring.
- The valid fixture mixes successful, `ERROR`-without-score, no-mention, and successful identity-collision
  observations so exclusion and legitimate identity score `0` are distinguishable.
- The valid fixture contains three successful samples for every required `(question, model)` cell and
  records funding preflight plus evaluator/scoring-guide revisions.

Build/Deploy/Runtime impact:
- Documentation/test data only; no provider request, credential, billing, or production change.
- The future provider runner must emit this exact contract.

Test plan (TDD - write FIRST):
- Assert `pnpm validate:geo-evidence -- --schema docs/seo/phase-3-geo/data/ai-run.schema.json --data docs/seo/phase-3-geo/fixtures/ai-run.valid.json` exits `0`.
- Assert the same command with `ai-run.invalid.json` exits nonzero for missing provider/model/attempt/
  citation/scoring fields and malformed `N/A` applicability.
- Assert missing/tampered fact snapshot, fewer than three required samples, incomplete required cells,
  or absent snapshot ID/hash, returned revision, primary evaluator ID, adjudicator ID, or guide revision
  fails structural schema validation. Snapshot-file integrity and aggregate recomputation belong to MIU 7.

Done when:
- Valid and invalid manifests produce the expected schema results against the AI-run schema.
- Root typecheck, lint, and tests pass; no live model call occurs.

## MIU 7: AI question set and run semantic rules

Block: TESTING

Files: `scripts/validate-geo-evidence.mjs`, `scripts/validate-geo-evidence.test.mjs`, `docs/seo/phase-3-geo/data/ai-questions.json`

Type: modify-existing

Depends on: MIU 6

What it does:
- Defines frozen question IDs/prompts/hashes, applicability, and `requiredForBaseline`: Q1–Q9 are
  required; Q10 remains optional until an approved commercial-policy question-set revision.
- Adds `--ai-run <path>` using `data/ai-run.schema.json`, `data/ai-questions.json`, and
  the manifest-pinned immutable fact snapshot; checks snapshot ID/hash, prompt hashes, selected models,
  complete required cells, exactly three samples per cell, claim references, funding preflight,
  retries, attempts, evaluator/adjudicator revision, identity collision, applicability denominators,
  aggregation/dispersion, returned revision, and error-vs-score invariants. It never revalidates an
  archived AI run against mutable `data/facts.json`.
- Encodes invalid cases including HTTP 402/ERROR plus numeric score, unrecorded fallback, missing
  request ID, prompt mismatch, collision counted as mention, and invalid `N/A` denominator.

Build/Deploy/Runtime impact:
- Repository validation only; no model call or production change.

Test plan (TDD - write FIRST):
- Assert `pnpm validate:geo-evidence -- --ai-run docs/seo/phase-3-geo/fixtures/ai-run.valid.json`
  exits `0` and reproduces normalized aggregate scores.
- Assert the same command with `ai-run.invalid.json` exits nonzero and reports every encoded invariant;
  removing one invalid case removes only its diagnostic.
- Independently assert the mixed exact-entity oracle: 3 successful responses, 1 `ERROR`, 1 no-mention,
  1 identity collision; successful normalized-score distribution `[0, 0, 100]`, median `0`; identity,
  factual, citation, and completeness medians `0`; recommendation is `N/A`. Removing the unscored
  `ERROR` changes neither denominator, distribution, nor median.
- Assert the valid mixed fixture has exact valid/error/no-mention/collision counts and aggregates only
  applicable successful dimensions; removing the error changes neither denominators nor medians.
- Assert Q1–Q9 × every selected model × three samples is the only completion denominator; Q10 does not
  block until its frozen `requiredForBaseline` flag is approved.
- Assert a comparison with a changed returned model revision remains valid evidence but is classified
  observational and cannot carry uplift; a same-revision comparison below 10 normalized points is “no
  material measured uplift.”
- Assert factual scores resolve against the manifest snapshot after live facts are withdrawn, while a
  tampered/missing snapshot fails.
- Assert all three successful D0 samples in one `(question, model)` cell return one identical revision;
  mixed or missing revisions block that cell rather than being averaged.
- Assert both primary evaluator ID and adjudicator ID plus scoring-guide revision are frozen. Any role or
  guide change makes the comparison observational even with a passing bridge-set record; bridge
  calibration may establish a new baseline but cannot restore uplift attribution.

Done when:
- Persistent provider errors cannot be represented as zero visibility in validated evidence.
- Root typecheck, lint, tests, and function artifact smoke pass.

## MIU 8: Measurement-checkpoint schema and fixtures

Block: TESTING

Files: `docs/seo/phase-3-geo/data/checkpoint.schema.json`, `docs/seo/phase-3-geo/fixtures/checkpoint.valid.json`, `docs/seo/phase-3-geo/fixtures/checkpoint.invalid.json`

Type: new-file

Depends on: MIU 2

What it does:
- Defines checkpoint type/status/blocker, immutable deploy SHA, `deployedThroughBranch`, deployment
  timestamp, measured public origins, evidence references, timezone, half-open windows, extraction
  timestamp, reporting delay, eligibility/reset, and decision records.
- Covers blocked/complete SEO-D0, blocked/complete AI-D0, SEO-D14 eligibility, SEO-D59 comparison, and
  AI O1/uplift checkpoint variants in one discriminated contract.
- Encodes a valid 2026-08-14 SEO D0 schedule with Aug 28, Sep 11, Oct 9 window-end, and Oct 12 D+59
  review in `Asia/Hong_Kong`.

Build/Deploy/Runtime impact:
- Documentation/test data only; no external account mutation or runtime change.

Test plan (TDD - write FIRST):
- Assert `pnpm validate:geo-evidence -- --schema docs/seo/phase-3-geo/data/checkpoint.schema.json
  --data docs/seo/phase-3-geo/fixtures/checkpoint.valid.json` exits `0`.
- Assert the same command with `checkpoint.invalid.json` exits nonzero for missing SHA/evidence,
  missing deployment timestamp/branch/public origins, invalid timezone/status, malformed windows, and
  missing reset record.

Done when:
- Exact valid/invalid commands return expected exit codes and schema diagnostics.
- Root typecheck, lint, and tests pass.

## MIU 9: Measurement-checkpoint semantic rules

Block: TESTING

Files: `scripts/validate-geo-evidence.mjs`, `scripts/validate-geo-evidence.test.mjs`

Type: modify-existing

Depends on: MIU 7, MIU 8

What it does:
- Adds `--checkpoint <path>` using `data/checkpoint.schema.json`; computes timeline offsets in
  `Asia/Hong_Kong` and verifies `[start,end)`, three-day reporting delay, and reset eligibility.
- Enforces SEO-D0 four-URL/property/owner/sitemap/PageSpeed/CrUX completeness, AI-D0 valid-manifest/
  complete required-cell/three-sample/fact-snapshot/funding/raw-evidence/evaluator-adjudication
  readiness, SEO-D14 four-page reset rules, publish-relative timeline math, and AI O1-versus-uplift
  baseline/snapshot/revision rules. Publishing-registry/attestation resolution belongs to MIU 39 after
  those contracts exist.
- At the AI-D0 `complete` transition, recomputes the current approved-facts projection and requires its
  source revision/hash to match the selected snapshot. This check establishes a fresh rubric once and
  never revalidates a completed historical run against later mutable facts.
- For SEO-D0, requires `deployedThroughBranch: "test"`, an immutable test-deploy timestamp, and exactly
  the four `https://supplychainsai.com` production-origin URLs. A main-only SHA, localhost origin,
  alternate host, or missing deploy timestamp fails.
- Uses MIU 8 fixtures and rejects D+56 as the complete two-window review date while retaining it as
  the second window's exclusive end.
- Discovers every canonical `docs/seo/phase-3-geo/checkpoints/*.json` file during root tests, so later
  checkpoint MIUs enter CI without editing this test file.

Build/Deploy/Runtime impact:
- Repository validation only; no Search Console or production mutation.

Test plan (TDD - write FIRST):
- Assert `pnpm validate:geo-evidence -- --checkpoint docs/seo/phase-3-geo/fixtures/checkpoint.valid.json`
  exits `0` and produces Aug 28, Sep 11, Oct 9 window-end, and Oct 12 review.
- Assert the same command with `checkpoint.invalid.json` exits nonzero for incomplete SEO/AI baselines,
  inclusive end, Oct 9 review, missing delay, ineligible repair, or uplift without a baseline.
- Assert SEO-D0 rejects `main` as deployment branch, absent test-deploy timestamp, localhost/noncanonical
  hosts, or fewer/more than the four public production-origin URLs.
- Assert blocked SEO-D0, AI-D0, SEO-D59, and AI-COMPARISON variants reject injected dates, metrics,
  responses, scores, or uplift; complete publish-relative fixtures accept `P+31d` and reject overlap.
- Assert AI-D0 cannot become complete with an optional-only success set, any missing required sample,
  a live-facts pointer instead of snapshot ID/hash, failed funding preflight, or unnamed evaluator.
- Assert AI-D0 cannot become complete when the selected snapshot's source revision or
  `sourceFactsSha256` differs from the current approved-facts projection; after completion, later fact
  changes do not mutate or invalidate that archived checkpoint.
- Assert AI comparison with a changed returned revision or fact snapshot is observational, and a
  repaired D+14 page cannot use the headline D+59 window.

Done when:
- Timeline and eligibility invariants are executable and timezone-stable.
- Root typecheck, lint, tests, and function artifact smoke pass.

## MIU 10: Search Console SEO-D0 capture contract

Block: INTEGRATION

Files: `docs/seo/phase-3-geo/checkpoints/SEO-D0.json`, `docs/seo/phase-3-geo/checkpoints/SEO-D0.md`, `docs/seo/phase-3-geo/evidence/search-console/D0/README.md`

Type: new-file

Depends on: MIU 9

What it does:
- Creates source JSON, human runbook, and evidence index for existing-property/owner verification,
  sitemap state, four URL Inspection records, selected canonical, crawl/index, PageSpeed, CrUX,
  immutable SHA/timestamp deployed through `test`, and the measured public production-origin URLs.
- Consumes `data/checkpoint.schema.json` through `--checkpoint`; no-property/no-access is a blocked state and never triggers
  an unreviewed duplicate property or sitemap submission.
- Stores only a redacted tracked manifest; account identity, screenshots, and raw exports remain in the
  approved external evidence location under `MEASUREMENT-AND-EVIDENCE.md`.
- Remains blocked until external evidence location, access owner, redaction reviewer, and retention period
  are all assigned.

Build/Deploy/Runtime impact:
- Manual Search Console integration only; no dependency, site build, workflow, or production change.
- Owner/full access is required to replace blocked placeholders with observed evidence.

Test plan (TDD - write FIRST):
- Assert `pnpm validate:geo-evidence -- --checkpoint docs/seo/phase-3-geo/checkpoints/SEO-D0.json`
  exits `0` for initial blocked status while carrying no baseline date.
- Assert changing it to complete fails until all four URLs, property owner, sitemap state, deploy SHA, timezone,
  test deployment branch/timestamp, schedule, extraction timestamp, PageSpeed, and CrUX status exist;
  every URL must use `https://supplychainsai.com`.

Done when:
- Capture contract validates in blocked or evidence-complete state without fabricated observations.
- Root typecheck, lint, and tests pass; actual SEO D0 requires owner-access execution.

## MIU 11: AI-D0 capture and provider-decision gate

Block: INTEGRATION

Files: `docs/seo/phase-3-geo/checkpoints/AI-D0.json`, `docs/seo/phase-3-geo/checkpoints/AI-D0.md`, `docs/seo/phase-3-geo/evidence/ai/D0/README.md`

Type: new-file

Depends on: MIU 7, MIU 9

What it does:
- Creates source JSON, runbook, and evidence index for manifests conforming to
  `data/ai-run.schema.json`, frozen `data/ai-questions.json`, and `data/checkpoint.schema.json`.
- Records Decision 3 as blocked until the user selects funded GeoLoop or a controlled provider set;
  it does not guess APIs, credentials, model revisions, costs, or retry limits.
- Defines the provider-runner preflight gate: credential check, provider balance/quota or one minimal
  smoke call, estimated complete-run budget plus 20% headroom, and immediate stop on 402/quota/policy
  failure before any D0 sample.
- Pins the selected models, Q1–Q9 required cells, three sample indices, immutable fact snapshot ID/hash,
  primary evaluator, adjudicator, and scoring-guide revision.
- Requires the AI-D0 completion transition to prove the selected snapshot's source revision and
  `sourceFactsSha256` still match the current approved-facts projection.
- Requires a later provider-specific runner MIU before paid execution and GEO-09 publication.
- Stores only redacted hashes/aggregates in Git; raw responses, request IDs, billing metadata, and
  restricted citations remain in the approved external evidence location.
- Remains blocked until external evidence location, access owner, redaction reviewer, and retention period
  are all assigned.

Build/Deploy/Runtime impact:
- Documentation/integration gate only; no network call, credential, billing, or production change.

Test plan (TDD - write FIRST):
- Assert `pnpm validate:geo-evidence -- --checkpoint docs/seo/phase-3-geo/checkpoints/AI-D0.json`
  exits `0` for blocked status but reports `publicationReady: false`.
- Assert changing it to complete fails without a valid AI manifest, a complete Q1–Q9 × selected-model
  required-cell set, raw evidence, exactly three samples per required cell, funding preflight, immutable fact snapshot,
  evaluator/adjudication records, and exact provider/model parameters.
- Assert a stale snapshot whose internal hash remains valid still blocks completion when its recorded
  source revision/hash no longer matches current approved facts.

Done when:
- Capture contract and blocked decision state validate; failed requests carry no numeric score.
- Root typecheck, lint, and tests pass; actual AI D0 remains blocked pending route approval.

## MIU 12: Content-brief schema and fixtures

Block: TESTING

Files: `docs/seo/phase-3-geo/content-briefs/brief.schema.json`, `docs/seo/phase-3-geo/fixtures/content-brief.valid.json`, `docs/seo/phase-3-geo/fixtures/content-brief.invalid.json`

Type: new-file

Depends on: MIU 5, MIU 9

What it does:
- Defines procurement answer, case, certification, process, and differentiator briefs with exact
  `data/fact-register.schema.json` and `data/facts.json` claim IDs, permissions, target page, reviewer,
  and review/expiry dates.
- Supplies valid/invalid fixtures; unsupported leader/best, numeric, commercial, partner,
  certification, and outcome claims are represented only as failures.

Build/Deploy/Runtime impact:
- Documentation/test data only; no visible copy or Schema publication.

Test plan (TDD - write FIRST):
- Assert `pnpm validate:geo-evidence -- --schema docs/seo/phase-3-geo/content-briefs/brief.schema.json --data docs/seo/phase-3-geo/fixtures/content-brief.valid.json` exits `0`.
- Assert the same command with `content-brief.invalid.json` exits nonzero for missing permission/reviewer, invalid status/date, and
  malformed claim references.

Done when:
- Exact valid/invalid commands return expected exit codes and schema diagnostics.
- Root typecheck, lint, and tests pass; no runtime content changes.

## MIU 13: Canonical content briefs and fact-reference rules

Block: TESTING

Files: `scripts/validate-geo-evidence.mjs`, `scripts/validate-geo-evidence.test.mjs`, `docs/seo/phase-3-geo/content-briefs/approved.json`

Type: modify-existing

Depends on: MIU 9, MIU 12

What it does:
- Adds `--content-brief <path>` using `content-briefs/brief.schema.json` and canonical
  `data/facts.json`; every public statement must resolve to an approved, unexpired claim.
- This is intentionally a live publication-safety check. It may reject a withdrawn claim without
  invalidating historical AI runs, which remain pinned to immutable fact snapshots under MIU 7.
- Reuses MIU 12 fixtures and rejects blocked/expired/missing claims or unsupported numeric outcomes.
- Stores approved client briefs in canonical `content-briefs/approved.json`; an empty approved array is
  valid before client approval and authorizes no content publication.

Build/Deploy/Runtime impact:
- Repository validation only; no page or production change.

Test plan (TDD - write FIRST):
- Assert `pnpm validate:geo-evidence -- --content-brief docs/seo/phase-3-geo/fixtures/content-brief.valid.json`
  exits `0` and each claim resolves to canonical facts.
- Assert the same command with `content-brief.invalid.json` exits nonzero for blocked, expired, and missing claim IDs independently; `content-briefs/approved.json` also exits `0` while empty.

Done when:
- Content briefs cannot pass validation with unsupported public facts.
- Root typecheck, lint, tests, and function artifact smoke pass.

## MIU 14: Page-contract schema and fixtures

Block: TESTING

Files: `docs/seo/phase-3-geo/page-contracts/page-contract.schema.json`, `docs/seo/phase-3-geo/fixtures/page-contract.valid.json`, `docs/seo/phase-3-geo/fixtures/page-contract.invalid.json`

Type: new-file

Depends on: MIU 2, MIU 12, MIU 13

What it does:
- Defines visible fields, owner, index intent, URL/canonical/internal links, eligible Schema,
  omission behavior, lifecycle, and exact consumers from `data/fact-register.schema.json`,
  `data/facts.json`, `content-briefs/brief.schema.json`, and `content-briefs/approved.json`.
- Supplies valid Breadcrumb/Article and invalid Product/canonical/visibility examples. The current
  Phase 3 schema rejects every Product contract unconditionally; a later separately approved product-
  data DAG must version/extend this schema rather than flipping a dependency record here.

Build/Deploy/Runtime impact:
- Documentation/test data only; no page or JSON-LD implementation.

Test plan (TDD - write FIRST):
- Assert `pnpm validate:geo-evidence -- --schema docs/seo/phase-3-geo/page-contracts/page-contract.schema.json --data docs/seo/phase-3-geo/fixtures/page-contract.valid.json` exits `0`.
- Assert the same command with `page-contract.invalid.json` exits nonzero for missing visible fields, canonical/index mismatch, absent omission rule,
  and every Product contract regardless of dependency metadata.

Done when:
- Exact valid/invalid commands return expected exit codes and schema diagnostics.
- Root typecheck, lint, and tests pass; no runtime page changes.

## MIU 15: Canonical page contracts and evidence-reference rules

Block: TESTING

Files: `scripts/validate-geo-evidence.mjs`, `scripts/validate-geo-evidence.test.mjs`, `docs/seo/phase-3-geo/page-contracts/approved.json`

Type: modify-existing

Depends on: MIU 13, MIU 14

What it does:
- Adds `--page-contract <path>` using `page-contracts/page-contract.schema.json`, canonical
  `data/facts.json`, and `content-briefs/approved.json`.
- Rejects absent visible fields, blocked claims, unknown brief IDs, mismatched canonical/index intent,
  and all Product contracts in the current Phase 3 schema.
- Stores approved page contracts in canonical `page-contracts/approved.json`; an empty approved array is
  valid before review and authorizes no page or Schema publication.

Build/Deploy/Runtime impact:
- Repository validation only; no page, Schema, or deployment change.

Test plan (TDD - write FIRST):
- Assert `pnpm validate:geo-evidence -- --page-contract docs/seo/phase-3-geo/fixtures/page-contract.valid.json`
  exits `0` with every fact and content-brief reference resolved.
- Assert the same command with `page-contract.invalid.json` reports each visibility, reference,
  canonical, and unconditional Product-gate defect; `page-contracts/approved.json` also exits `0` while empty.

Done when:
- Page/Schema designs cannot pass with unsupported or non-visible source facts.
- Root typecheck, lint, tests, and function artifact smoke pass.

## MIU 16: SEO-D14 eligibility capture contract

Block: INTEGRATION

Files: `docs/seo/phase-3-geo/checkpoints/SEO-D14.json`, `docs/seo/phase-3-geo/checkpoints/SEO-D14.md`, `docs/seo/phase-3-geo/checkpoints/page-eligibility.json`

Type: new-file

Depends on: MIU 9, MIU 10

What it does:
- Defines four-page recrawl/index/canonical/sitemap/robots/resource/Schema/CWV evidence at SEO D+14.
- Consumes `data/checkpoint.schema.json` and records page-level origin/reset after any material canonical,
  indexing, or rendering repair.

Build/Deploy/Runtime impact:
- Evidence-only; a confirmed defect opens a separate bug-fix MIU.
- No content rewrite or infrastructure change in this MIU.

Test plan (TDD - write FIRST):
- Assert `pnpm validate:geo-evidence -- --checkpoint docs/seo/phase-3-geo/checkpoints/SEO-D14.json`
  exits `0` for blocked status before D+14.
- Assert changing it to complete fails without four pages; a material repair without a later origin also
  fails and cannot be labeled content uplift.

Done when:
- Templates enforce four-page status, immutable SHA, evidence, and reset decisions.
- Root typecheck, lint, and tests pass; early ranking noise causes no page edit.

## MIU 17: Publishing-registry structural contract

Block: TESTING

Files: `docs/seo/phase-3-geo/publishing/registry.schema.json`, `docs/seo/phase-3-geo/fixtures/publishing-registry.valid.json`, `docs/seo/phase-3-geo/fixtures/publishing-registry.invalid.json`

Type: new-file

Depends on: MIU 2, MIU 10, MIU 11, MIU 13, MIU 15, MIU 16

What it does:
- Defines exact state/scope/ownership/output/checkpoint/eligibility/control/window/reporting shapes.
- `planned/approved` forbid deployment/attestation/`P`; empty entries authorize nothing.

Build/Deploy/Runtime impact:
- Schema/fixtures only; no external mutation.

Test plan (TDD - write FIRST):
- Validate every state/scope; reject unknown/forbidden fields, duplicate IDs/owners, missing outputs,
  malformed windows, or per-page uplift on site scope.
- Prove empty registry is valid and authorizes no output.

Done when:
- Registry producers/consumers share one structural contract.
- Schema fixtures, typecheck, lint, and tests pass.

## MIU 18: Publishing-registry approval semantics

Block: TESTING

Files: `scripts/validate-geo-evidence.mjs`, `scripts/validate-geo-evidence.test.mjs`, `docs/seo/phase-3-geo/publishing/registry.json`

Type: modify-existing

Depends on: MIU 10, MIU 11, MIU 13, MIU 15, MIU 16, MIU 17

What it does:
- Validates canonical `publishing/registry.json` against `publishing/registry.schema.json` and permits
  approval only after complete SEO/AI D0, live approved facts/brief/page contract, and page/cohort
  eligibility.
- Enforces unique source/output ownership and page/site overlap/reporting; deployment lifecycle is later.

Build/Deploy/Runtime impact:
- Repository validation only; no publication.

Test plan (TDD - write FIRST):
- Reject incomplete baselines/references/eligibility, duplicate/stale owners, overlap, or omitted controls.
- Assert empty canonical registry passes and authorizes nothing.

Done when:
- Approval cannot bypass baseline/evidence/reference rules.
- Focused tests, typecheck, lint, tests, and function artifacts pass.

## MIU 19: CI event-base contract

Block: INFRASTRUCTURE

Files: `.github/workflows/ci.yml`, `scripts/validate-geo-evidence.mjs`, `scripts/validate-geo-evidence.test.mjs`

Type: modify-existing

Depends on: MIU 18

What it does:
- Fetches enough history and derives only PR base SHA or push `before` SHA as `GEO_DIFF_BASE_SHA`.
- Missing/unavailable/unknown/all-zero bases fail; no moving-ref fallback.

Build/Deploy/Runtime impact:
- CI checkout/history only; no runtime/deploy change.

Test plan (TDD - write FIRST):
- Cover PR/main/test push and all unsupported/shallow/all-zero cases.
- Assert selected object exists and HEAD is never substituted.

Done when:
- Every comparison receives one immutable explicit base.
- Workflow syntax, focused tests, typecheck, lint, and tests pass.

## MIU 20: Deterministic production-output comparator

Block: TESTING

Files: `scripts/validate-geo-evidence.mjs`, `scripts/validate-geo-evidence.test.mjs`

Type: modify-existing

Depends on: MIU 18, MIU 19

What it does:
- Builds base/HEAD with fixed origin and explicit normalization, then compares every emitted file.
- Resolves each delta to exactly one newly approved registry output/digest; transitive effects are covered.

Build/Deploy/Runtime impact:
- Adds one isolated comparison build; no runtime/deploy change.

Test plan (TDD - write FIRST):
- Cover route/asset/global/shared/data/config/generator, unregistered/duplicate/stale/digest mismatch,
  expected-unchanged, lifecycle-only unchanged, and unlisted nondeterminism.

Done when:
- Every emitted delta is uniquely authorized or CI fails.
- Focused tests, typecheck, lint, tests, and function artifacts pass.

## MIU 21: CloudBase publication contract probe

Block: INFRASTRUCTURE

Files: `scripts/geo-cloudbase-contract.mjs`, `scripts/geo-cloudbase-contract.test.mjs`, `docs/seo/phase-3-geo/CLOUDBASE-CONTRACT-PROBE.md`

Type: new-file

Depends on: MIU 20

What it does:
- Freezes pinned `cloudbase-mcp@2.24.1` request/classifier contracts for collection/index,
  insert/read/conditional-update CAS, hosting upload/delete/config/status,
  `queryHosting(listFiles|websiteConfig)`, `manageHosting(downloadFile|downloadDirectory)`, and gateway
  routes.
- Temporary live probe proves insert/duplicate/read/CAS winner/loser; ambiguity blocks consumers.

Build/Deploy/Runtime impact:
- Temporary non-public NoSQL probe only; no public hosting/runtime mutation.

Test plan (TDD - write FIRST):
- Replay redacted success/failure/timeout/malformed/hosting/gateway fixtures and reject version drift.
- Record exact probe version/date/response keys and safely clean only the probe collection.

Done when:
- Consumers import executable classifiers for every CloudBase operation used.
- Probe tests, SDK gate, typecheck, lint, tests, and function artifacts pass.

## MIU 22: Publication-claim data contract

Block: TESTING

Files: `docs/seo/phase-3-geo/data/publication-claim.schema.json`, `docs/seo/phase-3-geo/fixtures/publication-claim.valid.json`, `docs/seo/phase-3-geo/fixtures/publication-claim.invalid.json`

Type: new-file

Depends on: MIU 2, MIU 21

What it does:
- Defines one durable apply document with immutable UUID claim/nonce, repository, decimal run ID, ASCII
  EnvId/hypothesis, source/target/rollback digests, artifact IDs/digests, and signed RFC3339 apply and
  rollback authorization windows, each with `0 < lifetime <= 10 minutes`.
- Freezes verifier predicates against trusted GitHub/server time:
  `authorizedAt <= trustedNow < expiresAt` and
  `rollbackAuthorizedAt <= trustedNow < rollbackExpiresAt`; future-issued, equal-to-expiry, missing,
  inverted, or longer-than-ten-minute windows fail. Canonical signed bytes include every timestamp.
- Defines apply states `prepared|upload-started|apply-succeeded|apply-failed`. `prepared` is a durable,
  non-authorizing record containing verified rollback custody before any EnvId lock or public mutation.
  Rollback CAS mutates the same keyed
  document through `rollback-started|rollback-succeeded|rollback-failed`; protected incident recovery
  may, only after terminal-origin/quarantine proof, CAS any ambiguous post-claim state
  (`prepared|upload-started|apply-succeeded|apply-failed|rollback-started|rollback-failed`) to
  `remediation-started`, then
  `remediation-succeeded|remediation-failed`. Every state preserves nonce/key and exhaustively
  requires/forbids timestamps, UUID receipts, enumerated failure phase, and reason.
- Protected remediation retry may CAS `remediation-started|remediation-failed → remediation-started`
  only after the prior remediation GitHub-hosted run is terminal, quarantine has elapsed, a fresh signed
  authorization exists, and exact prior state/run/attempt CAS wins. It records monotonic
  `remediationAttempt`; no concurrent/time-only takeover exists.
- Before `upload-started`, claim fields require full rollback custody: `rollbackArtifactId` (decimal
  string), `rollbackArtifactDigest` and `rollbackManifestSha256` (64 lowercase hex),
  `rollbackArtifactVerifiedAt`/`rollbackArtifactRetainUntil` (RFC3339), and exact covered static paths.
  Retention must extend past the longest active/recovery window; manifest-only evidence is insufficient.
- `rollback-started` records immutable rollback run/attempt identity but has no automatic lease takeover.
  Remediation requires the original GitHub-hosted run to be terminal, trusted time later than
  `originRunCompletedAt + maxHostingOperationDuration + quarantineDuration`, and exact state+run CAS.
  Self-hosted/unknown runners or nonterminal origin runs are not recoverable automatically or manually.
- Defines `$defs.publicationControl` for one `geo_publication_controls` document per EnvId:
  `envId`, `locked`, `lockEpoch`, `lockOwnerClaimId`, `reason`, `incidentEvidenceId`, `lockedAt`,
  `resolvedAt`, `resolvedBy`, and `resolutionEvidenceId`. Authorization atomically CASes unlocked→locked
  before emitting apply authority; writer requires that exact claim-owned lock. Success unlocks only
  after signed success evidence is persisted. Any runner death/failure leaves the lock in place.
  Both success and incident unlock require verified reconciled public bytes and website configuration,
  complete append-only evidence, exact live claim/control epoch, signed resolution evidence, and an
  approver distinct from publication/remediation executor. Incident unlock additionally requires
  `remediation-succeeded`; unlock always uses monotonic epoch, never an environment variable.
- Evidence references include monotonic integer `evidenceSequence` scoped to claim ID. Success, rollback,
  remediation, and resolution append records; no record may replace an earlier sequence.

Build/Deploy/Runtime impact:
- Schema/fixtures only; no external mutation.

Test plan (TDD - write FIRST):
- Reject malformed/missing/inverted/long windows, changed rollback key/nonce, illegal mode/state/fields,
  invalid receipt/failure, or reusable metadata.
- Assert unique key is repository/run/nonce/EnvId/target digest.
- Reject `trustedNow` before issue or at/after expiry; test original-run terminal/quarantine predicates,
  concurrent remediation CAS single winner, and death before/during/after rollback/remediation.
- Reject missing/expired/unverified rollback bytes and invalid control lock/unlock transitions.
- Reject non-monotonic/duplicate evidence sequence and stale success after later rollback/remediation.
- Cover crash after `prepared` insert but before lock, after lock but before authorization, and before
  `upload-started`; each remains recoverable with no unowned lock or public mutation.
- Cover death/failure during remediation, terminal+quarantine retry, fresh authorization, monotonic
  attempt, concurrent retry single winner, and nonterminal/unknown prior run rejection.

Done when:
- Resource/helper/apply/rollback share one exact state graph.
- Schema fixtures, typecheck, lint, and tests pass.

## MIU 23: Publication-claim NoSQL resource

Block: INFRASTRUCTURE

Files: `scripts/cloudbase-nosql-resources.mjs`, `scripts/cloudbase-nosql-resources.test.mjs`

Type: modify-existing

Depends on: MIU 21, MIU 22

What it does:
- Adds canonical ADMINONLY `geo_publication_claims` with the exact unique index from
  `docs/seo/phase-3-geo/data/publication-claim.schema.json` and no TTL/delete, plus
  ADMINONLY `geo_publication_controls` with one unique `envId` index/no TTL/delete.
- Uses `scripts/geo-cloudbase-contract.mjs` classifiers; fails on index/permission drift.

Build/Deploy/Runtime impact:
- Provisions one collection/index; no site/function runtime change.

Test plan (TDD - write FIRST):
- Cover both collections' create/idempotence/drift/permission/post-verification/exact order and no
  sibling authority.

Done when:
- Durable store matches prior schema/probe.
- Resource tests, typecheck, lint, tests, and function artifacts pass.

## MIU 24: GitHub provenance contract probe

Block: INFRASTRUCTURE

Files: `.github/workflows/geo-provenance-probe.yml`, `scripts/geo-github-provenance-contract.mjs`, `scripts/geo-github-provenance-contract.test.mjs`

Type: new-file

Depends on: MIU 20

What it does:
- Probe workflow freezes full action SHAs, verifier client/version, run/artifact API fields, commands,
  permissions, and parsers; signs/verifies one non-deploy current-run statement.
- Floating refs and committed/self-reported trust are forbidden.

Build/Deploy/Runtime impact:
- Non-deploy GitHub probe only; no CloudBase/public mutation.

Test plan (TDD - write FIRST):
- Reject wrong repo/workflow/ref/run/head/signer/digest, unsigned/expired data, missing permissions/token,
  malformed metadata, or floating refs.
- Assert workflow executes pinned helper and exports reusable fixtures/constants.

Done when:
- Downstream producers/importers share one pinned provenance contract.
- Workflow syntax, focused tests, typecheck, lint, and tests pass.

## MIU 25: Deployment-attestation data contract

Block: TESTING

Files: `docs/seo/phase-3-geo/data/deployment-attestation.schema.json`, `docs/seo/phase-3-geo/fixtures/deployment-attestation.valid.json`, `docs/seo/phase-3-geo/fixtures/deployment-attestation.invalid.json`

Type: new-file

Depends on: MIU 2, MIU 17, MIU 22, MIU 24

What it does:
- Defines structural apply/rollback authorization, receipt, public observation, success, failure,
  preexisting-output, and evidence variants using exact fields from `data/publication-claim.schema.json`
  and provenance constants from `scripts/geo-github-provenance-contract.mjs`.
- Schema owns shape/format/discriminated presence only; no self-trust/cross-field semantics.

Build/Deploy/Runtime impact:
- Schema/fixtures only; no external mutation.

Test plan (TDD - write FIRST):
- Validate every variant; reject malformed/forbidden/partial/self-trust fields while explicitly excluding
  signature/equality/ordering/replay semantics.

Done when:
- Publication producers/consumers share one structural statement contract.
- Schema fixtures, typecheck, lint, and tests pass.

## MIU 26: Atomic publication-claim helper

Block: TESTING

Files: `scripts/geo-publication-claim.mjs`, `scripts/geo-publication-claim.test.mjs`

Type: new-file

Depends on: MIU 21, MIU 22, MIU 23

What it does:
- Uses `scripts/geo-cloudbase-contract.mjs` builders/classifiers to insert `prepared`, read by
  immutable claim ID, and CAS legal transitions from `data/publication-claim.schema.json`.
- Legal graph: insert `prepared`; writer CASes `prepared→upload-started`; then
  `apply-succeeded|apply-failed`; rollback CAS from any of
  `upload-started|apply-succeeded|apply-failed` to `rollback-started`; then
  `rollback-succeeded|rollback-failed`. Every loser/ambiguous result fails closed; no delete/reopen.
- Exports atomic claim transitions, protected remediation CAS, append-only evidence-sequence CAS, and
  publication-control acquire/verify/resolve CAS from `data/publication-claim.schema.json`; every
  ambiguous result fails closed.

Build/Deploy/Runtime impact:
- Repository helper only until consumed; no public mutation.

Test plan (TDD - write FIRST):
- Replay probe fixtures and two-process/restart races; assert one insert/CAS winner and durable replay
  rejection for every graph edge.
- Reject illegal state, changed immutable key, malformed response, or unprobed selector.
- Prove one claim/control/remediation winner, terminal-origin+quarantine gate, monotonic evidence, and no
  unlock without remediation success, reconciled public bytes, and audited resolution/monotonic epoch.
- Prove remediation CAS from every listed ambiguous state while rejecting nonterminal/unknown origin.

Done when:
- Atomic claim/CAS behavior is independently executable.
- Focused tests, typecheck, lint, and tests pass.

## MIU 27: Rollback-artifact custody helper

Block: TESTING

Files: `scripts/geo-rollback-artifact.mjs`, `scripts/geo-rollback-artifact.test.mjs`

Type: new-file

Depends on: MIU 20, MIU 21, MIU 22, MIU 24, MIU 25

What it does:
- Uses `scripts/geo-cloudbase-contract.mjs` probed `queryHosting(listFiles)`,
  `manageHosting(downloadFile|downloadDirectory)`,
  and `queryHosting(websiteConfig)` contracts to enumerate/download complete pre-mutation bytes for the
  exact apply mutation set: overwritten target files, target-only new paths requiring later deletion,
  every approved prune/delete path, and website-document configuration. It builds artifact+manifest,
  uploads/signs via `scripts/geo-github-provenance-contract.mjs`, downloads to a clean path, verifies
  bytes/digests/path coverage, and emits custody fields from `data/publication-claim.schema.json`.
- Reads artifact-service metadata and requires actual expiry/retention beyond active+quarantine+incident
  recovery windows; requested retention alone and manifest-only custody are invalid.

Build/Deploy/Runtime impact:
- Creates a non-public durable GitHub rollback artifact; no public mutation.

Test plan (TDD - write FIRST):
- Cover target-only deletion restoration, deterministic bytes, upload/sign/download/hash/path/retention,
  missing/corrupt artifact, wrong signer, and clean extraction.
- Reject incomplete remote enumeration/download, omitted mutation path/config, and actual artifact expiry
  shorter than policy.

Done when:
- Apply consumes verified restorable bytes without discovering custody behavior.
- Focused tests, typecheck, lint, and tests pass.

## MIU 28: Authorized static apply writer

Block: INFRASTRUCTURE

Files: `scripts/deploy-cloudbase-test.mjs`, `scripts/geo-cloudbase-publication.mjs`, `scripts/geo-cloudbase-publication.test.mjs`

Type: modify-existing

Depends on: MIU 18, MIU 21, MIU 24, MIU 25, MIU 26, MIU 27

What it does:
- Defaults all static upload/delete/config mutations off inside `deployWebApp()` while preserving
  function deployment.
- Verifies current-run apply authorization via `scripts/geo-github-provenance-contract.mjs`, including
  signed `authorizedAt`/`expiresAt` and `0 < lifetime <= 10m`; verifies exact registry/source/EnvId/
  target, verifies `geo_publication_controls` is locked by this exact prepared claim ID/epoch, then
  atomically CASes `prepared→upload-started` via `scripts/geo-publication-claim.mjs` before first mutation.
- Verifies the signed authorization embeds the previously verified custody result from
  `scripts/geo-rollback-artifact.mjs`; persists those custody/retention fields in the inserted
  `prepared` claim. Any missing byte, target-only deletion gap, retention defect, or ambiguous
  custody response prevents all static mutation.
- Emits only writer-observable receipt/topology fields using `scripts/geo-cloudbase-contract.mjs` and
  `data/deployment-attestation.schema.json`; public observation/`P` are excluded.

Build/Deploy/Runtime impact:
- Guards the existing public static writer; no new runtime dependency.

Test plan (TDD - write FIRST):
- Invalid/forged/expired/replayed authority or unchanged target invokes no static mutation; exact
  authority permits one apply.
- Cover all mutation/receipt/topology/digest outcomes and apply claim transitions.
- Cover locked/missing/ambiguous control state; rollback artifact build/upload/sign/download/hash/path/
  retention failures; prove claim insertion includes verified custody before any static mutation.
- Reject unlocked, other-claim, or stale-epoch control lock even with otherwise valid authorization.

Done when:
- No repository path can apply static output without verified authority and one atomic claim.
- Focused tests, SDK gate, typecheck, lint, tests, and deploy smoke pass.

## MIU 29: Authorized static rollback writer

Block: INFRASTRUCTURE

Files: `scripts/deploy-cloudbase-test.mjs`, `scripts/geo-cloudbase-publication.mjs`, `scripts/geo-cloudbase-publication.test.mjs`

Type: modify-existing

Depends on: MIU 24, MIU 25, MIU 26, MIU 27, MIU 28

What it does:
- Verifies a fresh rollback authorization via `scripts/geo-github-provenance-contract.mjs` with signed
  `rollbackAuthorizedAt`/`rollbackExpiresAt`, `0 < lifetime <= 10m`, approved recovery signer/workflow,
  same immutable apply identity/nonce/key, and frozen rollback-manifest digest.
- Uses `scripts/geo-publication-claim.mjs` CAS to enter `rollback-started` from any recoverable apply
  state, performs rollback only through `deployWebApp()`, then CASes rollback outcome. Apply expiry is
  irrelevant after claim insertion; rollback has its own fresh window.
- Records the authorized rollback run identity, downloads/verifies claim-bound artifact, and reconciles
  idempotently through `scripts/geo-rollback-artifact.mjs`. No second runner may take over
  `rollback-started`; later remediation is a distinct
  protected state after terminal-origin/quarantine verification.
- Exposes an explicit remediation mode in `scripts/geo-cloudbase-publication.mjs` using the same
  provenance, artifact, public-byte reconciliation, and sole `deployWebApp()` mutation boundary. It
  consumes only a remediation plan/authorization whose exact state/run/attempt CAS already won.

Build/Deploy/Runtime impact:
- Adds rollback mode behind the sole writer.

Test plan (TDD - write FIRST):
- Reject unsigned/wrong signer/repo/workflow/ref/head/claim/digest, stale/missing/inverted/>10m rollback
  window, illegal state, or CAS loss with zero static mutations.
- Cover rollback from each recoverable state, success/partial failure, and preserved immutable claim.
- Cover second-run rejection, death before/during/after mutation, artifact corruption/absence, public
  already rolled back/target/partial, and same-run idempotent retry.
- Cover remediation-mode first attempt/retry, fresh authorization, prior-run terminal/quarantine,
  monotonic attempt CAS, and zero mutation on stale/concurrent plan.

Done when:
- Rollback is fresh-authorized, single-winner, and never a second writer.
- Focused tests, typecheck, lint, tests, and deploy smoke pass.

## MIU 30: Public-observation helper

Block: TESTING

Files: `scripts/geo-public-observation.mjs`, `scripts/geo-public-observation.test.mjs`

Type: new-file

Depends on: MIU 20, MIU 25

What it does:
- Produces normalized public manifests before/after receipt, detects preexisting target, polls with a
  bounded schedule, and sets `P` only to the first post-receipt target match.
- Exports pure digest/timestamp/`P` validation; no workflow, signing, or hosting mutation.
- Emits public-observation structures defined by
  `docs/seo/phase-3-geo/data/deployment-attestation.schema.json`.

Build/Deploy/Runtime impact:
- Read-only public HTTP observation helper.

Test plan (TDD - write FIRST):
- Cover preexisting target, timeout, changing/nonmatching bytes, first match, ordering, normalization,
  cache-busting, and noncanonical origin.

Done when:
- Public `P` semantics are independently executable.
- Focused tests, typecheck, lint, and tests pass.

## MIU 31: Evidence-finalizer helper

Block: TESTING

Files: `scripts/geo-publication-finalizer.mjs`, `scripts/geo-publication-finalizer.test.mjs`

Type: new-file

Depends on: MIU 24, MIU 25, MIU 26, MIU 30

What it does:
- Given apply/observation/rollback/remediation outcome, builds/signs/uploads sequenced evidence using
  constants/helpers from
  `scripts/geo-github-provenance-contract.mjs` and `data/deployment-attestation.schema.json`.
- Performs no rollback or hosting mutation. Callers return their original failure only after evidence
  persistence. Before recording rollback failure/ambiguity it verifies the claim-owned EnvId lock remains
  set and appends sequence through `scripts/geo-publication-claim.mjs`; inability to verify lock prevents
  finalization. Runner death belongs to MIU 33.

Build/Deploy/Runtime impact:
- Repository finalization helper; no workflow enabled yet.

Test plan (TDD - write FIRST):
- Cover success/failure/remediation variants, sequence CAS, evidence-before-error ordering, no failure
  `P`, retained lock on rollback failure, and zero writer/hosting calls.

Done when:
- All outcomes have one reusable evidence finalizer with no mutation authority.
- Focused tests, typecheck, lint, and tests pass.

## MIU 32: Stale-claim detector

Block: TESTING

Files: `scripts/geo-stale-claim.mjs`, `scripts/geo-stale-claim.test.mjs`

Type: new-file

Depends on: MIU 22, MIU 26, MIU 30

What it does:
- Classifies `data/publication-claim.schema.json` records using trusted time, origin-run terminal status,
  quarantine duration, state,
  custody/evidence sequence, EnvId lock, and current public bytes from
  `scripts/geo-public-observation.mjs`; emits one deterministic protected-remediation plan.
- Never mutates claims, controls, hosting, or evidence.

Build/Deploy/Runtime impact:
- Read-only helper.

Test plan (TDD - write FIRST):
- Cover nonterminal/terminal/unknown/self-hosted origin, quarantine boundary, every claim state,
  custody/evidence/control state, public target/rollback/partial, and death before/during/after rollback.

Done when:
- Recovery consumes a fixed plan instead of rediscovering state logic.
- Focused tests, typecheck, lint, and tests pass.

## MIU 33: Protected incident-remediation workflow

Block: INFRASTRUCTURE

Files: `.github/workflows/geo-publication-recovery.yml`, `scripts/geo-publication-recovery.mjs`, `scripts/geo-publication-recovery.test.mjs`

Type: new-file

Depends on: MIU 24, MIU 26, MIU 29, MIU 31, MIU 32

What it does:
- Protected manual workflow consumes `scripts/geo-stale-claim.mjs`, requires terminal GitHub-hosted origin
  run plus quarantine, signs fresh remediation authorization, then CASes exact prior state/run/attempt to
  `remediation-started` exclusively through `scripts/geo-publication-claim.mjs`. It passes that
  authorization plus the winning CAS plan to the remediation mode owned by
  `scripts/geo-cloudbase-publication.mjs`, and persists sequenced evidence through
  `scripts/geo-publication-finalizer.mjs`, using
  `scripts/geo-github-provenance-contract.mjs` for trust.
- Uses EnvId-scoped non-cancelling concurrency. Ambiguous/failed remediation keeps control locked and
  transitions to `remediation-failed`; it never auto-unlocks or reopens apply.

Build/Deploy/Runtime impact:
- Enables protected incident remediation before public apply integration.

Test plan (TDD - write FIRST):
- Cover terminal/quarantine gate, concurrent remediation CAS, provenance, byte reconciliation,
  remediation/evidence failure, retained lock, same concurrency key, and no direct hosting mutation.
- Cover protected retry after remediation runner death/failure and reject nonterminal/unknown prior run.

Done when:
- Runner loss has an executable, fenced-by-termination remediation owner.
- Workflow syntax, focused tests, typecheck, lint, tests, and smoke pass.

## MIU 34: Publication-lock resolution workflow

Block: INFRASTRUCTURE

Files: `.github/workflows/geo-publication-unlock.yml`, `scripts/geo-publication-unlock.mjs`, `scripts/geo-publication-unlock.test.mjs`

Type: new-file

Depends on: MIU 24, MIU 26, MIU 33

What it does:
- Protected workflow resolves an EnvId lock only for `success-verified` or `incident-remediated`.
  It directly verifies evidence with `scripts/geo-github-provenance-contract.mjs` and
  `data/deployment-attestation.schema.json`. `success-verified` requires signed success, live
  `apply-succeeded`, and no later evidence.
  Both modes require verified current public bytes and website configuration, complete ordered evidence,
  exact live claim/control epoch, signed resolution evidence, and an approver distinct from the executor.
  `incident-remediated` additionally requires `remediation-succeeded`. It CASes exact lock epoch through
  `scripts/geo-publication-claim.mjs`; it cannot mutate claims/hosting.

Build/Deploy/Runtime impact:
- Adds audited lock resolution; no public static mutation.

Test plan (TDD - write FIRST):
- Reject wrong signer/evidence/EnvId/epoch/live claim/later evidence/unreconciled bytes/ambiguous CAS;
  accept both valid resolution modes and retain lock history.

Done when:
- Lockout resolution is explicit and auditable.
- Workflow syntax, focused tests, typecheck, lint, and tests pass.

## MIU 35: Signed publication authorization helper

Block: TESTING

Files: `scripts/emit-geo-publication-authorization.mjs`, `scripts/emit-geo-publication-authorization.test.mjs`

Type: new-file

Depends on: MIU 18, MIU 22, MIU 24, MIU 25, MIU 26, MIU 27, MIU 31

What it does:
- Freezes current main tip/registry/output digests and emits a canonical apply authorization with signed
  `authorizedAt`/`expiresAt` lifetime ≤10 minutes using
  `docs/seo/phase-3-geo/data/deployment-attestation.schema.json` and the pinned provenance helper.
- Validates exact test-controller ref/workflow/source, obtains verified custody from
  `scripts/geo-rollback-artifact.mjs`, inserts a non-authorizing `prepared` record through
  `scripts/geo-publication-claim.mjs`, then atomically locks `geo_publication_controls` to that claim and
  includes lock epoch/custody in signed bytes. Failure after `prepared` or lock appends incident evidence
  via `scripts/geo-publication-finalizer.mjs` and leaves a recoverable record; no unsigned cleanup exists.

Build/Deploy/Runtime impact:
- Repository helper only; no deployment/public mutation.

Test plan (TDD - write FIRST):
- Reject wrong ref/source/workflow/registry/output/time window/permissions and prove deterministic signed
  projection.
- Reject locked/missing/ambiguous/CAS-loss control state; prove one authorization winner and retained
  lock after producer crash.
- Reject missing/corrupt/expired custody and prove signed projection binds exact custody fields.

Done when:
- Exact-main apply authorization is independently executable.
- Focused tests, typecheck, lint, and tests pass.

## MIU 36: Atomic publication workflow integration

Block: INFRASTRUCTURE

Files: `.github/workflows/deploy-test.yml`, `scripts/geo-deploy-workflow.test.mjs`, `scripts/runtime-contract.test.mjs`

Type: modify-existing

Depends on: MIU 19, MIU 20, MIU 28, MIU 29, MIU 30, MIU 31, MIU 33, MIU 34, MIU 35

What it does:
- Only after recovery is enabled, wires pre-observation → signed authorization → apply writer → public
  observation/smoke → signed success evidence. Under `if: always()`, a reported post-claim failure first
  signs a fresh rollback authorization, invokes only MIU 29, then sends the rollback/outcome to MIU 31
  for sequenced evidence persistence before restoring the original failure.
- Enumerates all source/package/workflow static writers and requires convergence on MIU 28/29, one
  EnvId-scoped `cancel-in-progress:false` group shared with recovery, exact-main source, and no direct
  hosting mutation. Non-GEO runs may deploy functions or skip byte-identical static output only.
- Success appends signed sequenced evidence but leaves the claim-owned EnvId lock set for MIU 34
  `success-verified` resolution; every failure path leaves it locked for remediation.

Build/Deploy/Runtime impact:
- First MIU that enables the guarded public apply path.

Test plan (TDD - write FIRST):
- Cover complete success/failure ordering, every mutation failure, finalizer-before-failure, writer
  enumeration, concurrency equality, exact source, and unauthorized static delta.
- Assert workflow invokes only `emit-geo-publication-authorization.mjs`,
  `geo-cloudbase-publication.mjs`, `geo-public-observation.mjs`, and
  `geo-publication-finalizer.mjs` at their owning stages.
- Assert runner-death recovery workflow is enabled before apply step can run.

Done when:
- No intermediate MIU exposed an unfinalized public writer; integrated deployment is recoverable.
- Workflow syntax, focused tests, typecheck, lint, tests, deploy smoke, and function artifacts pass.

## MIU 37: Trusted attestation verifier

Block: TESTING

Files: `scripts/geo-attestation-import.mjs`, `scripts/geo-attestation-import.test.mjs`

Type: new-file

Depends on: MIU 24, MIU 25, MIU 26, MIU 36

What it does:
- Retrieves all artifacts for the claim and verifies run/workflow/ref/head/artifact/subject/signer through
  `scripts/geo-github-provenance-contract.mjs`, validates
  `docs/seo/phase-3-geo/data/deployment-attestation.schema.json`, orders strict append-only
  `evidenceSequence`, reads live claim/control through `scripts/geo-publication-claim.mjs`, recomputes
  digest/time/`P`, and emits one normalized current result. Committed locators are untrusted; earlier
  success is invalid when later rollback/remediation/incident evidence or live state exists.

Build/Deploy/Runtime impact:
- Read-only GitHub verification helper.

Test plan (TDD - write FIRST):
- Reject forged/wrong/unsigned/expired/missing, duplicate/gapped/reordered evidence, stale success, and
  live claim/control mismatch; accept current success/failure/remediation evidence.

Done when:
- Lifecycle validation consumes one verified result.
- Focused tests, typecheck, lint, and tests pass.

## MIU 38: Registry lifecycle import

Block: TESTING

Files: `scripts/validate-geo-evidence.mjs`, `scripts/validate-geo-evidence.test.mjs`, `.github/workflows/ci.yml`

Type: modify-existing

Depends on: MIU 17, MIU 18, MIU 19, MIU 20, MIU 37

What it does:
- Consumes only verified results from `scripts/geo-attestation-import.mjs`, compares canonical
  `docs/seo/phase-3-geo/publishing/registry.json` at `GEO_DIFF_BASE_SHA` with HEAD, and permits legal
  lifecycle transitions with no production-output delta.
- CI grants contents/actions/attestations read only.

Build/Deploy/Runtime impact:
- Read-only CI lifecycle validation.

Test plan (TDD - write FIRST):
- Reject base mutation/output delta/illegal transition/unverified result; accept verified success/
  failure/recovery transitions.

Done when:
- Registry cannot advance from self-reported provenance.
- Focused tests, typecheck, lint, tests, and function artifacts pass.

## MIU 39: Attested comparison semantic rules

Block: TESTING

Files: `scripts/validate-geo-evidence.mjs`, `scripts/validate-geo-evidence.test.mjs`, `docs/seo/phase-3-geo/data/comparison-checkpoint.schema.json`

Type: modify-existing

Depends on: MIU 9, MIU 16, MIU 17, MIU 25, MIU 38

What it does:
- Resolves eligible active/measurement-complete hypotheses from
  `docs/seo/phase-3-geo/publishing/registry.json` plus verified
  `docs/seo/phase-3-geo/data/deployment-attestation.schema.json` evidence and emits
  `data/comparison-checkpoint.schema.json`; standalone SHA/time never suffices.
- Applies overlap/reset and AI snapshot/model/evaluator/sample/effect rules after intervention eligibility.

Build/Deploy/Runtime impact:
- Repository validation only; no external mutation.

Test plan (TDD - write FIRST):
- Accept eligible active/completed entries; reject every other state, recovery/rollback, drift, overlap,
  missing sample, or incorrect effect classification.

Done when:
- SEO/AI uplift cannot be reported without one verified public intervention.
- Focused tests, typecheck, lint, and tests pass.

## MIU 40: SEO and AI comparison checkpoint templates

Block: INTEGRATION

Files: `docs/seo/phase-3-geo/checkpoints/SEO-D59.json`, `docs/seo/phase-3-geo/checkpoints/AI-COMPARISON.json`, `docs/seo/phase-3-geo/checkpoints/COMPARISON-RUNBOOK.md`

Type: new-file

Depends on: MIU 39

What it does:
- Creates blocked templates/runbook with no synthetic observations. Empty registry omits hypothesis ID
  and records `unassigned-hypothesis`; complete state requires one eligible hypothesis.
- Encodes SEO windows and AI identical-run/effect requirements from
  `data/comparison-checkpoint.schema.json` and references canonical `publishing/registry.json`.

Build/Deploy/Runtime impact:
- Reporting templates only; no external mutation.

Test plan (TDD - write FIRST):
- Validate blocked templates against empty registry and complete fixtures only against eligible evidence;
  reject injected metrics/`P`/uplift/nonexistent hypothesis.

Done when:
- Templates cannot claim results before real evidence exists.
- Root typecheck, lint, and tests pass.
