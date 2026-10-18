import assert from 'node:assert/strict';
import test from 'node:test';
import { type CollectionDoc, catalogReferencedImageIds } from '@vibelingan-channel/shared';
import {
  CATALOG_MEDIA_SEAL_POLICY,
  CATALOG_PIXEL_POLICY,
  CATALOG_PREPARATION_POLICY,
} from '@vibelingan-channel/shared/catalog-preparation';
import { alibabaPricingFingerprint } from './alibaba-pricing-fingerprint.ts';
import { catalogApprovalDigest } from './catalog-detail-commit.ts';
import { prepareStagedApproval } from './catalog-detail-staging.ts';
import type { CatalogOwnedApprovalMedia } from './catalog-operation-media.ts';
import {
  prepareOwnedApprovalReferences,
  readOwnedApprovalReferencePlan,
} from './catalog-operation-references.ts';
import { catalogSealedImageIdsDigest } from './catalog-preparation-media-seal.ts';

function fixture(gallery = 0, description = 0, variantCount = 0, shared = false) {
  const galleryIds = Array.from({ length: gallery }, (_, i) => `gallery${i}`);
  const descriptionIds = Array.from({ length: description }, (_, i) =>
    shared && i === 0 && gallery ? 'gallery0' : `description${i}`,
  );
  const product: CollectionDoc = {
    _id: 'p',
    name: 'Clock',
    published: false,
    archived: false,
    imageIds: galleryIds,
    descriptionImageIds: descriptionIds,
    detailSourceOwner: 'owner',
    detailSourceRevision: 'source-v1',
    detailSourceReady: true,
    detailSourceManifest: {
      revision: 'source-v1',
      variantIds: Array.from({ length: variantCount }, (_, i) => `v${i}`),
    },
    detailSourceCandidate: {
      schemaVersion: 'catalog-product-detail-v1',
      _id: 'p',
      name: 'Clock',
      images: [],
      facts: [],
      offers: [],
    },
  };
  const variants: CollectionDoc[] = Array.from({ length: variantCount }, (_, i) => ({
    _id: `v${i}`,
    productId: 'p',
    position: i,
    sku: `v${i}`,
    detailSourceOwner: 'owner',
    detailSourceRevision: 'source-v1',
    detailSourceMissing: false,
    imageIds: [shared && i === 0 && gallery ? 'gallery0' : `sku${i}`],
    optionValues: { Color: String(i) },
    detailSourceCandidate: {
      id: `v${i}`,
      options: [],
      images: [],
      offers: [],
      inventory: { state: 'unknown' },
    },
  }));
  const prepared = prepareStagedApproval(
    'admin',
    {
      productId: 'p',
      operationId: '12345678-1234-4234-8234-123456789012',
      expectedRevision: null,
      expectedDigest: catalogApprovalDigest(product, variants),
    },
    product,
    variants,
  );
  assert.ok(prepared.ok, JSON.stringify(prepared));
  const base = {
    ...prepared.value,
    operation: {
      inputDigest: 'a'.repeat(64),
      policy: {
        preparation: CATALOG_PREPARATION_POLICY,
        media: CATALOG_MEDIA_SEAL_POLICY,
        pixels: CATALOG_PIXEL_POLICY,
      },
    },
  };
  const ids = catalogReferencedImageIds({
    _id: 'p',
    catalogDetailPublication: base.publication,
  }).sort();
  // Pure binding fixture only; completed-job and actual pixels are tested through the operation/worker flow.
  const body: Omit<CatalogOwnedApprovalMedia, 'bindingDigest'> = {
    kind: 'catalog-owned-approval-media-v1',
    preparationInputDigest: 'b'.repeat(64),
    ready: {
      kind: 'catalog-preparation-ready-seal-v1',
      jobId: 'c'.repeat(64),
      receiptId: 'd'.repeat(64),
      planDigest: 'e'.repeat(64),
      imageIdsDigest: catalogSealedImageIdsDigest(ids),
      imageCount: ids.length,
      mediaPolicyVersion: CATALOG_MEDIA_SEAL_POLICY,
      pixelPolicyVersion: CATALOG_PIXEL_POLICY,
    },
  };
  const media: CatalogOwnedApprovalMedia = {
    ...body,
    bindingDigest: alibabaPricingFingerprint([
      'catalog-owned-approval-media-v1',
      base._id,
      base.productId,
      base.operation.inputDigest,
      base.operation.policy,
      base.revision,
      base.productFingerprint,
      body,
    ]),
  };
  return { product, variants, owner: { ...base, media }, ids };
}
for (const [gallery, description, variants, shared] of [
  [0, 0, 0, false],
  [9, 0, 0, false],
  [0, 18, 0, false],
  [9, 18, 105, true],
  [9, 18, 10000, false],
] as const)
  test(`server plan preserves canonical/media agreement for ${gallery}/${description}/${variants}/${shared}`, () => {
    const h = fixture(gallery, description, variants, shared);
    const canonical = catalogReferencedImageIds({
      ...h.product,
      catalogDetailPublication: h.owner.publication,
    }).sort();
    assert.deepEqual(canonical, h.ids);
    const binding = prepareOwnedApprovalReferences(h.owner, h.product);
    assert.ok(binding);
    const plan = readOwnedApprovalReferencePlan(h.owner, binding);
    assert.ok(plan);
    assert.deepEqual(
      plan.changes,
      h.ids.map((imageId) => ({ imageId, delta: 1 })),
    );
    assert.equal(binding.leafCount, h.ids.length);
    assert.equal(Buffer.byteLength(JSON.stringify(binding)) < 1024, true);
    assert.equal(h.product.published, false);
  });
for (const change of ['extra-raw', 'missing-media', 'wrong-product', 'live', 'archived'] as const)
  test(`reference preparation refuses ${change} instead of guessing a different public plan`, () => {
    const h = fixture(1, 1, 1);
    if (change === 'extra-raw') h.product.imageIds = ['unprepared'];
    if (change === 'missing-media') Reflect.deleteProperty(h.owner, 'media');
    if (change === 'wrong-product') h.product._id = 'other';
    if (change === 'live') h.product.published = true;
    if (change === 'archived') h.product.archived = true;
    assert.equal(prepareOwnedApprovalReferences(h.owner, h.product), null);
  });
for (const change of [
  'root',
  'product',
  'input',
  'revision',
  'fingerprint',
  'media',
  'policy',
  'publication',
] as const)
  test(`persisted reference binding cannot be borrowed after ${change} changes`, () => {
    const h = fixture(1, 1, 1);
    const binding = prepareOwnedApprovalReferences(h.owner, h.product);
    assert.ok(binding);
    if (change === 'root') h.owner._id = 'f'.repeat(64);
    if (change === 'product') h.owner.productId = 'other';
    if (change === 'input') h.owner.operation.inputDigest = 'f'.repeat(64);
    if (change === 'revision') h.owner.revision = '00000000-0000-4000-8000-000000000000';
    if (change === 'fingerprint') h.owner.productFingerprint = 'f'.repeat(64);
    if (change === 'media') h.owner.media.bindingDigest = 'f'.repeat(64);
    if (change === 'policy') h.owner.operation.policy.media = 'old-media';
    if (change === 'publication') h.owner.publication.header.images = ['/api/images/other'];
    assert.equal(readOwnedApprovalReferencePlan(h.owner, binding), null);
  });
for (const change of ['root', 'tree', 'count'] as const)
  test(`self-consistent ${change} commitment cannot replace the actual frozen image plan`, () => {
    const h = fixture(1, 1, 1);
    const binding = prepareOwnedApprovalReferences(h.owner, h.product);
    assert.ok(binding);
    if (change === 'root') binding.operationRootId = 'f'.repeat(64);
    if (change === 'tree') binding.treeRoot = 'f'.repeat(64);
    if (change === 'count') binding.leafCount++;
    const { bindingDigest: _old, ...body } = binding;
    binding.bindingDigest = alibabaPricingFingerprint([
      'catalog-owned-approval-references-v1',
      h.owner._id,
      h.owner.productId,
      h.owner.operation.inputDigest,
      h.owner.operation.policy,
      h.owner.revision,
      h.owner.productFingerprint,
      h.owner.media.bindingDigest,
      body,
    ]);
    assert.equal(readOwnedApprovalReferencePlan(h.owner, binding), null);
  });
for (const invalid of [undefined, null, {}, 'x'.repeat(2048)])
  test(`malformed reference binding remains unreadable: ${typeof invalid}`, () => {
    const h = fixture();
    assert.equal(readOwnedApprovalReferencePlan(h.owner, invalid), null);
  });
test('unused old approved pictures on an unpublished product do not create removal deltas', () => {
  const h = fixture(1);
  h.product.catalogDetailPublication = {
    state: 'approved',
    header: { _id: 'p', images: ['/api/images/old'] },
    variantImageIds: ['old-sku'],
  };
  const binding = prepareOwnedApprovalReferences(h.owner, h.product);
  assert.ok(binding);
  const plan = readOwnedApprovalReferencePlan(h.owner, binding);
  assert.ok(plan);
  assert.deepEqual(plan.changes, [{ imageId: 'gallery0', delta: 1 }]);
});

for (const corruption of ['digest', 'extra', 'kind'] as const)
  test(`valid-looking reference body still refuses ${corruption} corruption`, () => {
    const h = fixture(1, 1, 1);
    const binding = prepareOwnedApprovalReferences(h.owner, h.product);
    assert.ok(binding);
    if (corruption === 'digest') binding.bindingDigest = 'f'.repeat(64);
    if (corruption === 'extra') Reflect.set(binding, 'future', 'unreviewed');
    if (corruption === 'kind') Reflect.set(binding, 'kind', 'different-protocol');
    assert.equal(readOwnedApprovalReferencePlan(h.owner, binding), null);
  });
test('a different valid media completion receipt cannot reuse a previous reference binding', () => {
  const h = fixture(1, 1, 1);
  const binding = prepareOwnedApprovalReferences(h.owner, h.product);
  assert.ok(binding);
  h.owner.media.ready.receiptId = 'f'.repeat(64);
  const { bindingDigest: _old, ...body } = h.owner.media;
  h.owner.media.bindingDigest = alibabaPricingFingerprint([
    'catalog-owned-approval-media-v1',
    h.owner._id,
    h.owner.productId,
    h.owner.operation.inputDigest,
    h.owner.operation.policy,
    h.owner.revision,
    h.owner.productFingerprint,
    body,
  ]);
  assert.ok(prepareOwnedApprovalReferences(h.owner, h.product));
  assert.equal(readOwnedApprovalReferencePlan(h.owner, binding), null);
});
