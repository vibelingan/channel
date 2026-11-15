import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeliveryReconcileRoute } from './delivery-reconcile-route.ts';
import type { SalesRequest } from './handler.ts';
import { submissionDelivery } from './runtime-delivery.ts';

test('reconciliation only accepts its dedicated token, empty strict JSON and a fixed bounded page', async () => {
  let calls = 0;
  const worker = {
    tick: async (limit?: number) => {
      assert.equal(limit, 5);
      calls++;
      return { state: 'scanned' as const, wrapped: true, results: [] };
    },
  };
  const token = 'r'.repeat(48);
  assert.throws(() => createDeliveryReconcileRoute(worker, token, [token]));
  const route = createDeliveryReconcileRoute(worker, token);
  const req: SalesRequest = {
    method: 'POST',
    url: '/source-deliveries/reconcile',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: Buffer.from('{}'),
  };
  for (const headers of [
    { ...req.headers, authorization: '' },
    { ...req.headers, Authorization: `Bearer ${token}` },
    { ...req.headers, authorization: `Bearer ${'x'.repeat(48)}` },
  ])
    assert.equal((await route({ ...req, headers })).status, 401);
  assert.equal((await route({ ...req, method: 'GET' })).status, 405);
  assert.equal(
    (await route({ ...req, headers: { ...req.headers, 'content-type': 'text/plain' } })).status,
    415,
  );
  for (const body of ['[]', 'null', '{"limit":50}', '{"client_id":"other"}', '{"x":1,"x":2}', ''])
    assert.equal((await route({ ...req, body: Buffer.from(body) })).status, 400);
  assert.equal((await route({ ...req, body: Buffer.alloc(257) })).status, 413);
  assert.equal(calls, 0);
  assert.equal((await route(req)).status, 200);
  assert.equal(calls, 1);
});
test('unavailable reconciliation is retryable without leaking exception details', async () => {
  const route = createDeliveryReconcileRoute(
    {
      tick: async () => {
        throw new Error('Private failure');
      },
    },
    'r'.repeat(48),
  );
  const result = await route({
    method: 'POST',
    url: '/',
    headers: { authorization: `Bearer ${'r'.repeat(48)}`, 'content-type': 'application/json' },
    body: Buffer.from('{}'),
  });
  assert.equal(result.status, 503);
  assert.equal(result.body.toString().includes('Private'), false);
});
test('immediate submission waits within budget and never changes the already committed receipt', async () => {
  await submissionDelivery(null)('oem', 'a');
  await submissionDelivery({
    deliverSource: async () => {
      throw new Error('Offline');
    },
  })('oem', 'a');
  let finish: (() => void) | undefined;
  const settled = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const pending = submissionDelivery(
    {
      deliverSource: async () => {
        await settled;
        return { key: 'a'.repeat(64), state: 'accepted' };
      },
    },
    10,
  );
  await pending('oem', 'a');
  finish?.();
  assert.throws(() => submissionDelivery(null, 0));
});
