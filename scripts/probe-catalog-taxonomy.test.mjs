import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { inspect } from 'node:util';
import {
  bootstrapProbe,
  cleanupProbe,
  probeFailure,
  runTransactionProbe,
} from './probe-catalog-taxonomy-helpers.mjs';

const fakeSecret = 'FAKE_SECRET_MUST_NOT_ESCAPE_7829';
const credentials = { secretId: 'fixture-id', secretKey: fakeSecret, token: 'fixture-token' };

function assertSanitized(error, code) {
  assert.ok(error instanceof Error);
  assert.equal(error.code, code);
  assert.equal(Object.hasOwn(error, 'cause'), false);
  const rendered = inspect(error, { showHidden: true, depth: null });
  assert.ok(!rendered.includes(fakeSecret), 'error must not retain credential material');
  assert.ok(!rendered.includes('stdout'), 'error must not retain captured command output');
  assert.ok(!JSON.stringify(probeFailure(error)).includes(fakeSecret));
  return true;
}

function bootstrapOptions(overrides = {}) {
  return {
    envId: 'fixture-env',
    allowIsolatedWrites: true,
    cli: () => JSON.stringify({ data: credentials }),
    loadSdk: () => ({ init: () => ({ database: () => ({ command: {} }) }) }),
    ...overrides,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function manualTimer() {
  let fire;
  let cleared = false;
  return {
    options: {
      setTimer(callback) {
        fire = callback;
        return 1;
      },
      clearTimer() {
        cleared = true;
      },
    },
    fire: () => fire(),
    get cleared() {
      return cleared;
    },
  };
}

test('bootstrap replaces a command exception containing captured secret stdout', () => {
  assert.throws(
    () =>
      bootstrapProbe(
        bootstrapOptions({
          cli: () =>
            execFileSync(
              process.execPath,
              ['-e', `process.stdout.write(${JSON.stringify(fakeSecret)}); process.exit(1)`],
              { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 },
            ),
        }),
      ),
    (error) => assertSanitized(error, 'PROBE_BOOTSTRAP_FAILED'),
  );
});

test('bootstrap sanitizes malformed JSON, unsupported keys, SDK loading and initialization', () => {
  for (const response of [
    `${fakeSecret}{`,
    JSON.stringify({ [fakeSecret]: fakeSecret }),
    'null',
    JSON.stringify({ data: { secretId: 'id', secretKey: fakeSecret } }),
  ]) {
    assert.throws(
      () => bootstrapProbe(bootstrapOptions({ cli: () => response })),
      (error) => assertSanitized(error, 'PROBE_BOOTSTRAP_FAILED'),
    );
  }
  for (const stage of ['load', 'init', 'database']) {
    const fail = () => {
      throw Object.assign(new Error(fakeSecret), { stdout: fakeSecret, cause: fakeSecret });
    };
    assert.throws(
      () =>
        bootstrapProbe(
          bootstrapOptions({
            loadSdk:
              stage === 'load'
                ? fail
                : () => ({
                    init: stage === 'init' ? fail : () => ({ database: fail }),
                  }),
          }),
        ),
      (error) => assertSanitized(error, 'PROBE_BOOTSTRAP_FAILED'),
    );
  }
});

test('bootstrap guards run before credentials and SDK loading; request timeout is explicit', () => {
  for (const guards of [{ envId: '' }, { allowIsolatedWrites: false }]) {
    let touched = false;
    const fail = () => {
      touched = true;
      throw new Error('must not run');
    };
    assert.throws(() => bootstrapProbe(bootstrapOptions({ ...guards, cli: fail, loadSdk: fail })));
    assert.equal(touched, false);
  }
  let config;
  const database = {};
  assert.equal(
    bootstrapProbe(
      bootstrapOptions({
        loadSdk: () => ({
          init(options) {
            config = options;
            return { database: () => database };
          },
        }),
      }),
    ),
    database,
  );
  assert.equal(config.timeout, 15000);
  assert.equal(config.env, 'fixture-env');
});

test('failure JSON accepts only fixed error codes, never arbitrary names, keys or operators', () => {
  for (const error of [
    { code: fakeSecret, name: fakeSecret, operator: fakeSecret, message: fakeSecret },
    { code: 'Unknown.But.Looks.Safe', name: fakeSecret },
    null,
  ]) {
    assert.deepEqual(probeFailure(error), { phase: 'probe-failed', code: 'PROBE_FAILED' });
  }
  assert.deepEqual(probeFailure({ code: 'ETIMEDOUT' }), {
    phase: 'probe-failed',
    code: 'ETIMEDOUT',
  });
});

test('deadline waits for both transactions to settle before cleanup and prevents late writes', async () => {
  const timer = manualTimer();
  const waiting = deferred();
  const slowRead = deferred();
  const events = [];
  let started = 0;
  const database = {
    async runTransaction(callback) {
      const transactionId = ++started;
      try {
        return await callback({
          collection: () => ({
            doc: () => ({
              async get() {
                if (transactionId === 2) await slowRead.promise;
                else waiting.resolve();
                return { data: { revision: 0 } };
              },
              async set() {
                events.push('write');
              },
            }),
          }),
        });
      } finally {
        events.push(`settled-${transactionId}`);
      }
    },
  };
  const probe = runTransactionProbe({
    database,
    collectionName: 'fixture',
    registryId: 'registry',
    ...timer.options,
  }).finally(() => events.push('cleanup'));
  const rejected = assert.rejects(probe, (error) => assertSanitized(error, 'PROBE_TIMEOUT'));
  await waiting.promise;
  timer.fire();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.includes('cleanup'), false);
  slowRead.resolve();
  await rejected;
  assert.deepEqual(events, ['settled-1', 'settled-2', 'cleanup']);
  assert.equal(timer.cleared, true);
});

test('first transaction failure releases its waiting sibling without waiting for the deadline', async () => {
  const timer = manualTimer();
  let started = 0;
  let settled = 0;
  let writes = 0;
  const database = {
    async runTransaction(callback) {
      const transactionId = ++started;
      try {
        if (transactionId === 2) throw new Error(fakeSecret);
        return await callback({
          collection: () => ({
            doc: () => ({
              get: async () => ({ data: { revision: 0 } }),
              set: async () => {
                writes++;
              },
            }),
          }),
        });
      } finally {
        settled++;
      }
    },
  };
  await assert.rejects(
    runTransactionProbe({
      database,
      collectionName: 'fixture',
      registryId: 'registry',
      ...timer.options,
    }),
    (error) => assertSanitized(error, 'PROBE_TRANSACTION_FAILED'),
  );
  assert.equal(settled, 2);
  assert.equal(writes, 0);
  assert.equal(timer.cleared, true);
});

test('successful competing transactions preserve saved/conflict results across SDK retry', async () => {
  const timer = manualTimer();
  let committed = false;
  let callbacks = 0;
  const database = {
    async runTransaction(callback) {
      const transaction = {
        collection: () => ({
          doc: () => ({
            get: async () => ({ data: [{ revision: committed ? 1 : 0 }] }),
            set: async () => {},
          }),
        }),
      };
      callbacks++;
      const result = await callback(transaction);
      if (committed) {
        callbacks++;
        return callback(transaction);
      }
      committed = true;
      return result;
    },
  };
  const outcomes = await runTransactionProbe({
    database,
    collectionName: 'fixture',
    registryId: 'registry',
    ...timer.options,
  });
  assert.deepEqual(outcomes, ['conflict', 'saved']);
  assert.equal(callbacks, 3);
  assert.equal(timer.cleared, true);
});

test('deadline drains in-flight writes and SDK completion before actual cleanup', async () => {
  const timer = manualTimer();
  const writesStarted = deferred();
  const finishWrites = deferred();
  const completionStarted = deferred();
  const finishCompletion = deferred();
  const events = [];
  let writes = 0;
  let completing = 0;
  let settled = 0;
  const database = {
    async runTransaction(callback) {
      const result = await callback({
        collection: () => ({
          doc: () => ({
            get: async () => ({ data: { revision: 0 } }),
            async set() {
              if (++writes === 2) writesStarted.resolve();
              await finishWrites.promise;
              events.push('write-finished');
            },
          }),
        }),
      });
      if (++completing === 2) completionStarted.resolve();
      await finishCompletion.promise;
      settled++;
      events.push('transaction-settled');
      return result;
    },
  };
  const probe = runTransactionProbe({
    database,
    collectionName: 'fixture',
    registryId: 'registry',
    ...timer.options,
  }).finally(() =>
    cleanupProbe({
      collectionName: 'fixture',
      writtenIds: ['registry'],
      collection: {
        doc: () => ({
          async remove() {
            assert.equal(settled, 2);
            events.push('cleanup');
          },
        }),
        count: async () => ({ total: 0 }),
      },
    }),
  );
  const rejected = assert.rejects(probe, (error) => assertSanitized(error, 'PROBE_TIMEOUT'));
  await writesStarted.promise;
  timer.fire();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, []);
  finishWrites.resolve();
  await completionStarted.promise;
  assert.deepEqual(events, ['write-finished', 'write-finished']);
  finishCompletion.resolve();
  await rejected;
  assert.deepEqual(events, [
    'write-finished',
    'write-finished',
    'transaction-settled',
    'transaction-settled',
    'cleanup',
  ]);
});

test('cleanup preserves the successful 131 removed, zero remaining summary', async () => {
  const writtenIds = Array.from({ length: 131 }, (_, index) => `fixture-${index}`);
  const removed = [];
  const logs = [];
  await cleanupProbe({
    collectionName: 'fixture',
    writtenIds,
    log: (record) => logs.push(record),
    collection: {
      doc: (id) => ({ remove: async () => removed.push(id) }),
      count: async () => ({ total: 0 }),
    },
  });
  assert.deepEqual(removed, writtenIds);
  assert.deepEqual(logs, [
    {
      phase: 'cleanup',
      collectionName: 'fixture',
      expected: 131,
      cleaned: 131,
      remaining: 0,
      emptyCollectionRetained: true,
    },
  ]);
});

test('cleanup rejects remaining documents and never logs a malformed secret count', async () => {
  for (const total of [1, fakeSecret]) {
    const logs = [];
    await assert.rejects(
      cleanupProbe({
        collectionName: 'fixture',
        writtenIds: [],
        log: (record) => logs.push(record),
        collection: { count: async () => ({ total }) },
      }),
      (error) => assertSanitized(error, 'PROBE_CLEANUP_FAILED'),
    );
    assert.ok(!JSON.stringify(logs).includes(fakeSecret));
  }
});

test('cleanup count failures are sanitized and all removals are attempted', async () => {
  const removed = [];
  const logs = [];
  await assert.rejects(
    cleanupProbe({
      collectionName: 'fixture',
      writtenIds: ['first', 'second'],
      log: (record) => logs.push(record),
      collection: {
        doc: (id) => ({
          async remove() {
            removed.push(id);
            if (id === 'first') throw new Error(fakeSecret);
          },
        }),
        async count() {
          throw Object.assign(new Error(fakeSecret), { code: fakeSecret });
        },
      },
    }),
    (error) => assertSanitized(error, 'PROBE_CLEANUP_FAILED'),
  );
  assert.deepEqual(removed, ['first', 'second']);
  assert.ok(!JSON.stringify(logs).includes(fakeSecret));
});

test('importing the executable does not require environment, credentials or CloudBase', () => {
  const stdout = execFileSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--input-type=module',
      '-e',
      `await import(${JSON.stringify(new URL('./probe-catalog-taxonomy.mjs', import.meta.url).href)})`,
    ],
    { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 },
  );
  assert.equal(stdout.toString(), '');
});
