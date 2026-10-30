import assert from 'node:assert/strict';
import test from 'node:test';
import { INQUIRY_CONSENT_VERSION, isInquirySubmission, isInternalInquirySubmission, isInquirySubmissionReceipt } from './inquiry.ts';
const submission = { submissionKey: 'request_1234', requirement: '500 headphones', name: '', company: '', email: 'buyer@example.invalid', consent: true, consentVersion: INQUIRY_CONSENT_VERSION };
test('confirmed inquiry accepts category needs without a selected product', () => {
  assert.ok(isInquirySubmission(submission));
  assert.ok(isInquirySubmission({ ...submission, productId: '12345678901234567890' }));
  for (const patch of [{ consent: false }, { consentVersion: 'marketing' }, { requirement: '' }, { requirement: 'x'.repeat(4001) }, { email: 'a@b.c\nBcc:x@y.z' }, { client_id: 'other' }, { productId: '../private' }, { submissionKey: 'short' }]) assert.equal(isInquirySubmission({ ...submission, ...patch }), false);
});
test('internal envelope and receipt strictly bind conversation and original submission', () => {
  const conversationId = '00000000-0000-4000-8000-000000000001';
  assert.ok(isInternalInquirySubmission({ schemaVersion: '1', conversationId, submission }));
  assert.equal(isInternalInquirySubmission({ schemaVersion: '1', conversationId, submission, workspace: 'all' }), false);
  const receipt = { schemaVersion: '1', conversationId, submissionKey: submission.submissionKey, reference: `ai_${'a'.repeat(64)}`, submittedAt: '2026-10-30T01:00:00.000Z' };
  assert.ok(isInquirySubmissionReceipt(receipt));
  assert.equal(isInquirySubmissionReceipt({ ...receipt, reference: '<script>' }), false);
  assert.equal(isInquirySubmissionReceipt({ ...receipt, submittedAt: 'invalid' }), false);
});
