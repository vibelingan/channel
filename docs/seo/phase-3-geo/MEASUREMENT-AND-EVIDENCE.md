# GEO Measurement and Evidence Contract

## 1. Two Baselines

### SEO D0

Starts only when:

- Google Search Console access is confirmed;
- property/sitemap state is captured;
- four URL Inspection records are stored;
- immutable SHA and timestamp deployed through the `test` branch are recorded, together with the
	public production-origin URLs measured at `https://supplychainsai.com`;
- PageSpeed lab results and CrUX availability are recorded separately.

### AI D0

Starts only when:

- the provider-specific runner passes the funding/quota preflight in §5;
- all required sample slots defined in §5 reach terminal `SUCCESS` within the allowed attempts. Failed
	attempts remain reported, but there is no unresolved required-slot `ERROR`;
- raw prompts, responses, citations, model IDs, date, region, and language are stored;
- request failures are excluded from all scores; unrelated-entity responses are excluded from mention
	counts but scored as identity failures;
- the fixed question set and fact-register snapshot are frozen for the first comparison period.

SEO D0 and AI D0 may be different dates.

## 2. Primary Page Cohort

- `https://supplychainsai.com/`
- `https://supplychainsai.com/oem/`
- `https://supplychainsai.com/portfolio/`
- `https://supplychainsai.com/headphones/`

Private/noindex pages are monitored only for accidental indexing and must not enter performance targets.

## 3. Fact Register

Canonical machine source:

- `docs/seo/phase-3-geo/data/fact-register.schema.json`
- `docs/seo/phase-3-geo/data/facts.json`

CSV/Markdown views may be generated, but they are not editable authorities.

Every public claim used for GEO content must have:

| Field | Meaning |
|---|---|
| `claimId` | stable identifier |
| `claim` | exact approved wording/fact |
| `scope` | company, facility, product family, model, market, date range |
| `source` | internal record or public independent source |
| `evidenceId` | stable evidence identifier |
| `evidenceHash` | SHA-256 or immutable source reference when possible |
| `sourceType` | contract, certificate, report, client approval, policy, external publication |
| `confidentiality` | public, internal, restricted |
| `owner` | person accountable for accuracy |
| `approver` | person who approved public use |
| `approvedAt` | approval timestamp |
| `reviewAt` | next review date |
| `expiresAt` | expiry if the fact changes over time |
| `publicUse` | pages/channels where the fact may appear |
| `schemaUse` | Schema properties that consume the claim |
| `llmsUse` | whether/where `llms.txt` may reference the claim |
| `status` | draft, blocked, approved, expired, withdrawn |
| `withdrawalReason` | required when withdrawn |

`blocked` means the claim is known/inventoried but cannot be approved for public use because evidence,
ownership, permission, or policy is missing. `draft` is incomplete work that may still become approved.
No approved fact register entry means no public numeric/commercial/certification claim.

### Fact snapshots for AI scoring

AI factual accuracy never validates historical runs against mutable `data/facts.json` directly.

- Before AI D0, write an immutable, canonicalized snapshot under
	`docs/seo/phase-3-geo/data/fact-snapshots/<factsSnapshotId>.json`.
- The snapshot envelope contains `factsSnapshotId`, `createdAt`, source fact-register revision,
	`sourceFactsSha256`, `canonicalization: "geo-facts-jcs-v1"`, `facts`, and
	`factsSnapshotSha256`.
- The hash is not self-referential: compute SHA-256 over UTF-8 RFC 8785 JSON Canonicalization Scheme
	bytes of the `facts` array only. Sort fact records by `claimId`; arrays whose schema declares set
	semantics are sorted lexicographically before JCS, while ordered arrays remain ordered. Envelope
	metadata and `factsSnapshotSha256` are excluded from the hashed projection.
- Every AI-run manifest stores `factsSnapshotId` and `factsSnapshotSha256`; validators resolve factual
	scores against that snapshot, so later withdrawal, expiry, or approval changes cannot invalidate an
	archived baseline.
- `sourceFactsSha256` hashes the canonical approved-facts projection from the source register at the
	recorded source revision. When AI D0 changes to `complete`, validation recomputes that projection from
	the then-current `data/facts.json`; revision and hash must both match the selected snapshot. This is a
	one-time freshness gate for establishing D0, not permission to revalidate completed historical runs
	against later mutable facts.
- A comparison claiming uplift must use the same snapshot as AI D0. If the live fact register changed,
	report a separate current-safety score against the new snapshot but do not mix it into the uplift
	comparison.
- If the old snapshot is no longer an acceptable rubric, re-score both D0 and the comparison against one
	new immutable snapshot, publish the original and rescored results side by side, and reset the
	attribution baseline. Publication gates continue to validate proposed content against the live fact
	register, not an historical snapshot.

## 4. Fixed AI Question Set

The first set should be small enough to rerun reliably and broad enough to detect entity collisions.

### Exact entity

1. What is Diversity Technology Limited and what does it manufacture?
2. What is the relationship between Diversity Technology and supplychainsai.com?
3. Where does Diversity Technology Limited operate?

### Category discovery

4. Which companies provide OEM/ODM product development from design through production?
5. Which manufacturers offer custom or OEM headphones?
6. Which OEM partners support sampling, tooling, production, quality control, and global delivery?

### Evidence and trust

7. What certifications or test evidence does Diversity Technology publish?
8. What customer cases or manufacturing outcomes does the company publish?
9. What is the company’s OEM development process?

### Commercial facts only after approval

10. What MOQ, lead-time, warranty, delivery, or payment terms are publicly documented?

Question 10 is scored “not published” rather than negative until approved policies exist.

## 5. AI Scoring

Score each successful response separately. Before AI D0, freeze:

- provider, provider routing/fallback policy, requested model identifier, and returned model revision;
- prompt template and SHA-256;
- temperature and max tokens;
- search/grounding/tool configuration and citation behavior;
- region, language, date/timezone;
- primary evaluator, independent adjudicator, scoring-guide revision, and disagreement rule;
- transient retry classes: HTTP 408/409/429/5xx, network reset, and provider timeout only;
- retry policy: at most one retry with recorded attempt number and deterministic backoff; authentication,
	credit/quota, invalid request, and policy blocks are not retried;
- every attempt stores provider request ID, billing/usage metadata when returned, and whether the provider
	may have billed a failed or duplicate request;
- aggregation rule: report per-question/model scores plus median by dimension, never hide error counts.

### Required request set and funding preflight

The required request set is defined once in `data/ai-questions.json` and the selected-model manifest:

- required questions are Q1–Q9 where `requiredForBaseline: true`;
- Q10 has `requiredForBaseline: false` until the commercial-policy approver enables it in a later frozen
	question-set revision;
- every required question is crossed with every selected model route and exactly three independent
	samples, producing the complete required-cell set;
- AI D0 and an uplift comparison are complete only when every required sample slot has terminal
	`SUCCESS` after at most two attempts (initial plus one allowed retry). A failed first attempt does not
	block when its slot later succeeds, but remains counted and reported. Any unresolved required-slot
	`ERROR` keeps the checkpoint blocked. Optional cells may remain `ERROR` but are reported and do not
	satisfy or expand the required denominator.

Before the first required request, the provider-specific runner must prove funding and quota:

1. validate credentials without exposing them;
2. use a provider balance/quota endpoint where available and require estimated run cost plus 20% headroom;
3. where no balance endpoint exists, perform one designated minimal smoke request and record an owner-
	approved budget cap with 20% headroom;
4. stop before D0 on authentication, credit/quota, policy, or budget failure. The preflight smoke is not
	a D0 sample.

| Dimension | Scale | Definition |
|---|---:|---|
| Identity accuracy | 0–2 | correct entity/domain/industry; no unrelated entity collision |
| Factual accuracy | 0–3 | statements match approved fact register |
| Citation quality | 0–2 | sources are relevant, accessible, and actually support claims |
| Recommendation relevance | 0–2 | brand appears for the intended need with defensible reasoning |
| Completeness | 0–1 | covers the necessary answer without unsupported additions |

Maximum: 10 per response. Request errors are `ERROR`, not 0. “No mention” is recorded separately from
incorrect mention. An unrelated entity does not count as a brand mention and receives identity accuracy
0. Dimensions that do not apply to a question are `N/A` and excluded from that response's denominator.
Normalize each response to a percentage of its applicable maximum. Aggregate by reporting the median
normalized score per dimension and question group plus valid/error/no-mention counts and the full
distribution. Never replace missing dimensions or failed responses with zero. Store aggregate and raw
evidence.

### Sampling, dispersion, and uplift threshold

- Run exactly three successful samples per required `(question, model)` cell at AI D0 and comparison.
- All three successful AI-D0 samples in one `(question, model)` cell must return the same provider/model
	revision. A mixed or missing revision blocks completion of that cell; do not average across revisions.
- Preserve each sample; report median, minimum, maximum, and interquartile range by cell, dimension, and
	question group. Never report a median without its valid sample count and dispersion.
- Pair D0 and comparison samples deterministically by frozen sample index for diagnostic deltas; the
	primary result remains the distribution and median, not one paired answer.
- Fewer than three valid samples in any required cell blocks a complete baseline or uplift claim.
- A normalized-score median increase below 10 percentage points is reported as “no material measured
	uplift,” not uplift. At or above 10 points, at least two of three paired sample deltas in the same cell
	must agree in direction; otherwise report the movement as inconclusive. This is an operational
	minimum-effect rule, not a statistical-significance claim.

### Provider model-revision drift

- Compare the returned provider/model revision for every required sample slot with the single frozen
	AI-D0 revision for that cell.
- Any differing or unreported revision degrades that model's comparison to observational; it cannot
	support an uplift claim even when requested model names and parameters match.
- Store the observational result, establish the changed revision as a candidate new baseline, and wait
	for a later controlled intervention before claiming uplift.

### Applicability matrix

| Question group | Identity | Factual | Citation | Recommendation | Completeness |
|---|---:|---:|---:|---:|---:|
| Exact entity | required | required | required | N/A | required |
| Unbranded category discovery | required when brand/entity mentioned | required when mentioned | required | required | required |
| Evidence and trust | required | required | required | N/A | required |
| Commercial facts | required | required | required | N/A | required |

### Evaluator consistency

- Before AI D0, the primary evaluator and adjudicator independently score the same frozen calibration
	set containing correct, unsupported, no-mention, and entity-collision responses.
- Exact agreement is preferred. Any dimension disagreement greater than one raw point, any identity-
	collision disagreement, or any dispute over `N/A` applicability requires adjudication and a recorded
	rationale before D0 proceeds.
- Freeze stable IDs for the primary evaluator and independent adjudicator plus the scoring-guide
	revision in the run manifest. Use the same two role IDs and guide at comparison. If either person,
	role assignment, or guide changes, the comparison is observational and cannot support uplift.
	Independently double-score the frozen bridge set to document continuity and establish a candidate new
	baseline; agreement cannot retroactively restore attribution across the changed evaluation system.

## 6. Search Console Checkpoints

### D+14: crawl/index health

- Were four pages recrawled after D0?
- Indexed status and Google-selected canonical.
- Sitemap/robots/resource errors.
- Structured-data errors.
- Mobile/CWV exceptions.

Allowed actions: fix confirmed technical defects. Do not rewrite content from short-term ranking noise.

### D+28: first optimization decision

Analyze page/query impressions, clicks, CTR, average position, country/device and search appearance.

Minimum evidence rules:

- fewer than 100 impressions: insufficient for CTR optimization;
- fewer than 10 clicks: do not treat CTR change as actionable unless snippet is clearly wrong;
- position is directional, not deterministic;
- annotate deploy dates and isolate one material page change where possible.
- extraction timezone is `Asia/Hong_Kong`;
- windows use inclusive start and exclusive end (`[start, end)`) in that timezone;
- extract at 09:00 Asia/Hong_Kong after a 3-day Search Console reporting delay and record requested
	window plus extraction timestamp;
- if a page receives a material canonical/indexing/rendering repair after SEO D0, reset that page's
	comparison origin or classify the change as technical recovery rather than content uplift.

### Earliest D+59: effectiveness review

- D+59 is the earliest full review only for a hypothesis deployed exactly at D+28: compare the complete
	windows `[D0, D+28)` and `[D+28, D+56)` after the three-day reporting delay. A page repaired during
	the D+14 checkpoint is not eligible for this headline window and needs two later clean windows;
- for a hypothesis deployed at timestamp `P`, compare `[P-28d, P)` with `[P, P+28d)` and extract no
	earlier than `P+31d` at 09:00; resolve one eligible publishing entry and derive `P`,
	`sourceMainSha`, `testWorkflowSha`, CloudBase upload/route evidence, deployed artifact digest, and
	`publicOutputManifestSha256` from its trusted-imported workflow attestation;
- `P` exists only when a pre-upload public manifest differs from the target and the target first matches
	after upload. Target bytes already public close the attempt as `preexisting-public-output`, with no
	new intervention or uplift eligibility;
- a `closed` entry produced by failed smoke/rollback has no `P` and cannot support SEO or AI uplift;
- do not publish a second material hypothesis on the same page during an eligible post-publish window;
	if changes overlap, report the result as observational and do not claim per-change uplift;
- treat a shared-layout/template change affecting the four-page cohort as a site-level hypothesis. It
	must ship without any active page-level hypothesis, has no unaffected holdout, and cannot support a
	per-page uplift claim;
- pages reset by material repairs use two later eligible windows or remain classified as technical recovery;
- separate branded/non-branded queries;
- attribute outcomes to named changes and dates;
- publish, revise, or retire content/Schema work based on evidence.

## 7. Reporting Format

Every effectiveness report contains:

1. observed dates plus publishing hypothesis ID, `sourceMainSha`, `testWorkflowSha`, workflow run
	identity, CloudBase EnvId/upload/route evidence, deployed artifact digest,
	`publicOutputManifestSha256`, and first matching public observation `P`;
2. page/query metrics;
3. crawl/index exceptions;
4. field vs lab performance evidence;
5. AI requested model, returned revision, fact snapshot ID/hash, evaluator-guide revision, sample count,
	dispersion, and valid/error request counts;
6. raw citation links and identity collisions;
7. changes since prior checkpoint;
8. decisions, owner, due date, and minimum evidence threshold;
9. explicit non-guarantee for ranking, rich results, Knowledge Panel, and AI citations.

### Evidence handling

- Git stores only redacted manifests, aggregate metrics safe for the repository, evidence hashes, and
	approved public citations.
- Search Console screenshots/exports, raw AI prompts/responses, provider request IDs, billing/usage
	metadata, account identity, and restricted cited material stay outside Git in an owner-approved,
	access-controlled location. Tracked manifests store a stable evidence ID, SHA-256, classification,
	retention date, owner, and external location label without credentials or local absolute paths.
- Before any file is committed, validation rejects secrets, cookies, tokens, email/account identifiers,
	provider request IDs, and rows classified `internal` or `restricted`.
- Public/redacted artifacts have a named reviewer. Expired or withdrawn evidence is removed from active
	consumers and retained or deleted according to the evidence owner's policy.

## 8. Executable Data Validation

Planned validator:

- implementation: `scripts/validate-geo-evidence.mjs`;
- interface: `node scripts/validate-geo-evidence.mjs [--schema <path> --data <path>] [--facts <path>]
	[--facts-snapshot <path>] [--ai-run <path>] [--checkpoint <path>] [--content-brief <path>]
	[--page-contract <path>]
	[--publishing-registry <path> --ai-checkpoint <path> --contracts-root <path>]`;
- fact fixtures: `docs/seo/phase-3-geo/fixtures/facts.valid.json` and
	`docs/seo/phase-3-geo/fixtures/facts.invalid.json`;
- AI fixtures: `docs/seo/phase-3-geo/fixtures/ai-run.valid.json` and
	`docs/seo/phase-3-geo/fixtures/ai-run.invalid.json`;
- each valid fixture command exits `0`; each invalid fixture command exits nonzero and names the failed
	invariant;
- exact fact commands append `--facts <fixture-path>` to the interface; exact AI commands append
	`--ai-run <fixture-path>`;
- validates `data/facts.json` against `data/fact-register.schema.json`;
- validates every AI run manifest against `data/ai-run.schema.json`;
- verifies unique IDs, evidence hashes/references, claim-to-page/Schema/`llms.txt` consumers, required
	withdrawal reason, canonical fact-snapshot hashes, prompt hashes, required cells/sample counts,
	attempt records, returned revisions, evaluator revision, and error-vs-score invariants;
- when completing AI D0, verifies the selected snapshot's recorded source revision and
	`sourceFactsSha256` against the current approved-facts projection, while archived completed runs remain
	pinned only to their immutable snapshot;
- exits nonzero on any schema or reference failure;
- GEO-02 is not complete until a passing fixture and a failing fixture prove the validator gate.
