import assert from 'node:assert/strict';
import test from 'node:test';
import { exposeBlogServer as runExposure } from './blog/server-exposure.mjs';
function exposeBlogServer(options) {
  let writes = 0;
  return runExposure({
    readDeployment: async () => ({ taskId: String(writes), kind: 'CONFIG', ready: true }),
    verifyRestored: async () => {},
    ...options,
    client: {
      async call(...args) {
        writes++;
        return options.client.call(...args);
      },
    },
  });
}
test('exposure patches only its staging key and verifies the running service after a lost acknowledgement', async () => {
  const calls = [];
  const records = [];
  let active = false;
  let verified = false;
  await exposeBlogServer({
    client: {
      async call(name, input) {
        calls.push({ name, input });
        active = true;
        throw Error('lost ack');
      },
    },
    readHealth: async () => ({ releaseId: 'a'.repeat(40), previewOnly: !active }),
    save: async (row) => {
      records.push(row);
    },
    verify: async () => {
      verified = true;
    },
  });
  assert.deepEqual(calls, [
    {
      name: 'manageCloudRun',
      input: {
        action: 'updateConfig',
        serverName: 'blog-pages',
        envParamsReplaceAll: false,
        serverConfig: { EnvParams: '{"BLOG_PREVIEW_ONLY":"0"}' },
      },
    },
  ]);
  assert.equal(records[0].prior, '1');
  assert.equal(records.at(-1).phase, 'accepted');
  assert(verified);
});
test('exposure never accepts a different running program', async () => {
  let active = false;
  let verified = false;
  await assert.rejects(
    exposeBlogServer({
      client: {
        async call() {
          active = true;
        },
      },
      readHealth: async () => ({
        releaseId: (active ? 'b' : 'a').repeat(40),
        previewOnly: !active,
      }),
      save: async () => {},
      verify: async () => {
        verified = true;
      },
    }),
    /Another Blog program/,
  );
  assert.equal(verified, false);
});
test('an unconfirmed config write is bounded and not repeated', async () => {
  let time = 0;
  let writes = 0;
  await assert.rejects(
    exposeBlogServer({
      client: {
        async call() {
          writes++;
        },
      },
      readHealth: async () => ({ releaseId: 'a'.repeat(40), previewOnly: true }),
      save: async () => {},
      verify: async () => {
        throw Error('unexpected');
      },
      now: () => time,
      pause: async () => {
        time += 10;
      },
      timeoutMs: 20,
    }),
    /unconfirmed/,
  );
  assert.equal(writes, 1);
});

test('failed verification restores only the indexing key, including a lost restore acknowledgement', async () => {
  let previewOnly = true;
  const writes = [];
  const records = [];
  await assert.rejects(
    exposeBlogServer({
      client: {
        async call(name, input) {
          writes.push({ name, input });
          previewOnly = JSON.parse(input.serverConfig.EnvParams).BLOG_PREVIEW_ONLY === '1';
          if (previewOnly) throw Error('lost restore reply');
        },
      },
      readHealth: async () => ({ releaseId: 'a'.repeat(40), previewOnly }),
      save: async (record) => {
        records.push(record);
      },
      verify: async () => {
        throw Error('public article failed');
      },
    }),
    /original indexing restriction was restored/,
  );
  assert.equal(previewOnly, true);
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1].input.serverConfig, { EnvParams: '{"BLOG_PREVIEW_ONLY":"1"}' });
  assert.equal(writes[1].input.envParamsReplaceAll, false);
  assert.equal(records.at(-1).phase, 'restored');
  assert(!records.some((r) => r.phase === 'accepted'));
});

test('verification failure cannot restore over another deployed program', async () => {
  let reads = 0;
  let writes = 0;
  await assert.rejects(
    exposeBlogServer({
      client: {
        async call() {
          writes++;
        },
      },
      readHealth: async () => ({
        releaseId: (++reads > 2 ? 'b' : 'a').repeat(40),
        previewOnly: reads === 1,
      }),
      save: async () => {},
      verify: async () => {
        throw Error('failed');
      },
    }),
    /state changed/,
  );
  assert.equal(writes, 1);
});

test('an unconfirmed restore is reported as unconfirmed and never retried blindly', async () => {
  let time = 0;
  let writes = 0;
  await assert.rejects(
    exposeBlogServer({
      client: {
        async call() {
          writes++;
        },
      },
      readHealth: async () => ({ releaseId: 'a'.repeat(40), previewOnly: writes === 0 }),
      save: async () => {},
      verify: async () => {
        throw Error('failed');
      },
      now: () => time,
      pause: async () => {
        time += 10;
      },
      timeoutMs: 20,
    }),
    /restore is unconfirmed/,
  );
  assert.equal(writes, 2);
});

test('a failed durable backup prevents all cloud writes', async () => {
  let writes = 0;
  await assert.rejects(
    exposeBlogServer({
      client: {
        async call() {
          writes++;
        },
      },
      readHealth: async () => ({ releaseId: 'a'.repeat(40), previewOnly: true }),
      save: async () => {
        throw Error('archive unavailable');
      },
      verify: async () => {},
    }),
    /archive unavailable/,
  );
  assert.equal(writes, 0);
});

test('health changing before the platform release finishes cannot start verification', async () => {
  let time = 0;
  let writes = 0;
  let verified = false;
  await runExposure({
    client: {
      async call() {
        writes++;
        return { data: { taskId: 2 } };
      },
    },
    readHealth: async () => ({ releaseId: 'a'.repeat(40), previewOnly: writes === 0 }),
    readDeployment: async () => ({
      taskId: writes ? '2' : '1',
      kind: 'CONFIG',
      ready: time >= 20 || !writes,
    }),
    save: async () => {},
    verify: async () => {
      assert.equal(time, 20);
      verified = true;
    },
    verifyRestored: async () => {
      throw Error('unexpected');
    },
    now: () => time,
    pause: async () => {
      time += 10;
    },
    timeoutMs: 40,
  });
  assert(verified);
  assert.equal(writes, 1);
});

test('restore is not declared complete until its platform release and both entry points are verified', async () => {
  let time = 0;
  let writes = 0;
  let restored = false;
  const records = [];
  await assert.rejects(
    runExposure({
      client: {
        async call() {
          writes++;
          return { data: { taskId: writes + 1 } };
        },
      },
      readHealth: async () => ({ releaseId: 'a'.repeat(40), previewOnly: writes !== 1 }),
      readDeployment: async () => ({
        taskId: String(writes + 1),
        kind: 'CONFIG',
        ready: writes !== 2 || time >= 20,
      }),
      save: async (row) => {
        if (row.phase === 'restored') assert(restored);
        records.push(row);
      },
      verify: async () => {
        throw Error('formal domain did not converge');
      },
      verifyRestored: async () => {
        assert.equal(time, 20);
        restored = true;
      },
      now: () => time,
      pause: async () => {
        time += 10;
      },
      timeoutMs: 40,
    }),
    /original indexing restriction was restored/,
  );
  assert.equal(writes, 2);
  assert.equal(records.at(-1).taskId, '3');
});

test('another configuration task prevents verification and any restoring write', async () => {
  let writes = 0;
  await assert.rejects(
    runExposure({
      client: {
        async call() {
          writes++;
          return { data: { taskId: 2 } };
        },
      },
      readHealth: async () => ({ releaseId: 'a'.repeat(40), previewOnly: !writes }),
      readDeployment: async () => ({ taskId: writes ? '3' : '1', kind: 'CONFIG', ready: true }),
      save: async () => {},
      verify: async () => {
        throw Error('unexpected');
      },
    }),
    /Another Blog deployment/,
  );
  assert.equal(writes, 1);
});

test('an existing in-progress deployment prevents even the first config write', async () => {
  let writes = 0;
  await assert.rejects(
    runExposure({
      client: {
        async call() {
          writes++;
        },
      },
      readHealth: async () => ({ releaseId: 'a'.repeat(40), previewOnly: true }),
      readDeployment: async () => ({ taskId: '1', kind: 'CONFIG', ready: false }),
    }),
    /still in progress/,
  );
  assert.equal(writes, 0);
});

test('a failed verification of the restored formal domain cannot produce a restored receipt', async () => {
  let writes = 0;
  const records = [];
  await assert.rejects(
    exposeBlogServer({
      client: {
        async call() {
          writes++;
        },
      },
      readHealth: async () => ({ releaseId: 'a'.repeat(40), previewOnly: writes !== 1 }),
      save: async (row) => {
        records.push(row);
      },
      verify: async () => {
        throw Error('open did not converge');
      },
      verifyRestored: async () => {
        throw Error('restored domain not confirmed');
      },
    }),
    /restored domain not confirmed/,
  );
  assert.equal(writes, 2);
  assert.equal(records.at(-1).phase, 'restore-before');
});
