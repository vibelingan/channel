import assert from 'node:assert/strict';
import test from 'node:test';
import type { InternalInquirySubmission } from '@vibelingan-channel/ai-contracts/inquiry';
import { AssistantInquiryConflict, createAssistantInquiryStore } from './assistant-inquiry.ts';
import { readSalesInquiry } from './sales-inquiry-source.ts';
import { createSalesTestDatabase } from './testing/sales-database.ts';
const scope = {
  client_id: 'a',
  business_line: 'website_sales',
  source_installation_id: 'site_a',
  environment: 'test' as const,
  cloud_env_id: 'env_a',
  cutover_at: 1700000000,
};
const input: InternalInquirySubmission = {
  schemaVersion: '1',
  conversationId: '00000000-0000-4000-8000-000000000001',
  submission: {
    submissionKey: 'inquiry_1234',
    requirement: `Headphones for gifts.\n${'Complete need. '.repeat(200)}`.padEnd(4000, '.'),
    name: 'Buyer',
    email: 'buyer@example.invalid',
    company: 'BuyerCo',
    consent: true,
    consentVersion: 'inquiry-contact-v1',
    productId: 'public_1',
  },
};
function setup() {
  const fixture = createSalesTestDatabase({
    'channelSalesInstallations/site_a': {
      record: { ...scope, state: 'active', cutover_at: undefined },
    },
  });
  // Installation schema deliberately excludes cutover_at.
  const rows = fixture.snapshot();
  const record = rows['channelSalesInstallations/site_a']?.record as Record<string, unknown>;
  // biome-ignore lint/performance/noDelete: Exercise an absent optional field, not an undefined value.
  delete record.cutover_at;
  const db = createSalesTestDatabase(rows);
  let reads = 0;
  return {
    ...db,
    get reads() {
      return reads;
    },
    store: createAssistantInquiryStore(
      db.db,
      scope,
      async (id) => {
        reads++;
        return { productId: id, productName: 'Public headphones', revision: 'r1' };
      },
      () => 1793318400,
    ),
  };
}
test('confirmed assistant inquiry reuses OEM transaction and retains complete owned source facts', async () => {
  const f = setup();
  const result = await f.store.submit(input);
  const rows = f.snapshot();
  assert.equal(Object.keys(rows).filter((k) => k.startsWith('oemProjects/')).length, 1);
  assert.equal(
    Object.keys(rows).filter((k) => k.startsWith('channelSalesSourceRegistrations/')).length,
    1,
  );
  assert.equal(
    Object.keys(rows).filter((k) => k.startsWith('channelSalesSourceDeliveries/')).length,
    1,
  );
  const source = await readSalesInquiry(
    {
      ...scope,
      readDoc: async (collection, id) => {
        const r = rows[`${collection}/${id}`];
        return r ? { ...r, _id: id } : null;
      },
    },
    'oem',
    result.reference,
  );
  assert.equal(source.view.requirements.brief, input.submission.requirement);
  assert.equal(source.view.contact.email, input.submission.email);
  assert.equal(source.view.requirements.requested_product_id, 'public_1');
  assert.equal((source.view.product_snapshot as { productId: string }).productId, 'public_1');
  assert.ok(JSON.stringify(rows).includes('Public headphones'));
  const registration = Object.entries(rows).find(([k]) =>
    k.startsWith('channelSalesSourceRegistrations/'),
  )?.[1].record as { event: { requirements: { confirmed_summary: string }; source: string } };
  assert.equal(
    registration.event.requirements.confirmed_summary,
    input.submission.requirement.trim(),
  );
  assert.equal(registration.event.source, 'website_oem');
});
test('concurrent retries and a fresh store instance return one original receipt without catalog reread', async () => {
  const f = setup();
  const results = await Promise.all(Array.from({ length: 16 }, () => f.store.submit(input)));
  assert.equal(new Set(results.map((r) => r.reference)).size, 1);
  const before = f.snapshot();
  const recovered = createAssistantInquiryStore(f.db, scope, async () => {
    throw new Error('Catalog now offline');
  });
  assert.deepEqual(await recovered.submit(input), results[0]);
  assert.deepEqual(f.snapshot(), before);
  await assert.rejects(
    recovered.submit({ ...input, submission: { ...input.submission, requirement: 'changed' } }),
    AssistantInquiryConflict,
  );
});
test('failure after project and registration writes rolls back everything and original key can recover', async () => {
  const f = setup();
  const before = f.snapshot();
  f.failNextWrite('channelSalesSourceDeliveries');
  await assert.rejects(f.store.submit(input));
  assert.deepEqual(f.snapshot(), before);
  await f.store.submit(input);
  assert.equal(Object.keys(f.snapshot()).length, 4);
});
test('missing consent, spoofed scope and revoked installation cannot create or recover records', async () => {
  const f = setup();
  await assert.rejects(
    f.store.submit({
      ...input,
      submission: { ...input.submission, consent: false },
    } as unknown as InternalInquirySubmission),
  );
  await assert.rejects(
    f.store.submit({ ...input, client_id: 'b' } as unknown as InternalInquirySubmission),
  );
  await f.store.submit(input);
  const foreign = createAssistantInquiryStore(f.db, { ...scope, client_id: 'b' }, async () => null);
  await assert.rejects(foreign.submit(input));
  await f.db.runTransaction(async (tx) => {
    await tx
      .collection('channelSalesInstallations')
      .doc('site_a')
      .set({ record: { ...scope, state: 'revoked' } });
  });
  await assert.rejects(f.store.submit(input));
});
test('different conversations do not share records and a withdrawn requested product remains an inquiry', async () => {
  const f = setup();
  const first = await f.store.submit(input);
  const other = createAssistantInquiryStore(
    f.db,
    scope,
    async () => null,
    () => 1793318400,
  );
  const second = await other.submit({
    ...input,
    conversationId: '00000000-0000-4000-8000-000000000002',
  });
  assert.notEqual(second.reference, first.reference);
  assert.equal(
    (
      f.snapshot()[`oemProjects/${second.reference}`]?.assistantSubmission as {
        productReference: { current: unknown };
      }
    ).productReference.current,
    null,
  );
});

test('concurrent changed bodies sharing a key have one winner and one explicit conflict', async () => {
  const f = setup();
  const results = await Promise.allSettled([
    f.store.submit(input),
    f.store.submit({
      ...input,
      submission: { ...input.submission, requirement: 'A different requirement' },
    }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const rejected = results.find((r) => r.status === 'rejected');
  assert.ok(rejected?.status === 'rejected' && rejected.reason instanceof AssistantInquiryConflict);
  assert.equal(Object.keys(f.snapshot()).filter((k) => k.startsWith('oemProjects/')).length, 1);
});
