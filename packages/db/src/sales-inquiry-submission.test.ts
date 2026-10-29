import assert from 'node:assert/strict';
import test from 'node:test';
import {
  planSalesSubmission,
  registrationKey,
  SourceRegistrationSchema,
  createInitialSourceDelivery,
} from './sales-inquiry-submission.ts';

const scope = {
  client_id: 'a',
  business_line: 'website_sales',
  source_installation_id: 'site_a',
  environment: 'test' as const,
  cloud_env_id: 'env_a',
  cutover_at: 1700000000,
};
const row = {
  _id: 'oem_a',
  company: 'Buyer',
  contact: 'Alex',
  email: 'buyer@example.invalid',
  category: 'Headphones',
  quantity: 500,
  drawing: '',
  status: 'new',
  createdAt: '2026-10-29T00:00:00.000Z',
};
test('new saved OEM facts build finalized owner-bound source registration without external state', async () => {
  const result = await planSalesSubmission(scope, 'oem', row, null, 1793232000);
  assert.equal(result.project.salesSubmissionState, 'finalized');
  assert.equal(result.project.client_id, 'a');
  assert.equal(result.project.salesSubmittedRevision, result.registration.source.revision);
  assert.deepEqual(SourceRegistrationSchema.parse(result.registration), result.registration);
  assert.match(registrationKey(result.registration), /^[a-f0-9]{64}$/);
  assert.equal(result.registration.event.requirements.quantity, 500);
});
test('capture rejects a pre-cutover source and never repairs foreign metadata', async () => {
  await assert.rejects(
    planSalesSubmission({ ...scope, cutover_at: 1900000000 }, 'oem', row, null, 1793232000),
  );
  await assert.rejects(
    planSalesSubmission(scope, 'oem', { ...row, client_id: 'b' }, null, 1793232000),
  );
});

test('invalid registration events fail safe parsing and seed identity follows the exact saved registration', async () => {
  const result = await planSalesSubmission(scope, 'oem', row, null, 1793232000);
  const seed = createInitialSourceDelivery(result.registration);
  assert.equal(seed.registration_key, registrationKey(result.registration));
  assert.equal(seed.status, 'pending');
  assert.equal(seed.attempt, 0);
  assert.equal(seed.receipt, null);
  assert.equal(
    SourceRegistrationSchema.safeParse({ ...result.registration, event: { source_verified: true } })
      .success,
    false,
  );
});
