# Learnings

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