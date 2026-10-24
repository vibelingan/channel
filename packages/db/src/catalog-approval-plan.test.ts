import assert from 'node:assert/strict';
import test from 'node:test';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { catalogApprovalDigest, prepareCatalogApprovalPlan } from './catalog-detail-commit.ts';

function product(): CollectionDoc {
  return {
    _id: 'plan-product',
    name: 'Website title',
    description: '',
    imageIds: ['image'],
    published: false,
    archived: false,
    productFamily: 'misc',
    detailSourceOwner: 'manual:plan-product',
    detailSourceReady: true,
    detailSourceRevision: 'source-r1',
    detailSourceManifest: { revision: 'source-r1', variantIds: [] },
    detailSourceCandidate: {
      schemaVersion: 'catalog-product-detail-v1',
      _id: 'plan-product',
      name: 'Source title',
      images: ['/api/images/image'],
      facts: [],
      offers: [],
    },
  };
}

test('default review identity has a valid complete plan and does not change the input record', () => {
  const row = product();
  const before = structuredClone(row);
  const prepared = prepareCatalogApprovalPlan(row, []);
  assert.match(prepared.digest, /^[a-f0-9]{64}$/);
  assert.equal(prepared.plan.publication.revision, 'review-candidate');
  assert.equal(prepared.plan.publication.variantCount, 0);
  assert.deepEqual(row, before);
});

test('a publication target revision changes only that target and preserves the review digest', () => {
  const row = product();
  const before = structuredClone(row);
  const reviewed = prepareCatalogApprovalPlan(row, []);
  const target = '22222222-2222-4222-8222-222222222222';
  const prepared = prepareCatalogApprovalPlan(row, [], target);
  assert.equal(prepared.digest, catalogApprovalDigest(row, []));
  assert.deepEqual(prepared.plan, {
    ...reviewed.plan,
    publication: { ...reviewed.plan.publication, revision: target },
  });
  assert.deepEqual(row, before);
});

test('a valid-looking manifest with a missing configuration is refused without a partial plan', () => {
  const row = product();
  row.detailSourceManifest = { revision: 'source-r1', variantIds: ['missing'] };
  const before = structuredClone(row);
  assert.throws(() => prepareCatalogApprovalPlan(row, []), /Incomplete or mixed source generation/);
  assert.deepEqual(row, before);
});
