/** The same save/replay/cancellation contract runs against both native persistence adapters. */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { resolvePublicVersion } from '@vibelingan-channel/shared/catalog-public-version';
import type { CatalogProductSaveInput, CatalogProductSaveResult } from './adapter.ts';
import type { ApprovalPersistenceCommand, ApprovalStageResult } from './catalog-detail-staging.ts';
import { runCatalogImageReferenceRead } from './catalog-image-reference-store.ts';
import { readLiveSaveReferences } from './catalog-operation-live-save.ts';
import { persistOwnedReferencePageWithRecovery } from './catalog-operation-reference-recovery.ts';
export interface LiveSaveStorageHarness {
  persist(actor: string, command: ApprovalPersistenceCommand): Promise<ApprovalStageResult>;
  save(input: CatalogProductSaveInput): Promise<CatalogProductSaveResult>;
  get(collection: string, id: string): Promise<CollectionDoc | null>;
  put(collection: string, row: CollectionDoc): Promise<void>;
  snapshot(): string;
  failProof?(id: string): () => void;
  checkBudget?(): void;
}
const operationId = '12345678-1234-4234-8234-123456789012';
const at = '2026-10-18T00:00:00.000Z';
const query = { action: 'operation-get' as const, productId: 'p', operationId };
function record(result: ApprovalStageResult) {
  assert.ok(result.ok && 'record' in result, JSON.stringify(result));
  return result.record;
}
function initial() {
  return {
    users: [{ _id: 'admin', role: 'admin' }],
    products: [
      {
        _id: 'p',
        name: 'Clock',
        description: 'Old',
        productFamily: 'misc',
        published: true,
        archived: false,
        imageIds: ['old'],
        updatedAt: at,
      },
    ],
    images: [
      { _id: 'old', publishedRefCount: 1 },
      {
        _id: 'new',
        publishedRefCount: 0,
        status: 'active',
        storageProvider: 'local-disk',
        storageFileId: 'new',
        mimeType: 'image/png',
        byteSize: 10,
        checksumSha256: 'c'.repeat(64),
      },
    ],
  };
}
export function registerLiveSaveStorageContract(
  label: string,
  create: (t: TestContext, initial: Record<string, CollectionDoc[]>) => LiveSaveStorageHarness,
) {
  async function start(
    h: LiveSaveStorageHarness,
    values: Record<string, unknown> = { description: 'Reviewed', imageIds: ['new'] },
  ) {
    const row = record(
      await h.persist('admin', {
        action: 'operation-start',
        productId: 'p',
        operationId,
        intent: 'refresh-live',
        expectedUpdatedAt: at,
        values,
      }),
    );
    const identity = { productId: 'p', operationId, inputDigest: row.operation.inputDigest };
    const input: CatalogProductSaveInput = {
      mode: 'update',
      productId: 'p',
      expectedUpdatedAt: at,
      data: row.operation.values,
      expectedOperation: { actorId: 'admin', operationId, inputDigest: row.operation.inputDigest },
      expectedImageMutationOwner: row._id,
    };
    return { row, identity, input };
  }
  async function stage(
    h: LiveSaveStorageHarness,
    identity: { productId: string; operationId: string; inputDigest: string },
  ) {
    record(await h.persist('admin', { ...identity, action: 'operation-photo-claim' }));
    let row = record(
      await h.persist('admin', { ...identity, action: 'operation-live-save-references' }),
    );
    while (
      row.liveSaveReferences &&
      row.liveSaveReferences.cursor < row.liveSaveReferences.changes.length
    )
      row = record(
        await h.persist('admin', {
          ...identity,
          action: 'operation-live-save-reference-page',
          cursor: row.liveSaveReferences.cursor,
        }),
      );
    return row;
  }
  async function count(h: LiveSaveStorageHarness, imageId: string) {
    const result = await runCatalogImageReferenceRead(
      {
        get: h.get,
        set: async () => {
          throw Error('read must not write');
        },
      },
      { action: 'read', imageId },
    );
    assert.equal(result.state, 'counted');
    return result.state === 'counted' ? result.effectiveCount : null;
  }
  test(`${label} live row save commits product/receipt/public-reference proof once and recovers a lost answer`, async (t) => {
    const h = create(t, initial());
    const original = await h.get('products', 'p');
    const { identity, input } = await start(h);
    const staged = await stage(h, identity);
    assert.deepEqual(await h.get('products', 'p'), original);
    assert.equal(await count(h, 'new'), 0);
    assert.equal(await count(h, 'old'), 1);
    const saved = await h.save(input);
    assert.equal(saved.result, 'saved', JSON.stringify(saved));
    const row = await h.get('products', 'p');
    assert.equal(row?.published, true);
    assert.deepEqual(row?.imageIds, ['new']);
    assert.equal(row?.description, 'Reviewed');
    assert.equal(row?.productFamily, original?.productFamily);
    assert.equal(await count(h, 'new'), 1);
    assert.equal(await count(h, 'old'), 0);
    const refs = readLiveSaveReferences(staged, staged.liveSaveReferences);
    assert.ok(refs);
    assert.deepEqual(await h.get('catalogDetailApprovals', refs.plan.proof._id), refs.plan.proof);
    const receipt = record(await h.persist('admin', query));
    assert.equal(receipt.state, 'saved');
    const bytes = h.snapshot();
    const replay = await h.save(input);
    assert.equal(replay.result, 'saved');
    assert.equal(h.snapshot(), bytes, 'original save replay writes nothing');
    h.checkBudget?.();
  });
  test(`${label} saving a live edit preserves the valid approved buyer version and its image rights`, async (t) => {
    const data: Record<string, CollectionDoc[]> = initial();
    const product = data.products?.[0];
    assert.ok(product);
    const publication = {
      state: 'approved',
      revision: 'approved-r1',
      header: {
        schemaVersion: 'catalog-product-detail-v1',
        _id: 'p',
        name: 'Approved clock',
        descriptionText: 'Approved description',
        images: ['/api/images/approved'],
        facts: [],
        offers: [],
      },
      variantCount: 0,
    };
    product.catalogDetailPublication = publication;
    data.images?.push({ _id: 'approved', publishedRefCount: 1 });
    const h = create(t, data);
    const { identity, input } = await start(h);
    await stage(h, identity);
    assert.equal((await h.save(input)).result, 'saved');
    const saved = await h.get('products', 'p');
    assert.ok(saved);
    assert.equal(saved.description, 'Reviewed');
    assert.equal(saved.published, true);
    assert.deepEqual(saved.catalogDetailPublication, publication);
    const visible = resolvePublicVersion(saved, { detailEnabled: true });
    assert.equal(visible.kind, 'approved');
    if (visible.kind === 'approved')
      assert.equal(visible.publication.header.descriptionText, 'Approved description');
    assert.equal(await count(h, 'approved'), 1);
    assert.equal(await count(h, 'new'), 1);
    assert.equal(await count(h, 'old'), 0);
    h.checkBudget?.();
  });
  for (const phase of ['before-stage', 'after-stage', 'after-save'] as const)
    test(`${label} cancelling live edit ${phase} preserves acknowledged business state and releases photos`, async (t) => {
      const h = create(t, initial());
      const { identity, input } = await start(h);
      if (phase !== 'before-stage') await stage(h, identity);
      if (phase === 'after-save') assert.equal((await h.save(input)).result, 'saved');
      const product = await h.get('products', 'p');
      const cancelled = record(
        await h.persist('admin', { ...identity, action: 'operation-cancel' }),
      );
      assert.ok(cancelled.operation.cancelledAt);
      assert.deepEqual(await h.get('products', 'p'), product);
      assert.equal(await count(h, 'new'), phase === 'after-save' ? 1 : 0);
      assert.equal(await count(h, 'old'), phase === 'after-save' ? 0 : 1);
      const photo = await h.get('images', 'new');
      assert.ok(!photo?.imageMutationOwner);
      const before = h.snapshot();
      assert.notEqual((await h.save(input)).result, 'saved');
      assert.equal(h.snapshot(), before);
      h.checkBudget?.();
    });
  for (const failure of [
    'not-bound',
    'not-staged',
    'withdrawn',
    'archived',
    'edited',
    'reclassified',
    'revoked',
    'image-deleted',
    'proof-missing',
  ] as const)
    test(`${label} live save rejects ${failure} without a partial product or receipt write`, async (t) => {
      const h = create(t, initial());
      const { identity, input } = await start(h);
      if (!['not-bound', 'not-staged'].includes(failure)) await stage(h, identity);
      if (failure === 'not-staged')
        record(await h.persist('admin', { ...identity, action: 'operation-live-save-references' }));
      const product = await h.get('products', 'p');
      assert.ok(product);
      if (failure === 'withdrawn') await h.put('products', { ...product, published: false });
      if (failure === 'archived') await h.put('products', { ...product, archived: true });
      if (failure === 'edited')
        await h.put('products', { ...product, description: 'Other editor' });
      if (failure === 'reclassified')
        await h.put('products', { ...product, productFamily: 'toys' });
      if (failure === 'revoked') await h.put('users', { _id: 'admin', role: 'member' });
      if (failure === 'image-deleted') {
        const image = await h.get('images', 'new');
        assert.ok(image);
        await h.put('images', { ...image, status: 'deleted' });
      }
      if (failure === 'proof-missing') {
        assert.equal((await h.save(input)).result, 'saved');
        const saved = record(await h.persist('admin', query));
        const refs = readLiveSaveReferences(saved, saved.liveSaveReferences);
        assert.ok(refs);
        await h.put('catalogDetailApprovals', { _id: refs.plan.proof._id, kind: 'corrupt' });
      }
      const before = h.snapshot();
      assert.notEqual((await h.save(input)).result, 'saved');
      assert.equal(h.snapshot(), before);
      h.checkBudget?.();
    });
  test(`${label} live text-only save has no empty reference proof to collide with later approval`, async (t) => {
    const h = create(t, initial());
    const { identity, input } = await start(h, { description: 'Text only' });
    const staged = await stage(h, identity);
    const refs = readLiveSaveReferences(staged, staged.liveSaveReferences);
    assert.ok(refs);
    assert.equal(refs.plan.changes.length, 0);
    assert.equal((await h.save(input)).result, 'saved');
    assert.equal(await h.get('catalogDetailApprovals', refs.plan.proof._id), null);
    h.checkBudget?.();
  });
  test(`${label} live save full-slot recovery cancels an obsolete real Root and resumes the original page`, async (t) => {
    const data: Record<string, CollectionDoc[]> = initial();
    const product = data.products?.[0];
    const newImage = data.images?.find((r) => r._id === 'new');
    assert.ok(product && newImage);
    data.products = Array.from({ length: 81 }, (_, i) => ({
      ...product,
      _id: `p${i}`,
      imageIds: ['sharedOld'],
    }));
    data.images = [
      { _id: 'sharedOld', publishedRefCount: 81 },
      ...Array.from({ length: 81 }, (_, i) => ({
        ...newImage,
        _id: `new${i}`,
        storageFileId: `new${i}`,
      })),
    ];
    const h = create(t, data);
    const identities = [];
    for (let i = 0; i < 81; i++) {
      const operationId = `12345678-1234-4234-8234-${String(i).padStart(12, '0')}`;
      const row = record(
        await h.persist('admin', {
          action: 'operation-start',
          productId: `p${i}`,
          operationId,
          intent: 'refresh-live',
          expectedUpdatedAt: at,
          values: { imageIds: [`new${i}`] },
        }),
      );
      const identity = { productId: `p${i}`, operationId, inputDigest: row.operation.inputDigest };
      identities.push(identity);
      record(await h.persist('admin', { ...identity, action: 'operation-photo-claim' }));
      const bound = record(
        await h.persist('admin', { ...identity, action: 'operation-live-save-references' }),
      );
      assert.ok(bound.liveSaveReferences);
      if (i < 80)
        record(
          await h.persist('admin', {
            ...identity,
            action: 'operation-live-save-reference-page',
            cursor: 0,
          }),
        );
    }
    const own = identities[80];
    assert.ok(own);
    const command = { ...own, action: 'operation-live-save-reference-page' as const, cursor: 0 };
    const full = await h.persist('admin', command);
    assert.equal(!full.ok && full.code, 'MEDIA_BUSY');
    const obsolete = await h.get('products', 'p0');
    assert.ok(obsolete);
    await h.put('products', { ...obsolete, description: 'Changed by another editor' });
    const recovered = record(
      await persistOwnedReferencePageWithRecovery(
        { get: h.get, persist: h.persist },
        'admin',
        command,
      ),
    );
    assert.equal(recovered.operationId, own.operationId);
    assert.equal(recovered.liveSaveReferences?.cursor, 2);
    const first = identities[0];
    assert.ok(first);
    const abandoned = record(
      await h.persist('admin', {
        productId: first.productId,
        operationId: first.operationId,
        action: 'operation-get',
      }),
    );
    assert.ok(
      abandoned?.operation &&
        typeof abandoned.operation === 'object' &&
        Reflect.get(abandoned.operation, 'cancelledAt'),
    );
    assert.equal(
      await count(h, 'sharedOld'),
      81,
      'cancelling private deltas must preserve public references',
    );
    const saved = await h.save({
      mode: 'update',
      productId: own.productId,
      expectedUpdatedAt: at,
      data: { imageIds: ['new80'] },
      expectedOperation: {
        actorId: 'admin',
        operationId: own.operationId,
        inputDigest: own.inputDigest,
      },
      expectedImageMutationOwner: recovered._id,
    });
    assert.equal(saved.result, 'saved', JSON.stringify(saved));
    assert.equal(await count(h, 'sharedOld'), 80);
    assert.equal(await count(h, 'new80'), 1);
    h.checkBudget?.();
  });
  test(`${label} failure at the final live-save proof rolls back product and own receipt`, async (t) => {
    const h = create(t, initial());
    const { identity, input } = await start(h);
    const staged = await stage(h, identity);
    const refs = readLiveSaveReferences(staged, staged.liveSaveReferences);
    assert.ok(refs);
    assert.ok(h.failProof, 'storage harness must inject persistence failure');
    const before = h.snapshot();
    const restore = h.failProof(refs.plan.proof._id);
    try {
      await assert.rejects(h.save(input));
    } finally {
      restore();
    }
    assert.equal(h.snapshot(), before);
    assert.equal(await count(h, 'new'), 0);
    assert.equal(await count(h, 'old'), 1);
    assert.equal((await h.save(input)).result, 'saved');
    assert.equal(await count(h, 'new'), 1);
    assert.equal(await count(h, 'old'), 0);
    h.checkBudget?.();
  });
}
