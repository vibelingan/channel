/**
 * The AI service images must install dependencies BEFORE copying the source.
 *
 * Copying the whole repository first meant any edit anywhere invalidated the
 * dependency layer, so every build reinstalled from scratch — 425 seconds for a
 * cold ai-bff image, past the runtime bundle check's limit, which then failed
 * with a Docker timeout that looked like a broken bundle.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function stage(dockerfile, name) {
  const start = dockerfile.indexOf(` AS ${name}\n`);
  assert.ok(start >= 0, `no "${name}" stage`);
  const next = dockerfile.indexOf('\nFROM ', start + 1);
  return dockerfile.slice(start, next === -1 ? undefined : next);
}

for (const service of ['ai-bff', 'ai-worker']) {
  test(`${service}: dependencies install before the source is copied`, () => {
    const dockerfile = readFileSync(join(repoRoot, `apps/${service}/Dockerfile`), 'utf8');
    const build = stage(dockerfile, 'build');
    const manifests = build.indexOf('COPY --from=manifests');
    const install = build.indexOf('RUN pnpm install --frozen-lockfile');
    const source = build.indexOf('COPY . .');
    assert.ok(manifests >= 0, 'the build stage does not copy the dependency manifests');
    assert.ok(install > manifests, 'dependencies must install after the manifests arrive');
    assert.ok(
      source > install,
      'the full source copy must come AFTER the install, or every edit reinstalls',
    );
  });

  test(`${service}: the manifests stage carries the lockfile and workspace file`, () => {
    const manifests = stage(
      readFileSync(join(repoRoot, `apps/${service}/Dockerfile`), 'utf8'),
      'manifests',
    );
    for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
      assert.ok(manifests.includes(file), `the manifests stage does not carry ${file}`);
    }
  });

  test(`${service}: the manifests stage scans every workspace root`, () => {
    // A workspace package under a directory the manifests stage does not scan
    // has no package.json in the build stage when dependencies install.
    const manifests = stage(
      readFileSync(join(repoRoot, `apps/${service}/Dockerfile`), 'utf8'),
      'manifests',
    );
    const scan = /find ((?:[\w.-]+ )+)-name package\.json/.exec(manifests);
    assert.ok(scan, 'the manifests stage does not collect workspace package.json files');
    const scanned = new Set(scan[1].trim().split(' '));

    const workspace = readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8');
    const globs = /^packages:\n((?:[ \t]+-.*\n?)+)/m.exec(workspace);
    assert.ok(globs, 'pnpm-workspace.yaml has no packages list');
    const roots = globs[1]
      .split('\n')
      .map((line) => /-\s*['"]?(?!!)([^/'"\s]+)/.exec(line)?.[1])
      .filter(Boolean);
    assert.ok(roots.length > 0, 'no workspace roots parsed from pnpm-workspace.yaml');
    for (const root of roots) {
      assert.ok(scanned.has(root), `workspace root "${root}" is not scanned for package.json`);
    }
  });
}

test('the bundle check allows a cold image build to finish', () => {
  const source = readFileSync(join(repoRoot, 'scripts/check-ai-runtime-bundle.mjs'), 'utf8');
  const build = source.slice(source.indexOf("'build', '--target', 'runtime'"));
  const limit = Number(/timeout:\s*([\d_]+)/.exec(build)?.[1]?.replaceAll('_', ''));
  assert.ok(
    limit >= 900_000,
    `docker build limit is ${limit}ms; a cold build measured 425s locally`,
  );
});
