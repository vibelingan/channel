import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import {
  ISSUE_CODES,
  createGitProbe,
  verifyCatalogArchitecture,
} from './verify-catalog-architecture.mjs';

const repoRoot = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

function write(root, path, content) {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, 'utf8');
}

function baseTask(overrides = {}) {
  return {
    id: 'catalog-architecture-hardening',
    branch: 'refactor/catalog-architecture-hardening',
    remoteBranch: 'origin/refactor/catalog-architecture-hardening',
    worktree: '/repo',
    baseSha: 'base',
    claimedLocalHead: 'base',
    claimedRemoteHead: 'base',
    status: 'implementation-active',
    currentMiu: '01',
    activeExactReservations: [],
    miuFilePlans: {
      '01': ['scripts/verify-catalog-architecture.mjs'],
      '02': ['packages/shared/src/catalog/index.ts'],
    },
    miuTypes: { '01': 'new-file', '02': 'new-file' },
    miuDependencies: { '01': [], '02': ['01'] },
    miuReservationStates: {
      '01': { reservationState: 'active' },
      '02': { reservationState: 'planned' },
    },
    sequentialOwnership: {},
    consumerReferences: {},
    permanentCompatibilityOwner: { files: [], permanentReadOnlyReferences: [] },
    fullyMigratedRetirementFiles: [],
    ...overrides,
  };
}

function baseRegistry(task = baseTask()) {
  return {
    schemaVersion: 'catalog-task-registry-v4',
    reservationPolicy: { states: ['planned', 'blocked', 'active', 'released'] },
    tasks: [task],
  };
}

function baseConfig(overrides = {}) {
  return {
    schemaVersion: 'catalog-change-impact-v1',
    scanRoots: ['apps', 'packages', 'scripts'],
    layers: {
      domain: {
        include: ['packages/shared/src/catalog/**'],
        forbidPackages: ['react', 'astro:*'],
        forbidLayers: ['application', 'presentation', 'family', 'route'],
      },
      infrastructure: {
        include: ['apps/site/src/catalog/infrastructure/**'],
        forbidPackages: ['react'],
        forbidLayers: ['presentation', 'family', 'route'],
      },
      application: {
        include: ['apps/site/src/catalog/application/**'],
        forbidPackages: ['react', 'astro:*'],
        forbidLayers: ['family', 'route'],
      },
      presentation: {
        include: ['apps/site/src/catalog/presentation/**'],
        forbidLayers: ['family', 'route'],
      },
      family: {
        include: ['apps/site/src/catalog/families/**'],
        forbidPackages: ['react', 'astro:*'],
        forbidLayers: ['application', 'presentation', 'route'],
      },
      route: {
        include: ['apps/site/src/islands/shop/CatalogFamilyPage.tsx', 'apps/site/src/pages/**'],
        forbidLayers: [],
      },
    },
    additionalRequiredPaths: [],
    governanceOwners: [],
    ...overrides,
  };
}

function fakeGit(overrides = {}) {
  return {
    localSha: () => 'local',
    remoteSha: () => 'remote',
    isAncestor: (ancestor, descendant) =>
      ancestor === descendant ||
      (ancestor === 'base' && ['base', 'local', 'remote'].includes(descendant)),
    worktrees: () => [
      { path: '/repo', branch: 'refactor/catalog-architecture-hardening', head: 'local' },
    ],
    ...overrides,
  };
}

function fixture({ files = {}, task, registry, config, git } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'catalog-architecture-'));
  const actualTask = task ?? baseTask({ worktree: root });
  const actualRegistry = registry ?? baseRegistry(actualTask);
  const actualConfig = config ?? baseConfig();
  write(
    root,
    'docs/catalog-architecture-hardening/TASK_REGISTRY.json',
    `${JSON.stringify(actualRegistry, null, 2)}\n`,
  );
  if (!Object.hasOwn(files, 'docs/catalog-architecture-hardening/MIU_BREAKDOWN.md')) {
    const breakdown = Object.entries(actualTask.miuFilePlans)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([id, paths]) =>
          `## MIU ${Number(id)}: Synthetic ${id}\n\n- **Files:** ${paths
            .map((path) => `\`${path}\``)
            .join(', ')}\n`,
      )
      .join('\n');
    write(root, 'docs/catalog-architecture-hardening/MIU_BREAKDOWN.md', breakdown);
  }
  write(root, 'config/change-impact/catalog.yaml', `${JSON.stringify(actualConfig, null, 2)}\n`);
  for (const [path, content] of Object.entries(files)) write(root, path, content);
  const probe =
    git ?? fakeGit({ worktrees: () => [{ path: root, branch: actualTask.branch, head: 'local' }] });
  return {
    root,
    registry: actualRegistry,
    git: probe,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function codes(result) {
  return result.map((issue) => issue.code);
}

function verify(input) {
  return verifyCatalogArchitecture(input.root, input.registry, input.git);
}

function fixtureTest(name, setup, check) {
  test(name, () => {
    const input = fixture(setup());
    try {
      check(verify(input));
    } finally {
      input.cleanup();
    }
  });
}

fixtureTest(
  'rejects a domain import of React with the exact source and target',
  () => ({
    files: {
      'packages/shared/src/catalog/model.ts':
        "import React from 'react';\nexport const model = React;\n",
    },
  }),
  (issues) => {
    const issue = issues.find((item) => item.code === ISSUE_CODES.FORBIDDEN_EDGE);
    assert.equal(issue?.path, 'packages/shared/src/catalog/model.ts');
    assert.equal(issue?.relatedPath, 'react');
  },
);

fixtureTest(
  'rejects presentation importing a concrete family',
  () => ({
    files: {
      'apps/site/src/catalog/presentation/Card.tsx':
        "import { family } from '../families/headphones.ts';\nexport const card = family;\n",
      'apps/site/src/catalog/families/headphones.ts': 'export const family = {};\n',
    },
  }),
  (issues) => assert.ok(codes(issues).includes(ISSUE_CODES.FORBIDDEN_EDGE)),
);

fixtureTest(
  'rejects family adapters importing application state',
  () => ({
    files: {
      'apps/site/src/catalog/families/headphones.ts':
        "import { state } from '../application/state.ts';\nexport const family = state;\n",
      'apps/site/src/catalog/application/state.ts': 'export const state = {};\n',
    },
  }),
  (issues) => assert.ok(codes(issues).includes(ISSUE_CODES.FORBIDDEN_EDGE)),
);

fixtureTest(
  'allows a cycle contained within one layer',
  () => ({
    files: {
      'packages/shared/src/catalog/a.ts': "import { b } from './b.ts';\nexport const a = b;\n",
      'packages/shared/src/catalog/b.ts': "import { a } from './a.ts';\nexport const b = a;\n",
    },
  }),
  (issues) => assert.ok(!codes(issues).includes(ISSUE_CODES.MODULE_CYCLE)),
);

fixtureTest(
  'detects a cycle crossing catalog layers',
  () => ({
    files: {
      'packages/shared/src/catalog/a.ts':
        "import { b } from '../../../../apps/site/src/catalog/application/b.ts';\nexport const a = b;\n",
      'apps/site/src/catalog/application/b.ts':
        "import { a } from '../../../../../packages/shared/src/catalog/a.ts';\nexport const b = a;\n",
    },
  }),
  (issues) => assert.ok(codes(issues).includes(ISSUE_CODES.MODULE_CYCLE)),
);

fixtureTest(
  'parses imports from Astro script blocks',
  () => ({
    config: baseConfig({
      layers: {
        domain: {
          include: ['apps/site/src/pages/catalog.astro'],
          forbidPackages: [],
          forbidLayers: ['family'],
        },
        family: {
          include: ['apps/site/src/catalog/families/**'],
          forbidPackages: [],
          forbidLayers: [],
        },
      },
    }),
    files: {
      'apps/site/src/pages/catalog.astro':
        '<script>import { family } from "../catalog/families/headphones.ts";</script>',
      'apps/site/src/catalog/families/headphones.ts': 'export const family = {};\n',
    },
  }),
  (issues) => assert.ok(codes(issues).includes(ISSUE_CODES.FORBIDDEN_EDGE)),
);

fixtureTest(
  'parses TypeScript import-equals require syntax',
  () => ({
    files: {
      'packages/shared/src/catalog/model.ts':
        "import React = require('react');\nexport const model = React;\n",
    },
  }),
  (issues) => assert.ok(codes(issues).includes(ISSUE_CODES.FORBIDDEN_EDGE)),
);

fixtureTest(
  'parses dynamic imports with import attributes',
  () => ({
    files: {
      'apps/site/src/catalog/presentation/Card.tsx':
        "export const load = () => import('../families/headphones.ts', { with: { type: 'json' } });\n",
      'apps/site/src/catalog/families/headphones.ts': 'export const family = {};\n',
    },
  }),
  (issues) => assert.ok(codes(issues).includes(ISSUE_CODES.FORBIDDEN_EDGE)),
);

fixtureTest(
  'resolves workspace package aliases into the module graph',
  () => ({
    files: {
      'packages/shared/package.json': JSON.stringify({
        name: '@vibelingan-channel/shared',
        exports: { './catalog': './src/catalog/index.ts' },
      }),
      'packages/shared/src/catalog/index.ts':
        "import { state } from '@vibelingan-channel/site/catalog-application';\nexport const schema = state;\n",
      'apps/site/package.json': JSON.stringify({
        name: '@vibelingan-channel/site',
        exports: { './catalog-application': './src/catalog/application/state.ts' },
      }),
      'apps/site/src/catalog/application/state.ts': 'export const state = {};\n',
    },
  }),
  (issues) => assert.ok(codes(issues).includes(ISSUE_CODES.FORBIDDEN_EDGE)),
);

fixtureTest(
  'rejects an import to an unrooted catalog module',
  () => ({
    files: {
      'apps/site/src/catalog/application/state.ts': "import '../unknown/catalog-owner.ts';\n",
    },
  }),
  (issues) => assert.ok(codes(issues).includes(ISSUE_CODES.UNROOTED_IMPORT)),
);

fixtureTest(
  'rejects a relative import that escapes the repository root',
  () => ({
    files: { 'packages/shared/src/catalog/model.ts': "import '../../../../../../outside.ts';\n" },
  }),
  (issues) => assert.ok(codes(issues).includes(ISSUE_CODES.UNROOTED_IMPORT)),
);

fixtureTest(
  'rejects a glob-only MIU file plan',
  () => ({
    task: baseTask({
      miuFilePlans: { '01': ['scripts/**'] },
      miuTypes: { '01': 'new-file' },
      miuDependencies: { '01': [] },
      miuReservationStates: { '01': { reservationState: 'active' } },
    }),
  }),
  (issues) => assert.ok(codes(issues).includes(ISSUE_CODES.GLOB_ONLY_PLAN)),
);

fixtureTest(
  'rejects a dependency on an unknown MIU',
  () => ({ task: baseTask({ miuDependencies: { '01': ['99'], '02': ['01'] } }) }),
  (issues) => assert.ok(codes(issues).includes(ISSUE_CODES.MISSING_DEPENDENCY)),
);

fixtureTest(
  'rejects a registry whose MIU denominator shrinks below the documented headings',
  () => ({
    files: {
      'docs/catalog-architecture-hardening/MIU_BREAKDOWN.md':
        '## MIU 1: First\n- **Files:** `one.ts`\n\n## MIU 2: Second\n- **Files:** `two.ts`\n',
    },
    task: baseTask({
      miuFilePlans: { '01': ['one.ts'] },
      miuTypes: { '01': 'new-file' },
      miuDependencies: { '01': [] },
      miuReservationStates: { '01': { reservationState: 'active' } },
      activeExactReservations: ['one.ts'],
    }),
  }),
  (issues) => assert.ok(codes(issues).includes(ISSUE_CODES.REGISTRY_MIU_MISMATCH)),
);

fixtureTest(
  'rejects jointly shrinking both registry and MIU headings below the fixed 01-49 denominator',
  () => ({
    files: {
      'docs/catalog-architecture-hardening/MIU_BREAKDOWN.md':
        '## MIU 1: First\n- **Files:** `one.ts`\n',
      'one.ts': 'export {};\n',
    },
    task: baseTask({
      currentMiu: '01',
      activeExactReservations: ['one.ts'],
      miuFilePlans: { '01': ['one.ts'] },
      miuTypes: { '01': 'new-file' },
      miuDependencies: { '01': [] },
      miuReservationStates: { '01': { reservationState: 'active' } },
    }),
  }),
  (issues) => assert.ok(codes(issues).includes(ISSUE_CODES.REGISTRY_MIU_MISMATCH)),
);

fixtureTest(
  'rejects an unparsable empty MIU heading denominator',
  () => ({
    files: {
      'docs/catalog-architecture-hardening/MIU_BREAKDOWN.md': '# no valid MIU headings\n',
    },
  }),
  (issues) => assert.ok(codes(issues).includes(ISSUE_CODES.REGISTRY_MIU_MISMATCH)),
);

fixtureTest(
  'rejects registry files that differ from the documented MIU Files line',
  () => ({
    files: {
      'docs/catalog-architecture-hardening/MIU_BREAKDOWN.md':
        '## MIU 1: First\n- **Files:** `documented.ts`\n\n## MIU 2: Second\n- **Files:** `two.ts`\n',
      'wrong.ts': 'export {};\n',
    },
    task: baseTask({ activeExactReservations: ['wrong.ts'] }),
  }),
  (issues) => assert.ok(codes(issues).includes(ISSUE_CODES.REGISTRY_FILE_MISMATCH)),
);

fixtureTest(
  'rejects a cycle in the MIU dependency graph',
  () => ({ task: baseTask({ miuDependencies: { '01': ['02'], '02': ['01'] } }) }),
  (issues) => assert.ok(codes(issues).includes(ISSUE_CODES.MIU_CYCLE)),
);

fixtureTest(
  'rejects an active MIU whose dependency is not released',
  () => ({
    task: baseTask({
      currentMiu: '02',
      miuReservationStates: {
        '01': { reservationState: 'active' },
        '02': { reservationState: 'active' },
      },
    }),
  }),
  (issues) => assert.ok(codes(issues).includes(ISSUE_CODES.UNMET_ACTIVE_DEPENDENCY)),
);

fixtureTest(
  'rejects an illegal active to planned transition when previous state is recorded',
  () => ({
    task: baseTask({
      miuReservationStates: {
        '01': { reservationState: 'planned', previousReservationState: 'active' },
        '02': { reservationState: 'planned' },
      },
    }),
  }),
  (issues) => assert.ok(codes(issues).includes(ISSUE_CODES.ILLEGAL_STATE_TRANSITION)),
);

fixtureTest(
  'rejects an unmodeled repeated exact-file owner',
  () => ({ task: baseTask({ miuFilePlans: { '01': ['shared.ts'], '02': ['shared.ts'] } }) }),
  (issues) => assert.ok(codes(issues).includes(ISSUE_CODES.UNMODELED_REPEAT)),
);

fixtureTest(
  'allows a released-to-active sequential ownership transfer',
  () => ({
    task: baseTask({
      currentMiu: '02',
      miuFilePlans: { '01': ['shared.ts'], '02': ['shared.ts'] },
      miuReservationStates: {
        '01': { reservationState: 'released' },
        '02': { reservationState: 'active' },
      },
      sequentialOwnership: {
        'shared.ts': { chain: ['01', '02'], transition: 'released-before-next-active' },
      },
    }),
  }),
  (issues) =>
    assert.ok(
      !codes(issues).includes(ISSUE_CODES.UNMODELED_REPEAT) &&
        !codes(issues).includes(ISSUE_CODES.DUPLICATE_ACTIVE_OWNER),
    ),
);

fixtureTest(
  'allows MIU 01 and MIU 29 verifier ownership when both remain planned',
  () => ({
    task: baseTask({
      currentMiu: null,
      miuFilePlans: {
        '01': ['scripts/verify-catalog-architecture.mjs'],
        29: ['scripts/verify-catalog-architecture.mjs'],
      },
      miuTypes: { '01': 'new-file', 29: 'refactor' },
      miuDependencies: { '01': [], 29: ['01'] },
      miuReservationStates: {
        '01': { reservationState: 'planned' },
        29: { reservationState: 'planned' },
      },
      sequentialOwnership: {
        'scripts/verify-catalog-architecture.mjs': {
          chain: ['01', '29'],
          transition: 'released-before-next-active',
        },
      },
    }),
  }),
  (issues) => assert.ok(!codes(issues).includes(ISSUE_CODES.UNMODELED_REPEAT)),
);

fixtureTest(
  'rejects two active owners even when a sequential chain exists',
  () => ({
    task: baseTask({
      miuFilePlans: { '01': ['shared.ts'], '02': ['shared.ts'] },
      miuReservationStates: {
        '01': { reservationState: 'active' },
        '02': { reservationState: 'active' },
      },
      sequentialOwnership: {
        'shared.ts': { chain: ['01', '02'], transition: 'released-before-next-active' },
      },
    }),
  }),
  (issues) => assert.ok(codes(issues).includes(ISSUE_CODES.DUPLICATE_ACTIVE_OWNER)),
);

fixtureTest(
  'rejects multiple active MIUs even when they own disjoint files',
  () => ({
    task: baseTask({
      currentMiu: '01',
      activeExactReservations: [
        'scripts/verify-catalog-architecture.mjs',
        'packages/shared/src/catalog/index.ts',
      ],
      miuReservationStates: {
        '01': { reservationState: 'active' },
        '02': { reservationState: 'active' },
      },
    }),
    files: {
      'scripts/verify-catalog-architecture.mjs': 'export {};\n',
      'packages/shared/src/catalog/index.ts': 'export {};\n',
    },
  }),
  (issues) => assert.ok(codes(issues).includes(ISSUE_CODES.MULTIPLE_ACTIVE_MIUS)),
);

fixtureTest(
  'rejects currentMiu when it does not name the unique active MIU',
  () => ({ task: baseTask({ currentMiu: '02' }) }),
  (issues) => assert.ok(codes(issues).includes(ISSUE_CODES.CURRENT_MIU_MISMATCH)),
);

fixtureTest(
  'rejects a reversed sequential ownership chain',
  () => ({
    task: baseTask({
      miuFilePlans: { '01': ['shared.ts'], '02': ['shared.ts'] },
      sequentialOwnership: {
        'shared.ts': { chain: ['02', '01'], transition: 'released-before-next-active' },
      },
    }),
  }),
  (issues) => assert.ok(codes(issues).includes(ISSUE_CODES.INVALID_SEQUENTIAL_OWNERSHIP)),
);

fixtureTest(
  'rejects an unsupported sequential ownership transition',
  () => ({
    task: baseTask({
      miuFilePlans: { '01': ['shared.ts'], '02': ['shared.ts'] },
      sequentialOwnership: { 'shared.ts': { chain: ['01', '02'], transition: 'simultaneous' } },
    }),
  }),
  (issues) => assert.ok(codes(issues).includes(ISSUE_CODES.INVALID_SEQUENTIAL_OWNERSHIP)),
);

fixtureTest(
  'rejects an active sequential successor before its predecessor is released',
  () => ({
    task: baseTask({
      currentMiu: '02',
      activeExactReservations: ['shared.ts'],
      miuFilePlans: { '01': ['shared.ts'], '02': ['shared.ts'] },
      miuReservationStates: {
        '01': { reservationState: 'planned' },
        '02': { reservationState: 'active' },
      },
      sequentialOwnership: {
        'shared.ts': { chain: ['01', '02'], transition: 'released-before-next-active' },
      },
    }),
    files: { 'shared.ts': 'export {};\n' },
  }),
  (issues) => assert.ok(codes(issues).includes(ISSUE_CODES.INVALID_SEQUENTIAL_OWNERSHIP)),
);

fixtureTest(
  'rejects a later consumer becoming active before its declared owner is released',
  () => ({
    task: baseTask({
      currentMiu: '02',
      activeExactReservations: ['two.ts'],
      miuFilePlans: { '01': ['owned.ts'], '02': ['two.ts'] },
      miuReservationStates: {
        '01': { reservationState: 'planned' },
        '02': { reservationState: 'active' },
      },
      sequentialOwnership: {
        'owned.ts': { ownerMiu: '01', laterConsumers: ['02'] },
      },
    }),
    files: { 'two.ts': 'export {};\n' },
  }),
  (issues) => assert.ok(codes(issues).includes(ISSUE_CODES.INVALID_SEQUENTIAL_OWNERSHIP)),
);

fixtureTest(
  'canonicalizes equivalent file paths before ownership checks',
  () => ({ task: baseTask({ miuFilePlans: { '01': ['shared.ts'], '02': ['./shared.ts'] } }) }),
  (issues) => assert.ok(codes(issues).includes(ISSUE_CODES.UNMODELED_REPEAT)),
);

fixtureTest(
  'rejects activeExactReservations that differ from the active MIU file plan',
  () => ({ task: baseTask({ activeExactReservations: ['wrong.ts'] }) }),
  (issues) => assert.ok(codes(issues).includes(ISSUE_CODES.ACTIVE_RESERVATION_MISMATCH)),
);

fixtureTest(
  'rejects an active MIU whose implementation file is absent',
  () => ({}),
  (issues) => assert.ok(codes(issues).includes(ISSUE_CODES.MISSING_ACTIVE_FILE)),
);

fixtureTest(
  'accepts active exact reservations when every active implementation file exists',
  () => ({
    task: baseTask({ activeExactReservations: ['scripts/verify-catalog-architecture.mjs'] }),
    files: { 'scripts/verify-catalog-architecture.mjs': 'export const verifier = true;\n' },
  }),
  (issues) => {
    assert.ok(!codes(issues).includes(ISSUE_CODES.ACTIVE_RESERVATION_MISMATCH));
    assert.ok(!codes(issues).includes(ISSUE_CODES.MISSING_ACTIVE_FILE));
  },
);

fixtureTest(
  'accepts claimed activation anchors that remain ancestors of advancing heads',
  () => ({}),
  (issues) => assert.ok(!codes(issues).includes(ISSUE_CODES.STALE_SHA)),
);

fixtureTest(
  'accepts exact claimed heads and matching worktree HEAD',
  () => ({
    task: baseTask({ baseSha: 'base', claimedLocalHead: 'local', claimedRemoteHead: 'remote' }),
    git: fakeGit({
      worktrees: () => [
        { path: '/repo', branch: 'refactor/catalog-architecture-hardening', head: 'local' },
      ],
    }),
  }),
  (issues) =>
    assert.ok(
      !codes(issues).includes(ISSUE_CODES.STALE_SHA) &&
        !codes(issues).includes(ISSUE_CODES.WORKTREE_MISMATCH),
    ),
);

fixtureTest(
  'rejects a claimed local SHA detached from branch history',
  () => ({
    git: fakeGit({
      isAncestor: (ancestor, descendant) => !(ancestor === 'base' && descendant === 'local'),
    }),
  }),
  (issues) => assert.ok(codes(issues).includes(ISSUE_CODES.STALE_SHA)),
);

fixtureTest(
  'rejects a missing claimed worktree or wrong branch',
  () => ({ git: fakeGit({ worktrees: () => [] }) }),
  (issues) => assert.ok(codes(issues).includes(ISSUE_CODES.WORKTREE_MISMATCH)),
);

fixtureTest(
  'rejects a worktree whose observed HEAD differs from the branch head',
  () => ({
    task: baseTask({ claimedLocalHead: 'local', claimedRemoteHead: 'remote' }),
    git: fakeGit({
      worktrees: () => [
        { path: '/repo', branch: 'refactor/catalog-architecture-hardening', head: 'other' },
      ],
    }),
  }),
  (issues) => assert.ok(codes(issues).includes(ISSUE_CODES.WORKTREE_MISMATCH)),
);

fixtureTest(
  'rejects completed work whose local and remote heads differ',
  () => ({ task: baseTask({ status: 'implementation-complete', currentMiu: '01' }) }),
  (issues) => assert.ok(codes(issues).includes(ISSUE_CODES.LOCAL_ONLY_COMPLETION)),
);

fixtureTest(
  'rejects a released MIU whose local and remote heads differ regardless of free-text task status',
  () => ({
    task: baseTask({
      status: 'implementation-active',
      miuReservationStates: {
        '01': { reservationState: 'released' },
        '02': { reservationState: 'planned' },
      },
    }),
  }),
  (issues) => assert.ok(codes(issues).includes(ISSUE_CODES.LOCAL_ONLY_COMPLETION)),
);

fixtureTest(
  'accepts a released MIU when live local and remote heads are equal even if anchors are older',
  () => ({
    task: baseTask({
      status: 'implementation-review-complete',
      currentMiu: null,
      activeExactReservations: [],
      miuReservationStates: {
        '01': { reservationState: 'released' },
        '02': { reservationState: 'planned' },
      },
    }),
    git: fakeGit({
      localSha: () => 'same-head',
      remoteSha: () => 'same-head',
      isAncestor: (ancestor) => ancestor === 'base',
      worktrees: () => [
        {
          path: '/repo',
          branch: 'refactor/catalog-architecture-hardening',
          head: 'same-head',
        },
      ],
    }),
  }),
  (issues) => {
    assert.ok(!codes(issues).includes(ISSUE_CODES.STALE_SHA));
    assert.ok(!codes(issues).includes(ISSUE_CODES.LOCAL_ONLY_COMPLETION));
  },
);

fixtureTest(
  'rejects released lifecycle with residual activeExactReservations',
  () => ({
    task: baseTask({
      currentMiu: null,
      activeExactReservations: ['scripts/verify-catalog-architecture.mjs'],
      miuReservationStates: {
        '01': { reservationState: 'released' },
        '02': { reservationState: 'planned' },
      },
    }),
  }),
  (issues) => assert.ok(codes(issues).includes(ISSUE_CODES.ACTIVE_RESERVATION_MISMATCH)),
);

fixtureTest(
  'rejects a required denominator path missing from both disk and future MIU plans',
  () => ({
    config: baseConfig({ additionalRequiredPaths: ['apps/site/src/pages/missing.astro'] }),
  }),
  (issues) => assert.ok(codes(issues).includes(ISSUE_CODES.MISSING_CONSUMER)),
);

fixtureTest(
  'rejects a file path named by an MIU contract that is neither present nor planned',
  () => ({
    files: {
      'docs/catalog-architecture-hardening/MIU_BREAKDOWN.md':
        '## MIU 1: First\n- **Files:** `scripts/verify-catalog-architecture.mjs`\n- **What it does:** consumes `apps/missing/contract.ts`.\n\n## MIU 2: Second\n- **Files:** `packages/shared/src/catalog/index.ts`\n',
      'scripts/verify-catalog-architecture.mjs': 'export {};\n',
    },
    task: baseTask({ activeExactReservations: ['scripts/verify-catalog-architecture.mjs'] }),
  }),
  (issues) => assert.ok(codes(issues).includes(ISSUE_CODES.MISSING_CONSUMER)),
);

fixtureTest(
  'accepts a required future path declared by an unfinished MIU',
  () => ({
    config: baseConfig({ additionalRequiredPaths: ['packages/shared/src/catalog/index.ts'] }),
  }),
  (issues) => assert.ok(!codes(issues).includes(ISSUE_CODES.MISSING_CONSUMER)),
);

fixtureTest(
  'rejects duplicate governance roles',
  () => ({
    config: baseConfig({
      governanceOwners: [
        { role: 'pricing-resolver', path: 'a.ts', miu: '07' },
        { role: 'pricing-resolver', path: 'b.ts', miu: '08' },
      ],
    }),
  }),
  (issues) => assert.ok(codes(issues).includes(ISSUE_CODES.DUPLICATE_GOVERNANCE_OWNER)),
);

fixtureTest(
  'rejects deleting a canonical governance role from YAML',
  () => ({ config: baseConfig({ governanceOwners: [] }) }),
  (issues) => assert.ok(codes(issues).includes(ISSUE_CODES.CONFIG_DENOMINATOR_MISMATCH)),
);

fixtureTest(
  'rejects deleting scan roots or required catalog layers from YAML',
  () => ({ config: baseConfig({ scanRoots: [], layers: {} }) }),
  (issues) => assert.ok(codes(issues).includes(ISSUE_CODES.CONFIG_DENOMINATOR_MISMATCH)),
);

fixtureTest(
  'discovers a second governance owner from source instead of trusting YAML paths',
  () => ({
    config: baseConfig({
      governanceOwners: [
        {
          role: 'pricing-resolver',
          miu: '01',
          path: 'packages/shared/src/catalog/resolve-pricing.ts',
          discover: {
            roots: ['packages/shared/src/catalog'],
            declarationNames: ['resolveCatalogPricing'],
          },
        },
      ],
    }),
    files: {
      'packages/shared/src/catalog/resolve-pricing.ts':
        'export function resolveCatalogPricing() {}\n',
      'packages/shared/src/catalog/other.ts': 'export function resolveCatalogPricing() {}\n',
    },
  }),
  (issues) => assert.ok(codes(issues).includes(ISSUE_CODES.DUPLICATE_GOVERNANCE_OWNER)),
);

fixtureTest(
  'rejects a sole governance producer at a noncanonical path',
  () => ({
    config: baseConfig({
      governanceOwners: [
        {
          role: 'pricing-resolver',
          miu: '01',
          path: 'packages/shared/src/catalog/resolve-pricing.ts',
          discover: {
            roots: ['packages/shared/src/catalog'],
            declarationNames: ['resolveCatalogPricing'],
          },
        },
      ],
    }),
    files: {
      'packages/shared/src/catalog/rogue.ts': 'export function resolveCatalogPricing() {}\n',
    },
  }),
  (issues) => assert.ok(codes(issues).includes(ISSUE_CODES.GOVERNANCE_OWNER_MISMATCH)),
);

fixtureTest(
  'rejects D1-scoped MIUs leaving blocked without merged Select evidence',
  () => ({
    task: baseTask({
      currentMiu: null,
      externalGates: {
        D1: { scope: ['26', '27', '28'], taskLevelDependency: false },
        D2: { scope: ['46'], taskLevelDependency: false },
      },
      miuReservationStates: {
        '01': { reservationState: 'released' },
        '02': { reservationState: 'planned' },
        26: { reservationState: 'planned' },
        27: { reservationState: 'blocked' },
        28: { reservationState: 'blocked' },
      },
    }),
  }),
  (issues) => assert.ok(codes(issues).includes(ISSUE_CODES.UNSATISFIED_EXTERNAL_GATE)),
);

fixtureTest(
  'rejects MIU 46 activation without D2 approval evidence',
  () => ({
    task: baseTask({
      currentMiu: '46',
      activeExactReservations: ['deploy-evidence.md'],
      externalGates: {
        D1: { scope: ['26', '27', '28'], taskLevelDependency: false },
        D2: { scope: ['46'], taskLevelDependency: false },
      },
      miuFilePlans: { '01': ['one.ts'], '02': ['two.ts'], 46: ['deploy-evidence.md'] },
      miuTypes: { '01': 'new-file', '02': 'new-file', 46: 'modify-existing' },
      miuDependencies: { '01': [], '02': ['01'], 46: ['02'] },
      miuReservationStates: {
        '01': { reservationState: 'released', previousReservationState: 'active' },
        '02': { reservationState: 'released', previousReservationState: 'active' },
        46: { reservationState: 'active', previousReservationState: 'planned' },
      },
    }),
    files: { 'deploy-evidence.md': '# deploy\n' },
  }),
  (issues) => assert.ok(codes(issues).includes(ISSUE_CODES.UNSATISFIED_EXTERNAL_GATE)),
);

fixtureTest(
  'rejects a registry with missing D1 or D2 external gates',
  () => ({ task: baseTask({ externalGates: {} }) }),
  (issues) => assert.ok(codes(issues).includes(ISSUE_CODES.EXTERNAL_GATE_SHAPE)),
);

fixtureTest(
  'rejects removing permanent compatibility owners or underscore references',
  () => ({
    task: baseTask({ permanentCompatibilityOwner: { files: [], permanentReadOnlyReferences: [] } }),
  }),
  (issues) => assert.ok(codes(issues).includes(ISSUE_CODES.COMPATIBILITY_DENOMINATOR_MISMATCH)),
);

fixtureTest(
  'rejects released MIU without active-to-released transition evidence',
  () => ({
    task: baseTask({
      currentMiu: null,
      activeExactReservations: [],
      activeReservationPurpose: '',
      miuReservationStates: {
        '01': { reservationState: 'released' },
        '02': { reservationState: 'planned' },
      },
    }),
  }),
  (issues) => assert.ok(codes(issues).includes(ISSUE_CODES.ILLEGAL_STATE_TRANSITION)),
);

fixtureTest(
  'rejects stale activeReservationPurpose when no MIU is active',
  () => ({
    task: baseTask({
      currentMiu: null,
      activeExactReservations: [],
      activeReservationPurpose: 'stale MIU 01 claim',
      miuReservationStates: {
        '01': { reservationState: 'released', previousReservationState: 'active' },
        '02': { reservationState: 'planned' },
      },
    }),
  }),
  (issues) => assert.ok(codes(issues).includes(ISSUE_CODES.ACTIVE_RESERVATION_MISMATCH)),
);

fixtureTest(
  'rejects MIU 02 leaving planned at MIU 01 closure',
  () => ({
    task: baseTask({
      currentMiu: null,
      activeExactReservations: [],
      activeReservationPurpose: '',
      miuReservationStates: {
        '01': { reservationState: 'released', previousReservationState: 'active' },
        '02': { reservationState: 'blocked' },
      },
    }),
  }),
  (issues) => assert.ok(codes(issues).includes(ISSUE_CODES.NEXT_MIU_STATE_MISMATCH)),
);

fixtureTest(
  'allows MIU 02 activation after MIU 01 closure',
  () => ({
    task: baseTask({
      currentMiu: '02',
      activeExactReservations: ['packages/shared/src/catalog/index.ts'],
      activeReservationPurpose: 'MIU 02 public catalog contract',
      miuReservationStates: {
        '01': { reservationState: 'released', previousReservationState: 'active' },
        '02': { reservationState: 'active', previousReservationState: 'planned' },
      },
    }),
    files: { 'packages/shared/src/catalog/index.ts': 'export {};\n' },
  }),
  (issues) => assert.ok(!codes(issues).includes(ISSUE_CODES.NEXT_MIU_STATE_MISMATCH)),
);

fixtureTest(
  'discovers a second Catalog knowledge authority from Markdown paths',
  () => ({
    config: baseConfig({
      governanceOwners: [
        {
          role: 'catalog-knowledge-authority',
          miu: '01',
          path: 'docs/ENGINEERING_CRAFT.md',
          discover: {
            roots: ['docs'],
            filePatterns: ['docs/ENGINEERING_CRAFT.md', 'docs/knowledge/catalog/**'],
          },
        },
      ],
    }),
    files: {
      'docs/ENGINEERING_CRAFT.md': '# Existing authority\n',
      'docs/knowledge/catalog/rules.md': '# Duplicate authority\n',
    },
  }),
  (issues) => assert.ok(codes(issues).includes(ISSUE_CODES.DUPLICATE_GOVERNANCE_OWNER)),
);

fixtureTest(
  'discovers an unmodeled consumer importing a governed owner',
  () => ({
    config: baseConfig({
      governanceOwners: [
        {
          role: 'pricing-resolver',
          miu: '01',
          path: 'packages/shared/src/catalog/resolve-pricing.ts',
          discover: {
            roots: ['packages/shared/src/catalog'],
            declarationNames: ['resolveCatalogPricing'],
          },
        },
      ],
    }),
    task: baseTask({
      activeExactReservations: ['packages/shared/src/catalog/resolve-pricing.ts'],
      miuFilePlans: {
        '01': ['packages/shared/src/catalog/resolve-pricing.ts'],
        '02': ['modeled.ts'],
      },
    }),
    files: {
      'packages/shared/src/catalog/resolve-pricing.ts':
        'export function resolveCatalogPricing() {}\n',
      'apps/unmodeled.ts':
        "import { resolveCatalogPricing } from '../packages/shared/src/catalog/resolve-pricing.ts';\nresolveCatalogPricing();\n",
    },
  }),
  (issues) => assert.ok(codes(issues).includes(ISSUE_CODES.UNMODELED_CONSUMER)),
);

test('real catalog denominator has exactly one governance owner per role', () => {
  const config = parse(readFileSync(join(repoRoot, 'config/change-impact/catalog.yaml'), 'utf8'));
  const roles = config.governanceOwners.map((owner) => owner.role);
  assert.equal(new Set(roles).size, roles.length);
});

test('real architecture registry passes the foundational verifier', () => {
  const registry = JSON.parse(
    readFileSync(join(repoRoot, 'docs/catalog-architecture-hardening/TASK_REGISTRY.json'), 'utf8'),
  );
  const issues = verifyCatalogArchitecture(repoRoot, registry, createGitProbe(repoRoot));
  assert.deepEqual(issues, []);
});

test('issue codes are stable and unique', () => {
  const values = Object.values(ISSUE_CODES);
  assert.equal(new Set(values).size, values.length);
  assert.ok(values.length >= 15);
});

test('git remote probing applies a bounded timeout', () => {
  const calls = [];
  const probe = createGitProbe('/repo', {
    timeoutMs: 10_000,
    exec(command, args, options) {
      calls.push({ command, args, options });
      return '';
    },
  });
  probe.remoteSha('origin/refactor/catalog-architecture-hardening');
  assert.equal(calls[0].options.timeout, 10_000);
});
