import assert from 'node:assert/strict';
import test from 'node:test';
import { type DbAdapter, setAdapter } from '@vibelingan-channel/db';
import { mediaStorage } from '@vibelingan-channel/media-storage';
import { storeRawPayload } from './ingest.ts';

test('function cold start can execute the first raw Alibaba payload write', async () => {
  process.env.TCB_ENV = 'startup-wiring-test';
  process.env.JWT_SECRET = 'startup-wiring-test-secret';

  await import('./index.ts');

  const storage = mediaStorage();
  let objectWrites = 0;
  storage.putObject = async (input) => {
    objectWrites += 1;
    return {
      storageProvider: 'cloudbase-storage',
      storageMode: 'classic-nosql-storage',
      storageFileId: `cloud://startup-test/${input.fileName}`,
      storagePath: `alibaba-raw/${input.fileName}`,
      ...(input.content instanceof Uint8Array ? { byteSize: input.content.byteLength } : {}),
    };
  };

  let metadataWrites = 0;
  setAdapter({
    get: async () => null,
    createDocWithId: async () => {
      metadataWrites += 1;
      return 'created';
    },
  } as unknown as DbAdapter);

  const result = await storeRawPayload({
    bodyText: '{"ok":true}',
    endpointId: 'product.list',
    requestFingerprint: 'startup-test-fingerprint',
    connectionId: 'primary',
    runId: 'startup-test-run',
    now: '2026-09-03T00:00:00.000Z',
  });

  assert.equal(result.ok, true);
  assert.equal(objectWrites, 1, 'the first response must reach the configured storage adapter');
  assert.equal(metadataWrites, 1, 'the stored object must receive its hash-addressed metadata row');
});
