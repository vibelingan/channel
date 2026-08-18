# OEM Homepage Content Sync — Post-Merge Review

Date: 2026-08-18

Reviewed implementation: `f00465d..6807f15`

Promotion commits:

- Feature to `test`: PR #20, merge `73b41f0`
- Feature to `main`: PR #21, merge `9883297`

## Verdict

The OEM content synchronization itself is correct: `/oem` uses the nine shared homepage sections, preserves OEM media and form behavior, removes the retired claims, and leaves the homepage content/composition unchanged.

The post-merge review found one no-JavaScript false-green path, one no-JavaScript timeout risk, and three missing regression guards (asset dimensions, mapped-template parsing, and the shared Hero contract). These are fixed on `fix/oem-sync-review-hardening`; no production page behavior changed.

## Findings And Disposition

| ID | Severity | Finding | Disposition |
| --- | --- | --- | --- |
| OR-1 | P2 | `waitForLocalStylesheet` returned success when no same-origin stylesheet existed, allowing an unstyled page to pass the horizontal-overflow test. | Fixed: readiness now requires the `--spacing-header` token from application `global.css`; a browser test first proves styles are active, removes all linked/inline style nodes independent of Astro delivery mode, and proves readiness rejects. |
| OR-2 | P2 | The no-JS reveal test still waited for full `load`, so stalled Google Fonts could time it out. | Fixed: navigate to `domcontentloaded`, then wait only for the application CSS token. |
| OR-3 | P2 | OEM poster dimensions were bound into markup but not compared with the actual WebP bytes. | Fixed: site test parses OEM YAML and verifies poster width/height with Sharp metadata. |
| OR-4 | P3 | The media helper swallowed every `.map()` parser assertion and could reclassify a malformed mapped image as static. | Fixed: the TypeScript AST must identify the owning expression as a top-level `.map()` call; unsupported callback bindings reject with a dedicated error, while unrelated conditional branches remain static. |
| OR-5 | P3 | OEM browser acceptance did not pin the shared homepage Hero heading or unique CTAs. | Fixed: the Hero-scoped test asserts the exact shared H1 and exactly one `#submit` and `#factory` CTA. |

## Verified Implementation Contracts

- `/oem` section order: Hero, workflow comparison, 10-step process, factory, people, advantages, quality, certifications, inquiry form.
- `/oem#process`, `/oem#factory`, `/oem#submit`, and `/oem#what-we-do` resolve.
- OEM factory media remains `/media/oem-factory.mp4` with `/media/factory-oem.webp`.
- Inquiry fields, category options, upload accept list, `/api/admin`, and `/oem_submit_result` are unchanged.
- Retired `100+ Supply Chain Partners`, Flexible MOQ, Dedicated Project Manager, AQL, RoHS, and six-family marketing copy are absent.
- `apps/site/src/pages/index.astro` and `apps/site/src/i18n/content/en-US.md` have zero implementation diff.
- Extra `portfolio.astro` change is justified: `min-w-0` and `break-words` prevent the audited 320 px stats-label overflow.

## Deferred Non-Blocking Cleanup

- `CardGrid`, `WorkflowChain`, `ProcessTimeline`, and `ReasonList` plus their exported prop types are now disconnected legacy code. Removing them should be a separate dead-code cleanup, not mixed into this review fix.
- Several source-contract tests intentionally inspect Astro/YAML source text. Browser acceptance covers the runtime anchors and composition; replacing all source checks with AST/render contracts is optional maintainability work.
- The former `public.spec.ts` VIP-member smoke depended on a fixed local seed account and dynamically skipped in deployed environments, so it could not prove the authenticated contract there. It is removed rather than disguised as an early return. Deterministic `public-api` handler tests already cover entitled list/detail responses, viewer denial, wrong-secret denial, and immediate suspend/delete/demote/promote effects; the public browser suite retains its independent anonymous non-disclosure assertions.

## Validation

- Feature SHA before fixes: site tests 139/139; workspace and E2E typechecks; lint; production-origin build.
- Review-fix tests: site tests 141/141; focused browser tests 4/4, covering no-JS reveal, 24 viewport/path combinations, missing-CSS rejection, and OEM composition.
- Browser negative contract: application styles are first observed, all linked/inline style nodes are removed, and missing `--spacing-header` forces readiness timeout.
- GitHub: PR #20 checks succeeded; PR #21 merged to `main`; post-merge `main` CI run `32036824859` succeeded.