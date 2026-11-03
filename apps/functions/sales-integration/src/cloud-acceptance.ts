/** Fixed synthetic records in the approved existing environment; never an application API. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as cloudbase from '@cloudbase/node-sdk';
import type { InternalInquirySubmission } from '@vibelingan-channel/ai-contracts/inquiry';
import {
  AssistantInquiryConflict,
  createAssistantInquiryStore,
} from '@vibelingan-channel/db/assistant-inquiry';
import type { NodeSdkDatabase } from '@vibelingan-channel/db/cloudbase';
import {
  type SalesReadDatabase,
  assertSalesSdkWrite,
  normalizeSalesSdkDocument,
} from '@vibelingan-channel/db/sales-inquiry-read';
import { readSalesInquiry } from '@vibelingan-channel/db/sales-inquiry-source';
import {
  createInitialSourceDelivery,
  planSalesSubmission,
  registrationKey,
  validateSourceRegistration,
} from '@vibelingan-channel/db/sales-inquiry-submission';

export const ACCEPTANCE_ENV = 'diversity-123-d9grnqfux221323bb';
export const ACCEPTANCE_SCOPE = {
  client_id: 'acceptance_20261101',
  business_line: 'website_sales',
  source_installation_id: 'assistant_acceptance_20261101',
  environment: 'test' as const,
  cloud_env_id: ACCEPTANCE_ENV,
  cutover_at: 0,
};
const conversationId = '00000000-0000-4000-8000-202611010001';
const input = (submissionKey: string): InternalInquirySubmission => ({
  schemaVersion: '1',
  conversationId,
  submission: {
    submissionKey,
    requirement: '[TEST sales acceptance 20261101] Need 500 headphones for customer gifts.',
    name: 'Synthetic test buyer',
    company: '[TEST sales acceptance 20261101]',
    email: 'acceptance@example.invalid',
    consent: true,
    consentVersion: 'inquiry-contact-v1',
  },
});
function projectId(value: InternalInquirySubmission) {
  const s = ACCEPTANCE_SCOPE;
  return `ai_${createHash('sha256')
    .update(
      JSON.stringify([
        s.client_id,
        s.business_line,
        s.source_installation_id,
        s.environment,
        value.conversationId,
        value.submission.submissionKey,
      ]),
    )
    .digest('hex')}`;
}

export async function verifyCloudInquiry(db: NodeSdkDatabase & SalesReadDatabase) {
  const scope = ACCEPTANCE_SCOPE;
  const { cutover_at: _cutover, ...owner } = scope;
  await db.runTransaction(async (tx) => {
    const doc = tx.collection('channelSalesInstallations').doc(scope.source_installation_id);
    const existing = normalizeSalesSdkDocument(await doc.get(), scope.source_installation_id);
    if (existing) assert.deepEqual(existing.record, { ...owner, state: 'active' });
    else
      assertSalesSdkWrite(
        await doc.set({ record: { ...owner, state: 'active' } }),
        scope.source_installation_id,
      );
  });
  const store = createAssistantInquiryStore(db, scope, async () => {
    throw new Error('This acceptance does not read or change the product catalog');
  });
  const first = input('cloud_acceptance_primary_v1');
  const firstReceipt = await store.submit(first);
  assert.deepEqual(await store.submit(first), firstReceipt);
  await assert.rejects(
    store.submit({ ...first, submission: { ...first.submission, requirement: 'Changed body' } }),
    AssistantInquiryConflict,
  );

  const raced = input('cloud_acceptance_concurrent_v1');
  const receipts = await Promise.all([
    store.submit(raced),
    store.submit(raced),
    store.submit(raced),
  ]);
  assert.ok(receipts.every((v) => v.reference === receipts[0]?.reference));

  const failed = input('cloud_acceptance_rollback_v1');
  const rollbackId = projectId(failed);
  const alreadyRecovered = normalizeSalesSdkDocument(
    await db.collection('oemProjects').doc(rollbackId).get(),
    rollbackId,
  );
  let rollbackKey = '';
  let rollbackChecked = false;
  if (!alreadyRecovered) {
    const faulty: NodeSdkDatabase = {
      ...db,
      command: db.command,
      runTransaction: (operation) =>
        db.runTransaction((tx) =>
          operation({
            collection: (collection) => ({
              doc: (id) => {
                const original = tx.collection(collection).doc(id);
                return {
                  ...original,
                  get: () => original.get(),
                  set: async (data) => {
                    if (collection === 'channelSalesSourceDeliveries') {
                      rollbackKey = id;
                      throw new Error('Acceptance final-write failure');
                    }
                    return original.set(data);
                  },
                  update: (data) => original.update(data),
                  remove: () => original.remove(),
                };
              },
            }),
          }),
        ),
    };
    await assert.rejects(
      createAssistantInquiryStore(faulty, scope, async () => null).submit(failed),
      /Acceptance final-write failure/,
    );
    assert.ok(rollbackKey);
    for (const [collection, id] of [
      ['oemProjects', rollbackId],
      ['channelSalesSourceRegistrations', rollbackKey],
      ['channelSalesSourceDeliveries', rollbackKey],
    ] as const)
      assert.equal(
        normalizeSalesSdkDocument(await db.collection(collection).doc(id).get(), id),
        null,
      );
    rollbackChecked = true;
  }
  const recovered = await store.submit(failed);
  const records = [];
  for (const request of [first, raced, failed]) {
    const id = projectId(request);
    const row = normalizeSalesSdkDocument(await db.collection('oemProjects').doc(id).get(), id);
    assert.ok(row);
    assert.equal(row.client_id, scope.client_id);
    assert.equal(row.source_installation_id, scope.source_installation_id);
    const view = await readSalesInquiry(
      {
        ...scope,
        readDoc: async (collection, key) =>
          normalizeSalesSdkDocument(await db.collection(collection).doc(key).get(), key),
      },
      'oem',
      id,
    );
    assert.equal(view.view.requirements.brief, request.submission.requirement);
    const plan = await planSalesSubmission(
      scope,
      'oem',
      row,
      null,
      Math.floor(Date.parse(String(row.createdAt)) / 1000),
    );
    const key = registrationKey(plan.registration);
    const registered = normalizeSalesSdkDocument(
      await db.collection('channelSalesSourceRegistrations').doc(key).get(),
      key,
    );
    const pending = normalizeSalesSdkDocument(
      await db.collection('channelSalesSourceDeliveries').doc(key).get(),
      key,
    );
    assert.ok(registered);
    assert.ok(pending);
    const registration = validateSourceRegistration(registered.record);
    assert.equal(registrationKey(registration), key);
    assert.equal(registration.event.source_record_id, id);
    assert.deepEqual(pending.record, createInitialSourceDelivery(registration));
    records.push({ collection: 'oemProjects', id });
    records.push({ collection: 'channelSalesSourceRegistrations', id: key });
    records.push({ collection: 'channelSalesSourceDeliveries', id: key });
  }
  return {
    protocol: 'assistant-cloud-acceptance/1',
    environment: ACCEPTANCE_ENV,
    scope,
    checks: {
      saved: true,
      original_receipt: true,
      changed_body_rejected: true,
      concurrent_same_record: true,
      rollback: rollbackChecked ? 'verified' : 'previously_recovered',
      recovery: recovered.reference === rollbackId,
      read_back: true,
      registration_and_pending: true,
    },
    records,
    primary_receipt: firstReceipt,
    rollback_registration_key: rollbackKey || null,
    model_calls: 0,
    email_calls: 0,
    scheduling_enabled: false,
  };
}

export async function main(event: unknown) {
  // A fixed acceptance request cannot select arbitrary callers, data or destinations.
  assert.deepEqual(event, { action: 'verify', suite: 'assistant-cloud-acceptance-20261101' });
  const configuredEnv = process.env.TCB_ENV ?? process.env.SCF_NAMESPACE;
  assert.equal(configuredEnv, ACCEPTANCE_ENV);
  const app = cloudbase.init({ env: ACCEPTANCE_ENV });
  return verifyCloudInquiry(app.database());
}
