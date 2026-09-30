# Admin category assignment and publication (2026-09-28)

Goal: design a clear, compact category-and-publication workflow plus responsive Admin navigation, then implement only after the dev-pipeline approval gates. Never mutate customer products during live inspection.

## Phases

1. [complete] Detect stack/deploy, confirm main and inspect production UI read-only.
2. [complete] Lock dual-button intent and record G1 requirements approval in SPEC.
3. [complete] Audit responsive navigation and classification design; user approved G2.
4. [complete for UI-only scope] Lock the revised architecture, MIUs, prototype and test plan after the user deferred true backend batching and authorized the remaining UI phases.
5. [complete for UI-only scope] Implement and review classification outcomes, read-only recovery and responsive Admin navigation; validate the local production build and disposable-DB E2E. No deploy or live write.

Deferred separately: a true atomic backend batch with transaction, approval, image-counter and lost-response proofs in an isolated NoSQL environment. The UI release retains the existing <=20 revision-checked sequential publication behavior; it makes no atomicity claim.

Branch: `fix/admin-assign-category-publish-20260928` from fetched `origin/main` at `bf699b4`. Other dirty worktrees stay untouched.

## Safety

- Production browser: read-only navigation and network observation; no assignment, publish, Save, import or deletion.
- No automatic retry of ambiguous writes. Never claim publication succeeded without a confirmed per-product result.
- Keep local/disposable fixtures separate from live customer records.
- The env documented as `test` (`diversity-123-d9grnqfux221323bb`) currently routes the production site and `/api/admin`; treat it as PRODUCTION. No remote write probe there, including disposable collections. An independently isolated NoSQL env is required for the **deferred batch feature's** SDK transaction acceptance and G3, not for this release's UI-only G3. This release's mutating E2E uses the owned local JSON DB.
- The previous single-row publish experiment and red progress test were removed from this branch pending design approval; 24 baseline classification unit tests pass.