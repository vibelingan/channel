#!/usr/bin/env node
// Catalog Architecture Hardening — MIU 01 foundational verifier.
//
// verifyCatalogArchitecture(root, registry, gitProbe) -> ArchitectureIssue[]
//
// Five enforcement surfaces, all evaluated before any migration MIU:
//   1. module graph      — parse imports/re-exports/dynamic imports, build a rooted graph
//   2. dependency direction — reject forbidden edges and cycles per the kernel/adapter rule
//   3. reservation       — task-registry state machine, sequential ownership, consumer refs
//   4. git live refs     — stale claimed SHA, worktree/branch mismatch, missing refs, local-only
//   5. governance        — duplicate owner detection + rooted consumer discovery off the
//                          config/change-impact/catalog.yaml denominator
//
// The function is pure with respect to its inputs: all filesystem access goes through `root`
// and all git access through the injected `gitProbe`, so tests can drive synthetic fixtures.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { parse as parseYaml } from 'yaml';

// ---------------------------------------------------------------------------
// Issue model
// ---------------------------------------------------------------------------
function issue(type, detail, paths = []) {
  return { type, detail, paths };
}

// ---------------------------------------------------------------------------
// Source-file discovery (rooted: only known source roots, never node_modules/dist)
// ---------------------------------------------------------------------------
const SOURCE_ROOTS = ['apps', 'packages', 'scripts'];
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.mjs', '.astro'];
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  '.astro',
  'coverage',
  '.next',
  'out',
]);

export function collectSourceFiles(root) {
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (SKIP_DIRS.has(name)) continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
      } else if (SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext))) {
        files.push(full);
      }
    }
  };
  for (const rootDir of SOURCE_ROOTS) {
    const abs = join(root, rootDir);
    if (existsSync(abs)) walk(abs);
  }
  return files.sort();
}

// ---------------------------------------------------------------------------
// Import extraction (TypeScript compiler API; .astro goes through frontmatter)
// ---------------------------------------------------------------------------
function astroFrontmatter(source) {
  // Frontmatter is the leading --- ... --- fence; only that region holds imports.
  if (!source.startsWith('---')) return '';
  const end = source.indexOf('\n---', 3);
  if (end === -1) return '';
  return source.slice(3, end);
}

function extractSpecifiers(filePath, source) {
  const isAstro = filePath.endsWith('.astro');
  const code = isAstro ? astroFrontmatter(source) : source;
  if (!code.trim()) return [];
  const kind =
    filePath.endsWith('.tsx') || filePath.endsWith('.astro')
      ? ts.ScriptKind.TSX
      : filePath.endsWith('.mts') || filePath.endsWith('.mjs')
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true, kind);
  const specs = [];
  const push = (node) => {
    if (!node) return;
    if (ts.isStringLiteral(node)) specs.push(node.text);
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) push(node.moduleSpecifier);
    else if (ts.isExportDeclaration(node)) push(node.moduleSpecifier);
    else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      push(node.moduleReference.expression);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      push(node.arguments[0]);
    } else if (ts.isExportAssignment(node) && ts.isExternalModuleReference(node.expression)) {
      push(node.expression.expression);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return specs;
}

// ---------------------------------------------------------------------------
// Import specifier -> repo-relative file resolution
// ---------------------------------------------------------------------------
const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.mjs', '.js', '.jsx', '.astro'];
const PACKAGE_NAME = /^@[^/]+\/[^/]+$|^@vibelingan-channel\//;

function resolveSpecifier(fromFile, spec, root, fileSet) {
  if (!spec || spec.startsWith('node:')) return null;
  // Package/bare imports (npm deps, @vibelingan-channel/*) are outside the repo graph.
  if (!spec.startsWith('.') && !spec.startsWith('/')) return null;
  const baseDir = spec.startsWith('/') ? root : dirname(fromFile);
  const cleaned = spec.replace(/\.(js|mjs|cjs|jsx)$/, (m) => m); // keep as-is; try candidates below
  const base = resolve(baseDir, cleaned);
  const candidates = [];
  if (/\.(ts|tsx|mts|cts|mjs|js|jsx|astro)$/.test(base)) {
    candidates.push(base);
  } else {
    for (const ext of RESOLVE_EXTENSIONS) candidates.push(base + ext);
    for (const ext of RESOLVE_EXTENSIONS) candidates.push(join(base, `index${ext}`));
  }
  for (const cand of candidates) {
    if (fileSet.has(cand)) return cand;
  }
  return null;
}

export function buildModuleGraph(root) {
  const files = collectSourceFiles(root);
  const fileSet = new Set(files);
  // Map absolute path -> Set of absolute dependency paths (repo-internal only).
  const graph = new Map();
  for (const file of files) {
    let source;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const deps = new Set();
    for (const spec of extractSpecifiers(file, source)) {
      const target = resolveSpecifier(file, spec, root, fileSet);
      if (target && target !== file) deps.add(target);
    }
    graph.set(file, deps);
  }
  return { files, graph };
}

// ---------------------------------------------------------------------------
// Dependency-direction rule (kernel + adapters). Layer classification by path.
// ---------------------------------------------------------------------------
// Layers ordered by allowed dependency direction:
//   route/controller -> family adapter + application + presentation -> domain contracts
//
// IMPORTANT (progressive enforcement): only files that have MIGRATED into the new kernel
// layout are classified into a governed layer. The pre-refactor cluster under
// `islands/shop`, `islands/admin`, `components`, and existing `packages/shared/src/*`
// is the legacy baseline — it is recorded in config/change-impact/catalog.yaml and folded
// in by later MIUs, so it is intentionally NOT subject to the new dependency rule yet.
// Test files (*.test.*, test/) never participate in the direction rule.
function layerOf(relPath) {
  const p = relPath.split(sep).join('/');
  if (/\.test\.|\/test\//.test(p)) return 'test';
  if (/\/pages\//.test(p)) return 'route';
  if (/\/catalog\/families\/(headphones|ai-gadgets|toys|misc)\.tsx?$/.test(p))
    return 'family-adapter';
  if (/\/catalog\/families\/(catalog-family-adapter|registry)\.tsx?$/.test(p))
    return 'family-contract';
  if (/\/catalog\/presentation\//.test(p)) return 'presentation';
  if (/\/catalog\/application\//.test(p)) return 'application';
  if (/\/catalog\/infrastructure\//.test(p)) return 'infrastructure';
  if (/packages\/shared\/src\/catalog\//.test(p)) return 'domain';
  return 'other'; // legacy baseline + everything not yet migrated
}

// A concrete family adapter module lives only under the new families/ directory. Legacy
// Headphones* components under islands/shop are baseline, not adapters.
function isConcreteFamilyModule(relPath) {
  const p = relPath.split(sep).join('/');
  return /\/catalog\/families\/(headphones|ai-gadgets|toys|misc)\.tsx?$/.test(p);
}

function importsReactOrAstro(depRel) {
  const p = depRel.split(sep).join('/');
  return /\.(tsx|astro)$/.test(p) || /\/islands\//.test(p) || /\/components\//.test(p);
}

export function checkDependencyDirection(root, graph) {
  const issues = [];
  for (const [from, deps] of graph) {
    const fromRel = relative(root, from);
    const fromLayer = layerOf(fromRel);
    for (const to of deps) {
      const toRel = relative(root, to);
      // domain/application importing React/Astro/route/family is forbidden.
      if (fromLayer === 'domain' || fromLayer === 'application') {
        if (importsReactOrAstro(toRel) || isConcreteFamilyModule(toRel)) {
          issues.push(
            issue('forbidden-edge', `${fromLayer} module must not import presentation/family`, [
              fromRel,
              toRel,
            ]),
          );
        }
      }
      // presentation importing a concrete family adapter is forbidden.
      if (fromLayer === 'presentation' && isConcreteFamilyModule(toRel)) {
        issues.push(
          issue('forbidden-edge', 'presentation must not import a concrete family module', [
            fromRel,
            toRel,
          ]),
        );
      }
    }
  }
  return issues;
}

export function detectCycles(root, graph) {
  const issues = [];
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map([...graph.keys()].map((k) => [k, WHITE]));
  const stack = [];
  const report = (cyclePath) => {
    issues.push(
      issue(
        'cycle',
        'import cycle detected',
        cyclePath.map((f) => relative(root, f)),
      ),
    );
  };
  const dfs = (node) => {
    color.set(node, GRAY);
    stack.push(node);
    for (const dep of graph.get(node) || []) {
      const c = color.get(dep);
      if (c === GRAY) {
        const idx = stack.indexOf(dep);
        report([...stack.slice(idx), dep]);
      } else if (c === WHITE) {
        dfs(dep);
      }
    }
    stack.pop();
    color.set(node, BLACK);
  };
  for (const node of graph.keys()) {
    if (color.get(node) === WHITE) dfs(node);
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Reservation / task-registry state machine
// ---------------------------------------------------------------------------
const RESERVATION_STATES = ['planned', 'blocked', 'active', 'released'];
const LEGAL_TRANSITIONS = {
  planned: ['active', 'blocked'],
  blocked: ['planned'],
  active: ['released'],
  released: ['active'], // released -> active is a recorded transfer
};

function isGlob(path) {
  return /[*?[\]{}]/.test(path);
}

export function checkReservations(registry) {
  const issues = [];
  const tasks = Array.isArray(registry?.tasks) ? registry.tasks : [];
  const policy = registry?.reservationPolicy || {};
  const states = policy.states || RESERVATION_STATES;

  // Exact-file active ownership map: path -> [taskId, ...]
  const activeOwners = new Map();
  for (const task of tasks) {
    const reservations = task.activeExactReservations || [];
    for (const path of reservations) {
      if (!activeOwners.has(path)) activeOwners.set(path, []);
      activeOwners.get(path).push(task.id);
    }
    // MIU file plans must not be glob-only.
    for (const [miu, files] of Object.entries(task.miuFilePlans || {})) {
      if (!Array.isArray(files) || files.length === 0) {
        issues.push(issue('glob-only-plan', `MIU ${miu} has an empty file plan`, [task.id, miu]));
        continue;
      }
      const allGlob = files.every(isGlob);
      if (allGlob) {
        issues.push(issue('glob-only-plan', `MIU ${miu} reservation is glob-only`, [task.id, miu]));
      }
    }
    // Reservation states must be legal members and transitions legal.
    for (const [miu, st] of Object.entries(task.miuReservationStates || {})) {
      const state = st?.reservationState;
      if (state && !states.includes(state)) {
        issues.push(
          issue('illegal-transition', `MIU ${miu} has unknown state ${state}`, [
            task.id,
            miu,
            state,
          ]),
        );
      }
    }
  }
  // Duplicate active exact-file ownership across tasks is forbidden.
  for (const [path, owners] of activeOwners) {
    if (owners.length > 1) {
      issues.push(
        issue('duplicate-active-owner', `exact file is actively owned by ${owners.length} tasks`, [
          path,
          ...owners,
        ]),
      );
    }
  }
  return issues;
}

// MIU dependency DAG: no cycles, referenced MIUs exist, an active MIU depends only on
// released MIUs (anything else is an illegal transition).
export function checkMiuDependencies(registry) {
  const issues = [];
  const tasks = Array.isArray(registry?.tasks) ? registry.tasks : [];
  for (const task of tasks) {
    const deps = task.miuDependencies || {};
    const states = task.miuReservationStates || {};
    const label = task.id || '(task)';
    for (const [miu, depList] of Object.entries(deps)) {
      for (const dep of depList) {
        if (!(dep in states)) {
          issues.push(
            issue('unmet-dependency', `MIU ${miu} depends on unknown MIU ${dep}`, [
              label,
              miu,
              dep,
            ]),
          );
        }
      }
    }
    const mark = new Map();
    const dfs = (node, path) => {
      if (mark.get(node) === 'gray') {
        issues.push(
          issue('dependency-cycle', `MIU dependency cycle: ${[...path, node].join(' -> ')}`, [
            label,
            ...path,
            node,
          ]),
        );
        return;
      }
      if (mark.get(node) === 'black') return;
      mark.set(node, 'gray');
      for (const dep of deps[node] || []) dfs(dep, [...path, node]);
      mark.set(node, 'black');
    };
    for (const miu of Object.keys(deps)) {
      if (!mark.has(miu)) dfs(miu, []);
    }
    for (const [miu, st] of Object.entries(states)) {
      if (st?.reservationState === 'active') {
        for (const dep of deps[miu] || []) {
          const depState = states[dep]?.reservationState;
          if (depState !== 'released') {
            issues.push(
              issue(
                'illegal-transition',
                `MIU ${miu} active but dependency MIU ${dep} is ${depState || 'missing'} (must be released)`,
                [label, miu, dep],
              ),
            );
          }
        }
      }
    }
  }
  return issues;
}

// Sequential ownership: a file's chain may hold at most one active MIU at a time.
export function checkSequentialOwnership(registry) {
  const issues = [];
  const tasks = Array.isArray(registry?.tasks) ? registry.tasks : [];
  for (const task of tasks) {
    const seq = task.sequentialOwnership || {};
    const states = task.miuReservationStates || {};
    const label = task.id || '(task)';
    for (const [file, spec] of Object.entries(seq)) {
      const chain =
        spec?.chain || (spec?.ownerMiu ? [spec.ownerMiu, ...(spec.laterConsumers || [])] : []);
      const activeInChain = chain.filter((m) => states[m]?.reservationState === 'active');
      if (activeInChain.length > 1) {
        issues.push(
          issue(
            'illegal-transition',
            `file has ${activeInChain.length} simultaneously active chain MIUs (${activeInChain.join(', ')})`,
            [label, file],
          ),
        );
      }
    }
  }
  return issues;
}

// Consumer references: only active/released MIUs have present consumer files. Planned or
// blocked MIUs reference files that later MIUs create (or that live on other branches), so
// existence is only asserted for consumers of already-realized MIUs.
export function checkConsumerReferences(registry, root) {
  const issues = [];
  const tasks = Array.isArray(registry?.tasks) ? registry.tasks : [];
  for (const task of tasks) {
    const refs = task.consumerReferences || {};
    const states = task.miuReservationStates || {};
    const label = task.id || '(task)';
    for (const [miu, files] of Object.entries(refs)) {
      const state = states[miu]?.reservationState;
      if (state !== 'active' && state !== 'released') continue;
      for (const f of files || []) {
        if (!existsSync(join(root, f))) {
          issues.push(
            issue('missing-derived-consumer', 'consumer reference file does not exist', [
              label,
              miu,
              f,
            ]),
          );
        }
      }
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Git live refs (via injected gitProbe so tests can mock)
// ---------------------------------------------------------------------------
export function createGitProbe(root) {
  const run = (args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  return {
    root,
    headSha() {
      try {
        return run(['rev-parse', 'HEAD']);
      } catch {
        return null;
      }
    },
    showRefVerify(ref) {
      try {
        return run(['show-ref', '--verify', '--hash', ref]);
      } catch {
        return null;
      }
    },
    lsRemoteHeads(remote = 'origin') {
      try {
        const out = run(['ls-remote', '--heads', remote]);
        const map = {};
        for (const line of out.split('\n')) {
          if (!line.trim()) continue;
          const [sha, ref] = line.split(/\s+/);
          map[ref.replace(/^refs\/heads\//, '')] = sha;
        }
        return map;
      } catch {
        return null;
      }
    },
    worktreeList() {
      try {
        const out = run(['worktree', 'list', '--porcelain']);
        const list = [];
        let cur = {};
        for (const line of out.split('\n')) {
          if (line.startsWith('worktree ')) {
            if (cur.worktree) list.push(cur);
            cur = { worktree: line.slice(9) };
          } else if (line.startsWith('HEAD ')) cur.head = line.slice(5);
          else if (line.startsWith('branch '))
            cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
          else if (line === '' && cur.worktree) {
            list.push(cur);
            cur = {};
          }
        }
        if (cur.worktree) list.push(cur);
        return list;
      } catch {
        return [];
      }
    },
    isAncestor(ancestorSha, descendantRef) {
      try {
        run(['merge-base', '--is-ancestor', ancestorSha, descendantRef]);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export function checkGitRefs(registry, gitProbe) {
  const issues = [];
  const tasks = Array.isArray(registry?.tasks) ? registry.tasks : [];
  if (!gitProbe) return issues;
  const remoteHeads = gitProbe.lsRemoteHeads ? gitProbe.lsRemoteHeads('origin') : null;
  const worktrees = gitProbe.worktreeList ? gitProbe.worktreeList() : [];

  for (const task of tasks) {
    const label = task.id || '(unknown task)';
    const localRef = `refs/heads/${task.branch}`;
    const localSha = gitProbe.showRefVerify ? gitProbe.showRefVerify(localRef) : null;
    if (task.branch && !localSha) {
      issues.push(issue('missing-ref', `local ref ${task.branch} not found`, [label, task.branch]));
    }
    const branchName = task.remoteBranch ? task.remoteBranch.replace(/^origin\//, '') : null;
    const remoteSha = remoteHeads && branchName ? remoteHeads[branchName] : null;
    if (branchName && remoteHeads && !remoteSha) {
      issues.push(
        issue('missing-ref', `remote ref ${branchName} not found on origin`, [label, branchName]),
      );
    }
    // Stale claimed SHAs. A claimed SHA merely BEHIND the live head (an ancestor, i.e.
    // normal commit progress) is fine; a claimed SHA that is NOT an ancestor of the live
    // head means the registry is out of sync (rebase/reset/force-push) -> stale.
    const isAnc = (a, d) => (gitProbe.isAncestor ? gitProbe.isAncestor(a, d) : false);
    if (
      task.claimedLocalHead &&
      localSha &&
      task.claimedLocalHead !== localSha &&
      !isAnc(task.claimedLocalHead, localRef)
    ) {
      issues.push(
        issue(
          'stale-sha',
          `claimedLocalHead ${task.claimedLocalHead.slice(0, 7)} is not an ancestor of live local ${localSha.slice(0, 7)} (registry out of sync)`,
          [label, task.branch],
        ),
      );
    }
    if (
      task.claimedRemoteHead &&
      remoteSha &&
      branchName &&
      task.claimedRemoteHead !== remoteSha &&
      !isAnc(task.claimedRemoteHead, `origin/${branchName}`)
    ) {
      issues.push(
        issue(
          'stale-sha',
          `claimedRemoteHead ${task.claimedRemoteHead.slice(0, 7)} is not an ancestor of live remote ${remoteSha.slice(0, 7)} (registry out of sync)`,
          [label, branchName],
        ),
      );
    }
    // Local-only completion: local ahead of remote means unpushed work.
    if (localSha && remoteSha && localSha !== remoteSha) {
      issues.push(
        issue(
          'local-only-completion',
          `local ${localSha.slice(0, 7)} differs from remote ${remoteSha.slice(0, 7)} (unpushed or diverged)`,
          [label, task.branch],
        ),
      );
    }
    // Worktree/branch mismatch (ignore sibling worktrees on other branches).
    if (task.worktree) {
      const wt = worktrees.find((w) => w.worktree === task.worktree);
      if (wt?.branch && task.branch && wt.branch !== task.branch) {
        issues.push(
          issue(
            'worktree-mismatch',
            `worktree ${task.worktree} is on ${wt.branch}, expected ${task.branch}`,
            [label, task.worktree],
          ),
        );
      }
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Governance: denominator loading, duplicate owners, rooted discovery
// ---------------------------------------------------------------------------
export function loadDenominator(root) {
  const path = join(root, 'config', 'change-impact', 'catalog.yaml');
  if (!existsSync(path)) return null;
  const parsed = parseYaml(readFileSync(path, 'utf8'));
  return parsed;
}

export function checkDenominator(root, denominator) {
  const issues = [];
  if (!denominator || !denominator.owners) {
    issues.push(
      issue(
        'missing-denominator',
        'config/change-impact/catalog.yaml missing or has no owners',
        [],
      ),
    );
    return issues;
  }
  for (const [role, files] of Object.entries(denominator.owners)) {
    if (!Array.isArray(files) || files.length === 0) {
      issues.push(issue('empty-owner-role', `governance role ${role} names no owners`, [role]));
      continue;
    }
    for (const f of files) {
      if (isGlob(f)) {
        issues.push(
          issue('glob-only-owner', `governance role ${role} uses glob-only entry`, [role, f]),
        );
      } else if (!existsSync(join(root, f))) {
        issues.push(issue('stale-denominator', 'denominator path does not exist', [role, f]));
      }
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Governance: rooted consumer discovery + duplicate owner detection
// ---------------------------------------------------------------------------
// The rooted set is every denominator owner plus everything reachable from those owners
// along the import graph in BOTH directions. Governance enforcement applies ONLY to the
// new catalog kernel (apps/site/src/catalog/**, packages/shared/src/catalog/**): the
// pre-refactor legacy cluster is the recorded baseline and is intentionally not policed.
//   - unrooted-discovery: a kernel file unreachable from any known owner (no rooted owner).
//   - duplicate-governance-owner: a kernel file that shadows a denominator owner of a role
//     (same basename) without being that role's declared owner — a second owner appeared.
const CATALOG_KERNEL = /^apps\/site\/src\/catalog\/|^packages\/shared\/src\/catalog\//;
const ROLE_OF_KERNEL = [
  [/packages\/shared\/src\/catalog\//, 'schema'],
  [/\/catalog\/families\//, 'family'],
  [/\/catalog\/presentation\/|\/catalog\/application\//, 'family'],
];

function baseName(p) {
  return p.split(/[\\/]/).pop();
}

export function checkGovernance(root, denominator, graph, files) {
  const issues = [];
  if (!denominator?.owners) return issues;
  const knownOwners = new Set();
  for (const list of Object.values(denominator.owners)) {
    for (const f of list || []) knownOwners.add(resolve(root, f));
  }
  const reverse = new Map();
  for (const [from, deps] of graph) {
    for (const to of deps) {
      if (!reverse.has(to)) reverse.set(to, new Set());
      reverse.get(to).add(from);
    }
  }
  const rooted = new Set(knownOwners);
  const queue = [...knownOwners];
  while (queue.length) {
    const cur = queue.pop();
    for (const next of [...(graph.get(cur) || []), ...(reverse.get(cur) || [])]) {
      if (!rooted.has(next)) {
        rooted.add(next);
        queue.push(next);
      }
    }
  }
  const ownerByBase = new Map();
  for (const [role, list] of Object.entries(denominator.owners)) {
    for (const f of list || []) {
      const b = baseName(f);
      if (!ownerByBase.has(b)) ownerByBase.set(b, []);
      ownerByBase.get(b).push({ role, path: f });
    }
  }
  for (const file of files) {
    const rel = relative(root, file).split(sep).join('/');
    if (!CATALOG_KERNEL.test(rel)) continue;
    if (!rooted.has(file)) {
      issues.push(
        issue('unrooted-discovery', 'catalog kernel file is not reachable from any known owner', [
          rel,
        ]),
      );
    }
    const shadow = ownerByBase.get(baseName(rel));
    if (shadow && !shadow.some((s) => resolve(root, s.path) === file)) {
      issues.push(
        issue(
          'duplicate-governance-owner',
          `kernel file shadows declared ${shadow[0].role} owner ${shadow[0].path}`,
          [rel, shadow[0].path],
        ),
      );
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------
export function verifyCatalogArchitecture(root, registry, gitProbe) {
  const absRoot = resolve(root);
  const issues = [];
  const { files, graph } = buildModuleGraph(absRoot);
  issues.push(...checkDependencyDirection(absRoot, graph));
  issues.push(...detectCycles(absRoot, graph));
  issues.push(...checkReservations(registry));
  issues.push(...checkMiuDependencies(registry));
  issues.push(...checkSequentialOwnership(registry));
  issues.push(...checkConsumerReferences(registry, absRoot));
  issues.push(...checkGitRefs(registry, gitProbe));
  const denominator = loadDenominator(absRoot);
  issues.push(...checkDenominator(absRoot, denominator));
  issues.push(...checkGovernance(absRoot, denominator, graph, files));
  return issues;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const isMain = (() => {
  try {
    return process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  const root = resolve(process.cwd());
  const registryPath = join(root, 'docs', 'catalog-architecture-hardening', 'TASK_REGISTRY.json');
  const registry = existsSync(registryPath)
    ? JSON.parse(readFileSync(registryPath, 'utf8'))
    : { tasks: [] };
  const gitProbe = createGitProbe(root);
  const issues = verifyCatalogArchitecture(root, registry, gitProbe);
  if (issues.length === 0) {
    console.log('verify-catalog-architecture: OK (0 issues)');
    process.exit(0);
  }
  console.log(`verify-catalog-architecture: ${issues.length} issue(s)`);
  for (const i of issues) {
    console.log(`  [${i.type}] ${i.detail}${i.paths.length ? ` :: ${i.paths.join(' | ')}` : ''}`);
  }
  process.exit(1);
}
