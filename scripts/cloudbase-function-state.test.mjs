import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { waitForFunctionActive } from './cloudbase-function-state.mjs';

function harness(states, options = {}) {
  let time = 0;
  let reads = 0;
  const pauses = [];
  const logs = [];
  return {
    run: () =>
      waitForFunctionActive({
        functionName: 'admin',
        readState: () => ({ detail: states[Math.min(reads++, states.length - 1)] }),
        timeoutMs: 20_000,
        pollIntervalMs: 5_000,
        sleep: (ms) => {
          pauses.push(ms);
          time += ms;
        },
        now: () => time,
        log: (message) => logs.push(message),
        ...options,
      }),
    pauses,
    logs,
    reads: () => reads,
  };
}

test('real Updating + Available response waits until lifecycle Active before config can start', () => {
  const active = { Status: 'Active', AvailableStatus: 'Available', Runtime: 'Nodejs20.19' };
  const h = harness([
    { Status: 'Updating', AvailableStatus: 'Available' },
    { Status: 'Updating', AvailableStatus: 'Available' },
    active,
  ]);
  assert.equal(h.run(), active);
  assert.deepEqual(h.pauses, [5_000, 5_000]);
  assert.equal(h.reads(), 3);
});

test('billing Available alone and unknown lifecycle never unlock deployment', () => {
  for (const detail of [
    undefined,
    {},
    { AvailableStatus: 'Available' },
    { Status: 'Creating', AvailableStatus: 'Available' },
    { Status: 'Updating', AvailableStatus: 'Available' },
    { Status: 'Publishing', AvailableStatus: 'Available' },
    { Status: 'Unknown', AvailableStatus: 'Available' },
  ]) {
    const h = harness([detail]);
    assert.throws(h.run, /did not become active within 20000ms/);
    assert.equal(h.reads(), 4);
    assert.equal(
      h.pauses.reduce((a, b) => a + b, 0),
      20_000,
    );
  }
});

test('failed lifecycle and unavailable billing fail immediately, without logging environment values', () => {
  for (const status of [
    'CreateFailed',
    'UpdateFailed',
    'PublishFailed',
    'DeleteFailed',
    'Deleted',
  ]) {
    const h = harness([
      { Status: status, AvailableStatus: 'Available', Environment: { secret: 'not-for-logs' } },
    ]);
    assert.throws(
      h.run,
      (error) => /lifecycle failed/.test(error.message) && !error.message.includes('not-for-logs'),
    );
    assert.deepEqual(h.pauses, []);
  }
  assert.throws(
    harness([{ Status: 'Active', AvailableStatus: 'InsufficientBalance' }]).run,
    /billing unavailable/,
  );
});

test('Active without optional billing field succeeds; query authentication errors propagate', () => {
  assert.equal(harness([{ Status: 'Active' }]).run().Status, 'Active');
  const error = new Error('credentials expired');
  assert.throws(
    harness([], {
      readState: () => {
        throw error;
      },
    }).run,
    (value) => value === error,
  );
});

test('deployment uses the same tested waiter before code, after code and after configuration', () => {
  const source = readFileSync(new URL('./deploy-cloudbase-test.mjs', import.meta.url), 'utf8');
  assert.match(source, /return waitForFunctionActive\(/);
  const deploy = source.slice(
    source.indexOf('function deployFunction(def)'),
    source.indexOf('function ensureGateway(def)'),
  );
  for (const marker of [
    'if (before) waitForActive(def.name)',
    'deployFunctionWithCloudBaseCli(',
    'const after = waitForActive(def.name)',
    'updateFunctionConfig(def)',
    'const configAfter = waitForActive(def.name)',
  ])
    assert.ok(deploy.includes(marker), `Missing deployment phase: ${marker}`);
  assert.ok(
    deploy.indexOf('if (before) waitForActive(def.name)') <
      deploy.indexOf('deployFunctionWithCloudBaseCli('),
  );
  assert.ok(
    deploy.indexOf('const after = waitForActive(def.name)') <
      deploy.indexOf('updateFunctionConfig(def)'),
  );
  assert.ok(
    deploy.indexOf('const configAfter = waitForActive(def.name)') >
      deploy.indexOf('updateFunctionConfig(def)'),
  );
});
