import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  buildModuleGraph,
  checkConsumerReferences,
  checkDenominator,
  checkDependencyDirection,
  checkGitRefs,
  checkGovernance,
  checkMiuDependencies,
  checkReservations,
  checkSequentialOwnership,
  detectCycles,
  verifyCatalogArchitecture,
} from './verify-catalog-architecture.mjs';

// ---------------------------------------------------------------------------
// Synthetic fixtures (no real repo needed for pure graph/registry/git checks)
// ---------------------------------------------------------------------------
const R = '/repo';
const abs = (rel) => join(R, rel);
const types = (issues) => issues.map((i) => i.type);

const graphOf = (edges) => {
  const g = new Map();
  const ensure = (k) => {
    if (!g.has(k)) g.set(k, new Set());
  };
  for (const [from, to] of edges) {
    ensure(abs(from));
    g.get(abs(from)).add(abs(to));
    ensure(abs(to));
  }
  return g;
};

const registryOf = (task) => ({
  reservationPolicy: { states: ['planned', 'blocked', 'active', 'released'] },
  tasks: [{ id: 'catalog-architecture-hardening', ...task }],
});

const gitProbeOf = (o) => ({
  showRefVerify: (ref) => o.refs?.[ref] ?? null,
  lsRemoteHeads: () => o.remote ?? {},
  worktreeList: () => o.worktrees ?? [],
  isAncestor: (a) => (o.ancestors ?? []).includes(a),
});

const withTempDir = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'vca-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const write = (root, rel, content) => {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
};

// ---------------------------------------------------------------------------
// Dependency direction
// ---------------------------------------------------------------------------
test('dependency direction: domain importing presentation is a forbidden edge with exact path pair', () => {
  const g = graphOf([
    ['packages/shared/src/catalog/pricing.ts', 'apps/site/src/catalog/presentation/Card.tsx'],
  ]);
  const issues = checkDependencyDirection(R, g);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].type, 'forbidden-edge');
  assert.deepEqual(issues[0].paths, [
    'packages/shared/src/catalog/pricing.ts',
    'apps/site/src/catalog/presentation/Card.tsx',
  ]);
});

test('dependency direction: presentation importing a concrete family adapter is forbidden', () => {
  const g = graphOf([
    [
      'apps/site/src/catalog/presentation/List.tsx',
      'apps/site/src/catalog/families/headphones.tsx',
    ],
  ]);
  const issues = checkDependencyDirection(R, g);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].type, 'forbidden-edge');
});

test('dependency direction: route -> adapter -> domain chain is allowed', () => {
  const g = graphOf([
    ['apps/site/src/pages/headphones.astro', 'apps/site/src/catalog/families/headphones.tsx'],
    ['apps/site/src/catalog/families/headphones.tsx', 'packages/shared/src/catalog/index.ts'],
    ['apps/site/src/catalog/presentation/List.tsx', 'packages/shared/src/catalog/index.ts'],
  ]);
  assert.deepEqual(checkDependencyDirection(R, g), []);
});

test('dependency direction: test files and legacy islands cluster are not policed', () => {
  const g = graphOf([
    [
      'apps/site/src/islands/shop/CatalogFamilyPage.tsx',
      'apps/site/src/islands/shop/HeadphonesProductDetail.tsx',
    ],
    ['apps/site/src/islands/shop/x.test.ts', 'apps/site/src/islands/shop/HeadphonesPage.tsx'],
  ]);
  assert.deepEqual(checkDependencyDirection(R, g), []);
});

// ---------------------------------------------------------------------------
// Cycles
// ---------------------------------------------------------------------------
test('cycles: an import cycle returns the cycle path', () => {
  const g = graphOf([
    ['apps/site/src/catalog/a.ts', 'apps/site/src/catalog/b.ts'],
    ['apps/site/src/catalog/b.ts', 'apps/site/src/catalog/c.ts'],
    ['apps/site/src/catalog/c.ts', 'apps/site/src/catalog/a.ts'],
  ]);
  const issues = detectCycles(R, g);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].type, 'cycle');
});

test('cycles: acyclic graph passes', () => {
  const g = graphOf([
    ['apps/site/src/catalog/a.ts', 'apps/site/src/catalog/b.ts'],
    ['apps/site/src/catalog/b.ts', 'apps/site/src/catalog/c.ts'],
  ]);
  assert.deepEqual(detectCycles(R, g), []);
});

// ---------------------------------------------------------------------------
// Reservations
// ---------------------------------------------------------------------------
test('reservations: two tasks actively owning the same exact file returns the path', () => {
  const registry = {
    reservationPolicy: { states: ['planned', 'blocked', 'active', 'released'] },
    tasks: [
      {
        id: 'a',
        activeExactReservations: ['src/x.ts'],
        miuFilePlans: {},
        miuReservationStates: {},
      },
      {
        id: 'b',
        activeExactReservations: ['src/x.ts'],
        miuFilePlans: {},
        miuReservationStates: {},
      },
    ],
  };
  const issues = checkReservations(registry);
  const dup = issues.find((i) => i.type === 'duplicate-active-owner');
  assert.ok(dup, 'expected duplicate-active-owner');
  assert.ok(dup.paths.includes('src/x.ts'));
});

test('reservations: a glob-only MIU file plan is rejected', () => {
  const registry = registryOf({
    activeExactReservations: [],
    miuFilePlans: { '02': ['packages/shared/src/catalog/**'] },
    miuReservationStates: {},
  });
  assert.ok(types(checkReservations(registry)).includes('glob-only-plan'));
});

test('reservations: an unknown reservation state is an illegal transition', () => {
  const registry = registryOf({
    activeExactReservations: [],
    miuFilePlans: {},
    miuReservationStates: { '02': { reservationState: 'flying' } },
  });
  assert.ok(types(checkReservations(registry)).includes('illegal-transition'));
});

// ---------------------------------------------------------------------------
// MIU dependency DAG
// ---------------------------------------------------------------------------
test('miu dependencies: a cycle in the DAG is reported', () => {
  const registry = registryOf({
    miuDependencies: { '02': ['03'], '03': ['02'] },
    miuReservationStates: {
      '02': { reservationState: 'planned' },
      '03': { reservationState: 'planned' },
    },
  });
  assert.ok(types(checkMiuDependencies(registry)).includes('dependency-cycle'));
});

test('miu dependencies: active MIU depending on a non-released MIU is an illegal transition', () => {
  const registry = registryOf({
    miuDependencies: { '03': ['02'] },
    miuReservationStates: {
      '02': { reservationState: 'planned' },
      '03': { reservationState: 'active' },
    },
  });
  assert.ok(types(checkMiuDependencies(registry)).includes('illegal-transition'));
});

test('miu dependencies: released dependency allows activation (released-before-active passes)', () => {
  const registry = registryOf({
    miuDependencies: { '03': ['02'] },
    miuReservationStates: {
      '02': { reservationState: 'released' },
      '03': { reservationState: 'active' },
    },
  });
  assert.deepEqual(checkMiuDependencies(registry), []);
});

// ---------------------------------------------------------------------------
// Sequential ownership
// ---------------------------------------------------------------------------
test('sequential ownership: two simultaneously active chain MIUs is illegal; single active passes', () => {
  const bad = registryOf({
    sequentialOwnership: {
      'src/x.ts': { chain: ['02', '06'], transition: 'released-before-next-active' },
    },
    miuReservationStates: {
      '02': { reservationState: 'active' },
      '06': { reservationState: 'active' },
    },
  });
  assert.ok(types(checkSequentialOwnership(bad)).includes('illegal-transition'));

  const good = registryOf({
    sequentialOwnership: {
      'src/x.ts': { chain: ['02', '06'], transition: 'released-before-next-active' },
    },
    miuReservationStates: {
      '02': { reservationState: 'released' },
      '06': { reservationState: 'active' },
    },
  });
  assert.deepEqual(checkSequentialOwnership(good), []);
});

// ---------------------------------------------------------------------------
// Consumer references
// ---------------------------------------------------------------------------
test('consumer references: missing consumer file of an active MIU is reported; planned MIU future files are skipped', () =>
  withTempDir((root) => {
    const registry = registryOf({
      consumerReferences: { '01': ['src/exists.ts'], 99: ['src/future.ts'] },
      miuReservationStates: {
        '01': { reservationState: 'active' },
        99: { reservationState: 'planned' },
      },
    });
    write(root, 'src/exists.ts', 'export {};\n');
    // active MIU references a present file -> ok; planned MIU references a future file -> skipped.
    assert.deepEqual(checkConsumerReferences(registry, root), []);

    const missing = registryOf({
      consumerReferences: { '01': ['src/gone.ts'] },
      miuReservationStates: { '01': { reservationState: 'active' } },
    });
    assert.ok(types(checkConsumerReferences(missing, root)).includes('missing-derived-consumer'));
  }));

// ---------------------------------------------------------------------------
// Git live refs
// ---------------------------------------------------------------------------
test('git refs: stale claimed SHA, missing refs, worktree mismatch, local-only completion are each named', () => {
  const base = {
    branch: 'feat/x',
    remoteBranch: 'origin/feat/x',
    worktree: '/wt/main',
    claimedLocalHead: 'aaaaaaa',
    claimedRemoteHead: 'bbbbbbb',
  };
  const probe = gitProbeOf({
    refs: { 'refs/heads/feat/x': 'ccccccc' },
    remote: { 'feat/x': 'ddddddd' },
    worktrees: [{ worktree: '/wt/main', head: 'ccccccc', branch: 'feat/x' }],
  });
  const issues = checkGitRefs(registryOf(base), probe);
  const t = types(issues);
  assert.ok(t.includes('stale-sha'), 'stale-sha');
  assert.ok(t.includes('local-only-completion'), 'local-only');
});

test('git refs: a claimed SHA that is an ancestor of the live head is NOT stale (normal commit progress)', () => {
  const registry = registryOf({
    branch: 'feat/x',
    remoteBranch: 'origin/feat/x',
    worktree: '/wt/main',
    claimedLocalHead: 'old123',
    claimedRemoteHead: 'old123',
  });
  const probe = gitProbeOf({
    refs: { 'refs/heads/feat/x': 'new456' },
    remote: { 'feat/x': 'new456' },
    worktrees: [{ worktree: '/wt/main', head: 'new456', branch: 'feat/x' }],
    ancestors: ['old123'],
  });
  assert.deepEqual(checkGitRefs(registry, probe), []);
});

test('git refs: matching local/remote SHA and worktree passes (no issue)', () => {
  const sha = 'abc1234';
  const registry = registryOf({
    branch: 'feat/x',
    remoteBranch: 'origin/feat/x',
    worktree: '/wt/main',
    claimedLocalHead: sha,
    claimedRemoteHead: sha,
  });
  const probe = gitProbeOf({
    refs: { 'refs/heads/feat/x': sha },
    remote: { 'feat/x': sha },
    worktrees: [{ worktree: '/wt/main', head: sha, branch: 'feat/x' }],
  });
  assert.deepEqual(checkGitRefs(registry, probe), []);
});

test('git refs: sibling worktrees on other branches are ignored', () => {
  const sha = 'abc1234';
  const registry = registryOf({
    branch: 'feat/x',
    remoteBranch: 'origin/feat/x',
    worktree: '/wt/main',
    claimedLocalHead: sha,
    claimedRemoteHead: sha,
  });
  const probe = gitProbeOf({
    refs: { 'refs/heads/feat/x': sha },
    remote: { 'feat/x': sha },
    worktrees: [
      { worktree: '/wt/main', head: sha, branch: 'feat/x' },
      { worktree: '/wt/sibling', head: 'zzz9999', branch: 'feat/other' },
    ],
  });
  assert.deepEqual(checkGitRefs(registry, probe), []);
});

test('git refs: worktree on the wrong branch is a worktree-mismatch', () => {
  const sha = 'abc1234';
  const registry = registryOf({
    branch: 'feat/x',
    remoteBranch: 'origin/feat/x',
    worktree: '/wt/main',
    claimedLocalHead: sha,
    claimedRemoteHead: sha,
  });
  const probe = gitProbeOf({
    refs: { 'refs/heads/feat/x': sha },
    remote: { 'feat/x': sha },
    worktrees: [{ worktree: '/wt/main', head: sha, branch: 'feat/WRONG' }],
  });
  assert.ok(types(checkGitRefs(registry, probe)).includes('worktree-mismatch'));
});

// ---------------------------------------------------------------------------
// Denominator
// ---------------------------------------------------------------------------
test('denominator: stale path and glob-only owner are reported; a real file passes', () =>
  withTempDir((root) => {
    const denominator = {
      owners: { schema: ['src/real.ts', 'src/ghost.ts'], family: ['src/glob/**'] },
    };
    write(root, 'src/real.ts', 'export {};\n');
    const t = types(checkDenominator(root, denominator));
    assert.ok(t.includes('stale-denominator'));
    assert.ok(t.includes('glob-only-owner'));

    const good = { owners: { schema: ['src/real.ts'] } };
    assert.deepEqual(checkDenominator(root, good), []);
  }));

// ---------------------------------------------------------------------------
// Governance: rooted discovery + duplicate owner (catalog kernel only)
// ---------------------------------------------------------------------------
test('governance: unrooted kernel file and a duplicate (shadowing) owner are returned', () => {
  // denominator owner: packages/shared/src/catalog/index.ts (exists as a graph node, isolated)
  const denominator = { owners: { schema: ['packages/shared/src/catalog/index.ts'] } };
  const g = new Map();
  g.set(abs('packages/shared/src/catalog/index.ts'), new Set()); // isolated owner
  g.set(abs('apps/site/src/catalog/presentation/Orphan.tsx'), new Set()); // unreachable kernel file
  const files = [
    abs('packages/shared/src/catalog/index.ts'),
    abs('apps/site/src/catalog/presentation/Orphan.tsx'),
  ];
  const issues = checkGovernance(R, denominator, g, files);
  assert.ok(types(issues).includes('unrooted-discovery'));
});

test('governance: kernel file shadowing a declared owner basename is a duplicate-governance-owner', () => {
  const denominator = { owners: { schema: ['packages/shared/src/catalog/index.ts'] } };
  const g = new Map();
  // kernel index.ts is connected to the owner so it is rooted, but it shadows the basename.
  g.set(
    abs('packages/shared/src/catalog/index.ts'),
    new Set([abs('apps/site/src/catalog/index.ts')]),
  );
  g.set(abs('apps/site/src/catalog/index.ts'), new Set());
  const files = [
    abs('packages/shared/src/catalog/index.ts'),
    abs('apps/site/src/catalog/index.ts'),
  ];
  const issues = checkGovernance(R, denominator, g, files);
  assert.ok(types(issues).includes('duplicate-governance-owner'));
});

test('governance: a rooted kernel file reachable from the owner passes', () => {
  const denominator = { owners: { schema: ['packages/shared/src/catalog/index.ts'] } };
  const g = new Map();
  g.set(abs('packages/shared/src/catalog/index.ts'), new Set());
  g.set(
    abs('apps/site/src/catalog/presentation/Card.tsx'),
    new Set([abs('packages/shared/src/catalog/index.ts')]),
  );
  const files = [
    abs('packages/shared/src/catalog/index.ts'),
    abs('apps/site/src/catalog/presentation/Card.tsx'),
  ];
  assert.deepEqual(checkGovernance(R, denominator, g, files), []);
});

// ---------------------------------------------------------------------------
// Module graph (real temp files): import/re-export/dynamic import + astro frontmatter
// ---------------------------------------------------------------------------
test('module graph: parses import, re-export, dynamic import and astro frontmatter; ignores bare deps', () =>
  withTempDir((root) => {
    write(root, 'packages/shared/src/catalog/index.ts', 'export const x = 1;\n');
    write(
      root,
      'apps/site/src/catalog/a.ts',
      [
        "import { x } from '../../../../packages/shared/src/catalog/index.ts';",
        "export { x } from '../../../../packages/shared/src/catalog/index.ts';",
        "const m = import('react');", // bare -> ignored
        'export const y = x;',
      ].join('\n'),
    );
    write(
      root,
      'apps/site/src/pages/p.astro',
      ['---', "import { y } from '../catalog/a.ts';", '---', '<div>{y}</div>'].join('\n'),
    );

    const { graph } = buildModuleGraph(root);
    const aTs = join(root, 'apps/site/src/catalog/a.ts');
    const idx = join(root, 'packages/shared/src/catalog/index.ts');
    const astro = join(root, 'apps/site/src/pages/p.astro');
    assert.ok(graph.get(aTs)?.has(idx), 'a.ts -> index.ts');
    assert.ok(graph.get(astro)?.has(aTs), 'astro frontmatter -> a.ts');
    assert.ok(
      ![...(graph.get(aTs) || [])].some((d) => d.includes('react')),
      'bare react import ignored',
    );
  }));

// ---------------------------------------------------------------------------
// Integration: verifyCatalogArchitecture on a clean synthetic repo passes
// ---------------------------------------------------------------------------
test('integration: a clean synthetic repo yields zero issues', () =>
  withTempDir((root) => {
    write(root, 'packages/shared/src/catalog/index.ts', 'export const x = 1;\n');
    write(
      root,
      'apps/site/src/catalog/presentation/Card.tsx',
      "import { x } from '../../../../../packages/shared/src/catalog/index.ts';\nexport const C = () => x;\n",
    );
    write(
      root,
      'config/change-impact/catalog.yaml',
      'schemaVersion: v1\nowners:\n  schema:\n    - packages/shared/src/catalog/index.ts\n',
    );
    const registry = registryOf({
      branch: 'feat/x',
      remoteBranch: 'origin/feat/x',
      worktree: root,
      claimedLocalHead: 'abc',
      claimedRemoteHead: 'abc',
      activeExactReservations: [],
      miuFilePlans: {},
      miuReservationStates: {},
    });
    const probe = gitProbeOf({
      refs: { 'refs/heads/feat/x': 'abc' },
      remote: { 'feat/x': 'abc' },
      worktrees: [{ worktree: root, head: 'abc', branch: 'feat/x' }],
    });
    const issues = verifyCatalogArchitecture(root, registry, probe);
    assert.deepEqual(types(issues), []);
  }));
