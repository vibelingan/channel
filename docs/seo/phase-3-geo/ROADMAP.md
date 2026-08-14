# SEO Phase 3 GEO Roadmap

Status: proposed implementation sequence

## Timeline Rule

Calendar dates depend on two gates:

- PR #17 merged and Phase 3 implementation rebased onto latest `main`.
- Search Console owner/access available for SEO D0.

If SEO D0 is 2026-08-14, D+14 is Aug 28, D+28 is Sep 11, D+56 window-end is Oct 9, and the complete
D+59 extraction/review is Oct 12. If access arrives later,
shift all SEO checkpoint dates from the actual D0. AI checkpoints start from a separate AI D0.

## Planning and Baseline Setup: 2–5 Business Days

### GEO-01 — Report validity and scope lock

Deliverables:

- mark GeoLoop pages 21–75 model scores invalid due to OpenRouter 402;
- preserve pages 3–20 as dated recommendation inventory;
- remove Bing and superseded Phase 2 work from current backlog;
- confirm entity contract (`name`, `legalName`, visible brand);
- approve the Phase 3 page cohort and exclusions.

Acceptance:

- no invalid score appears in KPI/target documents;
- no completed Phase 2 item is reopened without new evidence;
- business/platform features remain excluded;
- the supplied report copy matches SHA-256
    `17ebfe0e4844c5f719e4e5593804b0e3f597c04673b586daafcf2723a8377a87`, 1,703,061 bytes, and 76 pages;
- pages 21–75 contain five failed request panels each, deriving 275 failures from 550 literal `402`
    occurrences; a different hash/count blocks reuse of this audit.

Artifacts:

- `docs/seo/phase-3-geo/REPORT-AUDIT.md`
- `docs/seo/phase-3-geo/README.md`

Validation: independent file hash/size/page checks, page-level 402 panel counts, and current Phase 2
status assertions pass; the local WeWork cache path is provenance only, not a validator input.

Build/runtime impact: none.

### GEO-02 — Measurement contracts

Dependencies: GEO-01.

Deliverables:

- JSON Schema: `docs/seo/phase-3-geo/data/fact-register.schema.json`;
- canonical records: `docs/seo/phase-3-geo/data/facts.json`;
- AI question set: `docs/seo/phase-3-geo/data/ai-questions.json`;
- AI run schema: `docs/seo/phase-3-geo/data/ai-run.schema.json`;
- documented provider/model/prompt/error/scoring/aggregation contract.

Acceptance:

- JSON validates against schemas;
- request errors cannot be represented as numeric zero;
- identity collision is excluded from mention count and scored as identity failure;
- withdrawal of a fact lists visible-content, Schema and `llms.txt` consumers.

Validator:

- implementation: `scripts/validate-geo-evidence.mjs`;
- interface: `node scripts/validate-geo-evidence.mjs [--schema <path> --data <path>] [--facts <path>]
    [--facts-snapshot <path>] [--ai-run <path>] [--checkpoint <path>] [--content-brief <path>]
    [--page-contract <path>]
    [--publishing-registry <path> --ai-checkpoint <path> --contracts-root <path>]`;
- fact fixtures: `docs/seo/phase-3-geo/fixtures/facts.valid.json` and
    `docs/seo/phase-3-geo/fixtures/facts.invalid.json`;
- AI fixtures: `docs/seo/phase-3-geo/fixtures/ai-run.valid.json` and
    `docs/seo/phase-3-geo/fixtures/ai-run.invalid.json`;
- passing commands exit `0`:
    `node scripts/validate-geo-evidence.mjs --facts docs/seo/phase-3-geo/fixtures/facts.valid.json`
    and
    `node scripts/validate-geo-evidence.mjs --ai-run docs/seo/phase-3-geo/fixtures/ai-run.valid.json`;
- failing commands exit nonzero and name the violated invariant when either `.invalid.json` path is used;
- validates fact records and AI manifests against the selected schemas;
- verifies IDs, hashes/references, consumers, withdrawal reasons, prompt hashes, attempts, and
    error-vs-score invariants;
- canonical release checks enumerate each fact, AI run, checkpoint, brief, page contract, and publishing
    artifact through its explicit mode; there is no implicit no-argument scan.

Build/runtime impact: none until a later publishing MIU consumes approved records.

### GEO-03 — Search Console ownership and SEO D0

Dependencies: GEO-01; Search Console owner/full access.

Deliverables:

- verify existing domain property before creating one;
- record property owner/full-user access;
- inspect existing sitemap submission before submitting;
- store four URL Inspection records and screenshots;
- record production SHA, canonical, crawl/index, last crawl and structured-data state;
- record PageSpeed lab and CrUX availability separately.

Acceptance:

- SEO D0 is an explicit timestamp;
- no duplicate property/sitemap is created;
- D+14/D+28/D+56 window-end and D+59 review dates are computed.

Artifacts:

- `docs/seo/phase-3-geo/evidence/search-console/D0/` redacted manifest/index only; screenshots and raw
    exports stay in the approved external evidence location;
- `docs/seo/phase-3-geo/checkpoints/SEO-D0.md`;
- no duplicate property or sitemap submissions.

Validation: four URL Inspection records, immutable deploy SHA, extraction timezone/date, PageSpeed
lab result, and CrUX availability are present.

Build/runtime impact: none.

### GEO-04 — Establish AI D0

Dependencies: GEO-02, GEO-05, and funded/working providers.

Deliverables:

- redacted hashes/aggregate manifest and public citation index under
    `docs/seo/phase-3-geo/evidence/ai/D0/`; raw responses, provider IDs, billing metadata, and restricted
    citations stay in the approved external evidence location;
- run manifest validated by `ai-run.schema.json`;
- checkpoint `docs/seo/phase-3-geo/checkpoints/AI-D0.md`.

Acceptance:

- the funding/quota preflight passes before the first D0 sample;
- at the complete transition, the selected immutable snapshot's source revision and canonical source
    hash match the then-current approved fact-register projection; a stale but internally valid snapshot
    keeps AI D0 blocked;
- the required-cell set from `MEASUREMENT-AND-EVIDENCE.md` §5 completes Q1–Q9 across every selected
    model with exactly three terminally successful sample slots per cell; failed attempts remain reported,
    but any unresolved required-slot `ERROR` blocks AI D0;
- prompt hashes and provider/model parameters match the frozen contract;
- `factsSnapshotId` and `factsSnapshotSha256` resolve to the immutable snapshot used for every factual
    score;
- identity, factual, citation, relevance and completeness scores are reproducible.

Evidence custody gate: GEO-03 and GEO-04 cannot start until the external location, access owner,
redaction reviewer, and retention period are named in their checkpoint. A missing custodian is a blocked
state, not permission to commit raw evidence.

Deferral rule: GEO-03, GEO-05, GEO-06, GEO-07, and GEO-08 may proceed without AI D0. GEO-09
publication remains blocked until AI D0 exists.

Build/runtime impact: none.

### GEO-05 — Fact and evidence register bootstrap

Dependencies: GEO-02.

Deliverables:

- populate canonical `facts.json` using the selected JSON Schema;
- owners for company history, facilities, capabilities, certifications, case results, MOQ/lead time,
  warranties, logistics, payments, and official profiles;
- initial inventory uses the complete lifecycle `draft | blocked | approved | expired | withdrawn`.

Acceptance:

- every public numeric/commercial/certification claim has evidence and owner or is removed/deferred;
- current entity contract is recorded as approved, not blocked.

Validation: schema validation, evidence hash/reference checks, and consumer-reference checks pass.

Build/runtime impact: none until approved claims are consumed by publishing MIUs.

## SEO D0–D+14: Technical Health

### GEO-06 — Crawl/index checkpoint

Dependencies: GEO-03 and SEO D+14.

Actions:

- monitor four-page crawl/index/canonical state;
- fix confirmed sitemap, robots, canonical, rendering or structured-data defects;
- verify noindex routes remain excluded;
- record performance/host-header observations for a separate infrastructure backlog only.

Do not:

- rewrite content from early rank movement;
- add Schema just to increase an audit score;
- enable HSTS/CDN without owner, cost, purge and rollback evidence.

Comparison rule: a material canonical/indexing/rendering repair resets that page's comparison origin;
report it as technical recovery, not content uplift.

Artifacts: `docs/seo/phase-3-geo/checkpoints/SEO-D14.md` and page eligibility table.

Validation: extraction dates/timezone fixed; four-page status and reset decisions recorded.

Build/runtime impact: only separate bug-fix MIUs for confirmed defects.

## SEO D+14–D+28: Content and Schema Preparation

### GEO-07 — Content evidence package

Dependencies: GEO-05; client approvers.

Prepare for client approval:

- 8–12 procurement questions and visible answers;
- 3–5 case-study briefs;
- company/process facts and differentiators;
- certification applicability map;
- official profiles and external citation candidates.

Fact-register changes after AI D0 do not mutate its rubric. Before publishing content that adds or
changes approved facts, either keep the uplift comparison on the original snapshot and report a
separate current-safety score, or re-score both stored D0 responses and the future comparison against a
new immutable snapshot and reset the attribution baseline. Record both original and rescored results.

Acceptance:

- every fact links to the evidence register;
- unsupported claims are removed or explicitly blocked;
- content is useful to a buyer without any Schema.

Artifacts: approved briefs under `docs/seo/phase-3-geo/content-briefs/` with claim IDs and permissions.

Validation: every public fact resolves to an approved fact record; expired/blocked claims are absent.

Build/runtime impact: none; approval package only.

### GEO-08 — Page/Schema design

Dependencies: GEO-05 and GEO-07.

For each proposed page, document:

- visible fields and owner;
- index/noindex intent;
- URL/canonical/internal-link contract;
- eligible Schema type and required fields;
- omission behavior when fields are absent;
- update/review lifecycle.

Candidate order:

1. BreadcrumbList on genuine visible hierarchy.
2. Article on approved dated/authored case or teardown pages.
3. Product remains outside this DAG until the separate server-visible product data contract is approved.
4. `sameAs`/logo only after official assets/accounts are confirmed.

Artifacts: per-page contracts under `docs/seo/phase-3-geo/page-contracts/`.

Executable gates for any later Schema MIU:

- matching visible fields in server-rendered production HTML;
- canonical/indexable page;
- omission when evidence/required fields are absent;
- JSON-LD/schema validation;
- deployed-page smoke and Search Console/Rich Results evidence where applicable.

Build/runtime impact: design only.

## From SEO D+28: Publish and Measure

### GEO-09 — Controlled publishing MIUs

Dependencies: GEO-03, GEO-04, GEO-06, GEO-07, and GEO-08. There is no publication bypass for deferred
SEO D0, AI D0, or page eligibility.

Use separate, reviewable MIUs:

- procurement FAQ/content section;
- case studies;
- internal links;
- matching Schema;
- trustworthy `lastmod` if content timestamps exist;
- `llms.txt` only after the final page set stabilizes.

Each MIU changes one material content/measurement hypothesis where possible.
For each affected page, deployment time `P` starts the hypothesis window: compare `[P-28d,P)` with
`[P,P+28d)` and extract at or after `P+31d`. A second material change on that page before `P+28d`
makes the result observational rather than attributable to either change.

Shared-layout edits such as Organization `sameAs`, logo, or other global JSON-LD are site-level
hypotheses. Ship one site-level hypothesis alone: no page-level hypothesis may be in an active pre/post
window. With no unaffected holdout in the four-page cohort, report site-level observation only and do
not claim per-page uplift.

The planned publication enforcement will be automatic, not caller opt-in. A canonical publishing registry will normally use
`planned → approved → deployed → active → closed` transitions; failed public smoke permits
`deployed → closed` with rollback evidence and no `P`. Before deployment, an `approved` entry
enumerates one page/site hypothesis, exact owned source files, approved claims/briefs/contracts,
completed SEO-D0 and AI-D0 checkpoints, applicable SEO-D14 eligibility, tests, rollback, and expected
generated outputs. A site entry requires eligibility for all four cohort pages. Only this state
authorizes the implementation diff; it does not invent a deploy SHA or start a measurement window.

After the reviewed implementation is merged to `main`, the planned protected `test` workflow will freeze the
current `origin/main` tip and require `sourceMainSha` to equal it exactly. It will
check out, build, and deploy that exact source SHA; `testWorkflowSha` will identify the workflow
controller but will never be presented as the released content. The workflow will refuse to run if its trusted
build/deploy/attestation files differ from the same files at `sourceMainSha`.

CloudBase currently has one publicly usable environment, and `test` is its deployment channel; that
does not make `test` the code authority. Once implemented, the workflow will record a structured hosting upload receipt, then
re-queries the selected `TCB_ENV_ID` and requires enabled `supplychainsai.com` `/` and `/*` routes to
that environment's `STATIC_STORE`. It fetches the normalized output manifest from the public origin
before upload and requires it to differ from the approved target. After upload it polls until the target
matches or times out. Only the first post-upload match after a different pre-upload observation is `P`,
not an invented provider deployment timestamp. If target bytes were already public, close the attempt
as `preexisting-public-output` with no `P` or uplift eligibility. The run artifact binds repository,
workflow path/blob, event,
ref, run ID, `sourceMainSha`, `testWorkflowSha`, EnvId, hosting bucket/static domain, upload request ID,
route-config digest, deployed artifact digest, `publicOutputManifestSha256`, `P`, and smoke/rollback
outcomes. `deployed` requires trusted import of that artifact; successful smoke permits `active`, while
failed smoke permits only rollback and `deployed → closed` with no `P`.

Upload invocation is the irreversible boundary. The upload call itself may fail after partial remote
mutation, so upload-call failure, receipt generation, route verification, public-manifest polling,
smoke, or any later failure runs the same unconditional finalizer: attempt rollback, record the failed
phase and rollback outcome, emit/sign/upload failure evidence, then restore the failed workflow result.
Even rollback failure closes the measurement attempt with no `P`, blocks further publication, and
requires an infrastructure incident before another run.

After MIUs 19–20, CI will check out enough history, pass an event-specific immutable base, and run the
output comparator: PR base SHA
for pull requests and push `before` SHA for branch pushes. Missing, unavailable, or all-zero first-push
bases will fail before build; there will be no fallback. It will build base and HEAD with
fixed production-origin values, normalize only an explicit nondeterminism allowlist, and compare every
emitted route, asset, sitemap/robots artifact, Schema-bearing HTML, `llms.txt`, and global output. Every
changed output must resolve to exactly one entry newly moving to `approved` and one expected digest;
source ownership remains a diagnostic, not the coverage boundary. New approval with no output change,
unregistered output, duplicate ownership, or stale ownership fails. Registry-only lifecycle changes and
historical entries may have unchanged output, but cannot smuggle any production-output delta.

MIU 36 will make every repository writer to the current public static store use the same environment-scoped concurrency
group and run this output gate before upload. Ordinary `test` deployments may continue for functions,
or skip static upload when public bytes are unchanged. Any static-output delta requires a newly approved
registry entry; no push-triggered or manual non-GEO path may overwrite an active/reserved measurement.

After MIU 28, the sole static writer, `deployWebApp()` in `scripts/deploy-cloudbase-test.mjs`, will
enforce the boundary: without a short-lived, signed, current-run authorization it will perform no
static upload. The authorization will
bind repository, exact signer workflow/ref/run, latest-main source SHA, EnvId, hypothesis ID, approved
registry digest, and target manifest. Direct root-script invocation cannot convert self-reported
environment variables or an unsigned JSON file into write authority.
Before apply authorization, MIU 35 will persist a non-authorizing `prepared` claim containing verified
rollback custody, then lock the EnvId to that claim and sign the authorization. Immediately before the
first static mutation, MIU 28 will CAS `prepared → upload-started`. The unique claim key covers
repository, run ID, nonce, EnvId, and target digest, so exactly one apply may proceed. Duplicate,
unavailable, or ambiguous results fail closed; post-claim states are never deleted or reopened.
Protected remediation reuses the same claim/nonce. It requires the prior GitHub-hosted run to be
terminal, quarantine to elapse, fresh signed remediation authority, monotonic attempt, and exact CAS;
it never creates a new apply claim to bypass the incident.

Artifacts: one implementation branch/MIU per hypothesis, with claim IDs, page contract, expected output
digests, imported deployment-attestation reference, tests, and rollback.

Validation: focused source tests, site tests/typecheck/lint/build, deploy E2E, public-origin smoke, and
checkpoint annotation.

Build/runtime impact: scoped to the approved page/content/Schema MIU.

### GEO-10 — Publish-relative SEO and AI effectiveness reviews

Dependencies: eligible measurement windows after GEO-09.

D+59 applies only to a GEO-09 hypothesis deployed at D+28 whose page was not repaired at D+14 or later.
Because GEO-06 intentionally repairs confirmed defects, D+59 is an earliest exceptional date, not the
expected review date for every page. Later publishes and repaired pages move to their own eligible
`P+31d` review after two clean windows.

Decide whether to:

- deepen a page with relevant impressions at positions 8–30;
- improve title/snippet alignment where position is good and CTR evidence is sufficient;
- strengthen page differentiation/internal links when the wrong page ranks;
- expand case/FAQ content;
- invest in authority/editorial citations;
- revise or retire low-value Schema/content;
- begin the next 56-day cycle.

Every SEO or AI effectiveness comparison resolves exactly one eligible registry entry. Eligible means
the entry has a verified successful attestation, passed through `deployed → active`, retains immutable
`P`, has no rollback, and is either still `active` or `closed` with `closeReason: measurement-complete`.
The comparison derives all release evidence from that attestation; planned, approved, deployed,
failed-smoke closed, rolled-back, or prematurely closed entries cannot support uplift.

AI comparison: only changes with a valid pre-intervention AI D0, the same fact snapshot, the complete
three-sample required-cell set, unchanged evaluator/adjudicator role IDs and guide revision, and
unchanged returned model revisions can claim uplift. Any evaluator, role, guide, or model-revision
change is observational and becomes a candidate new baseline; bridge calibration documents continuity
but cannot restore attribution. Movement below the §5 minimum-effect rule is “no material measured
uplift.” Without valid D0, establish AI O1 and wait for a later controlled change.

## Separate/Blocked Workstreams

| Item | Why separate or blocked |
|---|---|
| Compression/cache | Separate infrastructure workstream: CloudBase capability, cost, topology, purge and rollback approval |
| Host redirects/HSTS | Separate infrastructure workstream: certificate, host policy and irreversible browser state considerations |
| Conversion attribution | current inquiry flows do not provide a reliable tracked conversion baseline |
| Product SSR/data contract | current product details depend on client-side loading; needs its own design |
| Multilingual/hreflang | no approved translated pages |
| Marketplace/suppliers/logistics | business platform scope, not GEO Phase 3 |

## MIU Order After Approval

1. GEO-01 report validity and scope lock.
2. GEO-02 measurement contracts.
3. GEO-03 Search Console / SEO D0.
4. GEO-05 fact register bootstrap.
5. GEO-04 AI D0.
6. GEO-06 SEO D+14 health review.
7. GEO-07 content evidence package.
8. GEO-08 page and Schema design.
9. GEO-09 controlled publishing MIUs.
10. GEO-10 SEO D+59 / AI D+n effectiveness reviews.

No implementation begins until the user approves the plan and the applicable business/evidence gates.
The implementation-level contract is [MIU_BREAKDOWN.md](MIU_BREAKDOWN.md); GEO-09 creates a separate
validator-clean MIU for each approved publishing hypothesis.
