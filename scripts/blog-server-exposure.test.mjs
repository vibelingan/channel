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
