import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  HEAVY_SITE_TEST_FILES,
  siteTestFiles,
  siteTestShard,
} from '../apps/site/scripts/test-shard.mjs';

test('the site test shards cover every site test file exactly once', () => {
  const tracked = execFileSync('git', ['ls-files', 'apps/site/src'], { encoding: 'utf8' })
    .split('\n')
    .filter((path) => path.endsWith('.test.ts'))
    .map((path) => path.slice('apps/site/'.length))
    .sort();
  const files = siteTestFiles();
  for (const path of tracked) assert.ok(files.includes(path), `${path} is in no shard`);
  const heavy = siteTestShard('heavy', files);
  const rest = siteTestShard('rest', files);
  assert.deepEqual([...heavy, ...rest].sort(), files);
  assert.equal(new Set([...heavy, ...rest]).size, files.length);
  assert.deepEqual(heavy, [...HEAVY_SITE_TEST_FILES]);
  // The package script still runs the same files in one go for local use.
  const scripts = JSON.parse(readFileSync('apps/site/package.json', 'utf8')).scripts;
  assert.match(scripts.test, /tsx --test --test-concurrency=2 "src\/\*\*\/\*\.test\.ts"/);
});

test('a new site test file lands in the rest shard, and a missing heavy file stops the run', () => {
  const files = [...HEAVY_SITE_TEST_FILES, 'src/new-feature.test.ts'];
  assert.deepEqual(siteTestShard('rest', files), ['src/new-feature.test.ts']);
  assert.throws(() => siteTestShard('heavy', ['src/new-feature.test.ts']), /missing/);
  assert.throws(() => siteTestShard('all', files), /heavy or rest/);
});
