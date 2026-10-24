# Execution Handoff — `feature/alibaba-linked-catalog-sync`

## 1. Create the worktree

```bash
git fetch origin
git worktree add ../channel-alibaba-linked-catalog-sync \
  -b feature/alibaba-linked-catalog-sync origin/main
cd ../channel-alibaba-linked-catalog-sync
git rev-parse HEAD
git status --short
```

Copy this package to:

```text
docs/alibaba-linked-catalog-sync/
```

Create `docs/alibaba-linked-catalog-sync/EXECUTION_LOG.md` and record the exact baseline.

## 2. Read before editing

- `AGENTS.md`
- `docs/ENGINEERING_CRAFT.md`
- `docs/CLOUDBASE_SDK_CONTRACT_VERIFICATION.md`
- this documentation set in authoritative order
- current collection registry, DB adapter, CloudBase adapter, public API handler, pricing components, function packaging, smoke, and deploy scripts

## 3. Protected-surface rule

Before every MIU touching catalog pricing, run a source inventory for:

```text
unitPrice
wholesalePrice
vipPrice
clearancePrice
PriceBlock
canSeeVipPricing
JWT_SECRET
Authorization
```

(R1 adds `clearancePrice` — it is a legacy pricing field in the shared public
allowlist and the overstock registry def, rendered by the overstock islands.)

Record the relevant consumers. Do not remove or rewrite them.

Add a regression test that snapshots the protected registry fields and confirms each remains after the feature.

## 4. Test-first execution loop

For each MIU:

1. reconcile current branch status and execution log;
2. load required engineering/CloudBase/testing guidance;
3. write focused failing test;
4. implement only the MIU contract;
5. run focused tests;
6. run cross-file assumption review;
7. run affected package typechecks/lint/build;
8. run full repository gates when shared surfaces changed;
9. review exact diff for protected-surface violations;
10. commit one MIU-specific change;
11. deploy exact reviewed SHA to test for runtime MIUs;
12. record release, run, smoke, and browser evidence.

## 5. Required commands

Use repository scripts as they exist at execution time. At minimum:

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm lint
pnpm verify:cloudbase-sdk
pnpm package:functions
pnpm smoke:functions
pnpm build
```

Run focused package and browser tests before the full gate.

## 6. Stop conditions

Stop and record evidence when:

- Alibaba permission or endpoint contract is missing;
- official response fields differ materially from fixtures;
- signature vector fails;
- raw bytes cannot be stored before parsing;
- lease/fence cannot be implemented with verified SDK contracts;
- test deployment would add an automatic timer;
- any MIU changes protected legacy fields or behavior;
- an agent proposes scraping, fuzzy matching, auto-publication, FX/markup, Medusa, or destructive cleanup.

## 7. Review output format

Every implementation review finding must include:

- severity;
- exact file and symbol;
- violated invariant or acceptance criterion;
- reproduction/evidence;
- minimal correction;
- whether the correction affects docs or architecture.

Architectural changes require user approval and a documentation revision before implementation.
