# Catalog Architecture Hardening - Execution
Status: MIUs 01-15 released; MIU 16 planned and inactive.
Branch: `refactor/catalog-architecture-hardening`

**Current phase:** `implementation`.

**Current/next MIU:** No MIU is active. MIU 16 requires separate activation.

## Git Truth

- Base SHA: `9ddda85593517bc9d1d2bea81c4862ce492b144f`.
- Planning packet reviewed and pushed at `bc1e69e25e9e8d453584be0fde9279f7bdf0c006`.
- MIU 01 implementation was pushed at `f96b75b9114f8aa5b694963cca9a783acf192106` and its
  closure record at `6398a58e6c420686283556ff3b37a837dc93b55e`; both are ancestors of the remote branch.
- MIU 02 implementation was pushed at `c2f0027e85c7bf2e5051333d39c213ca0d1d106d` and its
  closure record at `fa498a05e8dca9412b1ae53b42a5e9ef4f0015b2`; both are ancestors of the remote branch.
- MIU 03 implementation was pushed at `d00a923076d04646f22b211f13288c4c8c8f0c21`. Premature closure
  `2f0fbd43ac1f7e05aa0a2b2a1fee111eea93bd7e` was superseded by published corrective active evidence
  `1e4523c9f1fd67f469a94b46dab13a8a8ddc7e67` and release transition `57e2e77`.
- MIU 04 TDD activation `a1759e9`, implementation `1ea2669`, and reviewed active head `104390d` were pushed;
  release transition is `687b0a1`. No CloudBase deployment was run.
- MIU 05 TDD activation `edf06c5`, implementation `dc6674a`, and reviewed active head `d8e1bbf` were pushed.
  No CloudBase deployment was run.
- MIU 06 TDD activation `28236a6`, implementation `6c4f180`, and reviewed active head `6a14018` were pushed.
  No CloudBase deployment was run.
- MIU 07 TDD activation `f224a13`, implementation `403d8c9`, and reviewed active head `ac861b9` were pushed.
  No CloudBase deployment was run.
- MIU 08 TDD activation `4e9b5ca`, implementation `d9decd4`, and reviewed active head `aa18b0a` were pushed.
  No CloudBase deployment was run.
- MIU 09 implementation is `449469d`; corrective tracked activation is `0d2929a` because its TDD
  activation files were not committed before implementation. Both remain local until review and push.
  Reviewed active head `0f9f07f` was pushed; no CloudBase deployment was run.
- MIU 10 activated from released closure `635569d`; behavior-first contract and exact three-file
  reservation are tracked at `b7f35c0`. Implementation `f98c8d3` and reviewed active head `d33505f`
  were pushed; release transition is `0c2465d` and published closure is `afe6591`. No CloudBase deployment was run.
- MIU 09 post-release lint correction `c98250b` makes its existing pricing decision switch explicitly
  exhaustive. It changes one released owner file without changing the 49-MIU denominator or reopening
  lifecycle state; focused render, full site, site/Astro typecheck, 15-page build, and repository-wide
  Biome pass. Reviewed correction packet `d97c7fb` was pushed with local/remote equality, architecture
  verification, and the 93-script suite passing afterward.
- MIU 11 activated from published correction reconciliation `a8e307c`; behavior-first contract and exact
  three-file reservation are tracked at `54d81c6`, lifecycle sync at `052255c`, implementation and reviewed
  active head at `03933c5`, and release transition at `65e4091`. No CloudBase deployment was run.
- MIU 12 behavior-first contract and exact three-file reservation are tracked at `53f8c51`; application
  state and ProductMedia delegation implementation is `775bd2d`; effective-URL alias correction is
  `dd1d557`. Gallery consumer regression `7d8309b` proved duplicate effective URLs excluded a later unique
  fallback; independently reviewed correction `ed58f66` delegates its pre-bound normalization. Final
  corrected active packet `7e12025` was pushed and verified; release transition is `cda0def`. No CloudBase
  deployment was run.
- MIU 13 behavior-first contract and exact three-file reservation are tracked at `0c25770`; canonical
  SKU view and orchestration adapter implementation is `b387f61`, reviewed active head is `d9b1e00`,
  and release transition is `24259dc`. No CloudBase deployment was run.
- Latest `origin/main` at `78506d5` was merged into the published MIU 13 closure with merge commit
  `0e9d584`. The full workspace tests, workspace/E2E typechecks, 15-page site build, repository-wide
  Biome, and an independent merge audit passed locally. This updates only the feature branch; no test
  branch merge, workflow dispatch, or CloudBase deployment was performed.
- MIU 14 behavior-first contract and exact three-file reservation are tracked at `fc9048b`; canonical
  SEO pricing view implementation is `49e5ae3`, reviewed active head is `03b5f17`, and release transition
  is `67218de`. This MIU preserves the intentionally client-populated, noindex SKU shell and the existing
  public image-string contract; changing either is outside pricing parity. Currency/MOQ, zero-price, and
  malformed-link boundary assertions were completed in the implementation commit rather than a separate red commit.
- MIU 15 behavior-first interface/guard contract and exact two-file reservation are tracked at `5ffcc58`;
  hardened shallow runtime guard implementation is `a73be8f`, reviewed active head is `7e334c1`, and
  release transition is `8b28932`. No CloudBase deployment was run.
- A dirty packet, local-ahead commit, unreviewed commit, or local/remote mismatch is in progress, not
  complete.

## Source Of Truth

The tracked files in this directory are authoritative. Local `.claude` state is a disposable pointer.
`TASK_REGISTRY.json` is a claim manifest, but live Git refs, worktrees, and remote refs are validated
rather than trusted from JSON strings. No MIU or exact file is active; future plans remain
`planned|blocked` claims. Activation is one MIU at a time.

## MIU 15 Local Validation

- Adapter contract/guard suite: 4/4 pass; full site suite: 244/244 pass; all workspace tests pass.
- Workspace and E2E typechecks: 0 errors; Astro check: 0 errors with 7 existing hints.
- Production Astro build: 15 pages; repository-wide Biome: 354 files; architecture verifier: 0 issues;
  post-push script suite: 93/93 pass.
- Guard uses only the narrow shared Catalog contract, validates canonical family and six required surfaces,
  rejects sparse/inherited/accessor-backed malformed data, and never invokes adapter callbacks.
- Dynamic labels/capabilities and additive metadata remain intentionally extensible for MIUs 16-19; callback
  result shapes remain a TypeScript responsibility because runtime validation must not execute them.
- No test-branch merge, workflow dispatch, or CloudBase test deployment was performed.

## MIU 14 Local Validation

- Canonical SEO plus SKU integration slice: 20/20 pass; full site suite: 240/240 pass; all workspace tests pass.
- Workspace and E2E typechecks: 0 errors; Astro check: 0 errors with 7 existing hints.
- Production-origin Astro build: 15 pages; repository-wide Biome: 352 files; architecture verifier: 0 issues;
  post-push script suite: 93/93 pass.
- `toCatalogSeoView` owns addressability plus decision-to-offer/MOQ projection; `catalog-seo.ts` contains no
  raw manual, provider, wholesale, or unit pricing precedence and retains its public schema API.
- Manual/scalar/quote and every Alibaba decision preserve price, currency, extrema, zero, source MOQ,
  removed/malformed-link ownership, canonical, SKU, image, and serialization behavior.
- Latest main remains integrated only into this feature branch. No test-branch merge, workflow dispatch,
  or CloudBase test deployment was performed.

## MIU 13 Local Validation

- Canonical SKU plus retained tier characterization: 8/8 pass; full site suite: 232/232 pass.
- Workspace and E2E typechecks: 0 errors; Astro check: 0 errors with 7 existing hints.
- Production Astro build: 15 pages; repository-wide Biome: 348 files; architecture verifier: 0 issues;
  post-push script suite: 93/93 pass.
- SKU view owns status and ready presentation from resolved pricing, typed facts, media, related products,
  breadcrumbs, and schema slots; the island retains fetch/retry/abort/canonical and SEO assembly.
- Direct SKU/inline parity covers manual, wholesale, unit, quote, all Alibaba modes, source MOQ/update,
  facts, and media; related products require usable slugs and emit no empty detail links.
- CloudBase test deployment: not run and not authorized for MIU 13.

## MIU 12 Local Validation

- Catalog media plus inherited ProductMedia/Gallery slice: 16/16 pass; full site suite: 229/229 pass.
- Workspace and E2E typechecks: 0 errors; Astro check: 0 errors with 7 existing hints.
- Production Astro build: 15 pages; repository-wide Biome: 347 files; architecture verifier: 0 issues;
  post-push script suite: 93/93 pass.
- Application state owns trim, effective URL mapping, deduplication, order, nine-item bounding, active
  identity, immutable failure progression, and terminal fallback.
- Gallery consumer regression `7d8309b` failed on duplicate effective aliases before correction;
  reviewed correction `ed58f66` delegates the consumer path without expanding MIU 12's three owner files.
- CloudBase test deployment: not run and not authorized for MIU 12.

## MIU 11 Local Validation

- Detail, pricing, and media parity slice: 33/33 pass; full site suite: 224/224 pass.
- Workspace and E2E typechecks: 0 errors; Astro check: 0 errors with 7 existing hints.
- Production Astro build: 15 pages; repository-wide Biome: 345 files; architecture verifier: 0 issues;
  post-push script suite: 93/93 pass.
- Family-neutral presentation covers `_id` detail identity, Back/focus prerequisites, ordered facts,
  Gallery composition, manual/scalar/quote and all Alibaba modes, source MOQ, and source update metadata.
- The Headphones wrapper retains its old signature and direct typed Gallery labels for rollback/source
  compatibility while delegating resolved pricing and neutral facts to `CatalogDetail`.
- CloudBase test deployment: not run and not authorized for MIU 11.

## MIU 10 Local Validation

- Card and inherited pricing parity suite: 11/11 pass; full site suite: 219/219 pass.
- Workspace and E2E typechecks: 0 errors; Astro check: 0 errors with 7 existing hints.
- Production Astro build: 15 pages; architecture verifier: 0 issues; script suite: 93/93 pass.
- MIU 10 owned-file Biome and `git diff --check`: pass. The separate one-file MIU 09 post-release
  correction `c98250b` restores repository-wide Biome without expanding MIU 10's approved boundary.
- Family-neutral presentation covers all pricing decisions and modes, `_id` activation, optional deep
  links, missing media, and the legacy Headphones unit-price compatibility path.
- CloudBase test deployment: not run and not authorized for MIU 10.

## MIU 09 Local Validation

- Focused grid/source suite: 11/11 pass; full site suite: 213/213 pass.
- Site typecheck: 0 errors; production Astro build: 15 pages; Biome and architecture verifier: pass.
- Fixed/range/tiered/manual/scalar/quote/unavailable output parity is preserved.
- Grid source contains no independent pricing precedence or legacy helper calls; MOQ reads the decision.
- CloudBase test deployment: not run and not authorized for MIU 09.

Deviation: MIU 09's implementation commit preceded its tracked activation commit. The exact three-file
reservation is established in a separate corrective commit before source publication and release.
Post-release correction `c98250b` adds only compile-time exhaustiveness to the existing Alibaba render
branch; focused grid behavior remains 7/7, full site remains 219/219, the production build emits 15 pages,
and repository-wide Biome checks all 343 files successfully.

## MIU 08 Local Validation

- Compatibility suite: 11/11 pass after an observed 10-pass/1-fail TDD baseline.
- Full site suite: 211/211 pass; all workspace tests and typechecks: pass; production build: 15 pages.
- Repository Biome and `git diff --check`: pass; architecture verifier has only expected pre-push mismatch.
- Legacy helper signatures remain available; minor/tier validation and scalar outputs match characterization.
- Linked missing/unavailable provider decisions expose no manual/scalar display.
- CloudBase test deployment: not run and not authorized for MIU 08.

## MIU 07 Local Validation

- Focused resolver suite: 6/6 pass after an observed 0/4 TDD baseline.
- Full shared package: 29/29 pass; shared/site typechecks: 0 errors; production Astro build: 15 pages.
- Repository Biome and `git diff --check`: pass; architecture verifier has only expected pre-push local/remote mismatch.
- Linked inputs delegate first, including malformed links and provider-unavailable decisions; fallback
  values are not inspected. Unlinked precedence is valid manual tiers, wholesale, unit, then quote.
- Zero and decimal major-unit scalar values are preserved; negative/non-finite scalars and malformed tiers
  fail through safely. Decision-source consumer typing is compile-time exhaustive.
- CloudBase test deployment: not run and not authorized for MIU 07.

## MIU 06 Local Validation

- Focused adapter suite: 6/6 pass after an observed 0/4 TDD baseline.
- Adapter plus public schema suite: 14/14 pass; full shared package: 23/23 pass.
- Shared/site typechecks: 0 errors; production Astro build: 15 pages.
- Repository Biome and `git diff --check`: pass; architecture verifier has only expected pre-push local/remote mismatch.
- Fixed/range/tiered decisions preserve safe minor units and source MOQ; negotiable maps to quote.
- Linked missing, malformed, contradictory, or unavailable provider data stays Alibaba-owned unavailable
  and contains no manual/scalar fallback fields.
- CloudBase test deployment: not run and not authorized for MIU 06.

## MIU 05 Local Validation

- Focused gateway suite: 4/4 pass after an observed 0/2 TDD baseline.
- Full site suite: 207/207 pass; production and test typechecks: 0 errors.
- Node SSR import: pass; production Astro build: 15 pages; touched-file Biome and `git diff --check`: pass.
- Valid response order and AbortSignal forwarding are asserted; malformed required/envelope and gated
  fields reject while omitted optional fields decode.
- CloudBase test deployment: not run and not authorized for MIU 05.

## Planning Review Gate

Before MIU 01:

1. Review all ten packet files for requirement, architecture, MIU, test, and registry consistency.
2. Run the packet validators listed below.
3. Commit the packet only; do not include application code.
4. Push `refactor/catalog-architecture-hardening`.
5. Record the reviewed SHA and prove local HEAD equals the remote branch SHA.

## Concurrent Dependency D1

Shared selector merge `78506d525eefcd6410ff0d85a1a020d834f4ab02` is on `origin/main`, CloudBase
test deployment SHA `026e18b45c2bf8b61d54049e7a58bdf22466bfaa` succeeded, and focused live E2E
passed 9/9. Final-code WebKit validation was unavailable and is not claimed, so D1 remains unsatisfied.
D1 is scoped to MIUs 26-28 and is not a task-level dependency; those MIUs remain blocked.

## Environment Mutation Gate D2

Local tests and builds are non-live. MIUs 39-43 author and test all deploy/API/browser smoke source.
MIU 44 creates the reviewed immutable release manifest and validator; MIU 45 consumes it before credentials,
removes push deployment, and retains static concurrency. After those artifacts are independently reviewed
and pushed, D2 occurs immediately before MIU 46, the only LIVE CloudBase **test** mutation. MIU 47 only
executes already-reviewed smoke and records evidence here. Production is unauthorized.

Deploy and rollback each check out its manifest SHA, derive `CHANNEL_BUILD_SHA` and `GITHUB_SHA` from
`git rev-parse HEAD`, rebuild, and use the same real deploy script. MIU 46 preserves four evidence fields:
requested implementation commit, observed deployed release ID, requested rollback commit, and observed
rollback release ID. Each pair is compared only under this checked-out build identity contract.
No arbitrary release identifier is accepted.

## Final Evidence Model

Before D2, immutable implementation and rollback commits are independently reviewed, pushed, and recorded
in the integrity-checked manifest. MIU 46 deploys or restores only those commits; MIU 47 verifies the
observed release. MIUs 48-49 then produce a separate
docs-only closure commit.
The closure document records the implementation/deployed SHA and observed deployment/rollback/smoke
evidence; it does not claim the closure commit was deployed and does not embed its own SHA.

After the closure commit is pushed, registry/tool output external to that commit records its local/remote
equality. A separate branch/PR status field may point to `HEAD` for current closure status without storing
the commit's own SHA in its contents. Implementation release evidence and closure publication evidence
are distinct completion checks.

## Planning Validation

Run from the target worktree before requesting review:

```sh
git diff --check
node -e "JSON.parse(require('fs').readFileSync('docs/catalog-architecture-hardening/TASK_REGISTRY.json','utf8'))"
/Users/SeanCai/Desktop/projects/dev-pipeline/tools/validate-miu-breakdown.sh docs/catalog-architecture-hardening/MIU_BREAKDOWN.md
grep -c '^## MIU ' docs/catalog-architecture-hardening/MIU_BREAKDOWN.md
node -e "const r=require('./docs/catalog-architecture-hardening/TASK_REGISTRY.json'); const t=r.tasks.find(x=>x.id==='catalog-architecture-hardening'); if(Object.keys(t.miuFilePlans).length!==49) process.exit(1)"
git status --short --branch
git rev-parse HEAD origin/refactor/catalog-architecture-hardening
```

Implementation validation is intentionally absent for planned MIUs. Do not describe planned tests as passed evidence.

## MIU 01 Validation

MIU 01 (foundational architecture verifier), implementation commit `f96b75b9114f8aa5b694963cca9a783acf192106`:

- `node --test scripts/verify-catalog-architecture.test.mjs`: 65/65 pass. Synthetic cases cover forbidden edges, cross-layer cycles, Astro and TypeScript import forms, workspace aliases, immutable 49-MIU denominator, derived governance/consumer discovery, ownership transfers, D1/D2 gates, compatibility owners, lifecycle, stale SHA/worktree, and bounded Git probing; the real-registry integration case also passes.
- `pnpm test:deploy-smoke`: 90/90 pass, including all 65 Catalog architecture cases.
- `pnpm exec biome check .`: 330 files, exit 0.
- `pnpm -r --filter './packages/**' --filter './apps/**' typecheck && pnpm typecheck:e2e`: 0 errors.
- `pnpm build`: 15 pages, exit 0.
- `node scripts/verify-catalog-architecture.mjs` on the live repo: 0 issues.
- Critical injection: three planted real violations (stale-sha, illegal-transition, glob-only) were each named with exact paths, then the repo was restored to 0 issues.
- Design refinement found during validation: stale-sha detection changed from strict equality to ancestor-based (`git merge-base --is-ancestor`) so the tracked registry does not self-stale after normal commits.

## MIU 02 Validation

MIU 02 (shared catalog public schema and envelope subpath), implementation commit `c2f0027e85c7bf2e5051333d39c213ca0d1d106d`:

- `npx tsx --test src/catalog/index.test.ts`: 8/8 pass. Cases cover oldest-Headphones plus one current DTO per real family (required-only), required `_id`/name/canonical-family enforcement, role-gated/private/unknown-key rejection, malformed optional and nested-pricing rejection, valid-envelope parse, malformed-envelope rejection, and the generic `catalogPageSchema` factory.
- `npx tsx --test src/**/*.test.ts` (all shared): 108/108 pass, no regression to the existing 100.
- `npx pnpm@11.5.0 typecheck`: 0 errors across all workspaces.
- `npx biome check .`: 332 files, exit 0.
- `npx pnpm@11.5.0 build`: 15 pages, exit 0.
- Isolated subpath import: `import ... from '@vibelingan-channel/shared/catalog'` self-resolves via Node exports resolution with no root-barrel dependency, verified by a package-internal probe.
- Critical injection: a realistic public-API-shaped DTO parses, while role-gated (`vipPrice`), server-side (`imageIds`), supplier-offer (`sourceOfferKey`), empty-`_id`, and non-canonical-family variants are each rejected, and an unknown envelope key is rejected. The schema is not a rubber stamp.

## MIU 03 Validation

MIU 03 (public-read product normalizer), implementation commit `d00a923076d04646f22b211f13288c4c8c8f0c21`:

- `npx tsx --test src/catalog/*.test.ts`: 17/17 pass (8 schema + 9 normalizer). Normalizer cases cover frozen oldest-Headphones immutability and `_id` detail-capability, explicit invalid-family rejection, non-Headphones stale-category drop, explicit-family no-diagnostic, missing-family rejection, schema-violation rejection, Admin/write + role-gated/server-side strip, nested-field immutability, and Alibaba sub-projection.
- `npx tsx --test src/**/*.test.ts` (all shared): 117/117 pass, no regression to the existing 108.
- `npx pnpm@11.5.0 typecheck`: 0 errors across all workspaces.
- `npx biome check .`: 334 files, exit 0.
- `npx pnpm@11.5.0 build`: 15 pages, exit 0.
- Hidden issue found standing outside the design: a real alibaba-linked DB row stores supplier offer keys inside `alibabaCatalogPricing`, so the initial allowlist-copy + strict-schema approach fail-closed REJECTED every alibaba-linked product (`unrecognized_keys: sourceOfferKey...`). Fixed by sub-projecting Alibaba pricing (strip `sourceOfferKey`/`sourceProductId`/`sourceSkuId`) and masking `alibabaPrimarySourceKey` to the constant `'linked'`, matching the public projection exactly. Verified by a critical probe (row now normalizes, no supplier keys leak) plus a dedicated test.

## MIU 04 Local Validation

MIU 04 (schema-checked Public API projection), implementation commit `1ea2669`:

- Focused handler contract: 5/5 pass after an observed 2-pass/3-fail TDD baseline.
- Full Public API suite: 65/65 pass, including list/ID/slug parity, auth/VIP, Overstock, media, and Alibaba projection.
- Public API and shared package typechecks: 0 errors; touched-file Biome and `git diff --check`: pass.
- Local function build/package: admin, public-api, and alibaba-catalog-sync artifacts built and packaged.
- Bare cold-start smoke: all three packaged artifacts load with a `main` export in isolated temp directories.
- CloudBase test deployment: not run and not authorized for MIU 04.

## Deviations

Deviations: MIU 03 implementation and premature closure were pushed without a tracked active state.
Corrective active evidence was reviewed, validated, and published at `1e4523c`, then released separately
at `57e2e77`. MIU 03 also gained Alibaba-pricing sub-projection after a validation probe exposed the hidden
fail-closed rejection of alibaba-linked rows.
MIU 04 added an explicit `packages/shared/package.json` ownership transfer because MIU 03's normalizer had
no legal package export; the dedicated subpath avoids cross-workspace deep imports and an index cycle.
