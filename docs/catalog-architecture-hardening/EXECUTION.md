# Catalog Architecture Hardening - Execution
Status: MIU 01 foundational architecture verifier released; MIU 02 planned and inactive.
Branch: `refactor/catalog-architecture-hardening`

**Current phase:** `implementation`.

**Current/next MIU:** No MIU is active. MIU 01 is released; MIU 02 requires a separate activation after live-ref and dependency checks pass.

## Git Truth

- Base SHA: `9ddda85593517bc9d1d2bea81c4862ce492b144f`.
- Planning packet reviewed and pushed at `bc1e69e25e9e8d453584be0fde9279f7bdf0c006`.
- MIU 01 implementation was pushed at `f96b75b9114f8aa5b694963cca9a783acf192106` and its
  closure record at `6398a58e6c420686283556ff3b37a837dc93b55e`; both are ancestors of the remote branch.
- A dirty packet, local-ahead commit, unreviewed commit, or local/remote mismatch is in progress, not
  complete.

## Source Of Truth

The tracked files in this directory are authoritative. Local `.claude` state is a disposable pointer.
`TASK_REGISTRY.json` is a claim manifest, but live Git refs, worktrees, and remote refs are validated
rather than trusted from JSON strings. No implementation MIU or exact file is currently reserved;
49 MIU file plans are future `planned|blocked` claims, not active reservations. Activation is one MIU
at a time and shared files use references or explicit transfer.

## Planning Review Gate

Before MIU 01:

1. Review all ten packet files for requirement, architecture, MIU, test, and registry consistency.
2. Run the packet validators listed below.
3. Commit the packet only; do not include application code.
4. Push `refactor/catalog-architecture-hardening`.
5. Record the reviewed SHA and prove local HEAD equals the remote branch SHA.

## Concurrent Dependency D1

D1 is satisfied: shared selector merge `78506d525eefcd6410ff0d85a1a020d834f4ab02` is on
`origin/main`, CloudBase test deployment SHA `026e18b45c2bf8b61d54049e7a58bdf22466bfaa` succeeded,
and focused live shared-selector E2E passed 9/9. D1 is scoped to MIUs 26-28 and is not a task-level
dependency. Those MIUs are planned, not active, and still require their ordinary dependency and
reservation checks before activation.

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

## Deviations

Deviations: none. MIU 01 executed and validated as planned; stale-sha detection was refined to ancestor-based during validation.
