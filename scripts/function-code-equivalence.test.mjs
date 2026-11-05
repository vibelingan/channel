import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { provenUnchangedFunctionCode } from './function-code-equivalence.mjs';

const running = { releaseId: 'a'.repeat(40), buildTime: '2026-11-04T17:56:05.197Z' };
const current = { releaseId: 'b'.repeat(40), buildTime: '2026-11-05T13:10:00+08:00' };
// The minified shape tsup's define produces for the two stamp values.
const bundle = (stamp, body = 'module.exports=1') =>
  `var fHe=${JSON.stringify(stamp.releaseId)},mHe=${JSON.stringify(stamp.buildTime)};${body}\n`;
const packageJson = '{"name":"channel-public-api","main":"index.js"}\n';

function write(directory, files) {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(directory, path, '..'), { recursive: true });
    writeFileSync(join(directory, path), body);
  }
}

function setup(t, { deployed = {}, artifact = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'function-equivalence-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'deployed');
  const artifactDir = join(root, 'artifact');
  write(source, {
    'index.js': bundle(running),
    'package.json': packageJson,
    'decoder/native.node': Buffer.from([0, 1, 2, 3]),
    ...deployed,
  });
  write(artifactDir, {
    'index.js': bundle(current),
    'package.json': packageJson,
    'decoder/native.node': Buffer.from([0, 1, 2, 3]),
    ...artifact,
  });
  const deployedZip = join(root, 'deployed.zip');
  execFileSync('zip', ['-q', '-r', '-X', deployedZip, '.'], { cwd: source });
  return { artifactDir, deployedZip };
}

const prove = (f, stamps = {}) =>
  provenUnchangedFunctionCode({
    ...f,
    deployedStamp: stamps.deployedStamp ?? running,
    currentStamp: stamps.currentStamp ?? current,
  });

test('a package equal to the new build apart from its stamp is proven unchanged', (t) => {
  assert.equal(prove(setup(t)), true);
});

test('a rerun of the same commit is proven unchanged when the package bytes are identical', (t) => {
  const f = setup(t, { deployed: { 'index.js': bundle(current) } });
  assert.equal(prove(f, { deployedStamp: current }), true);
});

test('any other byte difference in the bundle or another file means upload', (t) => {
  assert.equal(
    prove(setup(t, { artifact: { 'index.js': bundle(current, 'exports.a=2') } })),
    false,
  );
  assert.equal(prove(setup(t, { artifact: { 'package.json': '{"name":"other"}\n' } })), false);
  assert.equal(
    prove(setup(t, { artifact: { 'decoder/native.node': Buffer.from([0, 1, 2, 4]) } })),
    false,
  );
});

test('a file present on only one side means upload', (t) => {
  assert.equal(prove(setup(t, { artifact: { 'extra.js': 'x' } })), false);
  assert.equal(prove(setup(t, { deployed: { 'extra.js': 'x' } })), false);
});

test('stamps that are missing, malformed or not in the bundle mean upload', (t) => {
  const f = setup(t);
  for (const stamps of [
    { deployedStamp: { releaseId: 'local', buildTime: running.buildTime } },
    { deployedStamp: { releaseId: running.releaseId, buildTime: 'local' } },
    { deployedStamp: {} },
    { currentStamp: { releaseId: current.releaseId, buildTime: undefined } },
  ])
    assert.equal(prove(f, stamps), false);
  // The stamp the health check reported is not the one inside the running package.
  assert.equal(
    prove(f, { deployedStamp: { releaseId: 'c'.repeat(40), buildTime: running.buildTime } }),
    false,
  );
  const unstamped = setup(t, { artifact: { 'index.js': 'module.exports=1\n' } });
  assert.equal(prove(unstamped), false);
});

test('an unreadable or absent deployed package means upload', (t) => {
  const f = setup(t);
  assert.equal(prove({ ...f, deployedZip: join(f.artifactDir, 'missing.zip') }), false);
  assert.equal(prove({ ...f, deployedZip: join(f.artifactDir, 'package.json') }), false);
});

test('an unsafe deployed entry name is never compared', (t) => {
  const f = setup(t);
  const run = (command, args, options) =>
    args[0] === '-Z1' ? '../escape.js\nindex.js\n' : execFileSync(command, args, options);
  assert.equal(
    provenUnchangedFunctionCode({ ...f, deployedStamp: running, currentStamp: current, run }),
    false,
  );
});
