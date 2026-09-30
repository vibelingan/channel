# Admin category assignment and publication (2026-09-28)

Goal: deliver the explicit category-and-publication workflow plus responsive Admin navigation. Initial live inspection was read-only; the later authorized Admin-page acceptance is limited to the A/C test drafts and B product with captured baseline and UI-only restoration in [G4-TEST-PLAN.md](G4-TEST-PLAN.md). Do not modify other customer products.

## Phases

1. [complete] Detect stack/deploy, confirm main and inspect production UI read-only.
2. [complete] Lock dual-button intent and record G1 requirements approval in SPEC.
3. [complete] Audit responsive navigation and classification design; user approved G2.
4. [complete for UI-only scope] Lock the revised architecture, MIUs, prototype and test plan after the user deferred true backend batching and authorized the remaining UI phases.
5. [complete for UI-only scope] Implement and review classification outcomes, read-only recovery and responsive Admin navigation; validate the local production build and disposable-DB E2E.
6. [pending] Push reviewed branch, merge safely into production-serving `test`, verify deployed SHA, then run and restore the specifically authorized A/C/B Admin-page acceptance.

Deferred separately: a true atomic backend batch with transaction, approval, image-counter and lost-response proofs in an isolated NoSQL environment. The UI release retains the existing <=20 revision-checked sequential publication behavior; it makes no atomicity claim.

Branch: `fix/admin-assign-category-publish-20260928` from fetched `origin/main` at `bf699b4`. Other dirty worktrees stay untouched.

## Safety

- Production browser: the earlier reconnaissance was read-only. For the later approved acceptance, allow Save/publish and A/C deletion only on the captured A/C/B products through Admin, restore their business-visible baseline after each case, and record the unavoidable audit/public-visibility history. No direct database/API calls for product changes or cleanup.
- No automatic retry of ambiguous writes. Never claim publication succeeded without a confirmed per-product result.
- Keep local/disposable fixtures separate from live customer records.
- The env documented as `test` (`diversity-123-d9grnqfux221323bb`) routes the production site and `/api/admin`; treat it as PRODUCTION. The approved UI-only A/C/B checks are the sole live product writes here. No SDK/direct-DB transaction probe, including disposable collections; an independently isolated NoSQL env is required for the **deferred batch feature**. Automated mutating E2E uses the owned local JSON DB.
- The previous single-row publish experiment and red progress test were removed from this branch pending design approval; 24 baseline classification unit tests pass.