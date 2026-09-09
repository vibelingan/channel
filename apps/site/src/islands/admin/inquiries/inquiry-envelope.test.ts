import assert from 'node:assert/strict';
import test from 'node:test';
import { readInquiryEnvelope } from './inquiry-envelope.ts';

test('inquiry decoder preserves domain conflicts and session failures for actionable UI recovery', async () => {
  for (const code of [
    'VERSION_CONFLICT',
    'IDEMPOTENCY_CONFLICT',
    'REASON_REQUIRED',
    'UNAUTHORIZED',
  ]) {
    const payload = { ok: false, error: { code, message: 'Reload or sign in.' } };
    assert.deepEqual(await readInquiryEnvelope(Response.json(payload, { status: 409 })), payload);
  }
});

test('inquiry decoder rejects malformed, unknown and contradictory envelopes without throwing', async () => {
  for (const body of [
    '',
    'null',
    'undefined',
    '[]',
    '{',
    '""',
    '{"ok":true}',
    '{"ok":false,"error":{"code":"MADE_UP","message":"bad"}}',
    '{"ok":false,"error":{"code":"VERSION_CONFLICT","message":null}}',
  ]) {
    assert.equal(await readInquiryEnvelope(new Response(body, { status: 409 })), null);
  }
  const payload = {
    ok: true,
    data: { kind: 'updated', id: '038e137e-300e-4cfa-a7fe-fd6465622943', version: 7 },
  };
  assert.deepEqual(await readInquiryEnvelope(Response.json(payload)), payload);
  assert.equal(await readInquiryEnvelope(Response.json(payload, { status: 500 })), null);
  assert.equal(await readInquiryEnvelope(Response.json({ ...payload, unexpected: true })), null);
});
