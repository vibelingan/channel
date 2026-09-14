/**
 * Docker build-context safety.
 *
 * Both AI Dockerfiles build from the REPOSITORY ROOT, so anything not excluded
 * here is uploaded to the daemon — a remote or shared builder included. This was
 * demonstrated, not assumed: with no `.dockerignore`, the real `.env.ai` was
 * present in the context; with it, only the `.example` files are.
 *
 * `.gitignore` does not apply to Docker. A file can be absent from git and still
 * ride into a build context, a layer, or a build cache.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const IGNORE_FILE = join(repoRoot, '.dockerignore');

/**
 * Split on `**` and translate each piece, rather than swapping in a sentinel
 * character and swapping it back. An earlier version used a raw NUL as that
 * sentinel, which made git classify this file as binary — no diff, no review,
 * no blame. Splitting needs no sentinel at all.
 */
function patternToRegExp(pattern) {
  const segments = pattern.split('**').map((segment) =>
    segment
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]'),
  );
  // A pattern also covers everything beneath it, the way `node_modules`
  // excludes the whole directory rather than an empty folder.
  return new RegExp(`^${segments.join('.*')}(/.*)?$`);
}

/** Docker semantics: every rule is evaluated, and the LAST match decides. */
function isExcluded(path, rules) {
  let excluded = false;
  for (const rule of rules) {
    if (rule.regex.test(path)) excluded = !rule.negated;
  }
  return excluded;
}

function loadRules() {
  const lines = readFileSync(IGNORE_FILE, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  return lines.map((line) => ({
    negated: line.startsWith('!'),
    regex: patternToRegExp(line.replace(/^!/, '')),
  }));
}

test('a root .dockerignore exists at all', () => {
  assert.ok(existsSync(IGNORE_FILE), 'no .dockerignore — the build context is the whole repo');
});

/**
 * Every `.env*` file in the working tree, as a repo-relative path.
 *
 * The whole tree, not just the root: an earlier version read the root only
 * while claiming to cover "every real environment file", so a secrets file in
 * `apps/` would have been uploaded with the claim still passing. Bounded in
 * depth and skipping directories the build context excludes wholesale, so this
 * stays fast on a monorepo.
 */
function findEnvFiles(dir = repoRoot, prefix = '', depth = 0) {
  if (depth > 4) return [];
  const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.astro', '.next', 'coverage']);
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      found.push(...findEnvFiles(join(dir, entry.name), relative, depth + 1));
    } else if (entry.name.startsWith('.env')) {
      found.push(relative);
    }
  }
  return found;
}

test('every real environment file anywhere in the tree is excluded', () => {
  // Read what is actually on disk rather than a hard-coded list, so a new
  // secrets file is caught the moment someone creates one.
  const rules = loadRules();
  const real = findEnvFiles().filter((path) => !path.endsWith('.example'));
  for (const path of real) {
    assert.ok(isExcluded(path, rules), `${path} would be uploaded into the Docker build context`);
  }
});

test('a nested environment file would also be excluded', () => {
  // A fixture rather than a real file, so the guarantee holds for paths that do
  // not happen to exist today.
  const rules = loadRules();
  for (const path of [
    'apps/ai-bff/.env',
    'packages/ai-store/.env.local',
    'apps/site/.env.production',
  ]) {
    assert.ok(isExcluded(path, rules), `${path} would be uploaded into the Docker build context`);
  }
});

test('example environment files are still available to the build', () => {
  const rules = loadRules();
  const examples = readdirSync(repoRoot).filter(
    (name) => name.startsWith('.env') && name.endsWith('.example'),
  );
  for (const name of examples) {
    assert.equal(isExcluded(name, rules), false, `${name} should remain in the context`);
  }
});

test('credential-shaped files are excluded by pattern, not by name', () => {
  const rules = loadRules();
  const paths = [
    '.env.production',
    '.env.staging.local',
    'server.key',
    'cert.pem',
    '.npmrc',
    'id_rsa',
  ];
  for (const path of paths) {
    assert.ok(isExcluded(path, rules), `${path} is not excluded from the build context`);
  }
});

test('git and agent state stay out of the context', () => {
  const rules = loadRules();
  const paths = [
    '.git',
    '.git/config',
    '.claude',
    '.claude/settings.json',
    '.github/workflows/ci.yml',
  ];
  for (const path of paths) {
    assert.ok(isExcluded(path, rules), `${path} would be uploaded into the Docker build context`);
  }
});

test('dependency and build output stay out at any depth', () => {
  const rules = loadRules();
  const paths = [
    'node_modules',
    'node_modules/pg/index.js',
    'apps/site/node_modules/x',
    'output',
    'coverage',
  ];
  for (const path of paths) {
    assert.ok(isExcluded(path, rules), `${path} would be uploaded into the Docker build context`);
  }
});

test('the sources the images actually build from are NOT excluded', () => {
  // A .dockerignore that excluded the application would fail the build loudly,
  // but one that excluded a single needed file fails subtly and late.
  const rules = loadRules();
  const needed = [
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'tsconfig.base.json',
    'apps/ai-bff/src/main.ts',
    'apps/ai-bff/dev/chat.html',
    'apps/ai-bff/policy/public-sales-v1.txt',
    'packages/ai-engine/src/index.ts',
    'packages/ai-engine-anythingllm/src/engine.ts',
    'packages/ai-store/src/pool.ts',
  ];
  for (const path of needed) {
    assert.equal(
      isExcluded(path, rules),
      false,
      `${path} is needed by the image build but excluded`,
    );
  }
});

test('the PostgreSQL CA bundle the images copy survives the build context, and only as .crt', () => {
  // Both images copy certs/tencentdb-postgres-ca.crt so DATABASE_URL can point
  // sslrootcert at it with sslmode=verify-full. This file excludes *.pem to keep
  // private keys out of images, so the SAME certificate saved as .pem is dropped
  // silently: the build succeeds, the image has no trust anchors, and every
  // database connection is refused at startup with nothing wrong in the Dockerfile.
  const rules = loadRules();
  assert.equal(
    isExcluded('certs/tencentdb-postgres-ca.crt', rules),
    false,
    'the CA bundle is excluded from the build context, so the images would ship without it',
  );
  assert.equal(
    isExcluded('certs/tencentdb-postgres-ca.pem', rules),
    true,
    'a .pem is no longer excluded — check the private-key rule was not weakened before renaming the CA bundle',
  );
});
