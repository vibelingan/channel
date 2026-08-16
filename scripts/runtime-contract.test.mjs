import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import ts from 'typescript';
import { parse } from 'yaml';
import { FUNCTION_NAMES } from './cloudbase-function-manifest.mjs';

const buildFloor = '22.12.0';
const functionRequire = createRequire(
  new URL('../apps/functions/admin/package.json', import.meta.url),
);
const rootRequire = createRequire(new URL('../package.json', import.meta.url));
const { require: tsxRequire } = functionRequire('tsx/cjs/api');
const rootPackage = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function collectPackageFiles(directory) {
  const packageFile = new URL('package.json', directory);
  if (existsSync(packageFile)) return [packageFile];

  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => collectPackageFiles(new URL(`${entry.name}/`, directory)));
}

function collectSourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'dist' || entry.name === 'node_modules') return [];
    const entryUrl = new URL(entry.isDirectory() ? `${entry.name}/` : entry.name, directory);
    if (entry.isDirectory()) return collectSourceFiles(entryUrl);
    return /\.(?:astro|cjs|js|jsx|mjs|ts|tsx)$/.test(entry.name) ? [entryUrl] : [];
  });
}

const productionPackageFiles = ['apps', 'packages'].flatMap((workspaceDirectory) =>
  collectPackageFiles(new URL(`../${workspaceDirectory}/`, import.meta.url)),
);
const productionSourceFiles = ['apps', 'packages'].flatMap((workspaceDirectory) =>
  collectSourceFiles(new URL(`../${workspaceDirectory}/`, import.meta.url)),
);
const buildWorkflows = [
  [
    'CI',
    parse(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')),
    'checks',
  ],
  [
    'Deploy Test',
    parse(readFileSync(new URL('../.github/workflows/deploy-test.yml', import.meta.url), 'utf8')),
    'deploy',
  ],
];
const ciJob = buildWorkflows[0][1].jobs?.checks;
const deployJob = buildWorkflows[1][1].jobs?.deploy;
const deploySource = readFileSync(new URL('./deploy-cloudbase-test.mjs', import.meta.url), 'utf8');
const packageSource = readFileSync(new URL('./package-functions.mjs', import.meta.url), 'utf8');
const smokeSource = readFileSync(new URL('./smoke-cloudbase-deploy.mjs', import.meta.url), 'utf8');
const functionBuildConfigs = FUNCTION_NAMES.map((name) => [
  name,
  tsxRequire(`../apps/functions/${name}/tsup.config.ts`, import.meta.url).default,
]);
const packageTree = ts.createSourceFile(
  'package-functions.mjs',
  packageSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);
const scriptTrees = [
  [
    'deploy',
    ts.createSourceFile(
      'deploy-cloudbase-test.mjs',
      deploySource,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    ),
  ],
  [
    'smoke',
    ts.createSourceFile(
      'smoke-cloudbase-deploy.mjs',
      smokeSource,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    ),
  ],
];

function versionTuple(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  assert.ok(match, `expected an exact major.minor.patch version, received ${version}`);
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  const leftParts = versionTuple(left);
  const rightParts = versionTuple(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

function findUniqueStep(job, predicate, label) {
  assert.ok(job && Array.isArray(job.steps), `${label} job must define steps`);
  const matches = job.steps.filter(predicate);
  assert.equal(matches.length, 1, `${label} must have exactly one matching step`);
  assert.equal(matches[0].if, undefined, `${label} step must not be conditional`);
  assert.notEqual(matches[0]['continue-on-error'], true, `${label} step must fail the job`);
  return matches[0];
}

function collectNodes(root, predicate) {
  const matches = [];
  function visit(node) {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  }
  visit(root);
  return matches;
}

function assertRuntimeDefault(name, tree) {
  const declarations = collectNodes(
    tree,
    (node) => ts.isVariableDeclaration(node) && node.name.getText(tree) === 'targetRuntime',
  );
  assert.equal(declarations.length, 1, `${name} must declare targetRuntime exactly once`);

  const initializer = declarations[0].initializer;
  assert.ok(ts.isBinaryExpression(initializer), `${name} targetRuntime must have a fallback`);
  assert.equal(initializer.operatorToken.kind, ts.SyntaxKind.BarBarToken);
  assert.equal(initializer.left.getText(tree), 'process.env.CLOUDBASE_FUNCTION_RUNTIME');
  assert.ok(ts.isStringLiteral(initializer.right));
  assert.equal(initializer.right.text, 'Nodejs20.19');

  const engineReferences = collectNodes(
    tree,
    (node) => ts.isPropertyAccessExpression(node) && node.name.text === 'engines',
  );
  assert.equal(engineReferences.length, 0, `${name} must not derive runtime from package engines`);
}

function assertRuntimeComparison(tree, objectName, label) {
  const matches = collectNodes(tree, (node) => {
    if (!ts.isBinaryExpression(node)) return false;
    return (
      node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken &&
      node.left.getText(tree) === `${objectName}.Runtime` &&
      node.right.getText(tree) === 'targetRuntime'
    );
  });
  assert.equal(matches.length, 1, label);
}

test('Ajv 2020 is root-only validation tooling', () => {
  assert.equal(rootPackage.devDependencies?.ajv, '8.20.0');
  assert.equal(typeof rootRequire('ajv/dist/2020'), 'function');

  for (const packageFile of productionPackageFiles) {
    const packageJson = JSON.parse(readFileSync(packageFile, 'utf8'));
    for (const dependencyType of ['dependencies', 'devDependencies']) {
      assert.equal(
        packageJson[dependencyType]?.ajv,
        undefined,
        `${packageJson.name} must not declare Ajv in ${dependencyType}`,
      );
    }
  }

  const ajvImport = /(?:from\s*|import\s*\(\s*|import\s+|require\(\s*)['"]ajv(?:\/[^'"]*)?['"]/;
  for (const sourceFile of productionSourceFiles) {
    assert.doesNotMatch(
      readFileSync(sourceFile, 'utf8'),
      ajvImport,
      `${sourceFile.pathname} must not import root-only Ajv tooling`,
    );
  }

  const artifactDependencies = collectNodes(
    packageTree,
    (node) => ts.isPropertyAssignment(node) && node.name.getText(packageTree) === 'dependencies',
  );
  assert.equal(artifactDependencies.length, 1, 'function packaging must define dependencies once');
  assert.ok(ts.isObjectLiteralExpression(artifactDependencies[0].initializer));
  assert.equal(
    artifactDependencies[0].initializer.properties.length,
    0,
    'function artifact manifests must not include root development dependencies',
  );

  for (const name of FUNCTION_NAMES) {
    const artifactPackageFile = new URL(
      `../.cloudbase-artifacts/functions/${name}/package.json`,
      import.meta.url,
    );
    if (existsSync(artifactPackageFile)) {
      const artifactPackage = JSON.parse(readFileSync(artifactPackageFile, 'utf8'));
      assert.equal(
        artifactPackage.dependencies?.ajv,
        undefined,
        `${name} artifact must not ship the root Ajv development dependency`,
      );
    }

    const artifactBundleFile = new URL(
      `../.cloudbase-artifacts/functions/${name}/index.js`,
      import.meta.url,
    );
    if (existsSync(artifactBundleFile)) {
      assert.doesNotMatch(
        readFileSync(artifactBundleFile, 'utf8'),
        /\bajv\b|ajv\/dist\/2020|json-schema\.org\/draft\/2020-12/i,
        `${name} artifact bundle must not contain Ajv runtime code`,
      );
    }
  }
});

test('site build engine and workflow Node versions satisfy the Astro build floor', () => {
  assert.equal(rootPackage.engines?.node, `>=${buildFloor}`);

  for (const [name, workflow, jobName] of buildWorkflows) {
    const job = workflow.jobs?.[jobName];
    assert.ok(job, `${name} must define jobs.${jobName}`);
    assert.equal(job.if, undefined, `${name} ${jobName} job must not be conditional`);
    findUniqueStep(job, (step) => step.run === 'pnpm build', `${name} site build`);
    const setupNode = findUniqueStep(
      job,
      (step) => step.uses === 'actions/setup-node@v4',
      `${name} Node setup`,
    );
    const nodeVersion = setupNode.with?.['node-version'];
    assert.ok(nodeVersion, `${name} must pin its site-build Node version`);
    assert.ok(
      compareVersions(String(nodeVersion), buildFloor) >= 0,
      `${name} Node ${nodeVersion} is below the >=${buildFloor} build floor`,
    );
  }
});

test('Deploy Test runs deployment contracts before packaging', () => {
  findUniqueStep(ciJob, (step) => step.run === 'pnpm test', 'CI root test gate');
  assert.ok(deployJob, 'Deploy Test must define jobs.deploy');
  assert.equal(deployJob.if, undefined, 'Deploy Test deploy job must not be conditional');
  const contractStep = findUniqueStep(
    deployJob,
    (step) => step.run === 'pnpm test:deploy-smoke',
    'Deploy Test contract gate',
  );
  const packageStep = findUniqueStep(
    deployJob,
    (step) => step.run === 'pnpm package:functions',
    'Deploy Test function packaging',
  );

  assert.ok(
    deployJob.steps.indexOf(contractStep) < deployJob.steps.indexOf(packageStep),
    'deployment contract tests must run before packaging',
  );
});

test('CloudBase functions retain their independent Nodejs20.19 runtime contract', () => {
  assert.equal(deployJob.env?.CLOUDBASE_FUNCTION_RUNTIME, 'Nodejs20.19');
  for (const step of deployJob.steps) {
    assert.equal(
      step.env?.CLOUDBASE_FUNCTION_RUNTIME,
      undefined,
      `${step.name ?? step.run ?? step.uses} must not override the function runtime`,
    );
  }

  for (const [name, tree] of scriptTrees) {
    assertRuntimeDefault(name, tree);
  }

  const deployTree = scriptTrees[0][1];
  const smokeTree = scriptTrees[1][1];
  const runtimeProperties = collectNodes(
    deployTree,
    (node) =>
      ts.isPropertyAssignment(node) &&
      node.name.getText(deployTree) === 'runtime' &&
      node.initializer.getText(deployTree) === 'targetRuntime',
  );
  assert.equal(
    runtimeProperties.length,
    1,
    'generated CloudBase config must use the independent function runtime',
  );

  const runtimeArgumentLists = collectNodes(deployTree, (node) => {
    if (!ts.isArrayLiteralExpression(node)) return false;
    return node.elements.some(
      (element) => ts.isStringLiteral(element) && element.text === '--runtime',
    );
  });
  assert.equal(runtimeArgumentLists.length, 1, 'CloudBase CLI must define one --runtime argument');
  const runtimeArgumentList = runtimeArgumentLists[0];
  const runtimeFlagIndex = runtimeArgumentList.elements.findIndex(
    (element) => ts.isStringLiteral(element) && element.text === '--runtime',
  );
  assert.equal(
    runtimeArgumentList.elements[runtimeFlagIndex + 1]?.getText(deployTree),
    'targetRuntime',
    'CloudBase CLI deploy must use the independent function runtime',
  );

  assertRuntimeComparison(deployTree, 'before', 'deployment must reject existing runtime drift');
  assertRuntimeComparison(
    deployTree,
    'after',
    'deployment must verify the resulting function runtime',
  );
  assertRuntimeComparison(
    deployTree,
    'configAfter',
    'deployment must verify the resulting function config runtime',
  );
  assertRuntimeComparison(
    smokeTree,
    'detail',
    'deployment smoke must verify the live function runtime',
  );

  for (const [name, config] of functionBuildConfigs) {
    assert.equal(config.target, 'node20', `${name} function bundle must target Node 20`);
  }
});
