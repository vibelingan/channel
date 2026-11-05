import assert from 'node:assert/strict';
import test from 'node:test';
import { callMcporter, callMcporterAsync } from './mcporter-call.mjs';

test('the tool receives the requested deadline before the process termination guard', () => {
  const reply = { success: true, data: { action: 'upload', cloudPath: 'owned/code.zip' } };
  let calls = 0;
  const actual = callMcporter(
    'cloudbase.manageStorage',
    { action: 'upload' },
    {
      cwd: '/owned/project',
      timeoutMs: 300_000,
      run(command, args, options) {
        calls++;
        assert.equal(command, 'npx');
        assert.equal(args[args.indexOf('--timeout') + 1], '300000');
        assert.deepEqual(JSON.parse(args[args.indexOf('--args') + 1]), { action: 'upload' });
        assert.equal(options.timeout, 310_000);
        assert.equal(options.cwd, '/owned/project');
        return JSON.stringify(reply);
      },
    },
  );
  assert.deepEqual(actual, reply);
  assert.equal(calls, 1);
});

for (const reply of [
  {
    server: 'cloudbase',
    tool: 'queryFunctions',
    error: 'Call timed out after 60000ms. private-signature',
    issue: { kind: 'offline', rawMessage: 'private-token' },
  },
  { isError: true, content: [{ type: 'text', text: 'private-token' }] },
]) {
  test(`a successful process exit cannot hide an MCP failure: ${Object.keys(reply)}`, () => {
    assert.throws(
      () =>
        callMcporter(
          'cloudbase.queryFunctions',
          {},
          {
            run: () => `tool restart notice\n${JSON.stringify(reply)}`,
          },
        ),
      (error) => {
        assert.match(error.message, /transport error/);
        assert.doesNotMatch(error.message, /private-signature|private-token/);
        return true;
      },
    );
  });
}

for (const reply of [
  { success: true, data: {} },
  { success: false, message: 'provider rejected' },
]) {
  test(`provider results retain their shape: ${reply.success}`, () => {
    assert.deepEqual(
      callMcporter('cloudbase.queryFunctions', {}, { run: () => JSON.stringify(reply) }),
      reply,
    );
  });
}

for (const output of ['private-token', '{not-json private-signature']) {
  test('malformed output fails without echoing the captured response', () => {
    assert.throws(
      () => callMcporter('cloudbase.queryFunctions', {}, { run: () => output }),
      (error) => {
        assert.match(error.message, /JSON/);
        assert.doesNotMatch(error.message, /private-signature|private-token/);
        return true;
      },
    );
  });
}

test('the async call sends the same command and deadline and parses the same reply', async () => {
  const reply = { success: true, data: { exists: true } };
  let sync;
  callMcporter(
    'cloudbase.readNoSqlDatabaseStructure',
    { action: 'checkCollection', collectionName: 'products' },
    {
      cwd: '/owned/project',
      timeoutMs: 60_000,
      run(...command) {
        sync = command;
        return JSON.stringify(reply);
      },
    },
  );
  let calls = 0;
  const actual = await callMcporterAsync(
    'cloudbase.readNoSqlDatabaseStructure',
    { action: 'checkCollection', collectionName: 'products' },
    {
      cwd: '/owned/project',
      timeoutMs: 60_000,
      async run(...command) {
        calls++;
        assert.deepEqual(command, sync);
        return { stdout: `notice\n${JSON.stringify(reply)}`, stderr: '' };
      },
    },
  );
  assert.deepEqual(actual, reply);
  assert.equal(calls, 1);
});

test('the async call rejects an MCP failure hidden behind a successful exit', async () => {
  await assert.rejects(
    callMcporterAsync(
      'cloudbase.queryPermissions',
      {},
      {
        run: async () => ({
          stdout: JSON.stringify({ isError: true, content: [{ text: 'private-token' }] }),
        }),
      },
    ),
    (error) => {
      assert.match(error.message, /transport error/);
      assert.doesNotMatch(error.message, /private-token/);
      return true;
    },
  );
  await assert.rejects(
    callMcporterAsync(
      'cloudbase.auth',
      {},
      {
        timeoutMs: 0,
        run: async () => {
          assert.fail('an invalid deadline must not start a process');
        },
      },
    ),
  );
});
