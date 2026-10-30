import assert from 'node:assert/strict';
import test from 'node:test';
import { createAssistantIntake } from './assistant-intake.ts';
import type { SalesRequest } from './handler.ts';
test('dedicated credential and strict confirmed form gate precede saving', async () => {
  let saves = 0;
  const handle = createAssistantIntake(
    {
      async submit(input) {
        saves++;
        return {
          schemaVersion: '1',
          conversationId: input.conversationId,
          submissionKey: input.submission.submissionKey,
          reference: `ai_${'a'.repeat(64)}`,
          submittedAt: '2026-10-30T00:00:00Z',
        };
      },
    },
    't'.repeat(40),
  );
  const request: SalesRequest = {
    method: 'POST',
    url: '/assistant-inquiries',
    headers: { authorization: `Bearer ${'t'.repeat(40)}`, 'content-type': 'application/json' },
    body: Buffer.from(
      JSON.stringify({
        schemaVersion: '1',
        conversationId: '00000000-0000-4000-8000-000000000001',
        submission: {
          submissionKey: 'request_123',
          requirement: '500 gifts',
          name: '',
          company: '',
          email: 'a@b.invalid',
          consent: true,
          consentVersion: 'inquiry-contact-v1',
        },
      }),
    ),
  };
  for (const headers of [
    { ...request.headers, authorization: '' },
    { ...request.headers, Authorization: `Bearer ${'t'.repeat(40)}` },
    { ...request.headers, authorization: [`Bearer ${'t'.repeat(40)}`, `Bearer ${'t'.repeat(40)}`] },
  ])
    assert.equal((await handle({ ...request, headers })).status, 401);
  assert.ok(request.body);
  const body = JSON.parse(request.body.toString());
  body.submission.consent = false;
  assert.equal((await handle({ ...request, body: Buffer.from(JSON.stringify(body)) })).status, 400);
  assert.equal(saves, 0);
  assert.equal((await handle(request)).status, 200);
  assert.equal(saves, 1);
});
