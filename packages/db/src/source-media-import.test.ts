import assert from 'node:assert/strict';
import test from 'node:test';
import { sourceMediaLinkId } from '@vibelingan-channel/catalog-import/observations';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import {
  buildCatalogImageReferencePlan,
  catalogImageReferenceCancelProof,
  catalogImageReferenceEntry,
} from './catalog-image-references.ts';
import { readImageDeletionIntent } from './image-deletion.ts';
import {
  type SourceMediaImportCommand,
  SourceMediaImportCommandSchema,
  runSourceMediaImport,
} from './source-media-import.ts';

const now = '2026-10-15T00:00:00.000Z';
const later = '2026-10-15T00:03:00.000Z';
const sourceUrl = 'https://sc04.alicdn.com/a.png';
const base = { sourceUrl, operationId: 'operation-1', imageId: 'image-1', now };
const claim = { ...base, action: 'claim' } as const;
const target = {
  storageProvider: 'local-disk',
  storageMode: 'local-disk',
  storageFileId: 'local-disk:Case%20Sensitive ',
  storagePath: 'catalog/owned/a.png',
  byteSize: 68,
  checksumSha256: 'a'.repeat(64),
  mimeType: 'image/png',
  name: 'a.png',
} as const;
const checkpoint = { ...base, action: 'checkpoint', target } as const;
const activate = { ...base, action: 'activate', target } as const;
const linkId = sourceMediaLinkId('alibaba', sourceUrl);
function fixture() {
  let rows = new Map<string, CollectionDoc>();
  const key = (collection: string, id: string) => `${collection}\0${id}`;
  let maximumOperations = 0;
  const f = {
    get: (collection: string, id: string) => structuredClone(rows.get(key(collection, id)) ?? null),
    put: (collection: string, row: CollectionDoc) => {
      rows.set(key(collection, row._id), structuredClone(row));
    },
    snapshot: () => structuredClone(rows),
    max: () => maximumOperations,
    async run(command: SourceMediaImportCommand) {
      const copy = structuredClone(rows);
      let writes = false;
      let operations = 0;
      const result = await runSourceMediaImport(
        {
          get: async (collection, id) => {
            assert.equal(writes, false, 'all reads precede writes');
            operations++;
            return structuredClone(copy.get(key(collection, id)) ?? null);
          },
          set: async (collection, row) => {
            writes = true;
            operations++;
            copy.set(key(collection, row._id), structuredClone(row));
          },
          remove: async (collection, id) => {
            writes = true;
            operations++;
            assert.ok(copy.delete(key(collection, id)), 'confirmed pending row removal');
          },
        },
        command,
      );
      rows = copy;
      maximumOperations = Math.max(maximumOperations, operations);
      return result;
    },
  };
  return f;
}
async function claimed() {
  const f = fixture();
  assert.equal((await f.run(claim)).status, 'claimed');
  return f;
}
async function staged() {
  const f = await claimed();
  assert.equal((await f.run(checkpoint)).status, 'checkpointed');
  return f;
}
async function active() {
  const f = await staged();
  assert.deepEqual(await f.run(activate), {
    status: 'ready',
    imageId: base.imageId,
    deduplicated: false,
  });
  return f;
}
function hold(f: ReturnType<typeof fixture>, id: string, owner: string) {
  const image = f.get('images', id);
  assert.ok(image);
  f.put('images', { ...image, imageMutationOwner: owner, imageMutationStartedAt: now });
}

test('claim, permanent checkpoint and atomic activation are idempotent with bounded reads and writes', async () => {
  const f = await claimed();
  assert.equal(f.get('images', base.imageId)?.status, 'pending');
  assert.equal(f.get('images', base.imageId)?.storageFileId, undefined);
  assert.equal((await f.run(claim)).status, 'claimed');
  assert.equal((await f.run(checkpoint)).status, 'checkpointed');
  assert.equal((await f.run(checkpoint)).status, 'checkpointed');
  assert.equal(f.get('images', base.imageId)?.storageFileId, target.storageFileId);
  assert.deepEqual(await f.run(activate), {
    status: 'ready',
    imageId: base.imageId,
    deduplicated: false,
  });
  assert.equal(f.get('images', base.imageId)?.status, 'active');
  assert.equal(f.get('catalogSourceLinks', linkId)?.imageId, base.imageId);
  assert.equal(f.get('catalogSourceLinks', linkId)?.mediaImport, undefined);
  assert.deepEqual(await f.run(activate), {
    status: 'ready',
    imageId: base.imageId,
    deduplicated: false,
  });
  assert.equal((await f.run({ ...base, action: 'fail', reason: 'write-failed' })).status, 'ready');
  assert.ok(f.max() <= 4);
});
test('a completed URL binding is reused without creating a second pending image', async () => {
  const f = await active();
  const before = f.snapshot();
  assert.deepEqual(await f.run({ ...claim, operationId: 'other', imageId: 'other' }), {
    status: 'ready',
    imageId: base.imageId,
    deduplicated: true,
  });
  assert.deepEqual(f.snapshot(), before);
});
test('busy URL has one claimant; expired takeover fences every late old write and retains old target', async () => {
  const f = await staged();
  const second = { ...claim, operationId: 'operation-2', imageId: 'image-2' };
  assert.equal((await f.run(second)).status, 'busy');
  assert.equal(f.get('images', 'image-2'), null);
  assert.equal((await f.run({ ...second, now: later })).status, 'claimed');
  for (const command of [
    checkpoint,
    activate,
    { ...base, action: 'fail', reason: 'fetch-failed' } as const,
  ])
    assert.equal((await f.run({ ...command, now: later })).status, 'conflict');
  assert.equal(f.get('images', base.imageId)?.storageFileId, target.storageFileId);
  assert.equal(f.get('images', base.imageId)?.status, 'pending');
  assert.equal(f.get('catalogSourceLinks', linkId)?.imageId, undefined);
});
test('checkpoint and activation refuse a changed permanent file or metadata', async () => {
  const f = await claimed();
  assert.equal((await f.run(activate)).status, 'conflict');
  await f.run(checkpoint);
  const before = f.snapshot();
  assert.equal(
    (await f.run({ ...checkpoint, target: { ...target, storageFileId: 'local-disk:other' } }))
      .status,
    'conflict',
  );
  assert.equal(
    (await f.run({ ...activate, target: { ...target, checksumSha256: 'b'.repeat(64) } })).status,
    'conflict',
  );
  assert.deepEqual(f.snapshot(), before);
});
test('the existing image mutex fences pending checkpoint and activation against cleanup', async () => {
  const f = await staged();
  hold(f, base.imageId, 'cleanup');
  const before = f.snapshot();
  assert.equal((await f.run(checkpoint)).status, 'busy');
  assert.equal((await f.run(activate)).status, 'busy');
  assert.deepEqual(f.snapshot(), before);
});
test('checksum reuse requires the existing image mutex, atomically binds and removes unused pending row, then replays', async () => {
  const f = await claimed();
  f.put('images', {
    _id: 'existing',
    status: 'active',
    ...target,
    publishedRefCount: 2,
    uploadedByUserId: 'admin',
  });
  const command = {
    ...base,
    action: 'reuse',
    existingImageId: 'existing',
    checksumSha256: target.checksumSha256,
  } as const;
  assert.equal((await f.run(command)).status, 'busy');
  hold(f, 'existing', base.operationId);
  assert.deepEqual(await f.run(command), {
    status: 'ready',
    imageId: 'existing',
    deduplicated: true,
  });
  assert.equal(f.get('images', base.imageId), null);
  assert.equal(f.get('images', 'existing')?.publishedRefCount, 2);
  assert.equal(f.get('catalogSourceLinks', linkId)?.imageId, 'existing');
  assert.equal(
    f.get('images', 'existing')?.imageMutationOwner,
    '',
    'binding and its lock cleanup commit together',
  );
  assert.deepEqual(await f.run(command), {
    status: 'ready',
    imageId: 'existing',
    deduplicated: true,
  });
  assert.ok(f.max() <= 6);
});
test('checksum reuse refuses inactive, wrong bytes or mismatched mutex owner', async () => {
  for (const patch of [
    { status: 'deleted' },
    { checksumSha256: 'b'.repeat(64) },
    { imageMutationOwner: 'someone-else', imageMutationStartedAt: now },
  ]) {
    const f = await claimed();
    f.put('images', {
      _id: 'existing',
      status: 'active',
      ...target,
      publishedRefCount: 0,
      imageMutationOwner: base.operationId,
      imageMutationStartedAt: now,
      ...patch,
    });
    assert.ok(
      ['busy', 'conflict'].includes(
        (
          await f.run({
            ...base,
            action: 'reuse',
            existingImageId: 'existing',
            checksumSha256: target.checksumSha256,
          })
        ).status,
      ),
    );
    assert.equal(f.get('catalogSourceLinks', linkId)?.imageId, undefined);
    assert.equal(f.get('images', base.imageId)?.status, 'pending');
  }
});
test('one owned failed fetch increments attempts once, releases the claim and keeps a tracked failed row', async () => {
  const f = await claimed();
  const failed = { ...base, action: 'fail', reason: 'fetch-failed' } as const;
  assert.equal((await f.run(failed)).status, 'failed');
  assert.equal((await f.run(failed)).status, 'failed');
  assert.equal(f.get('catalogSourceLinks', linkId)?.failureAttempts, 1);
  assert.equal(f.get('catalogSourceLinks', linkId)?.mediaImport, undefined);
  assert.equal(f.get('images', base.imageId)?.status, 'failed');
  assert.equal((await f.run({ ...claim, operationId: 'next', imageId: 'next' })).status, 'claimed');
  assert.equal(
    (
      await f.run({
        ...base,
        operationId: 'next',
        imageId: 'next',
        action: 'fail',
        reason: 'write-failed',
      })
    ).status,
    'failed',
  );
  assert.equal(f.get('catalogSourceLinks', linkId)?.failureAttempts, 1);
});
test('a late failure note cannot erase a successful URL binding or another pending operation', async () => {
  for (const f of [await active(), await claimed()]) {
    const before = f.snapshot();
    const result = await f.run({
      action: 'note-failure',
      sourceUrl,
      operationId: 'late',
      reason: 'not-found',
      now,
    });
    assert.ok(result.status === 'ready' || result.status === 'busy');
    assert.deepEqual(f.snapshot(), before);
  }
});
test('failure notes are idempotent and normalize malformed prior counts at the atomic write', async () => {
  for (const count of [undefined, 0, 1, 2.5, -1, '4']) {
    const f = fixture();
    f.put('catalogSourceLinks', {
      _id: linkId,
      kind: 'media',
      provider: 'alibaba',
      sourceUrl,
      ...(count === undefined ? {} : { failureAttempts: count }),
    });
    const command = {
      action: 'note-failure',
      sourceUrl,
      operationId: 'attempt',
      reason: 'fetch-failed',
      now,
    } as const;
    assert.equal((await f.run(command)).status, 'noted');
    assert.equal((await f.run(command)).status, 'noted');
    assert.equal(
      f.get('catalogSourceLinks', linkId)?.failureAttempts,
      count === undefined || count === 0 ? 1 : 2,
    );
  }
});
test('unknown ownership versions and extra ownership fields fail closed without writes', async () => {
  for (const patch of [{ schemaVersion: 'source-media-import-v2' }, { unexpected: true }]) {
    const f = await claimed();
    const link = f.get('catalogSourceLinks', linkId);
    assert.ok(link);
    const value = link.mediaImport;
    assert.ok(value && typeof value === 'object');
    f.put('catalogSourceLinks', { ...link, mediaImport: { ...value, ...patch } });
    const before = f.snapshot();
    assert.equal(
      (await f.run({ ...claim, operationId: 'other', imageId: 'other' })).status,
      'corrupt',
    );
    assert.deepEqual(f.snapshot(), before);
  }
});
test('unknown or extra receipt fields cannot fall back to legacy active binding', async () => {
  for (const receipt of [
    {
      schemaVersion: 'source-media-import-v2',
      operationId: base.operationId,
      imageId: base.imageId,
    },
    {
      schemaVersion: 'source-media-import-v1',
      operationId: base.operationId,
      imageId: base.imageId,
      extra: true,
    },
  ]) {
    const f = await active();
    const link = f.get('catalogSourceLinks', linkId);
    assert.ok(link);
    f.put('catalogSourceLinks', { ...link, mediaImportReceipt: receipt });
    const before = f.snapshot();
    assert.equal(
      (await f.run({ ...claim, operationId: 'other', imageId: 'other' })).status,
      'corrupt',
    );
    assert.deepEqual(f.snapshot(), before);
  }
});
test('retirement requires existing mutex and expired current claim; quarantines exact target before byte deletion', async () => {
  const f = await staged();
  const command = { action: 'retire', imageId: base.imageId, owner: 'cleanup', now } as const;
  assert.equal((await f.run(command)).status, 'busy');
  hold(f, base.imageId, 'cleanup');
  assert.equal((await f.run(command)).status, 'busy');
  assert.equal((await f.run({ ...command, now: later })).status, 'retired');
  const image = f.get('images', base.imageId);
  assert.ok(image);
  assert.equal(image.status, 'deleted');
  assert.deepEqual(readImageDeletionIntent(image)?.storageFileIds, [target.storageFileId]);
  assert.equal(f.get('catalogSourceLinks', linkId)?.mediaImport, undefined);
  assert.equal((await f.run({ ...command, now: later })).status, 'retired');
  assert.equal((await f.run({ ...activate, now: later })).status, 'conflict');
});
test('retiring an old pending row cannot clear a new URL claimant', async () => {
  const f = await staged();
  await f.run({ ...claim, operationId: 'new', imageId: 'new', now: later });
  hold(f, base.imageId, 'cleanup');
  const link = f.get('catalogSourceLinks', linkId);
  assert.equal(
    (await f.run({ action: 'retire', imageId: base.imageId, owner: 'cleanup', now: later })).status,
    'retired',
  );
  assert.deepEqual(f.get('catalogSourceLinks', linkId), link);
});
test('a stale cleanup selection cannot quarantine an image that has become active', async () => {
  const f = await active();
  hold(f, base.imageId, 'cleanup');
  const before = f.snapshot();
  assert.equal(
    (await f.run({ action: 'retire', imageId: base.imageId, owner: 'cleanup', now: later })).status,
    'conflict',
  );
  assert.deepEqual(f.snapshot(), before);
});
test('bad command fields and noncanonical URLs are validation failures, not decoder exceptions', () => {
  for (const patch of [
    { now: 'not-a-date' },
    { sourceUrl: 'http://sc04.alicdn.com/a.png' },
    { sourceUrl: 'https://SC04.alicdn.com:443/a.png#ignored' },
    { extra: true },
    { imageId: '' },
  ])
    assert.equal(SourceMediaImportCommandSchema.safeParse({ ...claim, ...patch }).success, false);
});

test('a legacy writer mixed into a pending source claim cannot be reused or cleaned as a valid phase', async () => {
  for (const patch of [
    { imageId: 'legacy-image' },
    {
      mediaImportReceipt: {
        schemaVersion: 'source-media-import-v1',
        operationId: 'legacy',
        imageId: 'legacy-image',
      },
    },
  ]) {
    const f = await staged();
    const link = f.get('catalogSourceLinks', linkId);
    assert.ok(link);
    f.put('catalogSourceLinks', { ...link, ...patch });
    const before = f.snapshot();
    assert.equal((await f.run(claim)).status, 'corrupt');
    assert.deepEqual(f.snapshot(), before);
    hold(f, base.imageId, 'cleanup');
    const locked = f.snapshot();
    assert.equal(
      (await f.run({ action: 'retire', imageId: base.imageId, owner: 'cleanup', now: later }))
        .status,
      'corrupt',
    );
    assert.deepEqual(f.snapshot(), locked);
  }
});

async function completedReuse() {
  const f = await claimed();
  f.put('images', {
    _id: 'shared-image',
    status: 'active',
    ...target,
    publishedRefCount: 3,
    name: 'Current photo name',
  });
  hold(f, 'shared-image', base.operationId);
  const reuse = {
    ...base,
    action: 'reuse' as const,
    existingImageId: 'shared-image',
    checksumSha256: target.checksumSha256,
  };
  assert.equal((await f.run(reuse)).status, 'ready');
  assert.equal(f.get('images', 'shared-image')?.imageMutationOwner, '');
  // Historical completion persisted the binding before a separate release.
  hold(f, 'shared-image', base.operationId);
  assert.equal(f.get('images', 'shared-image')?.imageMutationOwner, base.operationId);
  return { f, reuse };
}
test('a new claim repairs only the committed source operation lock without creating another image', async () => {
  const { f } = await completedReuse();
  const image = f.get('images', 'shared-image');
  const link = f.get('catalogSourceLinks', linkId);
  assert.ok(image);
  assert.deepEqual(
    await f.run({ ...claim, operationId: 'new-operation', imageId: 'unused-image' }),
    { status: 'ready', imageId: 'shared-image', deduplicated: true },
  );
  assert.deepEqual(f.get('images', 'shared-image'), {
    ...image,
    imageMutationOwner: '',
    imageMutationStartedAt: '',
  });
  assert.deepEqual(f.get('catalogSourceLinks', linkId), link);
  assert.equal(f.get('images', 'unused-image'), null);
  const before = f.snapshot();
  await f.run({ ...claim, operationId: 'another', imageId: 'another' });
  assert.deepEqual(f.snapshot(), before);
});
test('valid source reuse confirmation replay completes its own lock cleanup', async () => {
  const { f, reuse } = await completedReuse();
  assert.equal((await f.run(reuse)).status, 'ready');
  assert.equal(f.get('images', 'shared-image')?.imageMutationOwner, '');
  assert.equal(f.get('images', 'shared-image')?.publishedRefCount, 3);
});
for (const receipt of ['missing', 'different-owner', 'wrong-image', 'extra'] as const)
  test(`source lock recovery refuses ${receipt} proof`, async () => {
    const { f } = await completedReuse();
    const link = f.get('catalogSourceLinks', linkId);
    assert.ok(link);
    const original = link.mediaImportReceipt;
    assert.ok(original && typeof original === 'object');
    if (receipt === 'missing') Reflect.deleteProperty(link, 'mediaImportReceipt');
    else
      link.mediaImportReceipt = {
        ...original,
        ...(receipt === 'different-owner'
          ? { operationId: 'foreign' }
          : receipt === 'wrong-image'
            ? { imageId: 'foreign-image' }
            : { extra: true }),
      };
    f.put('catalogSourceLinks', link);
    const before = f.snapshot();
    const result = await f.run({ ...claim, operationId: 'new-operation', imageId: 'unused' });
    assert.ok(result.status === 'ready' || result.status === 'corrupt');
    assert.equal(f.get('images', 'shared-image')?.imageMutationOwner, base.operationId);
    assert.deepEqual(f.snapshot(), before);
  });
test('a completed receipt cannot release a new unrelated owner', async () => {
  const { f } = await completedReuse();
  hold(f, 'shared-image', 'new-unrelated-owner');
  const before = f.snapshot();
  assert.equal(
    (await f.run({ ...claim, operationId: 'new-claim', imageId: 'unused' })).status,
    'ready',
  );
  assert.deepEqual(f.snapshot(), before);
});
test('wrong replay bytes and late failure notes cannot clear a completed source lock', async () => {
  const { f, reuse } = await completedReuse();
  const before = f.snapshot();
  assert.equal((await f.run({ ...reuse, checksumSha256: 'b'.repeat(64) })).status, 'conflict');
  assert.equal(
    (
      await f.run({
        action: 'note-failure',
        sourceUrl,
        operationId: 'late-note',
        reason: 'fetch-failed',
        now,
      })
    ).status,
    'ready',
  );
  assert.deepEqual(f.snapshot(), before);
});

test('activation and late fail confirmation clean only the proven completed source owner', async () => {
  for (const action of ['activate', 'fail'] as const) {
    const f = await staged();
    assert.equal((await f.run(activate)).status, 'ready');
    hold(f, base.imageId, base.operationId);
    const command =
      action === 'activate' ? activate : { ...base, action, reason: 'write-failed' as const };
    assert.equal((await f.run(command)).status, 'ready');
    assert.equal(f.get('images', base.imageId)?.imageMutationOwner, '');
  }
});
test('wrong activation target cannot clear a completed source owner', async () => {
  const f = await staged();
  assert.equal((await f.run(activate)).status, 'ready');
  hold(f, base.imageId, base.operationId);
  const before = f.snapshot();
  assert.equal(
    (await f.run({ ...activate, target: { ...target, storageFileId: 'local-disk:foreign' } }))
      .status,
    'conflict',
  );
  assert.deepEqual(f.snapshot(), before);
});

for (const kind of ['addition', 'removal', 'cancel', 'missing', 'corrupt'] as const)
  test(`source retirement respects complete reference state ${kind}`, async () => {
    const f = await staged();
    hold(f, base.imageId, 'cleanup');
    const image = f.get('images', base.imageId);
    assert.ok(image);
    const removing = kind === 'removal';
    const plan = buildCatalogImageReferencePlan(
      '1'.repeat(64),
      removing ? [base.imageId] : [],
      removing ? [] : [base.imageId],
    );
    image.publishedRefCount = removing ? 1 : 0;
    image.catalogPublishedReferenceLedger = {
      version: 'catalog-image-reference-ledger-v1',
      epoch: 4,
      pending: [catalogImageReferenceEntry(plan, 0)],
    };
    f.put('images', image);
    if (kind !== 'missing')
      f.put(
        'catalogDetailApprovals',
        kind === 'cancel'
          ? catalogImageReferenceCancelProof(plan.proof)
          : kind === 'corrupt'
            ? { ...plan.proof, kind: 'unknown' }
            : plan.proof,
      );
    const before = f.snapshot();
    const result = await f.run({
      action: 'retire',
      imageId: base.imageId,
      owner: 'cleanup',
      now: later,
    });
    if (kind === 'removal' || kind === 'cancel') {
      assert.equal(result.status, 'retired');
      const actual = f.get('images', base.imageId);
      assert.ok(actual);
      assert.equal(actual.publishedRefCount, 0);
      assert.deepEqual(actual.catalogPublishedReferenceLedger, {
        version: 'catalog-image-reference-ledger-v1',
        epoch: 5,
        pending: [],
      });
      assert.deepEqual(readImageDeletionIntent(actual)?.storageFileIds, [target.storageFileId]);
      assert.equal(f.get('catalogSourceLinks', linkId)?.mediaImport, undefined);
      assert.ok(f.get('catalogDetailApprovals', plan.proof._id));
    } else {
      assert.equal(result.status, kind === 'corrupt' ? 'corrupt' : 'conflict');
      assert.deepEqual(f.snapshot(), before);
    }
  });
for (const action of ['checkpoint', 'activate', 'fail'] as const)
  test(`pending source ${action} refuses unresolved reference state`, async () => {
    const f = await staged();
    const image = f.get('images', base.imageId);
    assert.ok(image);
    const plan = buildCatalogImageReferencePlan('1'.repeat(64), [], [base.imageId]);
    image.catalogPublishedReferenceLedger = {
      version: 'catalog-image-reference-ledger-v1',
      epoch: 4,
      pending: [catalogImageReferenceEntry(plan, 0)],
    };
    f.put('images', image);
    const before = f.snapshot();
    const command =
      action === 'checkpoint'
        ? checkpoint
        : action === 'activate'
          ? activate
          : ({ ...base, action: 'fail', reason: 'write-failed' } as const);
    assert.equal((await f.run(command)).status, 'conflict');
    assert.deepEqual(f.snapshot(), before);
  });

test('source retirement clears 80 cancelled slots with its URL note in 85 document operations', async () => {
  const f = await staged();
  hold(f, base.imageId, 'cleanup');
  const image = f.get('images', base.imageId);
  assert.ok(image);
  const plans = Array.from({ length: 80 }, (_, index) =>
    buildCatalogImageReferencePlan((index + 1).toString(16).padStart(64, '0'), [], [base.imageId]),
  );
  image.catalogPublishedReferenceLedger = {
    version: 'catalog-image-reference-ledger-v1',
    epoch: 4,
    pending: plans.map((plan) => catalogImageReferenceEntry(plan, 0)),
  };
  f.put('images', image);
  for (const plan of plans)
    f.put('catalogDetailApprovals', catalogImageReferenceCancelProof(plan.proof));
  assert.equal(
    (await f.run({ action: 'retire', imageId: base.imageId, owner: 'cleanup', now: later })).status,
    'retired',
  );
  assert.equal(f.max(), 85);
  assert.equal(f.get('catalogSourceLinks', linkId)?.mediaImport, undefined);
  for (const plan of plans) assert.ok(f.get('catalogDetailApprovals', plan.proof._id));
});
for (const action of ['checkpoint', 'activate', 'fail'] as const)
  test(`pending source ${action} allows a valid empty zero ledger`, async () => {
    const f = await staged();
    const image = f.get('images', base.imageId);
    assert.ok(image);
    image.catalogPublishedReferenceLedger = {
      version: 'catalog-image-reference-ledger-v1',
      epoch: 4,
      pending: [],
    };
    f.put('images', image);
    const command: SourceMediaImportCommand =
      action === 'checkpoint'
        ? checkpoint
        : action === 'activate'
          ? activate
          : { ...base, action: 'fail', reason: 'write-failed' };
    assert.equal(
      (await f.run(command)).status,
      action === 'checkpoint' ? 'checkpointed' : action === 'activate' ? 'ready' : 'failed',
    );
    assert.deepEqual(
      f.get('images', base.imageId)?.catalogPublishedReferenceLedger,
      image.catalogPublishedReferenceLedger,
    );
  });
for (const damage of ['version', 'epoch', 'counter'] as const)
  test(`pending source rejects corrupt empty reference ${damage}`, async () => {
    const f = await staged();
    const image = f.get('images', base.imageId);
    assert.ok(image);
    image.catalogPublishedReferenceLedger = {
      version: damage === 'version' ? 'unknown' : 'catalog-image-reference-ledger-v1',
      epoch: damage === 'epoch' ? -1 : 4,
      pending: [],
    };
    if (damage === 'counter') image.publishedRefCount = '0';
    f.put('images', image);
    const before = f.snapshot();
    assert.equal((await f.run(activate)).status, 'conflict');
    assert.deepEqual(f.snapshot(), before);
  });
test('retirement with cancelled references leaves a later URL claimant intact', async () => {
  const f = await staged();
  await f.run({ ...claim, operationId: 'new', imageId: 'new', now: later });
  hold(f, base.imageId, 'cleanup');
  const image = f.get('images', base.imageId);
  assert.ok(image);
  const plan = buildCatalogImageReferencePlan('1'.repeat(64), [], [base.imageId]);
  image.catalogPublishedReferenceLedger = {
    version: 'catalog-image-reference-ledger-v1',
    epoch: 4,
    pending: [catalogImageReferenceEntry(plan, 0)],
  };
  f.put('images', image);
  f.put('catalogDetailApprovals', catalogImageReferenceCancelProof(plan.proof));
  const link = f.get('catalogSourceLinks', linkId);
  assert.equal(
    (await f.run({ action: 'retire', imageId: base.imageId, owner: 'cleanup', now: later })).status,
    'retired',
  );
  assert.deepEqual(f.get('catalogSourceLinks', linkId), link);
});

for (const guard of ['mutex-owner', 'lease', 'uploader', 'claim'] as const)
  test(`source retirement refuses ${guard} before reading80 proofs`, async () => {
    const f = await staged();
    hold(f, base.imageId, guard === 'mutex-owner' ? 'other' : 'cleanup');
    const image = f.get('images', base.imageId);
    assert.ok(image);
    const plans = Array.from({ length: 80 }, (_, index) =>
      buildCatalogImageReferencePlan(
        (index + 1).toString(16).padStart(64, '0'),
        [],
        [base.imageId],
      ),
    );
    image.catalogPublishedReferenceLedger = {
      version: 'catalog-image-reference-ledger-v1',
      epoch: 4,
      pending: plans.map((plan) => catalogImageReferenceEntry(plan, 0)),
    };
    if (guard === 'uploader') image.uploadedByUserId = 'other';
    if (guard === 'claim')
      image.sourceMediaImport = { ...Object(image.sourceMediaImport), imageId: 'other' };
    f.put('images', image);
    for (const plan of plans)
      f.put('catalogDetailApprovals', catalogImageReferenceCancelProof(plan.proof));
    const before = f.snapshot();
    const outcome = await f.run({
      action: 'retire',
      imageId: base.imageId,
      owner: 'cleanup',
      now: guard === 'lease' ? now : later,
    });
    assert.equal(outcome.status, guard === 'mutex-owner' || guard === 'lease' ? 'busy' : 'corrupt');
    assert.deepEqual(f.snapshot(), before);
    assert.equal(f.max(), 4);
  });

for (const action of ['warm', 'reuse'] as const)
  test(`active source ${action} preserves a nonempty reference ledger without resolving it`, async () => {
    const f = await active();
    const image = f.get('images', base.imageId);
    assert.ok(image);
    const plan = buildCatalogImageReferencePlan('1'.repeat(64), [], [base.imageId]);
    const ledger = {
      version: 'catalog-image-reference-ledger-v1',
      epoch: 4,
      pending: [catalogImageReferenceEntry(plan, 0)],
    };
    image.catalogPublishedReferenceLedger = ledger;
    f.put('images', image);
    f.put('catalogDetailApprovals', plan.proof);
    if (action === 'warm') {
      hold(f, base.imageId, base.operationId);
      assert.deepEqual(await f.run({ ...claim, operationId: 'new-op', imageId: 'new-image' }), {
        status: 'ready',
        imageId: base.imageId,
        deduplicated: true,
      });
    } else {
      const next = {
        ...base,
        sourceUrl: 'https://sc04.alicdn.com/b.png',
        operationId: 'new-op',
        imageId: 'new-image',
      };
      assert.equal((await f.run({ ...next, action: 'claim' })).status, 'claimed');
      hold(f, base.imageId, next.operationId);
      assert.deepEqual(
        await f.run({
          ...next,
          action: 'reuse',
          existingImageId: base.imageId,
          checksumSha256: target.checksumSha256,
        }),
        { status: 'ready', imageId: base.imageId, deduplicated: true },
      );
      assert.equal(f.get('images', next.imageId), null);
    }
    const current = f.get('images', base.imageId);
    assert.ok(current);
    assert.equal(current.publishedRefCount, 0);
    assert.deepEqual(current.catalogPublishedReferenceLedger, ledger);
    assert.equal(current.storageFileId, target.storageFileId);
    assert.equal(current.checksumSha256, target.checksumSha256);
    assert.equal(current.imageMutationOwner, '');
    assert.deepEqual(f.get('catalogDetailApprovals', plan.proof._id), plan.proof);
  });
