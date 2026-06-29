import { strict as assert } from 'node:assert';
import test from 'node:test';
import { buildWriteSchema, getCollection, writableFields } from './collections.ts';
import {
  BLOCKED_IMAGE_MIME_TYPES,
  CATALOG_IMAGE_MAX_BYTES,
  CATALOG_IMAGE_MIME_TYPES,
  IMAGE_STORAGE_PROVIDERS,
  type ImageMetadataDoc,
  MEDIA_PURPOSES,
  MEDIA_STATUSES,
  catalogImageUploadSchema,
} from './media.ts';

function imagesDef() {
  const def = getCollection('images');
  assert.ok(def, 'images collection must be registered');
  return def;
}

test('images generic write schema accepts only safe metadata fields', () => {
  const schema = buildWriteSchema(imagesDef());
  assert.deepEqual(schema.parse({ name: 'a.jpg', mimeType: 'image/jpeg' }), {
    name: 'a.jpg',
    mimeType: 'image/jpeg',
  });
});

test('images generic write schema rejects forged storage identifiers', () => {
  const schema = buildWriteSchema(imagesDef());
  assert.throws(() =>
    schema.parse({ name: 'a', mimeType: 'image/jpeg', storageFileId: 'cloud://forged' }),
  );
});

test('images generic write schema rejects base64 data writes', () => {
  const schema = buildWriteSchema(imagesDef());
  assert.throws(() => schema.parse({ name: 'a', mimeType: 'image/jpeg', data: 'AAAA' }));
});

test('images generic write schema rejects every server-managed lifecycle field', () => {
  const schema = buildWriteSchema(imagesDef());
  const forgeries: Record<string, unknown>[] = [
    { status: 'active' },
    { publishedRefCount: 9 },
    { storageProvider: 'cloudbase-storage' },
    { storageMode: 'classic-nosql-storage' },
    { storagePath: 'catalog/2026/06/x/original-p.jpg' },
    { purpose: 'catalog-image' },
    { variants: [] },
    { byteSize: 10 },
    { checksumSha256: 'deadbeef' },
  ];
  for (const forged of forgeries) {
    assert.throws(
      () => schema.parse({ name: 'a', mimeType: 'image/jpeg', ...forged }),
      `expected generic write to reject ${JSON.stringify(forged)}`,
    );
  }
});

test('images writable fields are only name + mimeType', () => {
  const names = writableFields(imagesDef()).map((f) => f.name);
  assert.deepEqual(names, ['name', 'mimeType']);
});

test('media constants expose the policy vocabulary', () => {
  assert.ok(MEDIA_PURPOSES.includes('catalog-image'));
  assert.ok(MEDIA_PURPOSES.includes('oem-drawing'));
  assert.ok(IMAGE_STORAGE_PROVIDERS.includes('legacy-base64'));
  assert.ok(IMAGE_STORAGE_PROVIDERS.includes('cloudbase-storage'));
  assert.ok(IMAGE_STORAGE_PROVIDERS.includes('local-disk'));
  assert.ok(MEDIA_STATUSES.includes('pending'));
  assert.ok(MEDIA_STATUSES.includes('active'));
  assert.equal(CATALOG_IMAGE_MAX_BYTES, 10 * 1024 * 1024);
  assert.ok(CATALOG_IMAGE_MIME_TYPES.includes('image/webp'));
  assert.ok(BLOCKED_IMAGE_MIME_TYPES.includes('image/svg+xml'));
});

test('catalog image upload schema accepts a valid request and defaults purpose', () => {
  const parsed = catalogImageUploadSchema.parse({
    fileName: 'product.jpg',
    mimeType: 'image/jpeg',
    byteSize: 2048,
  });
  assert.equal(parsed.purpose, 'catalog-image');
  assert.equal(parsed.fileName, 'product.jpg');
});

test('images generic UPDATE (partial) write schema also rejects forged readOnly keys', () => {
  // .partial() must preserve .strict(): the update path is as security-critical
  // as create. Forging a storage key on update must throw, not be stripped.
  const schema = buildWriteSchema(imagesDef()).partial();
  assert.throws(() => schema.parse({ storageFileId: 'cloud://forged' }));
  assert.throws(() => schema.parse({ data: 'AAAA' }));
  assert.throws(() => schema.parse({ status: 'active' }));
  // A safe partial edit still works.
  assert.deepEqual(schema.parse({ name: 'renamed.jpg' }), { name: 'renamed.jpg' });
});

test('catalog image upload schema rejects blocked MIME, oversize, and empty name', () => {
  assert.throws(() =>
    catalogImageUploadSchema.parse({ fileName: 'p.svg', mimeType: 'image/svg+xml', byteSize: 10 }),
  );
  assert.throws(() =>
    catalogImageUploadSchema.parse({
      fileName: 'p.jpg',
      mimeType: 'image/jpeg',
      byteSize: CATALOG_IMAGE_MAX_BYTES + 1,
    }),
  );
  assert.throws(() =>
    catalogImageUploadSchema.parse({ fileName: '', mimeType: 'image/jpeg', byteSize: 10 }),
  );
});

test('catalog image upload MIME is a whitelist, not an SVG-only blocklist', () => {
  // image/gif is neither allowed nor in BLOCKED_IMAGE_MIME_TYPES — it must still
  // be rejected, proving enforcement is the allowlist enum (a regression to a
  // naive `!== 'image/svg+xml'` blocklist would be caught here).
  assert.throws(() =>
    catalogImageUploadSchema.parse({ fileName: 'p.gif', mimeType: 'image/gif', byteSize: 10 }),
  );
  assert.throws(() =>
    catalogImageUploadSchema.parse({
      fileName: 'p.bin',
      mimeType: 'application/octet-stream',
      byteSize: 10,
    }),
  );
});

test('catalog image upload schema enforces byteSize bounds (int, positive, present)', () => {
  const base = { fileName: 'p.jpg', mimeType: 'image/jpeg' as const };
  assert.throws(() => catalogImageUploadSchema.parse({ ...base, byteSize: 0 }));
  assert.throws(() => catalogImageUploadSchema.parse({ ...base, byteSize: -5 }));
  assert.throws(() => catalogImageUploadSchema.parse({ ...base, byteSize: 2.5 }));
  assert.throws(() => catalogImageUploadSchema.parse(base)); // byteSize missing
  // Exactly at the cap is allowed (max is inclusive).
  assert.equal(
    catalogImageUploadSchema.parse({ ...base, byteSize: CATALOG_IMAGE_MAX_BYTES }).byteSize,
    CATALOG_IMAGE_MAX_BYTES,
  );
});

test('ImageMetadataDoc models both storage-backed and legacy records', () => {
  const storage: ImageMetadataDoc = {
    _id: 'img1',
    name: 'product.jpg',
    mimeType: 'image/jpeg',
    purpose: 'catalog-image',
    storageProvider: 'cloudbase-storage',
    storageMode: 'classic-nosql-storage',
    storageFileId: 'cloud://x',
    storagePath: 'catalog/2026/06/img1/original-product.jpg',
    byteSize: 2048,
    status: 'active',
    publishedRefCount: 1,
  };
  // A REAL pre-migration legacy row (matches apps/local-server/src/seed.ts):
  // only _id/name/mimeType/data — no purpose/storageProvider/status/refCount.
  // This must type-check; if the migration fields were required, it would not,
  // and MIU-04 code would wrongly assume legacy rows carry lifecycle state.
  const legacy: ImageMetadataDoc = {
    _id: 'img2',
    name: 'placeholder.svg',
    mimeType: 'image/svg+xml',
    data: 'PHN2Zz4=',
  };
  assert.equal(storage.storageProvider, 'cloudbase-storage');
  assert.equal(legacy.storageProvider, undefined); // defaulted to legacy-base64 by consumers
  assert.equal(legacy.status, undefined); // MIU-04 treats absent status as legacy-active
});
