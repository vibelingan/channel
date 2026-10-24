/** The same save/replay/cancellation contract runs against both native persistence adapters. */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { resolvePublicVersion } from '@vibelingan-channel/shared/catalog-public-version';
import type { CatalogProductSaveInput, CatalogProductSaveResult } from './adapter.ts';
import { catalogApprovalDigest } from './catalog-detail-commit.ts';
import {
  type ApprovalPersistenceCommand,
  type ApprovalStageResult,
  prepareStagedApproval,
} from './catalog-detail-staging.ts';
import { runCatalogImageReferenceRead } from './catalog-image-reference-store.ts';
import { readLiveSaveReferences } from './catalog-operation-live-save.ts';
import { persistOwnedReferencePageWithRecovery } from './catalog-operation-reference-recovery.ts';
import { readOwnedApprovalReferenceCommitment } from './catalog-operation-references.ts';
import { finishOwnedMediaFixture } from './catalog-owned-media.fixture.ts';
import { createCatalogPreparationAuthority } from './catalog-preparation-authority.ts';
import { runCatalogPreparationJob } from './catalog-preparation-jobs.ts';
import { runProductOperationWorkflow } from './catalog-product-operation-workflow.ts';
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
  nativeConcurrency = false,
) {
  async function start(
    h: LiveSaveStorageHarness,
    values: Record<string, unknown> = { description: 'Reviewed', imageIds: ['new'] },
    nonce = operationId,
  ) {
    const row = record(
      await h.persist('admin', {
        action: 'operation-start',
        productId: 'p',
        operationId: nonce,
        intent: 'refresh-live',
        expectedUpdatedAt: at,
        values,
      }),
    );
    const identity = { productId: 'p', operationId: nonce, inputDigest: row.operation.inputDigest };
    const input: CatalogProductSaveInput = {
      mode: 'update',
      productId: 'p',
      expectedUpdatedAt: at,
      data: row.operation.values,
      expectedOperation: {
        actorId: 'admin',
        operationId: nonce,
        inputDigest: row.operation.inputDigest,
      },
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
  test(`${label} public live save stops between reference pages and resumes its original frozen values exactly once`, async (t) => {
    const data: Record<string, CollectionDoc[]> = initial();
    const product = data.products?.[0];
    assert.ok(product);
    const old = Array.from({ length: 36 }, (_, i) => `old${i}`);
    const added = Array.from({ length: 27 }, (_, i) => `new${i}`);
    product.imageIds = old.slice(0, 18);
    product.descriptionImageIds = old.slice(18);
    data.images = [
      ...old.map((_id) => ({ _id, publishedRefCount: 1 })),
      ...added.map((_id) => ({ ...initial().images[1], _id })),
    ];
    const h = create(t, data);
    const own = await start(h, {
      description: 'Frozen live edit',
      imageIds: added.slice(0, 9),
      descriptionImageIds: added.slice(9),
    });
    let admitted = true;
    let saves = 0;
    const store = {
      persist: async (actor: string, command: ApprovalPersistenceCommand) => {
        const result = await h.persist(actor, command);
        if (command.action === 'operation-live-save-reference-page') admitted = false;
        return result;
      },
      save: async (input: CatalogProductSaveInput) => {
        saves++;
        return h.save(input);
      },
    };
    const command = { ...own.identity, action: 'product-operation-save' };
    const partial = await runProductOperationWorkflow(store, 'admin', command, undefined, {
      canContinue: () => admitted,
    });
    assert.ok(partial.ok && partial.state === 'reserved', JSON.stringify(partial));
    assert.ok(partial.saveReferences?.prepared);
    assert.ok(partial.saveReferences.staged > 0 && partial.saveReferences.staged < 63);
    assert.equal(saves, 0);
    assert.equal((await h.get('products', 'p'))?.description, 'Old');
    assert.equal(await count(h, old[0] ?? ''), 1);
    for (let i = 0; i < 8; i++) {
      admitted = true;
      const resumed = await runProductOperationWorkflow(store, 'admin', command, undefined, {
        canContinue: () => admitted,
      });
      assert.ok(resumed.ok, JSON.stringify(resumed));
      if (resumed.state === 'saved') break;
      assert.equal(resumed.state, 'reserved');
    }
    assert.equal(saves, 1);
    assert.equal((await h.get('products', 'p'))?.description, 'Frozen live edit');
    for (const id of old) assert.equal(await count(h, id), 0);
    for (const id of added) assert.equal(await count(h, id), 1);
    const after = h.snapshot();
    const replay = await runProductOperationWorkflow(store, 'admin', command);
    assert.ok(replay.ok && replay.state === 'saved', JSON.stringify(replay));
    assert.equal(saves, 1);
    assert.equal(h.snapshot(), after);
    h.checkBudget?.();
  });
  for (const boundary of ['before-claim', 'claim', 'binding', 'page'] as const)
    test(`${label} live save resumes after its ${boundary} deadline without saving early or losing photo ownership`, async (t) => {
      const h = create(t, initial());
      const own = await start(h);
      let admitted = boundary !== 'before-claim';
      let saves = 0;
      const phase = {
        claim: 'operation-photo-claim',
        binding: 'operation-live-save-references',
        page: 'operation-live-save-reference-page',
        'before-claim': '',
      }[boundary];
      const store = {
        persist: async (actor: string, command: ApprovalPersistenceCommand) => {
          const result = await h.persist(actor, command);
          if (command.action === phase) admitted = false;
          return result;
        },
        save: async (input: CatalogProductSaveInput) => {
          saves++;
          return h.save(input);
        },
      };
      const command = { ...own.identity, action: 'product-operation-save' };
      const before = h.snapshot();
      const paused = await runProductOperationWorkflow(store, 'admin', command, undefined, {
        canContinue: () => admitted,
      });
      assert.ok(paused.ok && paused.state === 'reserved', JSON.stringify(paused));
      assert.equal(saves, 0);
      assert.equal((await h.get('products', 'p'))?.description, 'Old');
      if (boundary === 'before-claim') assert.equal(h.snapshot(), before);
      const resumed = await runProductOperationWorkflow(store, 'admin', command);
      assert.ok(resumed.ok && resumed.state === 'saved', JSON.stringify(resumed));
      assert.equal(resumed.photosPending, undefined);
      assert.equal(saves, 1);
      assert.equal(await count(h, 'old'), 0);
      assert.equal(await count(h, 'new'), 1);
      h.checkBudget?.();
    });
  test(`${label} live save confirms a reference page committed before a busy answer`, async (t) => {
    const h = create(t, initial());
    const own = await start(h);
    let pages = 0;
    const status = await runProductOperationWorkflow(
      {
        persist: async (actor, command) => {
          const result = await h.persist(actor, command);
          if (command.action === 'operation-live-save-reference-page') {
            pages++;
            return {
              ok: false,
              code: 'MEDIA_BUSY',
              referenceRecovery: {
                imageId: 'old',
                ledgerDigest: 'a'.repeat(64),
                nextOffset: 3,
              },
            };
          }
          return result;
        },
        save: h.save,
      },
      'admin',
      { ...own.identity, action: 'product-operation-save' },
    );
    assert.ok(status.ok && status.state === 'saved', JSON.stringify(status));
    assert.equal(pages, 1);
    assert.equal(status.referenceRecovery, undefined);
    assert.equal(await count(h, 'old'), 0);
    assert.equal(await count(h, 'new'), 1);
    h.checkBudget?.();
  });
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
    const publicStore = {
      persist: (
        actor: string,
        input: ApprovalPersistenceCommand,
        cursor?: unknown,
        budget?: number,
      ) =>
        input.action === 'operation-live-save-reference-page'
          ? persistOwnedReferencePageWithRecovery(
              { get: h.get, persist: h.persist },
              actor,
              input,
              cursor,
              undefined,
              budget,
            )
          : h.persist(actor, input),
      save: h.save,
    };
    const waiting = await runProductOperationWorkflow(publicStore, 'admin', {
      ...own,
      action: 'product-operation-save',
    });
    assert.ok(waiting.ok && waiting.state === 'reserved', JSON.stringify(waiting));
    assert.ok(waiting.referenceRecovery?.cursor);
    assert.equal(waiting.referenceRecovery.cursor.nextOffset, 3);
    const continued = await runProductOperationWorkflow(publicStore, 'admin', {
      ...own,
      action: 'product-operation-save',
      referenceRecovery: waiting.referenceRecovery.cursor,
    });
    assert.ok(continued.ok && continued.state === 'reserved', JSON.stringify(continued));
    assert.equal(continued.referenceRecovery?.cursor?.nextOffset, 6);
    assert.equal(await count(h, 'sharedOld'), 81);
    assert.deepEqual((await h.get('products', own.productId))?.imageIds, ['sharedOld']);
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
  test(`${label} native live row save and reapproval share the original Root and roll back a missing final proof`, async (t) => {
    const data: Record<string, CollectionDoc[]> = initial();
    const product = data.products?.[0];
    assert.ok(product);
    product.catalogDetailPublication = {
      state: 'approved',
      revision: 'prior',
      header: {
        schemaVersion: 'catalog-product-detail-v1',
        _id: 'p',
        name: 'Approved old clock',
        images: ['/api/images/old'],
        facts: [],
        offers: [],
      },
      variantCount: 0,
    };
    const newImage = data.images?.find((image) => image._id === 'new');
    assert.ok(newImage);
    newImage.byteSize = 123;
    newImage.checksumSha256 = 'a'.repeat(64);
    const h = create(t, data);
    const own = await start(h);
    await stage(h, own.identity);
    assert.equal((await h.save(own.input)).result, 'saved');
    record(await h.persist('admin', { ...own.identity, action: 'operation-photo-release' }));
    assert.equal(
      (
        await h.persist('admin', {
          action: 'manual-source',
          productId: 'p',
          configurationRowIds: [],
        })
      ).ok,
      true,
    );
    const saved = await h.get('products', 'p');
    assert.ok(saved);
    const prepared = prepareStagedApproval(
      'admin',
      {
        productId: 'p',
        operationId,
        expectedRevision: 'prior',
        expectedDigest: catalogApprovalDigest(saved, []),
      },
      saved,
      [],
    );
    assert.ok(prepared.ok, JSON.stringify(prepared));
    const begun = record(
      await h.persist('admin', {
        ...own.identity,
        action: 'operation-approval-begin',
        prepared: prepared.value,
      }),
    );
    assert.equal(begun._id, own.row._id);
    // Preparation metadata lifecycle only; real PNG bytes/compiled worker remain a separate gate.
    const now = Date.now();
    const authority = createCatalogPreparationAuthority({
      secret: 'native-live-approval-test',
      environmentId: 'native-live-approval-test',
      now: () => now,
    });
    const tx = { get: h.get, set: h.put };
    await finishOwnedMediaFixture(
      (command) => runCatalogPreparationJob(tx, authority, command, now),
      h.get,
      ['new'],
    );
    record(await h.persist('admin', { ...own.identity, action: 'operation-approval-media' }));
    record(await h.persist('admin', { ...own.identity, action: 'operation-approval-references' }));
    const staged = record(
      await h.persist('admin', {
        ...own.identity,
        action: 'operation-approval-reference-page',
        cursor: 0,
      }),
    );
    assert.ok(staged.state === 'staging' && staged.references);
    assert.equal(staged.references.leafCount, 1);
    assert.equal(await count(h, 'old'), 1);
    assert.equal(await count(h, 'new'), 1, 'raw save already grants exactly one row reference');
    const commitment = readOwnedApprovalReferenceCommitment(staged, staged.references);
    assert.ok(commitment && h.failProof);
    const before = h.snapshot();
    const restore = h.failProof(commitment._id);
    try {
      await assert.rejects(h.persist('admin', { ...own.identity, action: 'operation-publish' }));
    } finally {
      restore();
    }
    assert.equal(h.snapshot(), before);
    const finished = record(
      await h.persist('admin', { ...own.identity, action: 'operation-publish' }),
    );
    assert.equal(finished.state, 'complete');
    assert.equal(finished._id, own.row._id);
    const current = await h.get('products', 'p');
    assert.equal(current?.published, true);
    const publicVersion = resolvePublicVersion(current, { detailEnabled: true });
    assert.equal(publicVersion.kind, 'approved');
    if (publicVersion.kind === 'approved')
      assert.equal(publicVersion.publication.header.descriptionText, 'Reviewed');
    assert.equal(await count(h, 'old'), 0);
    assert.equal(await count(h, 'new'), 1, 'reapproval cannot count the retained row image twice');
    const after = h.snapshot();
    assert.equal(
      record(await h.persist('admin', { ...own.identity, action: 'operation-publish' })).state,
      'complete',
    );
    assert.equal(h.snapshot(), after);
    h.checkBudget?.();
  });
  // The CloudBase harness models native ACK/read/write semantics, not MVCC scheduling.
  // Real overlapping commits are tested on the actual JSON mutation lock here and on CloudBase in P7.
  if (nativeConcurrency) {
    test(`${label} simultaneous public live saves converge on the original saved receipt`, async (t) => {
      const h = create(t, initial());
      const own = await start(h);
      const store = { persist: h.persist, save: h.save };
      const command = { ...own.identity, action: 'product-operation-save' };
      const results = await Promise.allSettled([
        runProductOperationWorkflow(store, 'admin', command),
        runProductOperationWorkflow(store, 'admin', command),
      ]);
      for (const result of results) {
        assert.ok(result.status === 'fulfilled', JSON.stringify(result));
        assert.ok(result.value.ok && result.value.state === 'saved', JSON.stringify(result.value));
      }
      assert.equal((await h.get('products', 'p'))?.catalogContentGeneration, 1);
      assert.equal(await count(h, 'old'), 0);
      assert.equal(await count(h, 'new'), 1);
      h.checkBudget?.();
    });
    test(`${label} concurrent live editors commit exactly one row and one reference proof`, async (t) => {
      const data: Record<string, CollectionDoc[]> = initial();
      const image = data.images?.find((r) => r._id === 'new');
      assert.ok(image);
      data.images?.push({ ...image, _id: 'otherNew', storageFileId: 'otherNew' });
      const h = create(t, data);
      const first = await start(h);
      const second = await start(
        h,
        { description: 'Competing editor', imageIds: ['otherNew'] },
        '12345678-1234-4234-8234-123456789013',
      );
      await stage(h, first.identity);
      await stage(h, second.identity);
      const attempts = await Promise.allSettled([h.save(first.input), h.save(second.input)]);
      assert.equal(attempts.filter((r) => r.status === 'rejected').length, 0);
      const successes = attempts
        .map((r, i) => (r.status === 'fulfilled' && r.value.result === 'saved' ? i : -1))
        .filter((i) => i >= 0);
      assert.equal(successes.length, 1, JSON.stringify(attempts));
      const winner = successes[0] === 0 ? first : second;
      const loser = successes[0] === 0 ? second : first;
      assert.equal(await count(h, 'old'), 0);
      assert.equal(await count(h, successes[0] === 0 ? 'new' : 'otherNew'), 1);
      assert.equal(await count(h, successes[0] === 0 ? 'otherNew' : 'new'), 0);
      const saved = record(
        await h.persist('admin', { ...query, operationId: winner.identity.operationId }),
      );
      assert.equal(saved.state, 'saved');
      record(await h.persist('admin', { ...loser.identity, action: 'operation-cancel' }));
      assert.equal(await count(h, 'old'), 0);
      assert.equal(await count(h, successes[0] === 0 ? 'otherNew' : 'new'), 0);
    });
    test(`${label} concurrent original-ID retries preserve one live save and one image delta`, async (t) => {
      const h = create(t, initial());
      const own = await start(h);
      await stage(h, own.identity);
      const attempts = await Promise.allSettled([h.save(own.input), h.save(own.input)]);
      assert.equal(
        attempts.filter((r) => r.status === 'fulfilled' && r.value.result === 'saved').length,
        2,
      );
      assert.equal(await count(h, 'new'), 1);
      assert.equal(await count(h, 'old'), 0);
      assert.equal(record(await h.persist('admin', query)).state, 'saved');
    });
    for (const cancelFirst of [false, true])
      test(`${label} live save racing cancellation preserves the winning business result cancelFirst=${cancelFirst}`, async (t) => {
        const h = create(t, initial());
        const own = await start(h);
        await stage(h, own.identity);
        const save = () => h.save(own.input);
        const cancel = () => h.persist('admin', { ...own.identity, action: 'operation-cancel' });
        const attempts = await Promise.allSettled(
          cancelFirst ? [cancel(), save()] : [save(), cancel()],
        );
        assert.equal(attempts.filter((r) => r.status === 'rejected').length, 0);
        const row = record(await h.persist('admin', query));
        assert.ok(row.operation.cancelledAt);
        const committed = row.state === 'saved';
        assert.equal(committed, !cancelFirst);
        assert.equal(await count(h, 'new'), committed ? 1 : 0);
        assert.equal(await count(h, 'old'), committed ? 0 : 1);
        assert.equal((await h.get('products', 'p'))?.published, true);
        assert.ok(!(await h.get('images', 'new'))?.imageMutationOwner);
      });
  }
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
