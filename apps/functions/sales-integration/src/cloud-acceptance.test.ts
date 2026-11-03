import assert from 'node:assert/strict';
import test from 'node:test';
import { createSalesTestDatabase } from '../../../../packages/db/src/testing/sales-database.ts';
import { ACCEPTANCE_SCOPE, main, verifyCloudInquiry } from './cloud-acceptance.ts';

function fixture(initial: Record<string, Record<string, unknown>> = {}) {
  const f = createSalesTestDatabase(initial);
  return {
    ...f,
    db: {
      ...f.db,
      collection: (name: string) => ({
        doc: (id: string) => ({
          async get() {
            const row = f.snapshot()[`${name}/${id}`];
            return { data: row ? [{ ...row, _id: id }] : [] };
          },
        }),
      }),
    },
  };
}

test('fixed cloud probe exercises actual store, rollback and pending records; retry keeps original IDs', async () => {
  const f = fixture();
  const first = await verifyCloudInquiry(f.db);
  assert.equal(first.checks.rollback, 'verified');
  assert.equal(first.checks.registration_and_pending, true);
  assert.equal(first.records.length, 9);
  const before = f.snapshot();
  const again = await verifyCloudInquiry(f.db);
  assert.equal(again.checks.rollback, 'previously_recovered');
  assert.deepEqual(again.primary_receipt, first.primary_receipt);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(Object.keys(before).length, 10);
});

test('preexisting foreign installation fails closed without changing any data', async () => {
  const f = fixture({
    [`channelSalesInstallations/${ACCEPTANCE_SCOPE.source_installation_id}`]: {
      record: { ...ACCEPTANCE_SCOPE, client_id: 'foreign_client', state: 'active' },
    },
  });
  const before = f.snapshot();
  await assert.rejects(verifyCloudInquiry(f.db));
  assert.deepEqual(f.snapshot(), before);
});

test('management handler rejects caller-selected scope or arbitrary action before SDK initialization', async () => {
  await assert.rejects(
    main({ action: 'verify', suite: 'assistant-cloud-acceptance-20261101', client_id: 'foreign' }),
  );
  await assert.rejects(main({ action: 'send' }));
});
