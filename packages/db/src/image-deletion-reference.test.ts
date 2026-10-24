import assert from 'node:assert/strict';
import test from 'node:test';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import {
  buildCatalogImageReferencePlan,
  catalogImageReferenceCancelProof,
  catalogImageReferenceEntry,
} from './catalog-image-references.ts';
import { executeImageDeletion } from './image-deletion-runner.ts';
import { readImageDeletionIntent, runImageDeletion } from './image-deletion.ts';

const now = '2026-10-18T00:00:00.000Z';
const begin = {
  action: 'begin',
  imageId: 'image',
  uploadedByUserId: 'u',
  owner: 'op',
  startedAt: now,
} as const;
function fixture(base: number, delta: 1 | -1, kind: 'commit' | 'cancel' | 'missing') {
  const plan = buildCatalogImageReferencePlan(
    '1'.repeat(64),
    delta === -1 ? ['image'] : [],
    delta === 1 ? ['image'] : [],
  );
  const rows: Record<string, CollectionDoc[]> = {
    images: [
      {
        _id: 'image',
        status: 'active',
        uploadedByUserId: 'u',
        publishedRefCount: base,
        imageMutationOwner: 'op',
        imageMutationStartedAt: now,
        storageProvider: 'local-disk',
        storageFileId: 'local://one',
        migrationStorageFileId: 'local://two',
        privateMetadata: { keep: true },
        catalogPublishedReferenceLedger: {
          version: 'catalog-image-reference-ledger-v1',
          epoch: 4,
          pending: [catalogImageReferenceEntry(plan, 0)],
        },
      },
    ],
    catalogDetailApprovals:
      kind === 'missing'
        ? []
        : [kind === 'cancel' ? catalogImageReferenceCancelProof(plan.proof) : plan.proof],
  };
  const calls: string[] = [];
  let wrote = false;
  const store = {
    get: async (collection: string, id: string) => {
      assert.equal(wrote, false, 'all snapshot reads must precede deletion write');
      calls.push(`get:${collection}:${id}`);
      return structuredClone(rows[collection]?.find((row) => row._id === id) ?? null);
    },
    set: async (collection: string, row: CollectionDoc) => {
      wrote = true;
      calls.push(`set:${collection}:${row._id}`);
      rows[collection] = [structuredClone(row)];
    },
    remove: async (collection: string, id: string) => {
      wrote = true;
      calls.push(`remove:${collection}:${id}`);
      rows[collection] = [];
    },
  };
  return {
    rows,
    calls,
    store,
    plan,
    image: () => rows.images?.[0] ?? assert.fail(),
    bytes: () => JSON.stringify(rows),
    reset: () => {
      wrote = false;
      calls.length = 0;
    },
  };
}
test('deletion cannot quarantine a zero base whose committed proof is public', async () => {
  const h = fixture(0, 1, 'commit');
  const before = h.bytes();
  assert.deepEqual(await runImageDeletion(h.store, begin), { status: 'conflict' });
  assert.equal(h.bytes(), before);
});
test('deletion settles a committed removal and writes one empty-ledger quarantine', async () => {
  const h = fixture(1, -1, 'commit');
  const result = await runImageDeletion(h.store, begin);
  assert.equal(result.status, 'ready');
  assert.equal(h.image().publishedRefCount, 0);
  assert.equal(h.image().status, 'deleted');
  assert.deepEqual(h.image().catalogPublishedReferenceLedger, {
    version: 'catalog-image-reference-ledger-v1',
    epoch: 5,
    pending: [],
  });
  assert.deepEqual(h.image().privateMetadata, { keep: true });
  assert.deepEqual(
    h.calls.filter((c) => c.startsWith('set:')),
    ['set:images:image'],
  );
  assert.equal(h.rows.catalogDetailApprovals?.length, 1);
});
test('deletion clears cancelled addition together with its durable quarantine', async () => {
  const h = fixture(0, 1, 'cancel');
  assert.equal((await runImageDeletion(h.store, begin)).status, 'ready');
  assert.deepEqual(h.image().catalogPublishedReferenceLedger, {
    version: 'catalog-image-reference-ledger-v1',
    epoch: 5,
    pending: [],
  });
});
test('an unresolved pending reference prevents deletion even with effective zero', async () => {
  const h = fixture(0, 1, 'missing');
  const before = h.bytes();
  assert.deepEqual(await runImageDeletion(h.store, begin), { status: 'conflict' });
  assert.equal(h.bytes(), before);
});
for (const damaged of ['proof', 'ledger'] as const)
  test(`deletion refuses corrupt ${damaged} without mutation`, async () => {
    const h = fixture(0, 1, 'commit');
    if (damaged === 'proof') {
      const proof = h.rows.catalogDetailApprovals?.[0] ?? assert.fail();
      proof.kind = 'unknown';
    } else
      h.image().catalogPublishedReferenceLedger = { version: 'unknown', epoch: 4, pending: [] };
    const before = h.bytes();
    assert.deepEqual(await runImageDeletion(h.store, begin), { status: 'corrupt' });
    assert.equal(h.bytes(), before);
  });
test('a persisted quarantine with pending references is not a resumable deletion intent', async () => {
  const h = fixture(0, 1, 'missing');
  const ledger = h.image().catalogPublishedReferenceLedger;
  Reflect.deleteProperty(h.image(), 'catalogPublishedReferenceLedger');
  const result = await runImageDeletion(h.store, begin);
  assert.equal(result.status, 'ready');
  h.image().catalogPublishedReferenceLedger = ledger;
  assert.equal(readImageDeletionIntent(h.image()), null);
});
test('orphan deletion also refuses an unresolved reference', async () => {
  const h = fixture(0, 1, 'missing');
  h.image().status = 'pending';
  h.image().createdAt = '2026-10-01T00:00:00.000Z';
  const before = h.bytes();
  assert.deepEqual(
    await runImageDeletion(h.store, {
      action: 'begin-orphan',
      imageId: 'image',
      owner: 'op',
      startedAt: now,
      cutoff: '2026-10-17T00:00:00.000Z',
    }),
    { status: 'conflict' },
  );
  assert.equal(h.bytes(), before);
});

for (const denial of ['uploader', 'lock', 'status'] as const)
  test(`deletion refuses ${denial} before loading any proofs`, async () => {
    const h = fixture(0, 1, 'commit');
    if (denial === 'uploader') h.image().uploadedByUserId = 'other';
    if (denial === 'lock') h.image().imageMutationOwner = 'other';
    if (denial === 'status') h.image().status = 'pending';
    const before = h.bytes();
    assert.equal(
      (await runImageDeletion(h.store, begin)).status,
      denial === 'uploader' ? 'forbidden' : 'conflict',
    );
    assert.deepEqual(h.calls, ['get:images:image']);
    assert.equal(h.bytes(), before);
  });
test('80 cancelled references and deletion quarantine fit 83 document operations with one write', async () => {
  const h = fixture(0, 1, 'cancel');
  const plans = Array.from({ length: 80 }, (_, index) =>
    buildCatalogImageReferencePlan((index + 1).toString(16).padStart(64, '0'), [], ['image']),
  );
  h.rows.catalogDetailApprovals = plans.map((plan) => catalogImageReferenceCancelProof(plan.proof));
  h.image().catalogPublishedReferenceLedger = {
    version: 'catalog-image-reference-ledger-v1',
    epoch: 4,
    pending: plans.map((plan) => catalogImageReferenceEntry(plan, 0)),
  };
  assert.equal((await runImageDeletion(h.store, begin)).status, 'ready');
  assert.equal(h.calls.length, 83);
  assert.equal(h.calls.filter((c) => c.startsWith('set:')).length, 1);
  assert.equal(h.rows.catalogDetailApprovals.length, 80);
  assert.equal(readImageDeletionIntent(h.image())?.operationId, 'op');
});
for (const count of [0, 1])
  test(`valid empty reference ledger count=${count} retains the one-read deletion path`, async () => {
    const h = fixture(count, 1, 'missing');
    h.image().catalogPublishedReferenceLedger = {
      version: 'catalog-image-reference-ledger-v1',
      epoch: 4,
      pending: [],
    };
    assert.equal(
      (await runImageDeletion(h.store, begin)).status,
      count === 0 ? 'ready' : 'conflict',
    );
    assert.equal(h.calls.filter((c) => c.startsWith('get:')).length, 1);
  });
for (const count of ['0', -1, 0.5])
  test(`deletion rejects invalid ledger base ${count} before quarantine`, async () => {
    const h = fixture(0, 1, 'cancel');
    h.image().publishedRefCount = count;
    const before = h.bytes();
    assert.equal((await runImageDeletion(h.store, begin)).status, 'corrupt');
    assert.equal(h.bytes(), before);
  });
test('mixed terminals are not partially settled if another reference is still unresolved', async () => {
  const h = fixture(0, 1, 'cancel');
  const missing = buildCatalogImageReferencePlan('2'.repeat(64), [], ['image']);
  h.image().catalogPublishedReferenceLedger = {
    version: 'catalog-image-reference-ledger-v1',
    epoch: 4,
    pending: [catalogImageReferenceEntry(h.plan, 0), catalogImageReferenceEntry(missing, 0)],
  };
  const before = h.bytes();
  assert.equal((await runImageDeletion(h.store, begin)).status, 'conflict');
  assert.equal(h.bytes(), before);
  assert.equal(
    h.calls.some((c) => c.startsWith('set:')),
    false,
  );
});
test('proof transport failure is not downgraded into a deletion decision', async () => {
  const h = fixture(0, 1, 'cancel');
  const get = h.store.get;
  h.store.get = async (collection, id) => {
    if (collection === 'catalogDetailApprovals')
      throw new Error('injected proof transport failure');
    return get(collection, id);
  };
  const before = h.bytes();
  await assert.rejects(runImageDeletion(h.store, begin), /injected proof transport failure/);
  assert.equal(h.bytes(), before);
});
test('a different second image snapshot is refused without changing storage identity', async () => {
  const h = fixture(1, -1, 'commit');
  const get = h.store.get;
  let reads = 0;
  h.store.get = async (collection, id) => {
    const row = await get(collection, id);
    if (collection === 'images' && ++reads === 2 && row) row.storageFileId = 'local://different';
    return row;
  };
  const before = h.bytes();
  assert.equal((await runImageDeletion(h.store, begin)).status, 'corrupt');
  assert.equal(h.bytes(), before);
});
test('lost quarantine acknowledgement resumes only a persisted cleared-ledger deletion intent', async () => {
  const h = fixture(1, -1, 'commit');
  let lose = true;
  const deleted: string[] = [];
  const result = await executeImageDeletion(
    {
      manage: async (command) => {
        h.reset();
        const outcome = await runImageDeletion(h.store, command);
        if (lose && command.action === 'begin') {
          lose = false;
          throw new Error('lost quarantine answer');
        }
        return outcome;
      },
      get: async () => structuredClone(h.rows.images?.[0] ?? null),
    },
    begin,
    async (id) => {
      deleted.push(id);
    },
  );
  assert.equal(result, 'deleted');
  assert.deepEqual(deleted, ['local://one', 'local://two']);
  assert.equal(h.rows.images?.length, 0);
  assert.equal(h.rows.catalogDetailApprovals?.length, 1);
});
