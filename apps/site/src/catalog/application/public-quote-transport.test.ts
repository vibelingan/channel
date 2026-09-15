import assert from 'node:assert/strict';
import test from 'node:test';
import { submitPublicQuote } from './public-quote-transport.ts';
const input = {
  idempotencyKey: 'f515f8e5-1950-49cc-bcd9-8fa8a7cd4c09',
  target: { intent: 'variant_quote' as const, productId: 'p', variantId: 'v', revision: 'r' },
  fields: {
    intent: 'variant_quote' as const,
    quantity: '500',
    deliveryDate: '',
    customizationTypes: [],
    brief: '',
    contactName: 'Buyer',
    company: 'Company',
    country: 'BR',
    email: 'buyer@example.invalid',
  },
};
test('public RFQ sends only validated buyer fields, no admin token, and accepts a confirmed receipt', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    assert.match(String(url), /\/api\/catalog-quote-requests$/);
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'error');
    assert.deepEqual(JSON.parse(String(init.body)), input);
    return Response.json({ ok: true, requestId: input.idempotencyKey });
  });
  assert.deepEqual(await submitPublicQuote(input), { ok: true, requestId: input.idempotencyKey });
});
test('invalid, truncated, oversized, or lost acknowledgements remain uncertain and never fabricate success', async (t) => {
  for (const response of [
    Response.json({ ok: true, requestId: 'invalid' }),
    new Response('{'),
    new Response('x'.repeat(9000)),
    Response.json({ ok: true, requestId: input.idempotencyKey, token: 'unexpected' }),
  ]) {
    t.mock.method(globalThis, 'fetch', async () => response);
    assert.deepEqual(await submitPublicQuote(input), { ok: false, code: 'uncertain' });
  }
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('network');
  });
  assert.deepEqual(await submitPublicQuote(input), { ok: false, code: 'uncertain' });
});
test('business rejections survive transport and invalid input never reaches the network', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return Response.json({ ok: false, code: 'stale-context' }, { status: 409 });
  });
  assert.deepEqual(await submitPublicQuote(input), { ok: false, code: 'stale-context' });
  assert.deepEqual(
    await submitPublicQuote({ ...input, fields: { ...input.fields, quantity: '0' } }),
    { ok: false, code: 'validation' },
  );
  assert.equal(calls, 1);
});
