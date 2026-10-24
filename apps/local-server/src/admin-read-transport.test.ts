/** Real Playwright HTTP sender, owned loopback data only; no application credentials or writes. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { type APIRequestContext, request as requests } from '@playwright/test';

test('the E2E helper retries one reset for read actions and never repeats an uncertain write', async (t) => {
  const counts = new Map<string, number>();
  let status = 200;
  let resetAlways = false;
  const server = createServer(async (incoming, response) => {
    let body = '';
    for await (const chunk of incoming) body += chunk;
    const command: unknown = JSON.parse(body);
    assert.ok(command && typeof command === 'object' && 'action' in command);
    const action = command.action;
    assert.equal(typeof action, 'string');
    if (typeof action !== 'string') throw Error('fixture action');
    const count = (counts.get(action) ?? 0) + 1;
    counts.set(action, count);
    if (status === 200 && (count === 1 || resetAlways)) {
      incoming.socket.destroy();
      return;
    }
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify(
        status === 200
          ? { ok: true, data: { action } }
          : { ok: false, error: { code: 'UNAVAILABLE', message: 'Owned test response' } },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const priorApiUrl = process.env.E2E_API_URL;
  process.env.E2E_API_URL = `http://127.0.0.1:${address.port}`;
  const cleanup: { client?: APIRequestContext } = {};
  t.after(async () => {
    try {
      await cleanup.client?.dispose();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      if (priorApiUrl === undefined) Reflect.deleteProperty(process.env, 'E2E_API_URL');
      else process.env.E2E_API_URL = priorApiUrl;
    }
  });
  const context = await requests.newContext();
  cleanup.client = context;
  const { adminAction } = await import('../../../tests/e2e/helpers/admin-api.ts');
  for (const action of ['get', 'list'])
    await t.test(`${action} retries one reset`, async () => {
      assert.deepEqual(await adminAction(context, action), { action });
      assert.equal(counts.get(action), 2);
    });
  for (const action of ['update', 'create', 'catalogDetailApproval', 'catalogCategories'])
    await t.test(`${action} preserves an unknown write outcome`, async () => {
      await assert.rejects(adminAction(context, action), /ECONNRESET|socket hang up/);
      assert.equal(counts.get(action), 1);
    });
  await t.test('a persistent reset is surfaced after exactly two read attempts', async () => {
    resetAlways = true;
    counts.delete('list');
    try {
      await assert.rejects(adminAction(context, 'list'), /ECONNRESET|socket hang up/);
      assert.equal(counts.get('list'), 2);
    } finally {
      resetAlways = false;
    }
  });
  for (const code of [400, 503])
    await t.test(`HTTP ${code} is never retried`, async () => {
      status = code;
      counts.delete('list');
      await assert.rejects(adminAction(context, 'list'), new RegExp(String(code)));
      assert.equal(counts.get('list'), 1);
    });
});
