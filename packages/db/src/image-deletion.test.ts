import assert from 'node:assert/strict';
import test from 'node:test';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { buildWriteSchema, getCollection } from '@vibelingan-channel/shared';
import { executeImageDeletion } from './image-deletion-runner.ts';
import {
  type ImageDeletionCommand,
  type ImageDeletionStore,
  readImageDeletionIntent,
  runImageDeletion,
} from './image-deletion.ts';

const now = '2026-10-15T00:00:00.000Z';
const begin = {
  action: 'begin',
  imageId: 'i',
  uploadedByUserId: 'u',
  owner: 'op',
  startedAt: now,
} as const;
const finish = {
  action: 'finish',
  imageId: 'i',
  uploadedByUserId: 'u',
  operationId: 'op',
} as const;
function fixture(patch: Record<string, unknown> = {}) {
  let row: CollectionDoc | null = {
    _id: 'i',
    status: 'active',
    uploadedByUserId: 'u',
    publishedRefCount: 0,
    imageMutationOwner: 'op',
    imageMutationStartedAt: now,
    storageProvider: 'local-disk',
    storageFileId: 'local://one',
    migrationStorageFileId: 'local://two',
    ...patch,
  };
  const writes: string[] = [];
  const store: ImageDeletionStore = {
    get: async () => structuredClone(row),
    set: async (_, value) => {
      writes.push('set');
      row = structuredClone(value);
    },
    remove: async () => {
      writes.push('remove');
      row = null;
    },
  };
  return {
    store,
    writes,
    get row() {
      return row;
    },
    patch(value: Record<string, unknown>) {
      assert.ok(row);
      row = { ...row, ...value };
    },
  };
}

test('quarantine is durable, bounded and terminal; a fresh caller resumes the original intent', async () => {
  const f = fixture();
  const result = await runImageDeletion(f.store, begin);
  assert.ok(result.status === 'ready');
  assert.equal(f.row?.status, 'deleted');
  assert.deepEqual(result.intent.storageFileIds, ['local://one', 'local://two']);
  f.patch({ imageMutationOwner: 'other-lock', imageMutationStartedAt: now });
  assert.deepEqual(await runImageDeletion(f.store, { ...begin, owner: 'fresh' }), result);
  assert.deepEqual(f.writes, ['set']);
  assert.deepEqual(await runImageDeletion(f.store, finish), { status: 'removed' });
  assert.deepEqual(await runImageDeletion(f.store, finish), { status: 'missing' });
});

for (const [name, patch, status] of [
  ['other uploader', { uploadedByUserId: 'other' }, 'forbidden'],
  ['pending', { status: 'pending' }, 'conflict'],
  ['failed', { status: 'failed' }, 'conflict'],
  ['unknown state', { status: 'typo' }, 'conflict'],
  ['unowned lock', { imageMutationOwner: '', imageMutationStartedAt: '' }, 'conflict'],
  ['other lock', { imageMutationOwner: 'other' }, 'conflict'],
  ['corrupt lock', { imageMutationStartedAt: 'bad' }, 'conflict'],
  ['positive references', { publishedRefCount: 1 }, 'conflict'],
  ['negative references', { publishedRefCount: -1 }, 'conflict'],
  ['missing references', { publishedRefCount: undefined }, 'conflict'],
  ['string references', { publishedRefCount: '0' }, 'conflict'],
  ['unsupported provider', { storageProvider: 'https' }, 'corrupt'],
  ['corrupt target', { migrationStorageFileId: [] }, 'corrupt'],
  ['oversized target', { storageFileId: 'a'.repeat(8193) }, 'corrupt'],
  ['legacy deleted without intent', { status: 'deleted' }, 'corrupt'],
] as const)
  test(`begin refuses ${name} without mutation`, async () => {
    const f = fixture(patch);
    assert.deepEqual(await runImageDeletion(f.store, begin), { status });
    assert.deepEqual(f.writes, []);
  });

for (const [name, patch] of [
  ['reopened row', { status: 'active' }],
  ['replaced primary target', { storageFileId: 'local://replacement' }],
  ['replaced migration target', { migrationStorageFileId: 'local://replacement' }],
  ['provider changed', { storageProvider: 'cloudbase-storage' }],
  ['became referenced', { publishedRefCount: 1 }],
  ['owner changed', { uploadedByUserId: 'other' }],
  ['malformed intent', { imageDeletion: { schemaVersion: 'image-deletion-v1' } }],
] as const)
  test(`finish refuses ${name}`, async () => {
    const f = fixture();
    await runImageDeletion(f.store, begin);
    f.patch(patch);
    assert.equal(readImageDeletionIntent(f.row ?? { _id: 'missing' }), null);
    assert.notEqual((await runImageDeletion(f.store, finish)).status, 'removed');
    assert.deepEqual(f.writes, ['set']);
  });

test('unknown deletion intent versions and extra fields cannot authorize a retry', async () => {
  for (const patch of [{ schemaVersion: 'image-deletion-v2' }, { unsafe: true }]) {
    const f = fixture();
    await runImageDeletion(f.store, begin);
    const original = f.row?.imageDeletion;
    assert.ok(original && typeof original === 'object');
    f.patch({ imageDeletion: { ...original, ...patch } });
    assert.equal(readImageDeletionIntent(f.row ?? { _id: '' }), null);
    assert.deepEqual(await runImageDeletion(f.store, finish), { status: 'corrupt' });
    assert.deepEqual(f.writes, ['set']);
  }
});

test('finish cannot remove an active row or another operation', async () => {
  const f = fixture();
  assert.deepEqual(await runImageDeletion(f.store, finish), { status: 'conflict' });
  await runImageDeletion(f.store, begin);
  assert.deepEqual(await runImageDeletion(f.store, { ...finish, operationId: 'other' }), {
    status: 'conflict',
  });
  assert.deepEqual(f.writes, ['set']);
});

test('duplicate targets are deleted once and an inline legacy image needs no storage deletion', async () => {
  for (const patch of [
    { migrationStorageFileId: 'local://one' },
    {
      storageProvider: 'legacy-base64',
      storageFileId: undefined,
      migrationStorageFileId: undefined,
    },
  ]) {
    const f = fixture(patch);
    const calls: string[] = [];
    assert.equal(
      await executeImageDeletion(
        { manage: (c) => runImageDeletion(f.store, c), get: async () => f.row },
        begin,
        async (id) => {
          calls.push(id);
        },
      ),
      'deleted',
    );
    assert.equal(calls.length, patch.storageProvider ? 0 : 1);
  }
});

for (const phase of ['before-begin', 'after-begin', 'before-finish', 'after-finish'] as const) {
  test(`lost database acknowledgement ${phase} never reports a false completion or deletes live bytes`, async () => {
    const f = fixture();
    const deletes: string[] = [];
    let fail = true;
    const manage = async (command: ImageDeletionCommand) => {
      const target = phase.includes('begin') ? 'begin' : 'finish';
      if (fail && command.action === target && phase.startsWith('before')) {
        fail = false;
        throw new Error('outage before commit');
      }
      const result = await runImageDeletion(f.store, command);
      if (fail && command.action === target && phase.startsWith('after')) {
        fail = false;
        throw new Error('commit ACK lost');
      }
      return result;
    };
    const deletion = () =>
      executeImageDeletion(
        { manage, get: async () => structuredClone(f.row) },
        begin,
        async (id) => {
          assert.equal(f.row?.status, 'deleted');
          deletes.push(id);
        },
      );
    assert.equal(await deletion(), phase.startsWith('after') ? 'deleted' : 'failed');
    if (phase === 'before-begin') {
      assert.deepEqual(deletes, []);
      assert.equal(f.row?.status, 'active');
    }
    if (phase === 'before-finish') assert.equal(f.row?.status, 'deleted');
    if (f.row) assert.equal(await deletion(), 'deleted');
    assert.equal(f.row, null);
  });
}

test('unknown quarantine and unavailable read-back never deletes bytes', async () => {
  let deletes = 0;
  assert.equal(
    await executeImageDeletion(
      {
        manage: async () => {
          throw new Error('unknown write');
        },
        get: async () => {
          throw new Error('unavailable');
        },
      },
      begin,
      async () => {
        deletes++;
      },
    ),
    'failed',
  );
  assert.equal(deletes, 0);
});

test('partial storage deletion retains the full durable target list across retry', async () => {
  const f = fixture();
  let fail = true;
  const existing = new Set(['local://one', 'local://two']);
  const deletion = () =>
    executeImageDeletion(
      { manage: (c) => runImageDeletion(f.store, c), get: async () => f.row },
      begin,
      async (id) => {
        if (id === 'local://two' && fail) {
          fail = false;
          throw new Error('second object unavailable');
        }
        existing.delete(id); // Confirmed absent is idempotent.
      },
    );
  assert.equal(await deletion(), 'failed');
  assert.deepEqual([...existing], ['local://two']);
  assert.equal(f.row?.status, 'deleted');
  assert.deepEqual(readImageDeletionIntent(f.row ?? { _id: '' })?.storageFileIds, [
    'local://one',
    'local://two',
  ]);
  assert.equal(await deletion(), 'deleted');
  assert.equal(f.row, null);
  assert.equal(existing.size, 0);
});

test('concurrent retries share one terminal intent and tolerate a competing finalizer', async () => {
  const f = fixture();
  await runImageDeletion(f.store, begin);
  const deletes = new Set<string>();
  const result = await Promise.all(
    Array.from({ length: 4 }, (_, i) =>
      executeImageDeletion(
        {
          manage: (c) => runImageDeletion(f.store, c),
          get: async () => structuredClone(f.row),
        },
        { ...begin, owner: `retry-${i}` },
        async (id) => {
          deletes.add(id);
        },
      ),
    ),
  );
  assert.ok(result.every((value) => value === 'deleted' || value === 'missing'));
  assert.equal(f.row, null);
  assert.equal(deletes.size, 2);
});

test('generic image writes cannot forge a deletion intent', () => {
  const def = getCollection('images');
  assert.ok(def);
  assert.equal(buildWriteSchema(def).safeParse({ name: 'x', imageDeletion: {} }).success, false);
});

test('malformed command time and unknown fields reject before database access', async () => {
  const f = fixture();
  for (const command of [
    { ...begin, startedAt: 'invalid' },
    { ...begin, unsafe: true },
  ]) {
    await assert.rejects(runImageDeletion(f.store, command));
  }
  assert.deepEqual(f.writes, []);
});

test('opaque storage identifiers preserve a fully URL-encoded legal COS object key', async () => {
  // Tencent COS permits 850 UTF-8 bytes per key; percent encoding expands it.
  const storageFileId = `cloud://environment.bucket/${encodeURIComponent('中'.repeat(283))}`;
  assert.ok(storageFileId.length > 2048);
  const f = fixture({
    storageProvider: 'cloudbase-storage',
    storageFileId,
    migrationStorageFileId: undefined,
  });
  const result = await runImageDeletion(f.store, begin);
  assert.ok(result.status === 'ready');
  assert.deepEqual(result.intent.storageFileIds, [storageFileId]);
});

test('a foreign document identity cannot authorize quarantine or terminal removal', async () => {
  const active = fixture({ _id: 'foreign' });
  assert.deepEqual(await runImageDeletion(active.store, begin), { status: 'corrupt' });
  assert.deepEqual(active.writes, []);
  const terminal = fixture();
  await runImageDeletion(terminal.store, begin);
  terminal.patch({ _id: 'foreign' });
  const before = structuredClone(terminal.row);
  assert.deepEqual(await runImageDeletion(terminal.store, finish), { status: 'corrupt' });
  assert.deepEqual(terminal.row, before);
});
test('unknown quarantine ACK followed by a foreign terminal readback never deletes bytes', async () => {
  const f = fixture();
  await runImageDeletion(f.store, begin);
  f.patch({ _id: 'foreign' });
  let deletes = 0;
  const result = await executeImageDeletion(
    {
      manage: async () => {
        throw new Error('quarantine outcome unknown');
      },
      get: async () => structuredClone(f.row),
    },
    begin,
    async () => {
      deletes++;
    },
  );
  assert.equal(result, 'corrupt');
  assert.equal(deletes, 0);
  assert.equal(f.row?.status, 'deleted');
});

test('expiry quarantine checks current status, age, source ownership and published references in the write transaction', async () => {
  const command = {
    action: 'begin-orphan',
    imageId: 'i',
    owner: 'op',
    startedAt: now,
    cutoff: now,
  } as const;
  for (const patch of [
    { status: 'active' },
    { createdAt: now },
    { createdAt: 'invalid' },
    { sourceMediaImport: { schemaVersion: 'source-media-import-v1' } },
    { publishedRefCount: 1 },
  ]) {
    const f = fixture({ status: 'pending', createdAt: '2020-01-01T00:00:00.000Z', ...patch });
    assert.equal((await runImageDeletion(f.store, command)).status, 'conflict');
    assert.deepEqual(f.writes, []);
  }
});

test('ownerless legacy expiry uses its own strict deletion version, not a weaker v1', async () => {
  const f = fixture({
    uploadedByUserId: undefined,
    status: 'pending',
    createdAt: '2020-01-01T00:00:00.000Z',
  });
  const result = await runImageDeletion(f.store, {
    action: 'begin-orphan',
    imageId: 'i',
    owner: 'op',
    startedAt: now,
    cutoff: now,
  });
  assert.ok(result.status === 'ready');
  assert.equal(result.intent.schemaVersion, 'image-deletion-ownerless-v1');
  assert.equal(result.intent.uploadedByUserId, undefined);
  assert.ok(f.row);
  assert.ok(readImageDeletionIntent(f.row));
  const before = structuredClone(f.row);
  assert.ok(before);
  assert.equal(
    readImageDeletionIntent({
      ...before,
      imageDeletion: { ...result.intent, schemaVersion: 'image-deletion-v1' },
    }),
    null,
  );
  assert.equal(
    readImageDeletionIntent({
      ...before,
      imageDeletion: { ...result.intent, uploadedByUserId: 'invented' },
    }),
    null,
  );
});
test('malformed uploader metadata is corrupt and cannot authorize expiry byte deletion', async () => {
  for (const uploadedByUserId of [null, [], {}, '']) {
    const f = fixture({
      uploadedByUserId,
      status: 'failed',
      createdAt: '2020-01-01T00:00:00.000Z',
    });
    assert.equal(
      (
        await runImageDeletion(f.store, {
          action: 'begin-orphan',
          imageId: 'i',
          owner: 'op',
          startedAt: now,
          cutoff: now,
        })
      ).status,
      'corrupt',
    );
    assert.deepEqual(f.writes, []);
  }
});
