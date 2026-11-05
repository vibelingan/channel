import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('cross-repository browser probe refuses remote and non-dedicated database destinations before starting', () => {
  for (const [database, intake] of [
    ['postgres://test@production.example.invalid/assistant_sales_test', 'http://127.0.0.1:1'],
    ['postgres://test@127.0.0.1/postgres', 'http://127.0.0.1:1'],
    ['postgres://test@127.0.0.1/assistant_sales_test', 'https://supplychainsai.com'],
  ]) {
    const result = spawnSync(
      process.execPath,
      ['apps/site/node_modules/tsx/dist/cli.mjs', 'scripts/assistant-sales-browser.mts'],
      {
        encoding: 'utf8',
        timeout: 15000,
        env: {
          ...process.env,
          SALES_ASSISTANT_TEST_DATABASE_URL: database,
          SALES_ASSISTANT_TEST_ORIGIN: intake,
        },
      },
    );
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /AssertionError/);
    assert.doesNotMatch(result.stderr, /ECONNREFUSED|ENOTFOUND|ERR_MODULE_NOT_FOUND/);
  }
});
