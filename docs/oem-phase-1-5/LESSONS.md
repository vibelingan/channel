# OEM Phase 1.5 — Commit and Conversation Retrospective

Status: evidence-backed retrospective before Phase 8
Branch range: `3d57384..d072c43`
Commit coverage: 35/35 commits
Conversation audit snapshot: 2026-07-10T04:18:53Z through 2026-07-22T16:33:39Z
Snapshot size: 26,629 JSONL events, including 175 user messages and 7,073 tool calls

## How this audit was derived

Two independent evidence routes were used:

1. Git history and focused diffs establish what was committed and which guards shipped.
2. The full Copilot JSONL transcript establishes user corrections, failed attempts, false assumptions, debugging pivots, and runtime verification.

The first delegated audit identified only 23 of 35 commits and another transcript audit stopped in the early review phase. Those reports were rejected as complete evidence. Coverage was re-derived mechanically from `git log`, `git diff-tree`, all user messages, all tool starts/completions, and focused high-risk diffs. A report must not claim complete coverage when it has named gaps.

## Complete commit walk-through

| # | Commit | Phase / change | Guard or lasting lesson |
|---:|---|---|---|
| 1 | `287a0e3` | CHANNEL header, navigation priority, fullscreen hero | Test the exact downstream URL shape, including fragments. Browser measurements complement source contracts. |
| 2 | `c1fdc1c` | Shared Traditional-vs-AI workflow | One typed producer for multiple pages prevents copy drift. Document dormant legacy producers instead of silently assuming they are gone. |
| 3 | `fabdf47` | Factory and Our People copy | Pin exact content, media count, and removed placeholders in one source contract. |
| 4 | `c18075e` | Quality copy and homepage reduction | Remove a consumer before deleting shared code; prove independent routes/data remain. |
| 5 | `83d03a0` | Product Capability retirement and Factory gallery | Trace history and every consumer before dead-code deletion; test what remains as well as what leaves. |
| 6 | `ea1cb70` | Teardown/Blue Ocean teaser retirement | Homepage component ownership does not imply route/data ownership. |
| 7 | `1a8c5ad` | Phase 2–3 execution record | Documentation-only checkpoint; no distinct code lesson. |
| 8 | `49a6b5c` | Five AI advantage stories | Static browser review caught a desktop order conflict that source tests could not see. Illustrative marketing UI needs an explicit non-live disclaimer. |
| 9 | `5103f3f` | Phase 4 execution record | Documentation-only checkpoint. |
| 10 | `cf13702` | Homepage ProjectForm reuse | Reuse the production form so validation, upload, endpoint, and result behavior have one implementation. |
| 11 | `eee2c46` | Canonical primary inquiry route | A shared route constant prevents CTA drift while preserving distinct navigation links. |
| 12 | `d812149` | Product CTA routing | Enumerate every listing/detail CTA and verify real clicks, not only string replacement. |
| 13 | `07b1fba` | Final CTA routing and retired-field removal | Delete alternate schema fields after migration so stale targets cannot be reintroduced. |
| 14 | `b77a1a8` | Phase 5 execution record | Documentation-only checkpoint. |
| 15 | `6de3f38` | Real portfolio cases and intrinsic media dimensions | Content, media path, alt text, and dimensions belong to one typed contract. |
| 16 | `f4b82da` | 50+/30+/100+ cumulative stats | Keep numeric claims content-owned and clarify that visible cards are selected highlights. |
| 17 | `f8b24de` | Retire duplicate Success Stories page | Adapterless Astro static redirects emit HTTP 200 meta-refresh artifacts, not origin 301s; test generated/runtime semantics. |
| 18 | `daec7ce` | Opt-in portfolio canonical | Introduce cross-cutting metadata as an opt-in contract rather than an unreviewed site-wide rollout. |
| 19 | `2c3ccdd` | Delete duplicate code/data/TWS asset and add prune target | Local source deletion is not remote retirement on additive hosting; the first prune entry still needed fail-closed/runtime proof. |
| 20 | `4f48db3` | Canonical Success Stories E2E | One focused journey can cover redirect, metadata, content, media, removal, and conversion seams. |
| 21 | `fc98d38` | Build-time `SITE_URL` origin | Canonicals and sitemaps need the real deployment origin at build time; placeholders are externally visible defects. |
| 22 | `0b49311` | Phase 6 execution record | Documentation-only checkpoint. |
| 23 | `353cb89` | Fail-closed hosting deploy and media smoke | Assert tool success, active replacements (200 + image MIME), and retired objects (404) with cache-busting. |
| 24 | `e1425ac` | Manual `SITE_URL` parity | CI configuration and operator runbooks are equal consumers of a build-time contract. |
| 25 | `e55b4a1` | Drain deployment-smoke response bodies | Status-only HTTP checks can retain sockets. Drain/cancel bodies, bound header/body/control-plane time, cap bytes, and test lifecycle exits. |
| 26 | `4d962ba` | Test-delivery evidence record | Documentation claims require exact run IDs, durations, pass/skip counts, and scoped historical observations. |
| 27 | `5d7bed4` | ICP filing footer | Exact legal text/URL belong in typed content; render once through the shared footer and verify all intended pages. |
| 28 | `3951362` | Certificate classification | Classify from document evidence: compliance/test report, design patent, and patent record are not interchangeable labels. |
| 29 | `c2944a9` | Patent derivative redaction | Privacy-approved binary derivatives need pinned SHA-256 hashes so later replacement cannot silently restore personal data. |
| 30 | `8ee8e2a` | Customer logo normalization batch 1 | Binary-only batch kept review scope bounded; alpha presence alone was later shown insufficient for visual acceptance. |
| 31 | `b6ae36a` | Education-logo anonymization | Privacy includes visible pixels, alt text, public filename, and URL, not only hiding a name in UI. |
| 32 | `bf104cf` | Customer logo batch 2 | Small binary batches keep review and rollback tractable. |
| 33 | `347c26d` | Publish all 13 customer logos | Contract exact count, unique URLs, required dimensions, anonymous rows, and forbidden identity terms. |
| 34 | `56893ed` | Responsive portfolio carousels | Test mobile/tablet controls, real autoplay then interaction pause, reduced motion, desktop grid rows, and dialog lightbox together. |
| 35 | `d072c43` | Phase 7 execution record | Documentation-only checkpoint; final review/delivery must bless the documentation commit’s new HEAD as well. |

## Incident ledger

### 1. Concurrent sessions could corrupt one checkout

- Symptom: the user warned that another agent was actively changing the shared checkout.
- Wrong path: switching branches in place would replace files under the other session.
- Resolution: create and use an isolated worktree; verify worktree and branch before every delivery action.
- Verification: all OEM work stayed in sibling worktrees; the primary checkout remained untouched.
- Classification: **BEST PRACTICE**, `git-worktree-concurrency`, high.
- Existing durable home: `docs/ENGINEERING_CRAFT.md` and `/memories/repo/concurrent-session-review.md`.

### 2. A broad ignore rule produced runtime-missing data

- Symptom: new Astro routes imported data modules that were absent and returned 500/build failures.
- Root cause: a bare `data/` ignore rule matched nested application source, so required files were never committed.
- Resolution: narrow the ignore path to local-server data and verify both repository tree and runtime import behavior.
- Verification: build and routes recovered after the data files entered source control.
- Classification: **WARNING**, `broad-ignore-hides-source`, high.

### 3. Visual polish masked broken routes and wrong product direction

- Symptom: a polished AI homepage made the branch appear ready while content routes were broken and the client deck required a traditional OEM-first revision.
- Root cause: visual recognition was treated as functional/spec validation.
- Resolution: compare implementation against client PPTX/PDF/DOCX, run every route, and separate current-round scope from future AI/3D roadmap work.
- Classification: **WARNING**, `visual-polish-not-readiness`, high.

### 4. Browser tooling captured the wrong or blank state

- Symptoms: parallel screenshots captured the active tab rather than the intended page; full-page reveal sections appeared blank; viewport tooling remapped requested widths; cached contact sheets showed stale pixels.
- Root causes: shared browser focus, reveal animations that had not entered the viewport, integration-browser viewport remapping, and stale image previews.
- Resolutions: run browser state sequentially, bring the intended page forward, scroll target sections into view, wait for settled state, and use isolated Playwright contexts with exact viewport sizes. Regenerate timestamped contact sheets and inspect the individual asset when cache is suspected.
- Classification: **WARNING**, `browser-capture-state-not-proof`, high.

### 5. Root package scripts invoked a different pnpm

- Symptom: `npx pnpm` attempted a major-version install/reinstall and could block on an interactive prompt.
- Root cause: root scripts wrapped pnpm through `npx` while another pnpm version was already on `PATH`.
- Resolution: use direct `pnpm --filter ...`, `pnpm -r ...`, and `pnpm exec ...` commands.
- Classification: **ERROR**, `npx-pnpm-version-switch`, high.
- Existing durable home: `/memories/repo/build-and-commands.md`.

### 6. zsh syntax and variable semantics broke otherwise valid commands

- Symptoms: assigning loop variable `path` overwrote command lookup; unbraced `commit:path` and `$color:similarity` were interpreted as zsh modifiers; mixed quoting entered `dquote>` continuation.
- Resolution: avoid reserved/special variable names, brace interpolations before colons, and move complex structured logic into a real script/structured tool call instead of dense shell quoting.
- Classification: **ERROR**, `zsh-special-name-colon-modifier`, medium.

### 7. Static redirect behavior differed from the desired HTTP status

- Symptom: the legacy route redirected visually, but the built artifact returned HTTP 200 with meta refresh rather than 301.
- Root cause: adapterless static Astro cannot emit an origin HTTP redirect.
- Resolution: document and E2E-test the actual compatibility behavior; do not claim 301 without hosting-level redirect support.
- Classification: **EXPERIENCE**, `static-redirect-status-semantics`, medium.

### 8. Local deletion did not retire the public object

- Symptom: retired TWS media still returned HTTP 200 after its source file was deleted.
- Root cause: CloudBase static hosting upload is additive.
- Insufficient first fix: an exact prune path existed, but hosting tool failures were tolerated and smoke did not verify the public result.
- Final fix: targeted prune, fail-closed upload/config results, cache-busted active-image 200/MIME checks, and exact retired-object 404 smoke (`2c3ccdd`, `353cb89`).
- Classification: **WARNING**, `source-delete-not-public-retirement`, critical.
- Existing durable home: Deploy & CI/CD rules and `/memories/repo/cloudbase-deploy.md`.

### 9. Canonical origin was correct in one producer but not all

- Symptom: a placeholder origin was rejected, then the automated workflow was correct while the manual runbook could still build localhost canonicals.
- Root cause: build-time URL configuration had multiple producers/consumers.
- Final fix: `SITE_URL` in `.env.example`, Astro config, workflow/environment, E2E expectation, and manual runbook (`fc98d38`, `e1425ac`).
- Classification: **BEST PRACTICE**, `build-origin-four-consumer-parity`, high.

### 10. All smoke assertions passed, but the process did not exit

- Symptom: Deploy Test logged every assertion as passed and then remained alive until cancellation at 27m50s.
- Root cause: successful image response bodies were not fully consumed.
- Resolution: `fetchFully()` drains/cancels streams, enforces a 15-second request timeout and 5 MiB cap; control-plane and workflow timeouts remain bounded. Tests cover full drain, stalled headers/body, oversized cancellation, and BOM decoding (`e55b4a1`).
- Verification: the next deployed smoke exited naturally in 23 seconds.
- Classification: **ERROR**, `http-smoke-body-lifecycle`, critical.

### 11. Legal/privacy documents required content-level classification

- Symptoms: product reports, design patents, and a patent record had been grouped too generically; patent sources exposed names, phone/ID/address fields, and QR codes.
- Resolution: classify from document evidence, publish redacted derivatives at stable URLs, and pin reviewed hashes (`3951362`, `c2944a9`).
- Classification: **BEST PRACTICE**, `public-legal-derivative-contract`, critical.

### 12. “Has alpha” did not mean the logo was visually transparent

- Symptoms: machine checks reported alpha, but gray/black composites still revealed white rectangles or color contamination.
- Failed tooling: the installed ffmpeg lacked suitable WebP/drawtext support; attempted `lutrgb` expressions failed; Sharp was absent and `sharp-cli` syntax differed from expectation.
- Resolution: use Pillow pixel-distance alpha, inspect alpha bounds, composite every asset over at least two contrasting backgrounds, and review contact sheets plus individual assets.
- Follow-up defect: Pillow `thumbnail()` only shrinks, so Rockland remained `118×24`; explicit proportional upscaling fixed optical weight.
- Classification: **BEST PRACTICE**, `alpha-plus-composite-visual-proof`, high.

### 13. Anonymization had multiple leak channels

- Symptoms: school names remained readable in pixels and one public filename exposed an institution even when the UI branch hid the image.
- Resolution: identity-free derivative pixels, generic alt/name text, safe filenames, forbidden-term source tests, metadata inspection, and live HTML/asset checks (`b6ae36a`, `347c26d`).
- Classification: **WARNING**, `privacy-pixels-filename-metadata`, critical.

### 14. Carousel interactions contained timing and event-order traps

- Symptoms: the pause button’s `focusin` handler stopped rotation and its click handler immediately resumed it; dialog keyboard events could drive the underlying carousel; smooth scrolling made an early position sample look like autoplay continued.
- Resolution: let the toggle own its state transition, ignore dialog-originated navigation, wait for scrolling to settle before taking the pause baseline, and verify a full autoplay interval after user input.
- Classification: **EXPERIENCE**, `carousel-event-order-and-settle`, high.

### 15. CDN retries covered headers but not the full body

- Symptom: `fetch()` succeeded, then `arrayBuffer()` timed out outside the retry envelope.
- Resolution: retry the entire operation—headers, status validation, and body drain—as one unit. With that change, all 21 live assets matched local SHA-256.
- Classification: **ERROR**, `retry-whole-response-lifecycle`, high.

### 16. Review tooling itself produced a false-complete report

- Symptom: a delegated audit documented only 23/35 commits yet labeled the report complete; transcript agents read only an early slice or truncated JSONL fields.
- Root cause: self-reported coverage was trusted without a mechanical denominator.
- Resolution: enumerate expected SHAs first, compare read set to expected set, parse JSONL structurally, report exact time/event boundary, and explicitly reject partial reports.
- Classification: **WARNING**, `audit-coverage-denominator`, high.

## User corrections that must persist

| Correction | Future behavior |
|---|---|
| Another agent is using the shared checkout | Use an isolated worktree; never switch the shared tree. |
| AI and 3D were excluded from the current page batch | Keep roadmap scope separate from approved implementation scope. Slide 1 AI customer service is deferred, not canceled. |
| Review the OEM Phase 1.5 branch | Resolve branch/worktree/remote tip before analysis; do not audit a similarly named stale branch. |
| Push the OEM branch before updating `test` | Feature/OEM first, verify exact remote SHA, then guarded fast-forward `test`; never shortcut topology. |
| A simple task took too long | Scale repeated validation to risk: focused test after each edit, full suite/review at milestone and pre-push. Never skip hard gates. |
| Validate on `supplychainsai.com` | Use the canonical public domain for final live acceptance, not only the provider test hostname. |
| “All slides complete?” | Completing Phase 8 finishes Slides 2–16; Slide 1 remains a separate deferred feature. |

## Reusable best practices

1. **Contract source → types → consumers → browser → deployed edge.** Validate each boundary independently.
2. **Red first, then smallest production edit, then focused validation.** Full validation belongs at phase boundaries.
3. **Removal tests assert both absence and retained siblings.** Deletion-only assertions miss collateral damage.
4. **Externally visible state is proven externally.** Tool success does not prove CDN/object/route state.
5. **Binary assets need semantic acceptance.** Dimensions, alpha, hashes, metadata, pixels, optical bounds, and contrasting composites answer different questions.
6. **Privacy is a whole-artifact property.** Text, alt, URL, filename, metadata, pixels, and old CDN objects all matter.
7. **Browser checks must control state.** Exact viewport, focus, scroll position, animation/reveal completion, and cache freshness are test inputs.
8. **Docs claims are reviewed like code.** Pin exact SHA, run IDs, pass/skip counts, duration labels, and deployment scope.
9. **Every retry wraps the full resource lifecycle.** Retrying only connection setup does not cover stalled bodies or cleanup.
10. **Every audit begins with a denominator.** Expected commits/files/events first; report gaps instead of rounding partial work up to complete.

## Warnings for Phase 8 and delivery

- Use direct pnpm commands; do not invoke root aliases that call `npx pnpm`.
- Keep source, rendered copy, email text/HTML, and packaged admin artifact in one SLA parity check.
- Remove only listing stats; assert cards, details, BOM/margin/MOQ, routes, and nav remain.
- Build with the intended `SITE_URL`; local canonical assertions must use the same origin as Playwright.
- Run focused tests after each MIU, then full typecheck/lint/tests/build/package smoke at G5.
- Final delivery order remains OEM branch → exact-SHA check → guarded `test` fast-forward → CI/Deploy Test → `supplychainsai.com` smoke.
- Refresh the exact-SHA review blessing after every commit, including documentation-only commits.

## Deliberately not promoted

- One-off source filenames, exact client product prices, and individual image coordinates remain project evidence, not general rules.
- Expected TDD red runs and searches returning no match are not logged as engineering errors.
- Tool failures caused only by nonexistent exploratory paths are noise unless they reveal a repeatable routing mistake.