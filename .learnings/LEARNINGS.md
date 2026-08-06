# Learnings

## [LRN-20260806-001] correction
<!-- consolidated: 2026-08-06 verdict=new-pattern target=verification-integrity/run-the-composed-gate-not-your-own -->

**Logged**: 2026-08-06T02:40:00Z
**Priority**: critical
**Status**: new
**Area**: workflow
**Pattern-Key**: hand-rolled-gate-drops-composed-gates

### Summary
Hand-rolling a validation or review step silently drops every gate composed into the official one. This is how an SDK upgrade shipped a total upload outage past four review rounds.

### Details
Phase 7.6 `verify-sdk-surface` is wired into BOTH `/dev-pipeline:validate` (STEP 2.6) and `/dev-pipeline:review`, and auto-triggers when a diff deletes a `*.d.ts` or changes a third-party version. The CloudBase SDK upgrade did BOTH. The gate never ran — not because it was skipped deliberately, but because validation was executed as raw `corepack pnpm typecheck && tsc && test && biome` and review was executed as ad-hoc parallel reviewers. Both substitutions look complete and are strictly weaker: they omit exactly the step whose entire purpose is this failure class. `grep -c verify-sdk-surface .claude/agent-events.jsonl` = 0, while the same file holds four `review.complete` records — the audit trail proves gates "passed" that never executed.

Compounding: `docs/<feature>/SDK-PROBE.md` carries an explicit **Re-Probe Trigger** list naming version changes, and the file was committed inside a docs batch without ever being opened. Its git history shows exactly one commit — it was never re-probed for the upgrade.

The gate's own docstring describes a PRIOR CloudBase SDK incident in this same project. The organisation had already paid for this lesson once and encoded it; the encoding was bypassed by convenience.

### Suggested Action
Invoke the composed pipeline command rather than its constituent commands. Where that is impractical, have each gate append a machine-readable completion record keyed to the exact HEAD SHA, and fail CI when a gate's trigger predicate is true but no record exists for that SHA. Treat "I ran the equivalent commands" as an unproven claim.

### Metadata
- Source: production_incident
- Related Files: scripts/verify-cloudbase-sdk-contract.mjs, docs/home-form-headphones-ui-fix/SDK-PROBE.md, .claude/agent-events.jsonl
- Tags: gates, sdk, process, audit-trail, rule-22

---

## [LRN-20260806-002] correction
<!-- consolidated: 2026-08-06 verdict=new-pattern target=silent-no-op-integrations/forked-sdk-transport -->

**Logged**: 2026-08-06T02:40:00Z
**Priority**: critical
**Status**: resolved
**Area**: third-party-integration
**Pattern-Key**: forked-sdk-transport-protocol-drift

### Summary
When your code sends a request assembled from an SDK-minted credential, you have forked the SDK's internal implementation — and a version bump can change the wire protocol while the method signature and return shape stay identical.

### Details
`@cloudbase/node-sdk` 2.10.0 built a multipart POST with `Signature`/`x-cos-security-token`/`x-cos-meta-fileid` as FORM FIELDS. 3.17.2 asks the control plane to sign for `method: 'put'` and PUTs raw bytes with those same names as HEADERS. `getUploadMetadata`'s signature and return shape did not change. The application mints that credential so the BROWSER can perform the upload — a fork of `uploadFile`'s private behaviour — and kept POSTing. COS rejected every upload with `403 SignatureDoesNotMatch`. Both admin image upload and OEM drawing upload were dead in the deployed environment.

Nothing in the normal toolchain could see it: types unchanged, 420 unit tests green, public read-only browser suite green. The only observer was a deployed upload smoke that was an optional dispatch input defaulting to false, switched off for two consecutive releases.

The contract script made it worse: it asserted the upload verb by grepping the WHOLE storage module for `method: 'post'` and matched the control-plane metadata request, which is legitimately a POST. It reported "multipart POST upload" while the SDK PUT the bytes — converting an unverified assumption into a green check.

The first fix then broke a SECOND time: it migrated the admin client and the probe pinned exactly that file, while the OEM client inlined in `ProjectForm.astro` kept POSTing. A hand-listed consumer set encodes the author's memory, which is the thing under test.

### Suggested Action
Register forked minter/sender pairs and assert verb, credential placement and body encoding against the installed SDK's sender-function BODY (extracted by name, extractor throwing when absent), for the minter and for every client discovered by repo-wide grep with a pinned expected count. Never assert protocol details against whole-module text.

### Metadata
- Source: production_incident
- Related Files: packages/media-storage/src/cloudbase.ts, packages/media-storage/src/index.ts, apps/site/src/islands/admin/api.ts, apps/site/src/components/ProjectForm.astro, scripts/verify-cloudbase-sdk-contract.mjs
- Tags: sdk-upgrade, wire-protocol, cos, upload, false-positive-probe

---

## [LRN-20260806-003] best_practice
<!-- consolidated: 2026-08-06 verdict=refinement target=verification-integrity/probe-must-fail-on-injected-defect -->

**Logged**: 2026-08-06T02:40:00Z
**Priority**: high
**Status**: new
**Area**: testing
**Pattern-Key**: tests-that-cannot-fail

### Summary
Across four adversarial review rounds the highest-value findings were not code bugs but tests and probes that could not fail. Each was proven by mutating the source and watching the suite stay green.

### Details
Verified instances: deleting all three request-generation guards left 14 reducer tests green, because the tests reset state first so a different guard rejected the input, and the one load-bearing scenario had no test. Reverting `client:load` to `client:only` left the "SSR is enabled" E2E green, because it asserted on a wrapper div outside the island and on a string that Astro serializes into island props either way. A `not.toContain('data-certifications')` assertion targeted a string that had never existed anywhere in the repo. A "columns are min-w-0 tracks" test was satisfied by unrelated elements deeper in the subtree.

Most instructive: a well-intentioned FLAKE FIX moved `frame.hover()` before the baseline sample, so hover was active in both snapshots and a real hover-zoom cancelled itself out — a working regression detector silently became a no-op, and the suite went green. The same test snapshotted CSS `transform` while Tailwind v4 `scale-*` writes the `scale` property, so the zoom was invisible to the assertion anyway.

Separately, a permanently skipped test carried a justification ("headphones is un-routed") that had become false, and its assertions targeted a retired UI — re-enabling it as written would have FAILED against correct code. Disabled tests with expired reasons read like coverage while being anti-coverage.

### Suggested Action
Mutation-proof any test asserting a guard, a mode literal, or two samples of one observable, and record the mutation next to the assertion. Re-run the original mutation after ANY test-file edit, including moving a line. Grep every containment/absence token for its producer count before asserting on it. Give unconditional skips a machine-checkable expiry predicate.

### Metadata
- Source: adversarial_review
- Related Files: tests/e2e/public.spec.ts, apps/site/src/islands/shop/headphonesCatalogState.test.ts
- Tags: mutation-testing, vacuous-assertions, flake-fix, skipped-tests

---

## [LRN-20260723-001] correction

**Logged**: 2026-07-23T00:00:00Z
**Priority**: high
**Status**: resolved
**Area**: workflow
**Pattern-Key**: delivery-topology-user-intent

### Summary
Delivery topology is part of the requirement: push the OEM feature branch first, then guarded-fast-forward `test`.

### Details
The initial delivery framing considered updating `test` directly. The user corrected this explicitly. A safe result at the same SHA does not make the branch order interchangeable because the feature branch is the reviewable source and `test` is the deployment target.

### Suggested Action
Before any push, print local HEAD, OEM remote SHA, and `test` remote SHA. Push OEM first, fetch, require OEM == reviewed HEAD and `test` to be an ancestor, then update `test`.

### Metadata
- Source: user_feedback
- Related Files: docs/oem-phase-1-5/EXECUTION.md
- Tags: git, delivery, branch-order, exact-sha

---

## [LRN-20260723-002] best_practice

**Logged**: 2026-07-23T00:00:00Z
**Priority**: high
**Status**: resolved
**Area**: frontend
**Pattern-Key**: alpha-plus-composite-visual-proof

### Summary
Image metadata proves structure, not rendered quality; transparent assets require contrasting composites and visible-bound checks.

### Details
Logo files reported alpha while still showing rectangular backgrounds or color contamination. Pillow `thumbnail()` also left a valid but optically tiny mark because it does not upscale. Alpha extrema, visible bounding boxes, white/gray contact sheets, and individual-asset review answered different acceptance questions.

### Suggested Action
For every normalized logo, assert canvas dimensions and alpha range, inspect visible bounds, composite over two contrasting backgrounds, and review a regenerated contact sheet. Use explicit proportional upscaling when optical bounds are below target.

### Metadata
- Source: conversation
- Related Files: apps/site/public/media/portfolio/customers/
- Tags: webp, alpha, image-processing, visual-verification

---

## [LRN-20260723-003] best_practice

**Logged**: 2026-07-23T00:00:00Z
**Priority**: critical
**Status**: resolved
**Area**: security
**Pattern-Key**: privacy-whole-public-artifact

### Summary
Public-image privacy includes pixels, metadata, labels, alt text, filenames, URLs, hashes, and old hosted objects.

### Details
Hiding an education logo in the component did not make its public source safe: a school name remained in pixels and another identity leaked through a filename. Patent pages also contained personal identity/contact data and QR codes. Approved derivatives were anonymized/redacted and contract tests pinned safe names and hashes.

### Suggested Action
Review every public derivative as a whole artifact. Use identity-free filenames and pixels, remove metadata, add forbidden-term tests, pin reviewed hashes for redacted legal documents, and verify the live edge does not retain superseded objects.

### Metadata
- Source: conversation
- Related Files: apps/site/src/i18n/portfolio-content.test.ts, apps/site/public/media/portfolio/
- Tags: privacy, redaction, anonymization, metadata, cdn

---

## [LRN-20260723-004] best_practice

**Logged**: 2026-07-23T00:00:00Z
**Priority**: critical
**Status**: resolved
**Area**: infra
**Pattern-Key**: external-state-authoritative

### Summary
Externally visible behavior must be verified at the deployed edge, even when build and deploy tools report success.

### Details
A deleted local asset remained live on additive hosting; a placeholder canonical passed compilation; every smoke assertion passed while Node stayed alive. The durable chain is source contract, build artifact, fail-closed deploy result, cache-busted public HTTP outcome, and process exit.

### Suggested Action
For each externally visible lifecycle, define positive and negative edge assertions: active 200/MIME/hash, retired 404, canonical origin, release SHA, and natural smoke exit.

### Metadata
- Source: conversation
- Related Files: scripts/deploy-cloudbase-test.mjs, scripts/smoke-cloudbase-deploy.mjs
- Tags: deployment, cloudbase, cdn, smoke, canonical

---

## [LRN-20260723-005] warning

**Logged**: 2026-07-23T00:00:00Z
**Priority**: high
**Status**: resolved
**Area**: tests
**Pattern-Key**: browser-capture-state-not-proof

### Summary
Browser screenshots are evidence only when focus, viewport, scroll/reveal, animation, and cache state are controlled.

### Details
Parallel captures returned the wrong tab, offscreen reveal sections appeared blank, an integration browser remapped a 1024px request, and an old contact sheet contradicted current alpha pixels. DOM and pixel routes disagreed until exact isolated Playwright contexts and regenerated assets were used.

### Suggested Action
Run stateful browser operations sequentially, use exact isolated viewports, scroll targets into view, wait for scroll/layout to settle, and pair screenshots with computed DOM measurements.

### Metadata
- Source: conversation
- Related Files: tests/e2e/public.spec.ts
- Tags: playwright, screenshot, viewport, reveal, cache

---

## [LRN-20260723-006] best_practice

**Logged**: 2026-07-23T00:00:00Z
**Priority**: high
**Status**: resolved
**Area**: process
**Pattern-Key**: audit-coverage-denominator

### Summary
An audit needs a mechanical denominator before narrative analysis.

### Details
A delegated audit identified only 23/35 commits and still labeled itself complete; transcript agents read truncated early slices. The corrected pass enumerated all expected SHAs, event counts, time bounds, and failed tool calls before synthesis.

### Suggested Action
Start reviews with expected set and exact boundary. Compare covered set mechanically; report gaps and stop using “complete” until the difference is empty.

### Metadata
- Source: error
- Related Files: docs/oem-phase-1-5/LESSONS.md
- Tags: audit, coverage, subagent, evidence

---

## [LRN-20260723-007] best_practice

**Logged**: 2026-07-23T00:00:00Z
**Priority**: medium
**Status**: resolved
**Area**: workflow
**Pattern-Key**: validation-cost-by-risk

### Summary
Use focused validation for each small edit and reserve full-suite/review repetition for milestone and delivery gates.

### Details
The user correctly questioned why a small ICP task took so long. Hard gates remained necessary, but repeating broad reads and full checks after every tiny change added delay without changing risk. Phase 7 moved to red focused contracts, narrow compile/browser checks, then one full validation and exact-SHA review.

### Suggested Action
After each edit run the cheapest discriminating check; after each MIU run its focused suite; at G5/pre-push run full lint/typecheck/tests/build/E2E/review exactly once per final SHA.

### Metadata
- Source: user_feedback
- Related Files: task_plan.md
- Tags: speed, validation, risk, pipeline

---

## [LRN-20260723-008] correction

**Logged**: 2026-07-23T00:00:00Z
**Priority**: high
**Status**: resolved
**Area**: process
**Pattern-Key**: approval-artifact-plain-language

### Summary
An approval gate must describe the feature in language the approver can judge, not only implementation-layer terminology.

### Details
The first G3 architecture described producers, consumers, contracts, and artifact seams without first saying which page feature was changing. The user correctly rejected it as unclear and could not assess the deployment statement. The revised gate led with the six visible changes, explicit non-changes, and OEM → `test` → `supplychainsai.com` delivery flow; approval followed.

### Suggested Action
Every architecture or final-approval artifact starts with four plain-language sections: feature, user-visible changes, explicit non-changes, and delivery/acceptance flow. Technical boundaries follow as an appendix.

### Metadata
- Source: user_feedback
- Related Files: docs/oem-phase-1-5/PHASE8_ARCHITECTURE.md
- Tags: architecture, approval, communication, gate

---