import assert from 'node:assert/strict';
import test from 'node:test';
import type { InternalInquirySubmission } from '@vibelingan-channel/ai-contracts/inquiry';
import { InquirySubmissionChanged, createInquiryClient } from './inquiry-client.ts';
const input: InternalInquirySubmission = {
  schemaVersion: '1',
  conversationId: '00000000-0000-4000-8000-000000000001',
  submission: {
    submissionKey: 'request_123',
    requirement: '500 gifts',
    name: '',
    company: '',
    email: 'buyer@example.invalid',
    consent: true,
    consentVersion: 'inquiry-contact-v1',
  },
};
const receipt = {
  schemaVersion: '1',
  conversationId: input.conversationId,
  submissionKey: input.submission.submissionKey,
  reference: `ai_${'a'.repeat(64)}`,
  submittedAt: '2026-10-30T00:00:00Z',
};
test('internal inquiry destination is fixed, HTTPS and credentialed with no redirect', async () => {
  for (const url of [
    'http://remote.invalid',
    'https://user:pass@example.invalid',
    'https://example.invalid/other',
    'https://example.invalid/?workspace=all',
  ])
    assert.throws(() => createInquiryClient(url, 't'.repeat(40)));
  const c = createInquiryClient('https://example.invalid', 't'.repeat(40), async (url, init) => {
    assert.equal(String(url), 'https://example.invalid/api/integrations/sales/assistant-inquiries');
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${'t'.repeat(40)}`);
    return Response.json(receipt);
  });
  assert.deepEqual(await c.submit(input), receipt);
});
test('foreign receipts, malformed or oversized bodies and changed requests cannot report success', async () => {
  for (const response of [
    Response.json({ ...receipt, conversationId: '00000000-0000-4000-8000-000000000002' }),
    Response.json({ ...receipt, submissionKey: 'another_request' }),
    Response.json({ reference: 'madeup' }),
    new Response('x'.repeat(4097), { headers: { 'content-type': 'application/json' } }),
  ]) {
    await assert.rejects(
      createInquiryClient('https://example.invalid', 't'.repeat(40), async () => response).submit(
        input,
      ),
    );
  }
  await assert.rejects(
    createInquiryClient(
      'https://example.invalid',
      't'.repeat(40),
      async () => new Response('', { status: 409 }),
    ).submit(input),
    InquirySubmissionChanged,
  );
});
