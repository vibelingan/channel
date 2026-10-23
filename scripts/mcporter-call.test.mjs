import assert from 'node:assert/strict';
import test from 'node:test';
import { callMcporter } from './mcporter-call.mjs';

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
