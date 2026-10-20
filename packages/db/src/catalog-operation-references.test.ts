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
  readOwnedApprovalReferenceCommitment,
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

for (const variants of [0, 105, 10000])
  test(`live refresh replaces only changed public references with ${variants} configurations`, () => {
    const h = fixture(1, 1, variants, true);
    const owner = {
      ...h.owner,
      operation: { ...h.owner.operation, intent: 'refresh-live' as const },
    };
    const oldPublication = structuredClone(owner.publication);
    oldPublication.header.images = ['/api/images/old-gallery'];
    oldPublication.header.descriptionImages = ['/api/images/old-description'];
    oldPublication.variantImageIds = Array.from({ length: variants }, (_, i) =>
      i === 0 ? 'gallery0' : `old-sku${i}`,
    );
    const product = { ...h.product, published: true, catalogDetailPublication: oldPublication };
    const frozen = structuredClone({ owner, product });
    const binding = prepareOwnedApprovalReferences(owner, product);
    assert.ok(
      binding,
      'A live refresh needs a before/after reference commitment, not a new publication increment.',
    );
    const plan = readOwnedApprovalReferencePlan(owner, binding, product);
    assert.ok(plan);
    const before = new Set(catalogReferencedImageIds(product));
    const after = new Set(h.ids);
    const expected = [
      ...[...before].filter((id) => !after.has(id)).map((imageId) => ({ imageId, delta: -1 })),
      ...[...after].filter((id) => !before.has(id)).map((imageId) => ({ imageId, delta: 1 })),
    ].sort((a, b) => (a.imageId < b.imageId ? -1 : a.imageId > b.imageId ? 1 : 0));
    assert.deepEqual(plan.changes, expected);
    assert.equal(
      plan.changes.some((change) => change.imageId === 'gallery0'),
      false,
      'Unchanged shared references must not increment again.',
    );
    assert.equal(binding.leafCount, expected.length);
    assert.deepEqual(readOwnedApprovalReferenceCommitment(owner, binding), plan.proof);
    assert.ok(
      Buffer.byteLength(JSON.stringify(binding)) < 1024,
      'The root must not duplicate 10000 old image IDs.',
    );
    assert.deepEqual({ owner, product }, frozen);
    assert.equal(
      readOwnedApprovalReferencePlan(owner, binding),
      null,
      'A bounded commitment alone cannot authorize image writes.',
    );
  });

test('unchanged live references have zero deltas and keep a bounded historical proof after a later edit', () => {
  const h = fixture(1, 1, 105, true);
  const owner = {
    ...h.owner,
    operation: { ...h.owner.operation, intent: 'refresh-live' as const },
  };
  const product: CollectionDoc & { catalogDetailPublication: typeof owner.publication } = {
    ...h.product,
    published: true,
    catalogDetailPublication: structuredClone(owner.publication),
  };
  const binding = prepareOwnedApprovalReferences(owner, product);
  assert.ok(binding);
  const plan = readOwnedApprovalReferencePlan(owner, binding, product);
  assert.ok(plan);
  assert.deepEqual(plan.changes, []);
  product.imageIds = ['later-gallery'];
  assert.equal(
    readOwnedApprovalReferencePlan(owner, binding, product),
    null,
    'A later edit must not reuse a write plan.',
  );
  assert.deepEqual(
    readOwnedApprovalReferenceCommitment(owner, binding),
    plan.proof,
    'Receipt inspection remains possible without authorizing writes.',
  );
});

for (const change of [
  'withdrawn',
  'archived',
  'wrong-product',
  'old-gallery',
  'old-variants',
  'new-gallery',
  'new-publication',
  'old-kind',
  'intent',
  'before-digest',
  'after-digest',
  'tree',
  'count',
  'extra',
] as const)
  test(`live reference writes reject ${change} against the original commitment`, () => {
    const h = fixture(1, 1, 2, true);
    const owner = {
      ...h.owner,
      operation: { ...h.owner.operation, intent: 'refresh-live' as const },
    };
    const product: CollectionDoc & { catalogDetailPublication: typeof owner.publication } = {
      ...h.product,
      published: true,
      catalogDetailPublication: structuredClone(owner.publication),
    };
    product.catalogDetailPublication.header.images = ['/api/images/old'];
    product.catalogDetailPublication.variantImageIds = ['old-sku'];
    const binding = prepareOwnedApprovalReferences(owner, product);
    assert.ok(binding);
    assert.ok(readOwnedApprovalReferencePlan(owner, binding, product));
    if (change === 'withdrawn') product.published = false;
    if (change === 'archived') product.archived = true;
    if (change === 'wrong-product') product._id = 'other';
    if (change === 'old-gallery')
      product.catalogDetailPublication.header.images = ['/api/images/other-old'];
    if (change === 'old-variants')
      product.catalogDetailPublication.variantImageIds = ['other-old-sku'];
    if (change === 'new-gallery') product.imageIds = ['new-unapproved'];
    if (change === 'new-publication')
      owner.publication.header.images = ['/api/images/new-unapproved'];
    if (change === 'old-kind') Reflect.set(binding, 'kind', 'catalog-owned-approval-references-v1');
    if (change === 'intent') Reflect.set(owner.operation, 'intent', 'publish');
    if (change === 'before-digest') Reflect.set(binding, 'beforeImageIdsDigest', 'f'.repeat(64));
    if (change === 'after-digest') Reflect.set(binding, 'afterImageIdsDigest', 'f'.repeat(64));
    if (change === 'tree') binding.treeRoot = 'f'.repeat(64);
    if (change === 'count') binding.leafCount++;
    if (change === 'extra') Reflect.set(binding, 'extra', 'untrusted');
    assert.equal(readOwnedApprovalReferencePlan(owner, binding, product), null);
  });

for (const field of ['treeRoot', 'leafCount'] as const)
  test(`recomputed live ${field} digest still cannot authorize a fabricated reference plan`, () => {
    const h = fixture(1);
    const owner = {
      ...h.owner,
      operation: { ...h.owner.operation, intent: 'refresh-live' as const },
    };
    const product: CollectionDoc & { catalogDetailPublication: typeof owner.publication } = {
      ...h.product,
      published: true,
      catalogDetailPublication: structuredClone(owner.publication),
    };
    const binding = prepareOwnedApprovalReferences(owner, product);
    assert.ok(binding);
    if (field === 'treeRoot') binding.treeRoot = 'f'.repeat(64);
    else binding.leafCount++;
    const { bindingDigest: _old, ...body } = binding;
    binding.bindingDigest = alibabaPricingFingerprint([
      'catalog-owned-approval-references-v1',
      owner._id,
      owner.productId,
      owner.operation.inputDigest,
      owner.operation.policy,
      owner.revision,
      owner.productFingerprint,
      owner.media.bindingDigest,
      body,
    ]);
    assert.equal(readOwnedApprovalReferencePlan(owner, binding, product), null);
  });

test('oversized old live reference sets return a controlled refusal without duplicating their IDs', () => {
  const h = fixture(1);
  const owner = {
    ...h.owner,
    operation: { ...h.owner.operation, intent: 'refresh-live' as const },
  };
  const publication = structuredClone(owner.publication);
  publication.variantImageIds = Array.from({ length: 65537 }, (_, i) => `old${i}`);
  const product = { ...h.product, published: true, catalogDetailPublication: publication };
  assert.equal(prepareOwnedApprovalReferences(owner, product), null);
});
