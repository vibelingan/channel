import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AssistantInquiryConflict,
  AssistantInquiryRejected,
} from '@vibelingan-channel/db/assistant-inquiry';
import { createAssistantIntake, testScopeInquiryStore } from './assistant-intake.ts';
import type { SalesRequest } from './handler.ts';
test('assistant wakes the exact committed source and a wakeup failure preserves its saved receipt', async () => {
  const reference = `ai_${'a'.repeat(64)}`;
  let saved = false;
  let called = false;
  const handle = createAssistantIntake(
    {
      submit: async (input) => {
        saved = true;
        return {
          schemaVersion: '1',
          conversationId: input.conversationId,
          submissionKey: input.submission.submissionKey,
          reference,
          submittedAt: '2026-11-09T00:00:00Z',
        };
      },
    },
    't'.repeat(40),
    async (kind, id) => {
      assert.equal(saved, true);
      assert.equal(kind, 'oem');
      assert.equal(id, reference);
      called = true;
      throw new Error('Hermes unavailable');
    },
  );
  const result = await handle(confirmed('Buyer', 'buyer@example.invalid'));
  assert.equal(called, true);
  assert.equal(result.status, 200);
  assert.equal(JSON.parse(result.body.toString()).reference, reference);
});
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
function confirmed(company: string, email: string): SalesRequest {
  return {
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
          name: 'Nina',
          company,
          email,
          consent: true,
          consentVersion: 'inquiry-contact-v1',
        },
      }),
    ),
  };
}
const outcome = (r: { body: Buffer }) => JSON.parse(r.body.toString());
test('results say whether nothing was saved or the outcome is unknown', async () => {
  let failure: Error = new AssistantInquiryRejected('PRODUCT_UNVERIFIED');
  const handle = createAssistantIntake(
    {
      async submit() {
        throw failure;
      },
    },
    't'.repeat(40),
  );
  const rejected = await handle(confirmed('VibeLingan', 'nina@vibelingan.com'));
  assert.equal(rejected.status, 422);
  assert.deepEqual(outcome(rejected), {
    code: 'REJECTED',
    outcome: 'not_started',
    reason: 'PRODUCT_UNVERIFIED',
  });
  failure = new Error('CloudBase timeout after write');
  const unknown = await handle(confirmed('VibeLingan', 'nina@vibelingan.com'));
  assert.equal(unknown.status, 503);
  assert.deepEqual(outcome(unknown), { code: 'UNAVAILABLE', outcome: 'unknown' });
  failure = new AssistantInquiryConflict('Submission changed');
  const changed = await handle(confirmed('VibeLingan', 'nina@vibelingan.com'));
  assert.equal(changed.status, 409);
  assert.deepEqual(outcome(changed), { code: 'SUBMISSION_CHANGED', outcome: 'unknown' });
  const invalid = await handle(confirmed('VibeLingan', 'not-an-email'));
  assert.equal(invalid.status, 400);
  assert.deepEqual(outcome(invalid), {
    code: 'INVALID_REQUEST',
    outcome: 'not_started',
    reason: 'INVALID_DETAILS',
  });
});
test('ordinary_company_in_test_scope_can_submit', async () => {
  const saved: string[] = [];
  const store = testScopeInquiryStore(
    {
      async submit(input) {
        saved.push(input.submission.company);
        return {
          schemaVersion: '1',
          conversationId: input.conversationId,
          submissionKey: input.submission.submissionKey,
          reference: `ai_${'a'.repeat(64)}`,
          submittedAt: '2026-11-02T00:00:00Z',
        };
      },
    },
    { environment: 'test' },
  );
  const handle = createAssistantIntake(store, 't'.repeat(40));
  const response = await handle(confirmed('VibeLingan', 'nina@vibelingan.com'));
  assert.equal(response.status, 200);
  assert.deepEqual(saved, ['VibeLingan']);
  assert.throws(() => testScopeInquiryStore(store, { environment: 'production' }));
});
