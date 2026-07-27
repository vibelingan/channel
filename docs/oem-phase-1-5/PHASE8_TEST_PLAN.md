# OEM Phase 8 — Test Plan

Status: completed; route contract superseded 2026-07-27 by `90bd06e`
Date: 2026-07-23
MIUs: `docs/oem-phase-1-5/PHASE8_MIUS.md`

## Plain-language acceptance

Before delivery, the tests must prove all of the following:

1. The two PPT-marked listing stats bands are gone.
2. Both listings still show three cards at 390 / 768 / 1024 / 1440 px with no overflow.
3. All six detail pages still return 200 and retain BOM, margin, MOQ, CTA, and back links.
4. `/oem` shows `20+`, not `15+`.
5. Both hidden ProjectForm success states and the visible result page contain exact `within 24 hours` without submitting a real inquiry.
6. Headphones and Overstock sources use the same promise; `/headphones` is now restored while `/overstock` remains retired.
7. Confirmation-email text and HTML use the same promise, and the packaged admin function contains it.
8. Generated build/package output remains ignored and uncommitted.
9. Delivery uses the exact reviewed SHA in the order OEM branch → `test` → `supplychainsai.com`; main/production remain unchanged.

## MIU 1 — Teardown listing

| ID | Level | Required assertion | Retention / negative assertion | Proof command |
|---|---|---|---|---|
| P8-M1-SRC | Source/unit | Stats signature, `avgMargin`, and `totalReports` are absent. | `reports.map`, `TeardownCard`, intro, nav, and CTA remain. | `pnpm --filter @vibelingan-channel/site exec tsx --test src/i18n/brand-logo.test.ts` |
| P8-M1-E2E | Browser | Removed labels have count zero; exactly three cards; columns are 1/2/3/3 at 390/768/1024/1440. | Reveal settles, heading hierarchy remains valid, no overflow. | Focused Playwright grep `OEM Phase 8.*Teardown` |
| P8-M1-DETAIL | Browser/build | All three collected detail hrefs return 200. | Each retains BOM, margin, MOQ, CTA, and back link. | Same focused Playwright test plus intended-origin site build. |

Required RED before implementation: P8-M1-SRC and the removed-label E2E assertions fail because the stats band exists. Retention assertions are baseline green and must stay green.

## MIU 2 — Blue Ocean listing

| ID | Level | Required assertion | Retention / negative assertion | Proof command |
|---|---|---|---|---|
| P8-M2-SRC | Source/unit | Stats signature, `avgMargin`, `totalProducts`, and `minMoq` are absent. | `products.map`, `ProductConceptCard`, intro, partnership content, nav, and CTA remain. | `pnpm --filter @vibelingan-channel/site exec tsx --test src/i18n/brand-logo.test.ts` |
| P8-M2-E2E | Browser | Removed labels have count zero; exactly three cards; columns are 1/2/3/3 at all four widths. | Reveal settles, heading hierarchy remains valid, no overflow. | Focused Playwright grep `OEM Phase 8.*Blue Ocean` |
| P8-M2-DETAIL | Browser/build | All three collected detail hrefs return 200. | Each retains BOM, margin, MOQ, three partnership tiers, CTA, and back link. | Same focused Playwright test plus intended-origin site build. |

Required RED before implementation: P8-M2-SRC and the removed-label E2E assertions fail because the stats band exists. Retention assertions stay green.

## MIU 3 — OEM active claims

| ID | Level | Required assertion | Retention / negative assertion | Proof command |
|---|---|---|---|---|
| P8-M3-SRC | Source/unit | Exact `stat: '20+'` and exact shared success sentence with `within 24 hours`. | No `15+` or case-insensitive `business day`; ProjectForm wiring unchanged. | Focused `brand-logo.test.ts` plus site typecheck. |
| P8-M3-E2E | Browser | `/oem` visibly shows `20+`; homepage/OEM hidden success DOM contains exact approved promise. | Zero POST requests to `/api/admin`; seven fields, endpoint, result path, disclaimer, and submit buttons remain. | Focused Playwright grep `OEM Phase 8.*active OEM claims` |
| P8-M3-BUILD | Build | Homepage and OEM HTML contain the approved promise; OEM contains `20+`. | Built carriers contain neither stale phrase. | Intended-origin site build plus `grep`. |

Required RED before implementation: source and DOM copy assertions fail on current `15+` / business-day copy. No real form submission is permitted.

## MIU 4 — Submission result

| ID | Level | Required assertion | Retention / negative assertion | Proof command |
|---|---|---|---|---|
| P8-M4-SRC | Source/unit | Exact `get back to you within 24 hours.` | Project-id script and `OEM_INQUIRY_HREF` remain; no old phrase. | Focused `oem-inquiry-routing.test.ts` plus site typecheck. |
| P8-M4-E2E | Browser | `/oem_submit_result?id=phase8-check` renders the new sentence and id. | No API POST; “Submit another request” still reaches `/#oem-inquiry`. | Focused Playwright grep `OEM Phase 8.*submission result` |
| P8-M4-BUILD | Build | Result HTML exists and contains exact copy. | No `business day`. | Intended-origin build plus `grep`. |

Required RED before implementation: source and visible result-copy assertions fail on current text.

## MIU 5 — Hidden source parity

| ID | Level | Required assertion | Retention / negative assertion | Proof command |
|---|---|---|---|---|
| P8-M5-SRC | Source/unit | Headphones and Overstock each contain their exact `within 24 hours` sentence. | No `business day`; restored Headphones navigation and retired Overstock routing remain explicit. | Focused `hidden-sections.test.ts` plus site typecheck. |
| P8-M5-BUILD | Build | Site builds after both source changes. | `dist/headphones` is emitted; `dist/overstock` and its sitemap entry remain absent. | Intended-origin site build plus filesystem/`grep` assertions. |
| P8-M5-LIVE | Deployed smoke | `/headphones` returns HTTP 200; `/overstock` remains HTTP 404 on `supplychainsai.com`. | Any opposite response fails current acceptance. | Cache-busted `curl` after deployment. |

Required RED before implementation: both source-copy assertions fail. Existing hidden-route guards remain green.

## MIU 6 — Email and packaged artifact

| ID | Level | Required assertion | Retention / negative assertion | Proof command |
|---|---|---|---|---|
| P8-M6-SRC | Source/unit | Plain text and HTML each contain `respond within 24 hours.`; exactly two approved occurrences. | No `business day`; handler call payload and best-effort email behavior remain unchanged. | New admin source-contract test plus email/admin typechecks. |
| P8-M6-ART | Build/artifact | Packaged admin `index.js` exists and contains `within 24 hours`. | No stale phrase or unresolved runtime import. | Function builds, `package-functions.mjs`, artifact scan, `smoke-function-artifacts.mjs`. |
| P8-M6-GIT | Build/artifact | All generated outputs are ignored. | No `dist/` or `.cloudbase-artifacts/` file is tracked or staged. | `git check-ignore`, `git ls-files`, and staged-path check. |

Required RED before implementation: the source test and freshly rebuilt old artifact fail on the stale email phrase.

## Existing and new tests

Extended:

- `apps/site/src/i18n/brand-logo.test.ts` — MIUs 1–3.
- `tests/e2e/public.spec.ts` — MIUs 1–4 and deployed acceptance.
- `apps/site/src/lib/oem-inquiry-routing.test.ts` — MIU 4.
- `apps/site/src/i18n/hidden-sections.test.ts` — MIU 5.

New:

- `apps/functions/admin/src/oem-email-content.test.ts` — MIU 6.

Reused unchanged:

- Existing form and CTA tests.
- Existing data/detail implementations.
- `scripts/smoke-function-artifacts.mjs`.
- Workspace typechecks, tests, and build commands.

## Final local validation

Run from the exact isolated worktree and assert `$PWD` before accepting results.

```zsh
[[ "$PWD" == "/Users/SeanCai/Desktop/projects/channel-icp-delivery" ]]

pnpm exec biome check .
pnpm -r --filter "./packages/**" --filter "./apps/**" typecheck
pnpm exec tsc --noEmit --project tsconfig.e2e.json
node --test scripts/smoke-http.test.mjs
pnpm -r test
pnpm exec playwright test --list

if grep -RIniE '15\+|business([[:space:]]|-)days?' \
  apps/site/src/i18n/content/oem/en-US.md \
  apps/site/src/pages/oem_submit_result.astro \
  apps/site/src/i18n/content/headphones/en-US.md \
  apps/site/src/i18n/content/overstock/en-US.md \
  packages/email/src/index.ts; then
  exit 1
fi

grep -Fq "stat: '20+'" apps/site/src/i18n/content/oem/en-US.md

CHANNEL_BUILD_SHA="$(git rev-parse HEAD)" pnpm -r --filter "./apps/functions/**" build
node scripts/package-functions.mjs
node scripts/smoke-function-artifacts.mjs

SITE_URL=http://127.0.0.1:4321 PUBLIC_CB_PROXY=0 \
  pnpm --filter @vibelingan-channel/site build
```

Start preview in a persistent server terminal, then run:

```zsh
E2E_SITE_URL=http://127.0.0.1:4321 E2E_RUN_ID=phase8-local \
  pnpm exec playwright test tests/e2e/public.spec.ts \
  --project=chromium --grep "OEM Phase 8"
```

Rebuild with the canonical origin before final artifact review:

```zsh
SITE_URL=https://supplychainsai.com PUBLIC_CB_PROXY=0 \
  pnpm --filter @vibelingan-channel/site build
```

The local Phase 8 browser test must not set mutation flags or submit a real inquiry.

## Delivery and live acceptance

1. Review and bless the final exact SHA.
2. Push that SHA to `dev/albertli/oem-phase1-5-adjustments` first.
3. Fetch and require the remote OEM branch to equal the reviewed SHA.
4. Require current `origin/test` to be an ancestor of that SHA.
5. Fast-forward the exact same SHA to `test`, without force.
6. Require CI and Deploy Test to pass; verify main/production did not move.
7. Run the focused Phase 8 Playwright contract against `https://supplychainsai.com` with the reviewed SHA as cache key.
8. Independently verify `/headphones` returns 200, `/overstock` returns 404, and all six retained details return 200.

Provider test hostname alone is not final acceptance. No main push, production workflow, mutation flag, or real inquiry submission is authorized.

## Phase 7.5 API contract

N/A. Phase 8 changes no endpoint, action, payload, response, status, schema, authentication rule, SDK surface, upload flow, environment variable, or client/server contract.

## G4 decision

Approving G4 authorizes only:

- deleting the two listing stats bands and their unused page-local aggregate variables;
- changing the approved `20+` and `within 24 hours` text;
- adding the source/browser/artifact tests described above;
- rebuilding ignored artifacts for verification;
- delivering OEM → `test` → `supplychainsai.com` after all gates pass.

At Phase 8 approval time it did not authorize route restoration. The later `90bd06e` change independently restored `/headphones`; `/overstock` remains retired.

G4 blockers: none. Open questions: none.