import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ImageUploadCommand } from '@vibelingan-channel/db';
import {
  buildCatalogImageReferencePlan,
  catalogImageReferenceEntry,
} from '../../../packages/db/src/catalog-image-references.ts';
import { imageUploadInputDigest } from '../../../packages/db/src/image-upload.ts';
import { JsonFileAdapter } from './json-adapter.ts';
function fixture(
  t: { after(fn: () => void): void },
  state:
    | 'pending-reference'
    | 'corrupt-ledger'
    | 'null-counter'
    | 'empty-ledger'
    | 'legacy-absent'
    | 'normal',
) {
  const directory = mkdtempSync(join(tmpdir(), 'channel-upload-references-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'db.json');
  const plan = buildCatalogImageReferencePlan('1'.repeat(64), [], ['upload']);
  const ledger = {
    version: 'catalog-image-reference-ledger-v1',
    epoch: 4,
    pending: state === 'empty-ledger' ? [] : [catalogImageReferenceEntry(plan, 0)],
  };
  const image: Record<string, unknown> & { _id: string } = {
    _id: 'upload',
    status: 'pending',
    uploadedByUserId: 'u',
    uploadIntentId: 'intent',
    purpose: 'catalog-image',
    mimeType: 'image/png',
    byteSize: 68,
    checksumSha256: 'a'.repeat(64),
    storageProvider: 'local-disk',
    storageMode: 'local-disk',
    storageFileId: 'local-disk:opaque upload',
    storagePath: 'upload/a.png',
    imageMutationOwner: 'op',
    imageMutationStartedAt: '2026-10-18T00:00:00.000Z',
    publishedRefCount: 0,
  };
  if (state === 'pending-reference' || state === 'empty-ledger' || state === 'corrupt-ledger')
    image.catalogPublishedReferenceLedger = state === 'corrupt-ledger' ? null : ledger;
  if (state === 'null-counter') image.publishedRefCount = null;
  if (state === 'legacy-absent') Reflect.deleteProperty(image, 'publishedRefCount');
  writeFileSync(
    file,
    JSON.stringify({ users: [{ _id: 'u', role: 'admin', status: 'active' }], images: [image] }),
  );
  const adapter = new JsonFileAdapter(file);
  const command = (action: 'activate' | 'reject'): ImageUploadCommand => ({
    imageId: 'upload',
    uploadedByUserId: 'u',
    owner: 'op',
    inputDigest: imageUploadInputDigest(image),
    now: '2026-10-18T00:00:00.000Z',
    ...(action === 'activate'
      ? { action, byteSize: 68, checksumSha256: 'a'.repeat(64) }
      : { action, reason: 'content' }),
  });
  return { adapter, command, file, ledger, bytes: () => readFileSync(file, 'utf8') };
}
for (const action of ['activate', 'reject'] as const)
  for (const state of ['pending-reference', 'corrupt-ledger', 'null-counter'] as const)
    test(`JSON upload ${action} refuses ${state} without writes`, async (t) => {
      const h = fixture(t, state);
      const before = h.bytes();
      assert.deepEqual(await h.adapter.manageImageUpload(h.command(action)), {
        status: 'conflict',
      });
      assert.equal(h.bytes(), before);
    });
for (const action of ['activate', 'reject'] as const)
  for (const state of ['empty-ledger', 'legacy-absent'] as const)
    test(`JSON upload ${action} preserves valid ${state}`, async (t) => {
      const h = fixture(t, state);
      assert.equal(
        (await h.adapter.manageImageUpload(h.command(action))).status,
        action === 'activate' ? 'active' : 'rejected',
      );
      const saved = await h.adapter.get('images', 'upload');
      assert.ok(saved);
      if (state === 'empty-ledger')
        assert.deepEqual(saved.catalogPublishedReferenceLedger, h.ledger);
      else assert.equal(Object.hasOwn(saved, 'publishedRefCount'), false);
    });
for (const action of ['activate', 'reject'] as const)
  test(`JSON upload ${action} captures command before its mutation lock wait`, async (t) => {
    const h = fixture(t, 'normal');
    const command = h.command(action);
    const pending = h.adapter.manageImageUpload(command);
    command.imageId = 'other';
    command.owner = 'other';
    command.inputDigest = 'f'.repeat(64);
    assert.equal((await pending).status, action === 'activate' ? 'active' : 'rejected');
    assert.equal(
      (await h.adapter.get('images', 'upload'))?.status,
      action === 'activate' ? 'active' : 'failed',
    );
  });
