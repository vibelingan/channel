# GEOreport-0813 Audit Matrix

Source: `GEOreport-0813.pdf`, 76 pages, generated 2026-08-13

Portable identity:

- SHA-256: `17ebfe0e4844c5f719e4e5593804b0e3f597c04673b586daafcf2723a8377a87`;
- byte size: `1,703,061`;
- observed page count: `76`;
- observed literal `402` occurrences in extracted text: `550`;
- candidate failed requests: `275`, inferred from `550 / 2`; this becomes a portable conclusion only
   after the reproduction rule below confirms five failed panels on every page 21–75.

The local path below records where the supplied source was observed; it is not a portable dependency.
Any reviewer with a supplied copy can verify the hash, page count, and page-level 402 layout independently.

Source path:
`/Users/SeanCai/Library/Containers/com.tencent.WeWorkMac/Data/Documents/Profiles/38D9383FD7F57260DEE8BF92A15DF65D/Caches/Files/2026-08/67453511c96dc677e11cc4353f56714f/GEOreport-0813.pdf`

## Evidence Quality Verdict

The report contains four different evidence classes:

1. **Pages 3–4: aggregate summaries.** Invalid as baselines because they incorporate the failed model
   tests from pages 21–75.
2. **Pages 6–11: heuristic/external-entity lookups.** Useful only as identity-collision and channel
   discovery clues; many results refer to unrelated “Diversity Technology” entities.
3. **Pages 12–20: deterministic technical/page inspection.** Useful as an August 13 snapshot, but
   several findings are superseded by Phase 2 evidence or use the wrong URL (`http://www...`,
   `/sitemap.xml`).
4. **Pages 21–75: model-dependent tests.** Every page contains five OpenRouter HTTP 402 errors. All
   Claude/Gemini/ChatGPT/Grok/Perplexity-style 0/5 scores from these pages are invalid/null.

The report’s aggregate values such as 11%, Authority 0%, Content 0%, Perception 0%, mention count,
accuracy, and recommendation rate must not be used as a KPI or baseline until a successful rerun.

Reproduction rule: first verify the PDF SHA-256 and 76-page count. Then extract pages 21–75 and assert
five failed request panels per page plus 550 total literal `402` occurrences. The total alone does not
prove uniform per-page failure. A page-level or total mismatch blocks use of the 275-request conclusion
against that copy; do not silently transfer it to a different file.

## Superseded Technical Findings

| Report recommendation | Report pages | Decision | Reason |
|---|---:|---|---|
| Repair canonical URLs | 17 | Reject as new work | Phase 2 verifies canonical on four public pages, including Headphones slash |
| Add sitemap | 18 | Reject as new work | Live site uses `sitemap-index.xml`; report checked `/sitemap.xml` |
| Add title/description and one H1 | 16–17 | Reject as new work | Four public pages verified unique and complete |
| Add OG metadata | 16 | Reject as new work | Deployed and live from `test@905a18f`; Twitter Card validation is an independent Phase 2 control, not a GeoLoop criterion |
| Add base Organization/WebSite/WebPage | 12–18 | Reject as new work | Existing global JSON-LD contract is deployed |
| Resolve entity name/legalName | 12–18 | Reject as blocker | Current code contract is confirmed and deployed |

Independent completed controls not measured by the report: Twitter Cards, image alt, image intrinsic
dimensions, and private-page social-tag exclusion. These remain Phase 2 regression contracts, not
GeoLoop-derived recommendations.

Unverified technical item retained for Phase 3 measurement: complete H2–H3 logical hierarchy/no skipped
levels. Phase 2 proves one visible H1 per public page, not every subheading transition.

## Adopt

| Recommendation | Report pages | Phase 3 treatment |
|---|---:|---|
| Search Console baseline and URL Inspection | Independent existing Phase 3 plan | Adopt; no Bing; inspect four primary pages and sitemap state |
| Core Web Vitals and mobile measurement | Independent existing Phase 3 plan | Adopt; separate PageSpeed lab from CrUX field data |
| Evidence-backed company facts | 21–41 | Adopt conceptually; build a fact register before publication |
| Procurement FAQs and customer journey | 54–56 | Adopt only as visible, approved content; no FAQ Schema by default |
| Case studies and client outcomes | 31–35, 42–60 | Adopt with permission, date, reviewer, image, and measurable result |
| Differentiators and expertise | 37–41, 67–75 | Adopt with process evidence; avoid “leader/best” claims without sources |
| Relevant editorial/partner citations | 9–11 | Adopt as business authority work; quality over raw count |
| Review/citation monitoring | 42–75 | Adopt after valid AI D0; retain raw responses and cited URLs |

## Adapt

| Recommendation | Report pages | Adaptation |
|---|---:|---|
| Organization logo | 12 | Add only approved public bitmap/logo asset with a stable URL |
| `sameAs` | 12 | Add only manually verified official profiles; no guessed handles |
| Breadcrumb Schema | 13 | Only where visible breadcrumb/hierarchy exists |
| Product Schema | 13–16 | Defer outside the current Phase 3 DAG. A separately approved server-visible product-data DAG may later map existing visible fields; no product features are authorized here. |
| Article Schema | 13–16 | Only dated/authored/reviewed visible case/editorial pages |
| FAQ content | 15, 55 | Publish useful visible answers; FAQPage Schema only if policy/current page warrants it |
| `llms.txt` and `llms-full.txt` | 19–20 | Start with concise `llms.txt` after pages/facts stabilize; no ranking claim |
| Google Business Profile/NAP | 7, 10 | First confirm eligibility, public office policy, canonical address/phone, owner |
| Reviews, directories, social/video | 7–11 | Treat as optional marketing channels; manually verify entity identity |
| Wikidata/Wikipedia | 6 | Conditional on independent notability and reliable sources |

## Reject or Defer

| Recommendation | Report pages | Reason |
|---|---:|---|
| WebSite `SearchAction` | 12 | No stable public site-search URL/action contract |
| NLWeb `/ask`, `/mcp`, MCP discovery | 19–20 | No demonstrated need; adds public service and operations/security burden |
| ReturnPolicy / AggregateRating / Review | 14–16 | No current visible policy or verified review dataset |
| LocalBusiness / Service / Offer expansion | 14–16 | Current entity/page facts do not support broad rollout |
| Hreflang | 17 | No approved translated pages |
| Prices, warranties, delivery, payment, loyalty | 45, 56–59 | Commercial policy absent or unstable; do not invent for GEO |
| Rankings, ratings, review summaries | 38, 50–53 | Requires independent sources and valid model runs |
| Bing setup | Independent prior plan, not GeoLoop | Explicitly removed from current scope |

## Entity Collision Risk

Pages 6–11 surface unrelated entities for “Diversity Technology,” including a genetics/Wikipedia topic,
other companies, music/video results, and low-quality directories. This is useful qualitatively: prompts
and monitoring must disambiguate with legal name, domain, OEM/ODM manufacturing, Hong Kong/Dongguan,
and product categories. It is not evidence that the current entity contract is wrong.

## AI Rerun Validity Contract

A future rerun is valid only if:

- the frozen Q1–Q9 required set crosses every selected model with three successful samples per cell;
- failed/timeout/blocked calls are excluded, not scored zero;
- model/version, returned revision, fact snapshot ID/hash, evaluator revision, date, region/language,
   prompt, raw response, and citations are stored;
- prompts test both exact brand/legal entity and unbranded category discovery;
- unrelated entity matches are separately scored as identity errors;
- factual accuracy, citation quality, and recommendation relevance are separate dimensions;
- the question set, fact snapshot, sample count, evaluator guide, and returned model revision remain
   stable across an uplift comparison; any evaluator/adjudicator identity or role, guide, snapshot, or
   model-revision drift is reported as observational. Bridge calibration may establish a new baseline
   but cannot restore attribution to the old one.
