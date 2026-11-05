import assert from 'node:assert/strict';
import test from 'node:test';
import { preserveCatalogRuntimeBackup } from './release/catalog-runtime-backup.mjs';
import { sha256 } from './release/input.mjs';

test('initial function retention verifies every byte and keeps the first programs across a partial rollout retry', async () => {
  const target = { envId: 'fixture', region: 'ap-shanghai', siteOrigin: 'https://fixture.example' };
  const storage = new Map();
  let state = null;
  let writes = 0;
  let reads = 0;
  const objects = {
    async put(bytes) {
      const hash = sha256(bytes);
      storage.set(hash, Buffer.from(bytes));
      return { fileID: hash, sha256: hash, bytes: bytes.length };
    },
    async get(ref) {
      reads++;
      const b = storage.get(ref.sha256);
      if (!b || sha256(b) !== ref.sha256 || b.length !== ref.bytes) throw Error('bad bytes');
      return b;
    },
  };
  const row = {
    async get() {
      return { data: state ? [{ _id: 'row', ...state }] : [] };
    },
    async set(value) {
      writes++;
      state = value;
      throw Error('lost reply');
    },
  };
  const originals = ['public-api', 'alibaba-catalog-sync', 'admin'].map((name) => {
    const bytes = Buffer.from(name);
    return {
      name,
      bytes,
      version: 'a'.repeat(40),
      snapshot: {
        name,
        status: 'Active',
        availableStatus: 'Available',
        packageSha256: sha256(bytes),
        packageBytes: bytes.length,
      },
    };
  });
  const input = { row, objects, target, codeSha: 'b'.repeat(40), sourceRunId: '1', originals };
  const first = await preserveCatalogRuntimeBackup(input);
  assert.equal(writes, 1);
  assert.equal(reads, 4);
  const replay = await preserveCatalogRuntimeBackup({ ...input, sourceRunId: '2', originals: [] });
  assert.deepEqual(replay, first);
  assert.equal(writes, 1);
  assert.equal(reads, 8);
  storage.set(sha256(originals[1].bytes), Buffer.from('changed'));
  await assert.rejects(preserveCatalogRuntimeBackup(input));
  assert.equal(writes, 1);
});

test('missing retention, wrong target and malformed saved manifests stop without changing the existing pointer', async () => {
  const target = { siteOrigin: 'https://fixture.example' };
  const original = {
    schemaVersion: 1,
    purpose: 'initial-catalog-function-backup',
    codeSha: 'b'.repeat(40),
    siteOrigin: target.siteOrigin,
    manifestObject: {},
  };
  let writes = 0;
  for (const manifest of [
    { purpose: 'wrong' },
    { purpose: original.purpose, target: { siteOrigin: 'https://another.example' }, originals: [] },
  ]) {
    await assert.rejects(
      preserveCatalogRuntimeBackup({
        row: {
          get: async () => ({ data: original }),
          set: async () => {
            writes++;
          },
        },
        objects: { get: async () => Buffer.from(JSON.stringify(manifest)) },
        target,
        codeSha: original.codeSha,
        originals: [],
      }),
    );
  }
  assert.equal(writes, 0);
});
