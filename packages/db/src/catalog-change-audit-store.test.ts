import assert from 'node:assert/strict';
import test from 'node:test';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { runStagedApproval } from './catalog-detail-staging.ts';

const DIGEST = 'a'.repeat(64);
const header = {
  schemaVersion: 'catalog-product-detail-v1',
  _id: 'p1',
  name: 'Headset',
  images: [],
  facts: [],
  offers: [],
};
const product = (extra: Record<string, unknown> = {}): CollectionDoc => ({
  _id: 'p1',
  name: 'Headset',
  published: true,
  alibabaPrimarySourceKey: 'source',
  alibabaReviewPending: false,
  catalogDetailPublication: { state: 'approved', revision: 'r1', header, variantCount: 0 },
  catalogDetailApprovalReceipt: { revision: 'r1', operationId: 'op', variantCount: 0 },
  ...extra,
});

function harness(row: CollectionDoc, role = 'admin') {
  const store: Record<string, CollectionDoc> = {
    'users/admin': { _id: 'admin', role },
    'products/p1': structuredClone(row),
  };
  const writes: string[] = [];
  const tx = {
    get: async (collection: string, id: string) =>
      structuredClone(store[`${collection}/${id}`] ?? null),
    set: async (collection: string, doc: CollectionDoc) => {
      writes.push(`${collection}/${doc._id}`);
      store[`${collection}/${doc._id}`] = structuredClone(doc);
    },
  };
  const mark = (command: Record<string, unknown>) =>
    runStagedApproval(tx, 'admin', {
      action: 'change-audit-mark',
      productId: 'p1',
      revision: 'r1',
      ...command,
    } as Parameters<typeof runStagedApproval>[2]);
  return { mark, writes, row: () => store['products/p1'] as CollectionDoc };
}

test('unchanged records the baseline digest on the receipt and nothing else', async () => {
  const before = product();
  const h = harness(before);
  assert.deepEqual(await h.mark({ outcome: 'unchanged', sourceDigest: DIGEST }), {
    ok: true,
    backfill: 'applied',
  });
  assert.deepEqual(h.row(), {
    ...before,
    catalogDetailApprovalReceipt: {
      ...(before.catalogDetailApprovalReceipt as object),
      sourceDigest: DIGEST,
    },
  });
});

test('changed flags the product for review and changes nothing else', async () => {
  const before = product();
  const h = harness(before);
  assert.deepEqual(await h.mark({ outcome: 'changed' }), { ok: true, backfill: 'applied' });
  assert.deepEqual(h.row(), {
    ...before,
    alibabaReviewPending: true,
    alibabaReviewReason: 'changed',
  });
});

test('changed never downgrades a stronger existing reason', async () => {
  const h = harness(product({ alibabaReviewPending: true, alibabaReviewReason: 'removed' }));
  assert.equal((await h.mark({ outcome: 'changed' })).ok, true);
  assert.equal(h.row().alibabaReviewReason, 'removed');
});

test('a moved revision, an existing digest or an archived product is skipped without a write', async () => {
  const cases: Array<[CollectionDoc, string]> = [
    [
      product({
        catalogDetailPublication: { state: 'approved', revision: 'r2', header, variantCount: 0 },
      }),
      'revision-changed',
    ],
    [product({ catalogDetailApprovalReceipt: { sourceDigest: DIGEST } }), 'already-present'],
    [product({ archived: true }), 'archived'],
    [product({ catalogDetailPublication: undefined }), 'not-approved'],
  ];
  for (const [row, reason] of cases) {
    const h = harness(row);
    assert.deepEqual(await h.mark({ outcome: 'changed' }), {
      ok: true,
      backfill: 'skipped',
      reason,
    });
    assert.deepEqual(h.writes, [], reason);
  }
});

test('only an admin may mark; "unchanged" requires the digest', async () => {
  const contributor = harness(product(), 'contributor');
  assert.deepEqual(await contributor.mark({ outcome: 'changed' }), {
    ok: false,
    code: 'FORBIDDEN',
  });
  const h = harness(product());
  assert.deepEqual(await h.mark({ outcome: 'unchanged' }), {
    ok: false,
    code: 'VALIDATION_ERROR',
  });
  assert.deepEqual(h.writes, []);
});
