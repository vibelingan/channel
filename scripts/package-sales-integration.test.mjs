import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { packageSalesIntegration } from './package-sales-integration.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'sales-package-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  mkdirSync(join(root, 'apps/functions/sales-integration/src'), { recursive: true });
  mkdirSync(join(root, 'packages/example'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@11.5.0' }));
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  writeFileSync(
    join(root, 'pnpm-workspace.yaml'),
    'packages: ["packages/*", "apps/functions/*"]\n',
  );
  writeFileSync(join(root, 'tsconfig.base.json'), '{}');
  writeFileSync(join(root, 'packages/example/package.json'), '{}');
  writeFileSync(
    join(root, 'apps/functions/sales-integration/package.json'),
    JSON.stringify({
      name: '@vibelingan-channel/fn-sales-integration',
    }),
  );
  const source = join(root, 'apps/functions/sales-integration/src/sentinel.ts');
  writeFileSync(source, 'committed-source');
  git(['init', '-q']);
  git(['config', 'user.email', 'fixture@example.invalid']);
  git(['config', 'user.name', 'Package fixture']);
  const commit = () => {
    git(['add', '.']);
    git(['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture']);
    return git(['rev-parse', 'HEAD']);
  };
  return { root, git, source, commit, sha: commit(), output: join(root, 'release') };
}

function builder({ version = '11.5.0', extra = false } = {}) {
  const calls = [];
  return {
    calls,
    run(file, args, options) {
      if (file !== 'pnpm') return execFileSync(file, args, options);
      calls.push({ args, env: options.env });
      if (args[0] === '--version') return version;
      const path = join(options.cwd, 'apps/functions/sales-integration/dist/package');
      if (args.at(-1) === 'build') {
        const source = readFileSync(
          join(options.cwd, 'apps/functions/sales-integration/src/sentinel.ts'),
        );
        mkdirSync(path, { recursive: true });
        writeFileSync(join(path, 'index.js'), source);
        writeFileSync(join(path, 'reconcile.js'), 'reconcile');
      }
      if (args.at(-1) === 'package:artifact') {
        writeFileSync(join(path, 'scf_bootstrap'), '#!/bin/sh\nexec node index.js\n');
        writeFileSync(join(path, 'package.json'), '{"private":true}');
        if (extra) writeFileSync(join(path, '.env'), 'must-not-ship');
      }
      return '';
    },
  };
}

test('committed Sales snapshot is packaged despite dirty input; only four runtime files ship', (t) => {
  const f = fixture(t);
  writeFileSync(f.source, 'uncommitted-source');
  writeFileSync(join(f.root, 'packages/untracked.env'), 'untracked-private-content');
  const b = builder();
  const previous = process.env.SALES_PRIVATE_FIXTURE;
  process.env.SALES_PRIVATE_FIXTURE = 'environment-private-content';
  try {
    const result = packageSalesIntegration({ ...f, run: b.run });
    assert.equal(result.commit, f.sha);
    assert.equal(readFileSync(join(f.output, 'package/index.js'), 'utf8'), 'committed-source');
    assert.equal(result.files.length, 4);
    assert.deepEqual(
      b.calls.map(({ args }) => args),
      [
        ['--version'],
        ['--filter', '@vibelingan-channel/fn-sales-integration...', 'install', '--frozen-lockfile'],
        ...['build', 'package:artifact', 'check:artifact'].map((name) => [
          '--filter',
          '@vibelingan-channel/fn-sales-integration',
          name,
        ]),
      ],
    );
    assert.ok(b.calls.every(({ env }) => env.SALES_PRIVATE_FIXTURE === undefined));
    const zip = readFileSync(join(f.output, result.zip.name));
    assert.equal(result.zip.sha256, createHash('sha256').update(zip).digest('hex'));
    assert.deepEqual(
      JSON.parse(readFileSync(join(f.output, 'manifest.json'))),
      Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'output')),
    );
    const entries = execFileSync('unzip', ['-Z1', join(f.output, result.zip.name)], {
      encoding: 'utf8',
    });
    assert.deepEqual(entries.trim().split('\n').sort(), [
      'index.js',
      'package.json',
      'reconcile.js',
      'scf_bootstrap',
    ]);
    assert.equal(readFileSync(f.source, 'utf8'), 'uncommitted-source');
  } finally {
    if (previous === undefined) delete process.env.SALES_PRIVATE_FIXTURE;
    else process.env.SALES_PRIVATE_FIXTURE = previous;
  }
});

test('branch names, abbreviated SHA and an existing output cannot become a release', (t) => {
  const f = fixture(t);
  for (const sha of ['HEAD', f.sha.slice(0, 7), '-bad', 'f'.repeat(40)])
    assert.throws(() => packageSalesIntegration({ ...f, sha, run: builder().run }));
  mkdirSync(f.output);
  writeFileSync(join(f.output, 'keep'), 'existing-release');
  assert.throws(() => packageSalesIntegration({ ...f, run: builder().run }), /new directory/);
  assert.equal(readFileSync(join(f.output, 'keep'), 'utf8'), 'existing-release');
});

test('unreviewed package files and mismatched pnpm fail before publishing an output', (t) => {
  const f = fixture(t);
  assert.throws(
    () => packageSalesIntegration({ ...f, run: builder({ extra: true }).run }),
    /unexpected files/,
  );
  assert.equal(existsSync(f.output), false);
  assert.throws(
    () => packageSalesIntegration({ ...f, run: builder({ version: '99.0.0' }).run }),
    /pnpm must match/,
  );
  assert.equal(existsSync(f.output), false);
});

test('committed symlinks are rejected instead of reading outside the fixed source snapshot', (t) => {
  const f = fixture(t);
  symlinkSync('/tmp/outside-private-fixture', join(f.root, 'packages/example/link'));
  const sha = f.commit();
  const b = builder();
  assert.throws(() => packageSalesIntegration({ ...f, sha, run: b.run }), /regular files/);
  assert.equal(b.calls.length, 0);
  assert.equal(existsSync(f.output), false);
});
