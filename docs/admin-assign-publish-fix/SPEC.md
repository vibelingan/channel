# Admin classification and publication — SPEC

> 2026-09-30. G1 confirmed the two explicit classification actions; G2 approved the responsive design and original Admin palette. The user then authorized completion of the remaining UI-only phases, locally verified with the disposable production-build suite. No production mutation or deployment authorized; true atomic backend batching remains deferred.

## 1. Problem Statement (问题陈述)

Operators cannot tell whether assigning a website category also publishes a product. The row Classify action silently remains draft-only while bulk Assign category defaults to publish; a separate Publish command sits next to it. Slow sequential publication and one generic loading/disabled state make it unclear whether classification saved, publication is still running, or a product needs attention. Long horizontal navigation and a reported right-side blank region make the Admin difficult to use on narrow screens.

## 2. Proposed Solution (方案描述)

Use the same classification dialog for one or multiple products with two outcome-named commands: **Save classification** (default, no automatic publication) and **Save and publish** (explicit intent). Each shows a concise, outcome-specific confirmation before writing. This release retains the existing <=20-product assignment and revision-guarded **sequential** publication; it does not claim one atomic batch or faster DB writes. Keep selection visible while waiting, then show confirmed successes, named rejections and unknown/not-attempted outcomes honestly, without per-product live progress. Summarize a multi-product selection by count and a short list. Replace narrow-screen horizontal Admin navigation with an accessible section selector, keep family filtering compact, and contain wide-table scrolling inside its own region. True backend batch publication is a separate deferred initiative documented in [SDK-PROBE.md](SDK-PROBE.md), not a prerequisite for these customer-facing fixes.

## 3. Technical Constraints (技术约束)

- Reuse existing Astro/React Admin islands, shared Select/dialog patterns and CloudBase Admin assignment and revision-guarded publication protections. No product-specific bulk endpoint, SDK upgrade or generic `batchUpdate` expansion in this release; actual throughput and a future atomic batch require separate proof and approval.
- Existing media/detail approval and server role checks remain authoritative. Assignment that is not fully confirmed must not trigger publication. Unknown write outcomes must not be retried automatically.
- A saved same-family subcategory edit to an already-published product can affect public catalog filtering immediately; the UI must state that clearly before saving. Changing its main family remains server-guarded.
- Only disposable local/test fixtures may be written during implementation verification; production browser investigation stays read-only until separately authorized.

## 4. Non-goals (明确不做的事)

- No customer-data repair, supplier auto-classification, new publication state machine or parallelized writes as part of this small UI change.
- No redesign of the public storefront, general site theme or all Admin tables.
- No silent publication of already-public products or implicit partial publication of mixed public/draft selections; G2 approved the conservative restriction on Save and publish for mixed selections.

## 5. Success Criteria (成功标准)

- A row or selection can choose either explicit outcome without losing its place; Save classification sends no publication request, Save and publish requires every assignment to be confirmed, then uses existing revision-checked individual publication requests for up to 20 selected drafts. Do not call this atomic or imply that confirmed publications roll back when a later product fails.
- A built-site Playwright journey against a disposable local database proves a single product becomes `published: true` after Save and publish; bulk success, partial rejection and concurrent conflict remain correctly reported. The same tests prove draft-only save does not publish.
- During deliberately delayed assignment, sequential publication and status refresh, the dialog gives a stable waiting state and prevents duplicate submission. A fast operation goes straight to confirmed results without a flashing progress bar; partial/unknown outcomes retain selection and named recovery steps. If a response is lost after possible commit, request status readback instead of claiming failure or automatically retrying. After the request settles, an operator may explicitly leave an unresolved outcome for later; keep the selected products and a visible verification warning on the list rather than trapping them in a dialog or calling the write successful.
- At 375, 390, 734/768, 1024 and 1440px, Admin navigation and family filtering do not require horizontal scrolling; only the wide product table may scroll locally. No incoherent right-side blank area or clipped command remains.

## 6. Quality Criteria (质量标准)

- Duplicate submission is blocked immediately; a brief operation needs no intermediate animation, while a longer one shows one clear waiting state, then a summary of confirmed and unresolved outcomes. Do not show per-product live counters or a fabricated single-batch percentage. No latency guarantee without before/after measurement.
- Touch targets are at least 40px (44px for mobile primary actions); labels, focus, Escape, status announcements and return focus work with keyboard and screen reader. Text contrast meets WCAG AA.
- Preserve row identity and selection across pending/partial outcomes, prevent accidental second writes, and keep layout stable for long names, 1–20 items and 200% zoom.

## 7. Blindspots considered

- Decided: supplier-linked products requiring review in Edit get named recovery guidance, not a false published state (Sections 3 and 5).
- Decided: unknown/partial outcomes are not automatically retried; confirmed writes are not claimed rolled back (Sections 3 and 5).
- G2 decision: show current-public versus draft counts; mixed selections cannot silently publish only some rows (Sections 2 and 4).
- Deferred: production latency root cause and customer-specific publish outcome, pending authorized timing/response evidence; no production write is implied by this SPEC.