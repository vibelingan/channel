# Catalog Architecture Hardening - Execution
Status: MIU 01 foundational verifier and MIU 02 shared catalog schema implemented and validated; MIU 03 pending activation.
Branch: `refactor/catalog-architecture-hardening`

**Current phase:** `implementation`.

**Current/next MIU:** MIU 02 released; MIU 03 is next and activates after the live-ref and dependency checks pass.

## Git Truth

- Base SHA: `9ddda85593517bc9d1d2bea81c4862ce492b144f`.
- Planning packet reviewed and pushed at `bc1e69e25e9e8d453584be0fde9279f7bdf0c006`.
- MIU 01 implementation reviewed and pushed at `f96b75b9114f8aa5b694963cca9a783acf192106`.
- MIU 02 implementation reviewed and pushed at `c2f0027e85c7bf2e5051333d39c213ca0d1d106d`; the
  remote branch resolves to a descendant of this SHA once the pending push completes.
- A dirty packet, local-ahead commit, unreviewed commit, or local/remote mismatch is in progress, not
  complete.

## Source Of Truth

The tracked files in this directory are authoritative. Local `.claude` state is a disposable pointer.
`TASK_REGISTRY.json` is a claim manifest, but live Git refs, worktrees, and remote refs are validated
rather than trusted from JSON strings. The only active Catalog reservation is
`docs/catalog-architecture-hardening/**`; 49 MIU file plans are future `planned|blocked` claims, not
active reservations. Activation is one MIU at a time and shared files use references or explicit transfer.

## Planning Review Gate

Before MIU 01:

1. Review all ten packet files for requirement, architecture, MIU, test, and registry consistency.
2. Run the packet validators listed below.
3. Commit the packet only; do not include application code.
4. Push `refactor/catalog-architecture-hardening`.
5. Record the reviewed SHA and prove local HEAD equals the remote branch SHA.

## Concurrent Dependency D1

`fix/shared-form-select` is live at remote SHA
`b9e52fed2b0af20e2b791bb6af08026404e3d57c` in
`/Users/SeanCai/Desktop/projects/channel-form-select-refactor`. It owns the excluded Select/Admin
files listed in `TASK_REGISTRY.json`. D1 is scoped to MIUs 26-28 and is not a task-level dependency.
Those MIUs remain blocked until the final reviewed SHA merges into `origin/main`; the current SHA is
in-progress evidence only. They remain blocked after merge until the full inherited controlled/reset,
validation/focus, Arrow/Home/End/Escape/Enter/Space, outside-pointer, no-JS, Chromium, and WebKit suite
passes on that final merge. Only then may Catalog integration activate.

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

- `node --test scripts/verify-catalog-architecture.test.mjs`: 25/25 pass. Synthetic cases cover forbidden edge, cycle, duplicate governance owner, unrooted discovery, two active exact-file owners, stale SHA, worktree mismatch, illegal transition, missing derived consumer, glob-only plan, local-only completion, released-to-active transfer, and sibling-worktree-ignored.
- `node --test scripts/*.test.mjs` (`test:deploy-smoke`): 49/49 pass, no regression to the existing 24.
- `npx biome check .`: 330 files, exit 0.
- `pnpm typecheck`: 0 errors.
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

## Deviations

Deviations: none. MIU 01 and MIU 02 executed and validated as planned; stale-sha detection was refined to ancestor-based during MIU 01 validation.
