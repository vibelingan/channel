import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const readJson = (name) => JSON.parse(readFileSync(resolve(root, name), 'utf8'));

test('cloud skill installer rejects unsafe archives and preserves existing files', () => {
  const result = spawnSync('python3', ['scripts/cloud-handoff/test_install_skills.py'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stderr, /Ran 8 tests/);
});

test('cloud shell entry points parse without executing setup or authentication', () => {
  for (const script of ['setup.sh', 'check.sh', 'mcp.sh']) {
    const result = spawnSync('bash', ['-n', `scripts/cloud-handoff/${script}`], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  }
});

test('cloud tools remain pinned, isolated, credential free and do not import personal config', () => {
  const manifest = readJson('tools/cloud-handoff/package.json');
  const lock = readJson('tools/cloud-handoff/package-lock.json');
  const project = readJson('package.json');
  assert.equal(manifest.engines.node, '22.13.0');
  assert.equal(project.packageManager, `pnpm@${manifest.dependencies.pnpm}`);
  assert.deepEqual(lock.packages[''].dependencies, manifest.dependencies);
  for (const [name, version] of Object.entries(manifest.dependencies)) {
    assert.match(version, /^\d+\.\d+\.\d+$/);
    assert.equal(lock.packages[`node_modules/${name}`].version, version);
  }
  for (const entry of Object.values(lock.packages)) {
    if (entry.resolved) assert.match(entry.resolved, /^https:\/\/registry\.npmjs\.org\//);
  }
  const config = readJson('docs/cloud-handoff/mcporter.json');
  assert.deepEqual(config.imports, []);
  assert.deepEqual(Object.keys(config.mcpServers), ['cloudbase']);
  assert.deepEqual(Object.keys(config.mcpServers.cloudbase).sort(), ['command', 'description']);
  assert.equal(
    resolve(root, 'docs/cloud-handoff', config.mcpServers.cloudbase.command),
    resolve(root, 'tools/cloud-handoff/node_modules/.bin/cloudbase-mcp'),
  );
});
