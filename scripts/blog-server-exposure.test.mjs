import assert from 'node:assert/strict';
import test from 'node:test';
import { exposeBlogServer } from './blog/server-exposure.mjs';
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
