#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import {
  dirname,
  extname,
  isAbsolute,
  join,
  matchesGlob,
  normalize,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { parse } from 'yaml';

export const ISSUE_CODES = Object.freeze({
  FORBIDDEN_EDGE: 'forbidden-edge',
  MODULE_CYCLE: 'module-cycle',
  UNROOTED_IMPORT: 'unrooted-import',
  GLOB_ONLY_PLAN: 'glob-only-plan',
  MISSING_DEPENDENCY: 'missing-dependency',
  MIU_CYCLE: 'miu-cycle',
  UNMET_ACTIVE_DEPENDENCY: 'unmet-active-dependency',
  ILLEGAL_STATE_TRANSITION: 'illegal-state-transition',
  UNMODELED_REPEAT: 'unmodeled-repeat',
  DUPLICATE_ACTIVE_OWNER: 'duplicate-active-owner',
  STALE_SHA: 'stale-sha',
  WORKTREE_MISMATCH: 'worktree-mismatch',
  LOCAL_ONLY_COMPLETION: 'local-only-completion',
  MISSING_CONSUMER: 'missing-consumer',
  DUPLICATE_GOVERNANCE_OWNER: 'duplicate-governance-owner',
  REGISTRY_SHAPE: 'registry-shape',
  MISSING_ACTIVE_FILE: 'missing-active-file',
  ACTIVE_RESERVATION_MISMATCH: 'active-reservation-mismatch',
  REGISTRY_MIU_MISMATCH: 'registry-miu-mismatch',
  REGISTRY_FILE_MISMATCH: 'registry-file-mismatch',
  MULTIPLE_ACTIVE_MIUS: 'multiple-active-mius',
  CURRENT_MIU_MISMATCH: 'current-miu-mismatch',
  INVALID_SEQUENTIAL_OWNERSHIP: 'invalid-sequential-ownership',
  UNMODELED_CONSUMER: 'unmodeled-consumer',
  GOVERNANCE_OWNER_MISMATCH: 'governance-owner-mismatch',
  UNSATISFIED_EXTERNAL_GATE: 'unsatisfied-external-gate',
  CONFIG_DENOMINATOR_MISMATCH: 'config-denominator-mismatch',
  EXTERNAL_GATE_SHAPE: 'external-gate-shape',
  COMPATIBILITY_DENOMINATOR_MISMATCH: 'compatibility-denominator-mismatch',
  NEXT_MIU_STATE_MISMATCH: 'next-miu-state-mismatch',
});

const EXPECTED_MIU_IDS = Object.freeze(
  Array.from({ length: 49 }, (_, index) => String(index + 1).padStart(2, '0')),
);
const EXPECTED_GOVERNANCE = Object.freeze([
  ['architecture-verifier', 'scripts/verify-catalog-architecture.mjs', '01'],
  ['public-catalog-schema', 'packages/shared/src/catalog/index.ts', '02'],
  ['public-read-normalizer', 'packages/shared/src/catalog/normalize-public-product.ts', '03'],
  [
    'public-api-projection',
    'apps/functions/public-api/src/catalog/project-public-product.ts',
    '04',
  ],
  ['browser-catalog-decoder', 'apps/site/src/catalog/infrastructure/catalog-api.ts', '05'],
  ['alibaba-pricing-adapter', 'packages/shared/src/catalog/alibaba-pricing-adapter.ts', '06'],
  ['pricing-resolver', 'packages/shared/src/catalog/resolve-pricing.ts', '07'],
  ['family-adapter-contract', 'apps/site/src/catalog/families/catalog-family-adapter.ts', '15'],
  ['family-registry', 'apps/site/src/catalog/families/registry.ts', '20'],
  ['catalog-list-state', 'apps/site/src/catalog/application/catalog-list-state.ts', '21'],
  ['family-route-composition', 'apps/site/src/islands/shop/CatalogFamilyPage.tsx', '22'],
  ['legacy-catalog-delegation', 'apps/site/src/islands/shop/api.ts', '36'],
  ['catalog-knowledge-authority', 'docs/ENGINEERING_CRAFT.md', '37'],
]);
const EXPECTED_COMPATIBILITY_FILES = Object.freeze([
  'apps/site/src/islands/shop/api.ts',
  'apps/site/src/islands/shop/catalog-types.ts',
  'apps/site/src/islands/shop/catalog-pricing.ts',
  'apps/site/src/islands/shop/ProductGrid.tsx',
  'apps/site/src/islands/shop/ProductCard.tsx',
  'apps/site/src/islands/shop/PriceBlock.tsx',
  'apps/site/src/islands/shop/ProductDetail.tsx',
  'apps/site/src/islands/shop/OverstockDetail.tsx',
  'apps/site/src/islands/shop/StockBadge.tsx',
]);
const EXPECTED_COMPATIBILITY_REFERENCES = Object.freeze([
  'apps/site/src/pages/_overstock.astro',
  'apps/site/src/pages/_overstock-item.astro',
]);
const EXPECTED_SCAN_ROOTS = Object.freeze(['apps', 'packages', 'scripts']);
const EXPECTED_LAYER_NAMES = Object.freeze([
  'application',
  'domain',
  'family',
  'infrastructure',
  'presentation',
  'route',
]);

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.astro']);
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', '.astro']);
const ACTIVE_STATES = new Set(['active']);
const FINISHED_STATES = new Set(['released']);
const LEGAL_STATES = new Set(['planned', 'blocked', 'active', 'released']);
const LEGAL_PREVIOUS_STATES = {
  planned: new Set(['planned', 'blocked']),
  blocked: new Set(['planned', 'blocked']),
  active: new Set(['planned', 'blocked', 'active']),
  released: new Set(['active', 'released']),
};

function posix(value) {
  return normalize(value).split(sep).join('/').replace(/^\.\//, '');
}

function issue(code, message, path = '', relatedPath = '') {
  return { code, severity: 'error', message, path, ...(relatedPath ? { relatedPath } : {}) };
}

function sortIssues(issues) {
  return issues.sort((left, right) =>
    [left.code, left.path, left.relatedPath ?? '', left.message]
      .join('\0')
      .localeCompare([right.code, right.path, right.relatedPath ?? '', right.message].join('\0')),
  );
}

function hasGlob(value) {
  return /[*?\[\]{}]/.test(value);
}

function matches(pattern, path) {
  return matchesGlob(posix(path), posix(pattern));
}

function walk(root, relativeRoot, output = []) {
  const absolute = join(root, relativeRoot);
  if (!existsSync(absolute)) return output;
  for (const entry of readdirSync(absolute)) {
    if (SKIP_DIRECTORIES.has(entry)) continue;
    const child = join(absolute, entry);
    const childRelative = posix(relative(root, child));
    const stats = statSync(child);
    if (stats.isDirectory()) walk(root, childRelative, output);
    else if (SOURCE_EXTENSIONS.has(extname(entry))) output.push(childRelative);
  }
  return output;
}

function walkAll(root, relativeRoot, output = []) {
  const absolute = join(root, relativeRoot);
  if (!existsSync(absolute)) return output;
  for (const entry of readdirSync(absolute)) {
    if (SKIP_DIRECTORIES.has(entry)) continue;
    const child = join(absolute, entry);
    const childRelative = posix(relative(root, child));
    const stats = statSync(child);
    if (stats.isDirectory()) walkAll(root, childRelative, output);
    else output.push(childRelative);
  }
  return output;
}

function sourceForParsing(path, source) {
  if (!path.endsWith('.astro')) return source;
  const parts = [];
  const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (frontmatter?.[1]) parts.push(frontmatter[1]);
  for (const script of source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
    if (script[1]) parts.push(script[1]);
  }
  return parts.join('\n');
}

function importSpecifiers(path, source) {
  const scriptKind = path.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : path.endsWith('.jsx')
      ? ts.ScriptKind.JSX
      : ts.ScriptKind.TS;
  const tree = ts.createSourceFile(
    path,
    sourceForParsing(path, source),
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  const imports = [];
  function add(node, value) {
    imports.push({
      specifier: value,
      line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
    });
  }
  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      add(node, node.moduleSpecifier.text);
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      add(node, node.moduleReference.expression.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.arguments.length >= 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')
      ) {
        add(node, node.arguments[0].text);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return imports;
}

function resolveRelativeImport(root, fromPath, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(root, dirname(fromPath), specifier);
  const candidates = [
    base,
    ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.astro'].map(
      (extension) => `${base}${extension}`,
    ),
    ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.astro'].map((extension) =>
      join(base, `index${extension}`),
    ),
  ];
  const found = candidates.find(
    (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
  );
  if (!found) return undefined;
  const relativeTarget = relative(root, found);
  return relativeTarget.startsWith('..') || isAbsolute(relativeTarget)
    ? undefined
    : posix(relativeTarget);
}

function workspaceAliases(root) {
  const aliases = new Map();
  for (const packageRoot of ['apps', 'packages']) {
    const absoluteRoot = join(root, packageRoot);
    if (!existsSync(absoluteRoot)) continue;
    for (const entry of readdirSync(absoluteRoot)) {
      const packageJson = join(absoluteRoot, entry, 'package.json');
      if (!existsSync(packageJson)) continue;
      const manifest = JSON.parse(readFileSync(packageJson, 'utf8'));
      if (!manifest.name) continue;
      const exports = typeof manifest.exports === 'object' ? manifest.exports : {};
      for (const [subpath, target] of Object.entries(exports)) {
        if (typeof target !== 'string') continue;
        const alias =
          subpath === '.' ? manifest.name : `${manifest.name}/${subpath.replace(/^\.\//, '')}`;
        aliases.set(alias, posix(join(packageRoot, entry, target)));
      }
      if (!aliases.has(manifest.name)) {
        aliases.set(
          manifest.name,
          posix(join(packageRoot, entry, manifest.module ?? manifest.main ?? './src/index.ts')),
        );
      }
    }
  }
  return aliases;
}

function resolveImport(root, fromPath, specifier, aliases) {
  if (specifier.startsWith('.')) return resolveRelativeImport(root, fromPath, specifier);
  const target = aliases.get(specifier);
  if (!target) return null;
  const absolute = resolve(root, target);
  const relativeTarget = relative(root, absolute);
  if (relativeTarget.startsWith('..') || isAbsolute(relativeTarget)) return undefined;
  return existsSync(absolute) ? posix(relativeTarget) : undefined;
}

function classifyLayer(config, path) {
  for (const [name, layer] of Object.entries(config.layers ?? {})) {
    if ((layer.include ?? []).some((pattern) => matches(pattern, path))) return name;
  }
  return null;
}

function packageForbidden(patterns, specifier) {
  return patterns.some((pattern) => {
    if (pattern.endsWith(':*')) {
      const prefix = pattern.slice(0, -2);
      return specifier === prefix || specifier.startsWith(`${prefix}:`);
    }
    return specifier === pattern || specifier.startsWith(`${pattern}/`);
  });
}

function validateModuleGraph(root, config, issues) {
  const files = [...new Set((config.scanRoots ?? []).flatMap((scanRoot) => walk(root, scanRoot)))];
  const aliases = workspaceAliases(root);
  const graph = new Map();
  for (const path of files) {
    const layerName = classifyLayer(config, path);
    const layer = layerName ? (config.layers[layerName] ?? {}) : {};
    const imports = importSpecifiers(path, readFileSync(join(root, path), 'utf8'));
    const dependencies = [];
    for (const imported of imports) {
      if (!imported.specifier.startsWith('.') && !aliases.has(imported.specifier)) {
        if (packageForbidden(layer.forbidPackages ?? [], imported.specifier)) {
          issues.push(
            issue(
              ISSUE_CODES.FORBIDDEN_EDGE,
              `${layerName} cannot import package ${imported.specifier} (line ${imported.line})`,
              path,
              imported.specifier,
            ),
          );
        }
        continue;
      }
      const target = resolveImport(root, path, imported.specifier, aliases);
      if (target === null) continue;
      if (target === undefined) {
        issues.push(
          issue(
            ISSUE_CODES.UNROOTED_IMPORT,
            `Import does not resolve inside the rooted graph (line ${imported.line})`,
            path,
            imported.specifier,
          ),
        );
        continue;
      }
      dependencies.push(target);
      const targetLayer = classifyLayer(config, target);
      if (targetLayer && layerName) {
        if ((layer.forbidLayers ?? []).includes(targetLayer)) {
          issues.push(
            issue(
              ISSUE_CODES.FORBIDDEN_EDGE,
              `${layerName} cannot depend on ${targetLayer} (line ${imported.line})`,
              path,
              target,
            ),
          );
        }
      }
    }
    graph.set(path, dependencies);
  }

  const state = new Map();
  const stack = [];
  function visit(path) {
    state.set(path, 'visiting');
    stack.push(path);
    for (const dependency of graph.get(path) ?? []) {
      if (!graph.has(dependency)) continue;
      if (state.get(dependency) === 'visiting') {
        const cycleStart = stack.indexOf(dependency);
        const cycle = [...stack.slice(cycleStart), dependency];
        const layers = new Set(cycle.map((item) => classifyLayer(config, item)).filter(Boolean));
        if (layers.size > 1) {
          issues.push(
            issue(
              ISSUE_CODES.MODULE_CYCLE,
              `Catalog layer cycle: ${cycle.join(' -> ')}`,
              path,
              dependency,
            ),
          );
        }
      } else if (!state.has(dependency)) visit(dependency);
    }
    stack.pop();
    state.set(path, 'done');
  }
  for (const path of graph.keys()) if (!state.has(path)) visit(path);
  return { files, graph };
}

function parseMiuBreakdown(root) {
  const path = join(root, 'docs/catalog-architecture-hardening/MIU_BREAKDOWN.md');
  if (!existsSync(path)) return new Map();
  const source = readFileSync(path, 'utf8');
  const headings = [...source.matchAll(/^## MIU (\d+):[^\n]*$/gm)];
  const result = new Map();
  for (const [index, heading] of headings.entries()) {
    const id = heading[1].padStart(2, '0');
    const sectionEnd = headings[index + 1]?.index ?? source.length;
    const section = source.slice(heading.index, sectionEnd);
    const filesLine = section.match(/^- \*\*Files:\*\* ([^\n]+)$/m)?.[1] ?? '';
    const files = [...filesLine.matchAll(/`([^`]+)`/g)].map((match) => posix(match[1]));
    const references = [
      ...new Set(
        [...section.matchAll(/`([^`]+)`/g)]
          .map((match) => match[1])
          .filter(
            (value) =>
              /^(?:\.github|apps|config|docs|packages|scripts|tests)\//.test(value) &&
              /\.[a-z0-9]+$/i.test(value),
          )
          .map(posix),
      ),
    ];
    result.set(id, { files, references });
  }
  return result;
}

function allMiuIds(task) {
  return new Set([
    ...Object.keys(task.miuFilePlans ?? {}),
    ...Object.keys(task.miuTypes ?? {}),
    ...Object.keys(task.miuDependencies ?? {}),
    ...Object.keys(task.miuReservationStates ?? {}),
  ]);
}

function plannedPaths(task) {
  return new Set(Object.values(task.miuFilePlans ?? {}).flat());
}

function sequentiallyModeled(task, path, owners) {
  const model = task.sequentialOwnership?.[path];
  if (!model) return false;
  if (Array.isArray(model.chain)) {
    const orderedOwners = [...owners].sort((left, right) => Number(left) - Number(right));
    return (
      model.transition === 'released-before-next-active' &&
      model.chain.length === orderedOwners.length &&
      model.chain.every((owner, index) => owner === orderedOwners[index])
    );
  }
  if (model.ownerMiu) {
    const modeled = new Set([model.ownerMiu, ...(model.laterConsumers ?? [])]);
    return owners.every((owner) => modeled.has(owner));
  }
  return Boolean(model.taskPlanningReference);
}

function validateRegistryShape(root, task, registry, issues) {
  const documented = parseMiuBreakdown(root);
  const ids = allMiuIds(task);
  const maps = ['miuFilePlans', 'miuTypes', 'miuDependencies', 'miuReservationStates'];
  for (const id of ids) {
    for (const map of maps) {
      if (!Object.hasOwn(task[map] ?? {}, id)) {
        issues.push(
          issue(ISSUE_CODES.REGISTRY_SHAPE, `MIU ${id} is missing ${map}`, `MIU ${id}`, map),
        );
      }
    }
  }
  const documentedIds = [...documented.keys()];
  const registryIds = [...ids].sort();
  if (
    JSON.stringify(documentedIds) !== JSON.stringify(EXPECTED_MIU_IDS) ||
    JSON.stringify(registryIds) !== JSON.stringify(EXPECTED_MIU_IDS)
  ) {
    issues.push(
      issue(
        ISSUE_CODES.REGISTRY_MIU_MISMATCH,
        `Catalog schema requires MIUs [${EXPECTED_MIU_IDS.join(', ')}]; documented [${documentedIds.join(', ')}], registry [${registryIds.join(', ')}]`,
        'docs/catalog-architecture-hardening/MIU_BREAKDOWN.md',
        'docs/catalog-architecture-hardening/TASK_REGISTRY.json',
      ),
    );
  }
  if (documented.size > 0) {
    for (const [id, contract] of documented) {
      const registryFiles = (task.miuFilePlans?.[id] ?? []).map(posix);
      if (JSON.stringify(contract.files) !== JSON.stringify(registryFiles)) {
        issues.push(
          issue(
            ISSUE_CODES.REGISTRY_FILE_MISMATCH,
            `MIU ${id} documented files differ from registry`,
            `MIU ${id}`,
            'miuFilePlans',
          ),
        );
      }
    }
  }
  const allowedStates = new Set(registry.reservationPolicy?.states ?? LEGAL_STATES);
  for (const [id, stateRecord] of Object.entries(task.miuReservationStates ?? {})) {
    const state = stateRecord?.reservationState;
    if (!allowedStates.has(state)) {
      issues.push(
        issue(
          ISSUE_CODES.ILLEGAL_STATE_TRANSITION,
          `MIU ${id} has unknown state ${state}`,
          `MIU ${id}`,
        ),
      );
    }
    const previous = stateRecord?.previousReservationState;
    if (previous && !LEGAL_PREVIOUS_STATES[state]?.has(previous)) {
      issues.push(
        issue(
          ISSUE_CODES.ILLEGAL_STATE_TRANSITION,
          `MIU ${id} cannot transition ${previous} -> ${state}`,
          `MIU ${id}`,
        ),
      );
    }
    if (state === 'released' && previous !== 'active') {
      issues.push(
        issue(
          ISSUE_CODES.ILLEGAL_STATE_TRANSITION,
          `MIU ${id} release must record previousReservationState active`,
          `MIU ${id}`,
        ),
      );
    }
  }
  if (
    task.miuReservationStates?.['01']?.reservationState === 'released' &&
    task.currentMiu == null &&
    task.miuReservationStates?.['02']?.reservationState !== 'planned'
  ) {
    issues.push(
      issue(
        ISSUE_CODES.NEXT_MIU_STATE_MISMATCH,
        'MIU 02 must remain planned when MIU 01 closes; activation is a separate step',
        'MIU 02',
      ),
    );
  }

  const compatibilityFiles = (task.permanentCompatibilityOwner?.files ?? []).map(posix).sort();
  const compatibilityReferences = (
    task.permanentCompatibilityOwner?.permanentReadOnlyReferences ?? []
  )
    .map(posix)
    .sort();
  if (
    task.permanentCompatibilityOwner?.ownerMiu !== '36' ||
    JSON.stringify(compatibilityFiles) !==
      JSON.stringify([...EXPECTED_COMPATIBILITY_FILES].sort()) ||
    JSON.stringify(compatibilityReferences) !==
      JSON.stringify([...EXPECTED_COMPATIBILITY_REFERENCES].sort())
  ) {
    issues.push(
      issue(
        ISSUE_CODES.COMPATIBILITY_DENOMINATOR_MISMATCH,
        'Permanent Overstock compatibility owner/files/references differ from catalog-change-impact-v1',
        'permanentCompatibilityOwner',
      ),
    );
  }
}

function validateMiuGraph(task, issues) {
  const ids = allMiuIds(task);
  const graph = new Map();
  for (const id of ids) {
    const dependencies = task.miuDependencies?.[id] ?? [];
    graph.set(
      id,
      dependencies.filter((dependency) => ids.has(dependency)),
    );
    for (const dependency of dependencies) {
      if (!ids.has(dependency))
        issues.push(
          issue(
            ISSUE_CODES.MISSING_DEPENDENCY,
            `MIU ${id} depends on unknown MIU ${dependency}`,
            `MIU ${id}`,
            `MIU ${dependency}`,
          ),
        );
    }
    const state = task.miuReservationStates?.[id]?.reservationState;
    if (ACTIVE_STATES.has(state)) {
      for (const dependency of dependencies) {
        const dependencyState = task.miuReservationStates?.[dependency]?.reservationState;
        if (!FINISHED_STATES.has(dependencyState)) {
          issues.push(
            issue(
              ISSUE_CODES.UNMET_ACTIVE_DEPENDENCY,
              `Active MIU ${id} requires released MIU ${dependency}, found ${dependencyState ?? 'missing'}`,
              `MIU ${id}`,
              `MIU ${dependency}`,
            ),
          );
        }
      }
    }
  }

  const visiting = new Set();
  const visited = new Set();
  function visit(id, chain) {
    if (visiting.has(id)) {
      const start = chain.indexOf(id);
      const cycle = [...chain.slice(start), id];
      issues.push(
        issue(ISSUE_CODES.MIU_CYCLE, `MIU dependency cycle: ${cycle.join(' -> ')}`, `MIU ${id}`),
      );
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of graph.get(id) ?? []) visit(dependency, [...chain, id]);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of ids) visit(id, []);
  const active = [...ids].filter((id) =>
    ACTIVE_STATES.has(task.miuReservationStates?.[id]?.reservationState),
  );
  if (active.length > 1) {
    issues.push(
      issue(
        ISSUE_CODES.MULTIPLE_ACTIVE_MIUS,
        `Only one MIU may be active, found ${active.join(', ')}`,
        task.id,
      ),
    );
  }
  if ((active[0] ?? null) !== (task.currentMiu ?? null)) {
    issues.push(
      issue(
        ISSUE_CODES.CURRENT_MIU_MISMATCH,
        `currentMiu ${task.currentMiu ?? 'null'} does not match active MIU ${active[0] ?? 'none'}`,
        task.id,
      ),
    );
  }
}

function validateOwnership(task, issues) {
  const ownersByPath = new Map();
  for (const [id, files] of Object.entries(task.miuFilePlans ?? {})) {
    if (!Array.isArray(files) || files.length === 0) {
      issues.push(
        issue(ISSUE_CODES.REGISTRY_SHAPE, `MIU ${id} has no exact file plan`, `MIU ${id}`),
      );
      continue;
    }
    for (const rawPath of files) {
      const path = posix(rawPath);
      if (hasGlob(path))
        issues.push(
          issue(
            ISSUE_CODES.GLOB_ONLY_PLAN,
            `MIU ${id} must reserve exact files, not ${path}`,
            `MIU ${id}`,
            path,
          ),
        );
      const owners = ownersByPath.get(path) ?? [];
      owners.push(id);
      ownersByPath.set(path, owners);
    }
  }

  for (const [path, owners] of ownersByPath) {
    const model = task.sequentialOwnership?.[path];
    if (owners.length > 1 && model && !sequentiallyModeled(task, path, owners)) {
      issues.push(
        issue(
          ISSUE_CODES.INVALID_SEQUENTIAL_OWNERSHIP,
          `Sequential ownership does not match owner order ${owners.join(', ')}`,
          path,
        ),
      );
    }
    if (owners.length > 1 && !model) {
      issues.push(
        issue(
          ISSUE_CODES.UNMODELED_REPEAT,
          `Repeated file plan lacks sequential ownership: ${owners.join(', ')}`,
          path,
        ),
      );
    }
    const activeOwners = owners.filter((id) =>
      ACTIVE_STATES.has(task.miuReservationStates?.[id]?.reservationState),
    );
    if (activeOwners.length > 1) {
      issues.push(
        issue(
          ISSUE_CODES.DUPLICATE_ACTIVE_OWNER,
          `Multiple active MIUs own this exact file: ${activeOwners.join(', ')}`,
          path,
        ),
      );
    }
    if (model?.transition === 'released-before-next-active' && activeOwners.length === 1) {
      const activeIndex = model.chain.indexOf(activeOwners[0]);
      for (const predecessor of model.chain.slice(0, activeIndex)) {
        if (!FINISHED_STATES.has(task.miuReservationStates?.[predecessor]?.reservationState)) {
          issues.push(
            issue(
              ISSUE_CODES.INVALID_SEQUENTIAL_OWNERSHIP,
              `Active MIU ${activeOwners[0]} requires predecessor MIU ${predecessor} released`,
              path,
            ),
          );
        }
      }
    }
  }

  for (const [path, model] of Object.entries(task.sequentialOwnership ?? {})) {
    if (!model?.ownerMiu || !Array.isArray(model.laterConsumers)) continue;
    const ownerState = task.miuReservationStates?.[model.ownerMiu]?.reservationState;
    for (const consumer of model.laterConsumers) {
      const consumerState = task.miuReservationStates?.[consumer]?.reservationState;
      if (
        (ACTIVE_STATES.has(consumerState) || FINISHED_STATES.has(consumerState)) &&
        !FINISHED_STATES.has(ownerState)
      ) {
        issues.push(
          issue(
            ISSUE_CODES.INVALID_SEQUENTIAL_OWNERSHIP,
            `MIU ${consumer} cannot consume ${path} before owner MIU ${model.ownerMiu} is released`,
            path,
          ),
        );
      }
    }
  }

  const activeFiles = new Set();
  for (const [id, stateRecord] of Object.entries(task.miuReservationStates ?? {})) {
    if (!ACTIVE_STATES.has(stateRecord?.reservationState)) continue;
    for (const path of task.miuFilePlans?.[id] ?? []) activeFiles.add(path);
  }
  if (activeFiles.size > 0) {
    const claimed = new Set(task.activeExactReservations ?? []);
    for (const path of activeFiles) {
      if (!claimed.has(path)) {
        issues.push(
          issue(
            ISSUE_CODES.ACTIVE_RESERVATION_MISMATCH,
            'Active MIU file is missing from activeExactReservations',
            path,
          ),
        );
      }
    }
    for (const path of claimed) {
      if (!activeFiles.has(path)) {
        issues.push(
          issue(
            ISSUE_CODES.ACTIVE_RESERVATION_MISMATCH,
            'activeExactReservations contains a file not owned by an active MIU',
            path,
          ),
        );
      }
    }
  } else if ((task.activeExactReservations ?? []).length > 0) {
    for (const path of task.activeExactReservations) {
      issues.push(
        issue(
          ISSUE_CODES.ACTIVE_RESERVATION_MISMATCH,
          'No MIU is active, so activeExactReservations must be empty',
          path,
        ),
      );
    }
  }
  if (activeFiles.size === 0 && String(task.activeReservationPurpose ?? '').trim()) {
    issues.push(
      issue(
        ISSUE_CODES.ACTIVE_RESERVATION_MISMATCH,
        'No MIU is active, so activeReservationPurpose must be empty',
        'activeReservationPurpose',
      ),
    );
  }
}

function validateConsumers(root, task, config, issues) {
  const futurePaths = plannedPaths(task);
  const documented = parseMiuBreakdown(root);
  for (const path of config.additionalRequiredPaths ?? []) {
    if (!existsSync(join(root, path)) && !futurePaths.has(path)) {
      issues.push(
        issue(
          ISSUE_CODES.MISSING_CONSUMER,
          'Required Catalog denominator path is neither present nor planned',
          path,
        ),
      );
    }
  }
  for (const [id, paths] of Object.entries(task.consumerReferences ?? {})) {
    const state = task.miuReservationStates?.[id]?.reservationState;
    if (!ACTIVE_STATES.has(state) && !FINISHED_STATES.has(state)) continue;
    for (const path of paths) {
      if (!existsSync(join(root, path)) && !futurePaths.has(path)) {
        issues.push(
          issue(
            ISSUE_CODES.MISSING_CONSUMER,
            `MIU ${id} consumer reference is absent and unplanned`,
            path,
            `MIU ${id}`,
          ),
        );
      }
    }
  }
  for (const [id, contract] of documented) {
    for (const path of contract.references) {
      if (!existsSync(join(root, path)) && !futurePaths.has(path)) {
        issues.push(
          issue(
            ISSUE_CODES.MISSING_CONSUMER,
            `MIU ${id} names a contract path that is neither present nor planned`,
            path,
            `MIU ${id}`,
          ),
        );
      }
    }
  }
  for (const [id, stateRecord] of Object.entries(task.miuReservationStates ?? {})) {
    if (!ACTIVE_STATES.has(stateRecord?.reservationState)) continue;
    for (const path of task.miuFilePlans?.[id] ?? []) {
      if (!hasGlob(path) && !existsSync(join(root, path))) {
        issues.push(
          issue(
            ISSUE_CODES.MISSING_ACTIVE_FILE,
            `Active MIU ${id} implementation file does not exist`,
            path,
            `MIU ${id}`,
          ),
        );
      }
    }
  }
}

function validateGovernance(task, config, issues) {
  const byRole = new Map();
  const ids = allMiuIds(task);
  for (const owner of config.governanceOwners ?? []) {
    const existing = byRole.get(owner.role);
    if (existing) {
      issues.push(
        issue(
          ISSUE_CODES.DUPLICATE_GOVERNANCE_OWNER,
          `Governance role ${owner.role} has multiple canonical owners`,
          existing.path,
          owner.path,
        ),
      );
    } else byRole.set(owner.role, owner);
    if (!ids.has(String(owner.miu).padStart(2, '0'))) {
      issues.push(
        issue(
          ISSUE_CODES.REGISTRY_SHAPE,
          `Governance owner references unknown MIU ${owner.miu}`,
          owner.path,
        ),
      );
    }
  }
  const configured = (config.governanceOwners ?? [])
    .map((owner) => [owner.role, posix(owner.path), String(owner.miu).padStart(2, '0')])
    .sort((left, right) => left[0].localeCompare(right[0]));
  const expected = [...EXPECTED_GOVERNANCE].sort((left, right) => left[0].localeCompare(right[0]));
  if (JSON.stringify(configured) !== JSON.stringify(expected)) {
    issues.push(
      issue(
        ISSUE_CODES.CONFIG_DENOMINATOR_MISMATCH,
        'governanceOwners differs from immutable catalog-change-impact-v1 roles',
        'config/change-impact/catalog.yaml',
      ),
    );
  }
  const scanRoots = [...(config.scanRoots ?? [])].sort();
  const layerNames = Object.keys(config.layers ?? {}).sort();
  const invalidLayer = EXPECTED_LAYER_NAMES.some((name) => {
    const layer = config.layers?.[name];
    return !layer || !Array.isArray(layer.include) || layer.include.length === 0;
  });
  if (
    JSON.stringify(scanRoots) !== JSON.stringify([...EXPECTED_SCAN_ROOTS].sort()) ||
    JSON.stringify(layerNames) !== JSON.stringify([...EXPECTED_LAYER_NAMES].sort()) ||
    invalidLayer
  ) {
    issues.push(
      issue(
        ISSUE_CODES.CONFIG_DENOMINATOR_MISMATCH,
        'scanRoots/layers differ from immutable catalog-change-impact-v1 topology',
        'config/change-impact/catalog.yaml',
      ),
    );
  }
}

function declarationNames(path, source) {
  const tree = ts.createSourceFile(
    path,
    sourceForParsing(path, source),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const names = [];
  function visit(node) {
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isVariableDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name)
    ) {
      names.push(node.name.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return names;
}

function modeledPaths(task, config) {
  return new Set([
    ...Object.values(task.miuFilePlans ?? {})
      .flat()
      .map(posix),
    ...Object.values(task.consumerReferences ?? {})
      .flat()
      .map(posix),
    ...(task.permanentCompatibilityOwner?.files ?? []).map(posix),
    ...(task.permanentCompatibilityOwner?.permanentReadOnlyReferences ?? []).map(posix),
    ...(config.additionalRequiredPaths ?? []).map(posix),
  ]);
}

function validateDiscoveredGovernance(root, task, config, moduleGraph, issues) {
  const modeled = modeledPaths(task, config);
  for (const owner of config.governanceOwners ?? []) {
    const discover = owner.discover;
    if (!discover) continue;
    const producers = [];
    for (const scanRoot of discover.roots ?? []) {
      for (const path of walkAll(root, scanRoot)) {
        if ((discover.filePatterns ?? []).some((pattern) => matches(pattern, path))) {
          producers.push(path);
          continue;
        }
        if (SOURCE_EXTENSIONS.has(extname(path))) {
          const names = declarationNames(path, readFileSync(join(root, path), 'utf8'));
          if ((discover.declarationNames ?? []).some((name) => names.includes(name))) {
            producers.push(path);
          }
        }
      }
    }
    if (producers.length > 1) {
      issues.push(
        issue(
          ISSUE_CODES.DUPLICATE_GOVERNANCE_OWNER,
          `Governance role ${owner.role} has discovered producers ${producers.join(', ')}`,
          producers[0],
          producers[1],
        ),
      );
    }
    const canonical = posix(owner.path);
    if (producers.length === 1 && producers[0] !== canonical) {
      issues.push(
        issue(
          ISSUE_CODES.GOVERNANCE_OWNER_MISMATCH,
          `Governance role ${owner.role} is produced at ${producers[0]}, expected ${canonical}`,
          producers[0],
          canonical,
        ),
      );
    }
    const ownerState =
      task.miuReservationStates?.[String(owner.miu).padStart(2, '0')]?.reservationState;
    if (
      (ACTIVE_STATES.has(ownerState) || FINISHED_STATES.has(ownerState)) &&
      !producers.includes(canonical)
    ) {
      issues.push(
        issue(
          ISSUE_CODES.GOVERNANCE_OWNER_MISMATCH,
          `Active/released governance owner ${owner.role} is missing at its canonical path`,
          canonical,
        ),
      );
    }
    for (const [consumer, dependencies] of moduleGraph.graph) {
      if (dependencies.includes(canonical) && !modeled.has(consumer)) {
        issues.push(
          issue(
            ISSUE_CODES.UNMODELED_CONSUMER,
            `Consumer of ${owner.role} is absent from registry and denominator`,
            consumer,
            canonical,
          ),
        );
      }
    }
  }
}

function validateGit(root, task, gitProbe, issues) {
  const localHead = gitProbe.localSha(task.branch);
  const remoteHead = gitProbe.remoteSha(task.remoteBranch);
  if (!task.baseSha || !localHead || !gitProbe.isAncestor(task.baseSha, localHead)) {
    issues.push(
      issue(
        ISSUE_CODES.STALE_SHA,
        `base claimed SHA ${task.baseSha ?? 'missing'} is not an ancestor of ${localHead ?? 'missing'}`,
        task.branch,
        task.remoteBranch,
      ),
    );
  }
  for (const [label, claimed, actual] of [
    ['local', task.claimedLocalHead, localHead],
    ['remote', task.claimedRemoteHead, remoteHead],
  ]) {
    if (!claimed || !actual || !gitProbe.isAncestor(claimed, actual)) {
      issues.push(
        issue(
          ISSUE_CODES.STALE_SHA,
          `${label} claimed SHA ${claimed ?? 'missing'} is not an ancestor of observed head ${actual ?? 'missing'}`,
          task.branch,
          task.remoteBranch,
        ),
      );
    }
  }

  const expectedWorktree = normalize(
    isAbsolute(task.worktree) ? task.worktree : resolve(root, task.worktree),
  );
  const found = gitProbe
    .worktrees()
    .find(
      (worktree) =>
        normalize(worktree.path) === expectedWorktree && worktree.branch === task.branch,
    );
  if (!found) {
    issues.push(
      issue(
        ISSUE_CODES.WORKTREE_MISMATCH,
        'Claimed worktree/branch pair is not present in live Git worktrees',
        task.worktree,
        task.branch,
      ),
    );
  }

  if (found && found.head !== localHead) {
    issues.push(
      issue(
        ISSUE_CODES.WORKTREE_MISMATCH,
        `Worktree HEAD ${found.head} differs from local branch head ${localHead}`,
        task.worktree,
        task.branch,
      ),
    );
  }
  const released = Object.values(task.miuReservationStates ?? {}).some(
    (state) => state?.reservationState === 'released',
  );
  if (
    (released || /(complete|completed|closure|released)/i.test(task.status ?? '')) &&
    localHead !== remoteHead
  ) {
    issues.push(
      issue(
        ISSUE_CODES.LOCAL_ONLY_COMPLETION,
        `Task status ${task.status} cannot complete with local ${localHead} != remote ${remoteHead}`,
        task.branch,
        task.remoteBranch,
      ),
    );
  }
}

function validateExternalGates(task, gitProbe, issues) {
  const gate = task.externalGates?.D1;
  const deployGate = task.externalGates?.D2;
  if (
    !gate ||
    JSON.stringify((gate.scope ?? []).map(String)) !== JSON.stringify(['26', '27', '28']) ||
    gate.taskLevelDependency !== false ||
    !deployGate ||
    JSON.stringify((deployGate.scope ?? []).map(String)) !== JSON.stringify(['46']) ||
    deployGate.taskLevelDependency !== false
  ) {
    issues.push(
      issue(
        ISSUE_CODES.EXTERNAL_GATE_SHAPE,
        'Catalog registry must retain MIU-scoped D1 [26,27,28] and D2 [46]',
        'externalGates',
      ),
    );
    return;
  }
  const scopeHasUnblockedMiu = gate.scope.some(
    (id) =>
      task.miuReservationStates?.[String(id).padStart(2, '0')]?.reservationState !== 'blocked',
  );
  if (scopeHasUnblockedMiu) {
    const mergedSha = gate.satisfiedMergedSha;
    const evidence = gate.validationEvidence;
    const mainHead = gitProbe.remoteSha('origin/main');
    if (
      !mergedSha ||
      !Array.isArray(evidence) ||
      evidence.length === 0 ||
      !mainHead ||
      !gitProbe.isAncestor(mergedSha, mainHead)
    ) {
      issues.push(
        issue(
          ISSUE_CODES.UNSATISFIED_EXTERNAL_GATE,
          'D1-scoped MIUs cannot leave blocked until the final Select SHA is merged and validation evidence is recorded',
          'externalGates.D1',
        ),
      );
    }
  }

  const d2Unblocked = deployGate.scope.some((id) => {
    const state = task.miuReservationStates?.[String(id).padStart(2, '0')]?.reservationState;
    return ACTIVE_STATES.has(state) || FINISHED_STATES.has(state);
  });
  if (d2Unblocked) {
    const implementationSha = deployGate.approvedImplementationSha;
    const rollbackSha = deployGate.approvedRollbackSha;
    if (
      deployGate.confirmLive !== true ||
      !implementationSha ||
      !rollbackSha ||
      !gitProbe.isAncestor(implementationSha, implementationSha) ||
      !gitProbe.isAncestor(rollbackSha, rollbackSha)
    ) {
      issues.push(
        issue(
          ISSUE_CODES.UNSATISFIED_EXTERNAL_GATE,
          'MIU 46 requires confirmLive plus valid approved implementation and rollback SHAs',
          'externalGates.D2',
        ),
      );
    }
  }
}

function loadConfig(root) {
  const path = join(root, 'config/change-impact/catalog.yaml');
  if (!existsSync(path)) return null;
  return parse(readFileSync(path, 'utf8'));
}

export function verifyCatalogArchitecture(root, registry, gitProbe = createGitProbe(root)) {
  const issues = [];
  const config = loadConfig(root);
  if (!config || config.schemaVersion !== 'catalog-change-impact-v1') {
    return [
      issue(
        ISSUE_CODES.REGISTRY_SHAPE,
        'Missing or unsupported config/change-impact/catalog.yaml',
        'config/change-impact/catalog.yaml',
      ),
    ];
  }
  if (!registry || !Array.isArray(registry.tasks) || registry.tasks.length !== 1) {
    return [
      issue(
        ISSUE_CODES.REGISTRY_SHAPE,
        'Catalog registry must contain exactly one task',
        'docs/catalog-architecture-hardening/TASK_REGISTRY.json',
      ),
    ];
  }
  const task = registry.tasks[0];
  validateRegistryShape(root, task, registry, issues);
  validateMiuGraph(task, issues);
  validateOwnership(task, issues);
  validateConsumers(root, task, config, issues);
  validateGovernance(task, config, issues);
  const moduleGraph = validateModuleGraph(root, config, issues);
  validateDiscoveredGovernance(root, task, config, moduleGraph, issues);
  validateGit(root, task, gitProbe, issues);
  validateExternalGates(task, gitProbe, issues);
  return sortIssues(issues);
}

export function createGitProbe(root, options = {}) {
  const execute = options.exec ?? execFileSync;
  const timeoutMs = options.timeoutMs ?? 10_000;
  function run(args, options = {}) {
    try {
      return execute('git', args, {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: timeoutMs,
        ...options,
      }).trim();
    } catch {
      return '';
    }
  }
  return {
    localSha(branch) {
      return run(['rev-parse', '--verify', `refs/heads/${branch}`]) || null;
    },
    remoteSha(remoteBranch) {
      const normalizedRemote = remoteBranch.replace(/^refs\/remotes\//, '');
      const slash = normalizedRemote.indexOf('/');
      const remote = slash < 0 ? 'origin' : normalizedRemote.slice(0, slash);
      const branch = slash < 0 ? normalizedRemote : normalizedRemote.slice(slash + 1);
      const live = run(['ls-remote', '--heads', remote, branch]);
      return live.split(/\s+/)[0] || null;
    },
    isAncestor(ancestor, descendant) {
      if (!ancestor || !descendant) return false;
      try {
        execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
          cwd: root,
          stdio: 'ignore',
        });
        return true;
      } catch {
        return false;
      }
    },
    worktrees() {
      const output = run(['worktree', 'list', '--porcelain']);
      if (!output) return [];
      return output.split(/\n\n+/).map((block) => {
        const values = Object.fromEntries(
          block.split('\n').map((line) => {
            const space = line.indexOf(' ');
            return space < 0 ? [line, true] : [line.slice(0, space), line.slice(space + 1)];
          }),
        );
        return {
          path: values.worktree,
          head: values.HEAD,
          branch:
            typeof values.branch === 'string' ? values.branch.replace(/^refs\/heads\//, '') : null,
        };
      });
    },
  };
}

export function formatIssue(value) {
  return `[${value.code}] ${value.path}${value.relatedPath ? ` -> ${value.relatedPath}` : ''}: ${value.message}`;
}

function cli() {
  const root = resolve(process.cwd());
  const registryPath = join(root, 'docs/catalog-architecture-hardening/TASK_REGISTRY.json');
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  const issues = verifyCatalogArchitecture(root, registry, createGitProbe(root));
  if (process.argv.includes('--json'))
    console.log(JSON.stringify({ ok: issues.length === 0, issues }, null, 2));
  else if (issues.length === 0) console.log('Catalog architecture verification passed (0 issues).');
  else for (const value of issues) console.error(formatIssue(value));
  process.exitCode = issues.length === 0 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) cli();
