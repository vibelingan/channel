import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
const script = new URL('./ci-ubuntu-archive.py', import.meta.url).pathname;

test('actual CI source preparation handles AWS, Azure and both APT formats without changing verification or other repositories', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ci-ubuntu-archive-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'sources.list.d'));
  const sources = {
    'sources.list':
      'deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] http://us-east-2.ec2.archive.ubuntu.com/ubuntu noble main universe\n',
    'apt-mirrors.txt': 'https://azure.archive.ubuntu.com/ubuntu/\n',
    'sources.list.d/ubuntu.sources':
      'Types: deb\nURIs: http://us-west-2.ec2.archive.ubuntu.com/ubuntu\nSuites: noble noble-updates\nComponents: main universe\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n',
    'sources.list.d/unchanged.list':
      'deb http://security.ubuntu.com/ubuntu noble-security main\ndeb https://packages.microsoft.com/repos/code stable main\ndeb http://archive.ubuntu.com/ubuntu noble main\ndeb https://archive.ubuntu.com.evil.example/ubuntu stable main\n',
  };
  for (const [name, text] of Object.entries(sources)) writeFileSync(join(root, name), text);
  const run = () => spawnSync('python3', [script, '--apt-dir', root], { encoding: 'utf8' });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /updated: 3/);
  for (const [name, text] of Object.entries(sources)) {
    const expected =
      name === 'apt-mirrors.txt'
        ? `https://archive.ubuntu.com/ubuntu/\tpriority:0\n${text}`
        : text
            .replaceAll('us-east-2.ec2.archive.ubuntu.com', 'archive.ubuntu.com')
            .replaceAll('us-west-2.ec2.archive.ubuntu.com', 'archive.ubuntu.com');
    assert.equal(readFileSync(join(root, name), 'utf8'), expected);
  }
  const second = run();
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /updated: 0/);
});

test('source preparation refuses a missing directory or linked file before changing the linked target', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ci-ubuntu-link-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const external = join(root, 'external');
  const original = 'http://azure.archive.ubuntu.com/ubuntu';
  writeFileSync(external, original);
  symlinkSync(external, join(root, 'sources.list'));
  for (const directory of [root, join(root, 'missing')]) {
    const run = spawnSync('python3', [script, '--apt-dir', directory], { encoding: 'utf8' });
    assert.notEqual(run.status, 0);
  }
  assert.equal(readFileSync(external, 'utf8'), original);
});

test('prioritizes the main mirror without losing the runner fallback sources', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ci-ubuntu-mirrors-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'apt-mirrors.txt');
  const original = [
    'http://azure.archive.ubuntu.com/ubuntu/\tpriority:1',
    'https://archive.ubuntu.com/ubuntu/\tpriority:2',
    'https://security.ubuntu.com/ubuntu/\tpriority:3',
    '',
  ].join('\n');
  writeFileSync(path, original);
  const run = () => spawnSync('python3', [script, '--apt-dir', root], { encoding: 'utf8' });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const expected = [
    'https://archive.ubuntu.com/ubuntu/\tpriority:0',
    'http://azure.archive.ubuntu.com/ubuntu/\tpriority:1',
    'https://security.ubuntu.com/ubuntu/\tpriority:3',
    '',
  ].join('\n');
  assert.equal(readFileSync(path, 'utf8'), expected);
  assert.match(run().stdout, /updated: 0/);
});
