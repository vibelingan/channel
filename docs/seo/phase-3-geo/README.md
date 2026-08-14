# SEO Phase 3 — GEO Consolidated Plan

Status: proposal for review; no page/content/infrastructure implementation yet

Date: 2026-08-14

Branch: `docs/seo-phase-3-geo-plan`

Planning base: `feat/seo-phase-2-main-delivery@1099462`

Implementation gate: rebase onto latest `origin/main` after PR #17 is reviewed and merged. `main` remains
source of truth; `test` remains the sole current deploy environment but is not the planning base.

## Authority

This directory is the source of truth for SEO Phase 3 GEO scope, sequencing, measurement, and technical
MIUs after approval. `docs/seo/README.md`, `docs/seo/CURRENT_EXECUTION.md`, and
`docs/seo/SEO_GEO_AUDIT_AND_PLAN.md` remain historical evidence for completed or previously proposed
work, but every Bing setup, submission, backlog, and execution instruction in those files is superseded
by this plan. Bing is not part of the current backlog.

## Decision

Phase 3 should be a measurement-first GEO program, not an attempt to raise the GeoLoop 11% score.
The supplied 76-page report is useful as a recommendation inventory, but its model-dependent score is
not a valid baseline: every tested model response on report pages 21–75 failed with OpenRouter HTTP 402
(insufficient credits). Those 0/5 values mean **no valid observation**, not zero brand visibility.

Use two independent baselines:

1. **SEO D0:** Search Console access is available and the production four-page snapshot is stored.
2. **AI D0:** a funded model run satisfies the complete required-cell and sampling predicate defined
  once in `MEASUREMENT-AND-EVIDENCE.md` §5.

Do not compare SEO metrics and AI visibility against one shared score or date.

## What We Should Do

### A. Immediate planning and measurement foundation

- Verify the existing Google Search Console property before creating or submitting anything.
- Capture URL Inspection evidence for `/`, `/oem/`, `/portfolio/`, `/headphones/`.
- Create a fact/evidence register with owner, source, approval date, review date, and expiry rule.
- Define a fixed AI question set covering entity identity, OEM capability, headphones, process, cases,
  certifications, MOQ/lead-time conditions, and differentiators.
- Define AI scoring for identity accuracy, factual accuracy, citation quality, and recommendation
  relevance. Failed requests are excluded, never scored zero.
- Record deploy SHA and every material content/Schema change date.

### B. Technical GEO work after evidence exists

- Add `BreadcrumbList` only where a visible hierarchy exists.
- Add `Article` only where visible headline, author/reviewer, date, and image exist.
- Keep Product Schema outside the current Phase 3 DAG. A later separate product-data MIU may add SEO
  markup only after server-rendered production HTML exposes the approved real fields; Phase 3 does not
  build products, pricing, inventory, or Marketplace functionality.
- Add trustworthy sitemap `lastmod` only from reviewed content timestamps, never build time.
- Add official profile `sameAs` only from manually verified account URLs.
- Add an approved representative logo only after the public logo asset and entity usage are confirmed.
- Add `llms.txt` only after fact-rich pages and their URLs stabilize; it is a discovery aid, not a
  ranking guarantee.
- Treat `sameAs`, Organization logo, or any other shared-layout change as one site-level hypothesis.
  Ship it without a concurrent per-page hypothesis; report site-level observation only, never per-page
  uplift, because the four-page cohort has no unaffected holdout.

### C. Content and authority work after client approval

- Publish evidence-backed procurement FAQs in visible page content, not Schema-only text.
- Build 3–5 case studies with approved problem, process, result, date, reviewer, images, and permission.
- Publish certification scope carefully: document/model applicability, issuer evidence, and review date.
- Explain differentiators using specific process evidence rather than unsupported “industry leader” copy.
- Pursue relevant partner/editorial citations and verified official profiles; do not optimize for raw
  backlink or directory counts.

## What We Should Not Do

- Do not use GeoLoop 11%, Content 0%, Perception 0%, or any page-21–75 0/5 value as a baseline.
- Do not rerun AI tests until model calls are funded and error states are excluded from scoring.
- Do not add `WebSite.SearchAction`; the site has no stable public site-search URL contract.
- Do not add ReturnPolicy, AggregateRating, Review, LocalBusiness, Service, Offer, FAQPage, or other
  Schema without matching visible, current, owner-approved facts.
- Do not create Wikipedia/Wikidata entries solely to obtain GEO points.
- Do not implement NLWeb `/ask`, `/mcp`, MCP discovery endpoints, or crawler declarations without a
  demonstrated customer/crawler need and an operations owner.
- Do not publish prices, warranties, delivery promises, payment methods, rankings, ratings, partner names,
  or logistics claims merely because the report asks whether AI knows them.
- Do not start multilingual/hreflang work before approved translated pages exist.
- Do not include Bing in the current Phase 3 scope.

## Current Confirmed Entity Contract

This is not blocked on customer clarification:

- Schema `Organization.name`: `Diversity Technology`
- Schema `Organization.legalName`: `Diversity Technology Limited`
- Visible page brand/legal copy: `Diversity Technology Limited`

Introduced in commit `3382dfb` and present in the Phase 2 promotion tree. A future change to
`SupplyChainsAI` would be a separate approved brand/legal migration, not a Phase 3 prerequisite.

## Work Packages

| Work package | When | Outcome |
|---|---|---|
| GEO-01 Report validity and scope lock | Planning day 1 | Invalid scores quarantined; Phase 2 work not reopened |
| GEO-02 Measurement contracts | Planning days 1–2 | Fact schema, AI scoring, prompt and storage contracts frozen |
| GEO-03 Search Console / SEO D0 | Access-dependent | Four-page crawl/index/canonical baseline |
| GEO-05 Fact register bootstrap | Planning days 2–5 | Existing public claims inventoried with owners/review dates |
| GEO-04 AI D0 | After GEO-05; funding/provider-dependent | Valid pre-intervention AI baseline required before publication |
| GEO-06 SEO D+14 health review | SEO D+14 | Crawl/index defects fixed; affected page windows reset |
| GEO-07 Content evidence package | SEO D+14–D+28 | Approved FAQ/case/certification/differentiator briefs |
| GEO-08 Page and Schema design | SEO D+14–D+28 | Visible fields, URL, ownership and omission contracts |
| GEO-09 Controlled publishing MIUs | After GEO-03, GEO-04, GEO-06, GEO-07, and GEO-08 complete | One baseline-eligible, deploy-attested hypothesis per publish MIU |
| GEO-10 Effectiveness reviews | Publish P+31d; D+59 only for an unrepaired D+28 publish | Publish-relative 28-day windows compared after reporting delay |

Details: [ROADMAP.md](ROADMAP.md), [MIU_BREAKDOWN.md](MIU_BREAKDOWN.md),
[REPORT-AUDIT.md](REPORT-AUDIT.md), and [MEASUREMENT-AND-EVIDENCE.md](MEASUREMENT-AND-EVIDENCE.md).

## Decisions Needed Before Implementation

1. Confirm PR #17 review/merge timing so implementation can rebase onto latest `main`.
2. Name the Search Console owner/full-access user.
3. Choose the AI baseline route: funded GeoLoop rerun or a smaller controlled model set. If funding is
  deferred, Search Console setup, fact approval, and content/Schema design may continue, but GEO-09
  publication remains blocked.
4. Name approvers for company facts, certifications, cases, commercial claims, and official profiles.
5. Assign CloudBase compression/cache and redirect/HSTS to a separate infrastructure workstream if
  desired; they are not GEO MIUs.
6. Decide whether inquiry/conversion attribution is a separate workstream; current website flows do not
   provide a reliable GEO conversion baseline.
7. Name the approved external evidence location, access owner, redaction reviewer, and retention period
  for Search Console exports and raw AI/provider records. This is a hard gate before GEO-03/GEO-04;
  until assigned, both remain blocked and restricted evidence must not enter Git.
8. Name the primary AI evaluator and an independent adjudicator, then approve the scoring guide and
  disagreement rule before AI D0. The same evaluator roles and rubric revision apply at comparison.
9. Name separate publication executor, incident-remediation executor, and lock-resolution approver.
  Remediation execution and lock-resolution approval require separation of duties.
10. Approve rollback-artifact storage/retention, evidence-chain custody, and an owner responsible for
  extending retention while an incident remains unresolved. These are hard gates before public apply.

## Publication Authority

GEO-09 has no AI-only or SEO-baseline bypass. Before a source change is approved, its registry entry
must reference completed SEO D0, completed AI D0, approved briefs/contracts, and the applicable
SEO-D14 page-eligibility record. A site-level hypothesis requires an eligible record for all four cohort
pages. A page that cannot supply an eligible SEO baseline may still be improved through a separately
approved non-measurement workstream, but Phase 3 must not publish it or later claim SEO uplift from it.

After the publishing-gate MIUs are implemented, publication authorization and deployment evidence will
be separate. Registry entries will normally move through
`planned → approved → deployed → active → closed`; a failed public smoke moves directly from
`deployed → closed` with rollback evidence and never starts a measurement window. Only an entry newly
moving to `approved` will authorize its exact source/generated-output diff. After that implementation
enters `main`, the `test` workflow will deploy the exact approved `sourceMainSha`, not arbitrary `test`
branch content. Its attestation will bind the GitHub run, CloudBase EnvId/upload receipt, enabled gateway route from
`supplychainsai.com` to that environment's `STATIC_STORE`, deployed artifact digest, and the first
matching public-output manifest. That first verified public observation is `P`; the plan does not claim
a more precise provider deployment time than the current hosting API exposes.

Planning-time topology evidence observed on 2026-08-16:

- CloudBase EnvId `diversity-123-d9grnqfux221323bb` reported online static hosting;
- gateway query request `2df52edf-53f3-42bc-bfe3-ac44be5d4abb` reported enabled
  `supplychainsai.com` `/` and `/*` routes to `STATIC_STORE/staticstore` in that environment;
- `manageHosting domainStatus` did not report the domain because it is bound through the HTTP gateway,
  not the hosting-domain surface.

This dated observation is not permanent authority. The planned publication workflow will re-query
EnvId, hosting, and gateway state before every upload and fail closed on drift.

MIU 28 will change the sole repository write primitive, `deployWebApp()` in
`scripts/deploy-cloudbase-test.mjs`, to default to no static upload and reject a write before
`manageHosting(upload)` unless it verifies a short-lived,
GitHub-signed authorization for the current workflow run, exact latest-main source SHA, EnvId,
hypothesis, and target manifest. This applies equally to the root `pnpm deploy:cloudbase:test` command;
workflow convention is not the security boundary.
MIU 35 will first persist a non-authorizing `prepared` claim with verified rollback custody, then lock
the EnvId to that claim and issue signed apply authority. MIU 28 will CAS `prepared → upload-started`
immediately before the first static mutation. The claim's unique key covers repository, run ID, nonce,
EnvId, and target digest. Exactly one process may cross this gate; duplicate, unavailable, or ambiguous
results fail closed, and a post-claim state is never deleted or reopened.
