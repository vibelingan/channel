import { strict as assert } from 'node:assert';
import test from 'node:test';
import { buildWriteSchema, getCollection, writableFields } from './collections.ts';
import {
  BLOCKED_IMAGE_MIME_TYPES,
  CATALOG_IMAGE_MAX_BYTES,
  CATALOG_IMAGE_MAX_COUNT,
  CATALOG_IMAGE_MIME_TYPES,
  type FileMetadataDoc,
  IMAGE_STORAGE_PROVIDERS,
  type ImageMetadataDoc,
  MEDIA_PURPOSES,
  MEDIA_STATUSES,
  OEM_FILE_EXTENSIONS,
  OEM_FILE_MAX_BYTES,
  OEM_MAX_PENDING_INTENTS_GLOBAL,
  OEM_MAX_PENDING_INTENTS_PER_SOURCE,
  OEM_UPLOAD_INTENT_TTL_MS,
  OEM_UPLOAD_RATE_MAX_PER_WINDOW,
  OEM_UPLOAD_RATE_MAX_PER_WINDOW_GLOBAL,
  OEM_UPLOAD_RATE_WINDOW_MS,
  type StorageBackedImageMetadataDoc,
  catalogImageUploadSchema,
  fileExtension,
  isAllowedOemExtension,
  isStorageBackedImage,
  oemFileUploadSchema,
} from './media.ts';

function imagesDef() {
  const def = getCollection('images');
  assert.ok(def, 'images collection must be registered');
  return def;
}

function productsDef() {
  const def = getCollection('products');
  assert.ok(def, 'products collection must be registered');
  return def;
}

test('images generic write schema accepts only safe metadata fields', () => {
  const schema = buildWriteSchema(imagesDef());
  assert.deepEqual(schema.parse({ name: 'a.jpg' }), { name: 'a.jpg' });
});

test('images generic write schema rejects forged storage identifiers', () => {
  const schema = buildWriteSchema(imagesDef());
  assert.throws(() => schema.parse({ name: 'a', storageFileId: 'cloud://forged' }));
});

test('images generic write schema rejects base64 data writes', () => {
  const schema = buildWriteSchema(imagesDef());
  assert.throws(() => schema.parse({ name: 'a', data: 'AAAA' }));
});

test('images generic write schema rejects every server-managed lifecycle field', () => {
  const schema = buildWriteSchema(imagesDef());
  const forgeries: Record<string, unknown>[] = [
    // mimeType is reflected into the public delivery Content-Type, so it is
    // server-managed like the storage/lifecycle fields (stored-XSS hardening).
    { mimeType: 'text/html' },
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
      () => schema.parse({ name: 'a', ...forged }),
      `expected generic write to reject ${JSON.stringify(forged)}`,
    );
  }
});

test('images writable fields are only name', () => {
  const names = writableFields(imagesDef()).map((f) => f.name);
  assert.deepEqual(names, ['name']);
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
  assert.equal(CATALOG_IMAGE_MAX_COUNT, 18);
  assert.ok(CATALOG_IMAGE_MIME_TYPES.includes('image/webp'));
  assert.ok(BLOCKED_IMAGE_MIME_TYPES.includes('image/svg+xml'));
});

test('storefront catalog writes enforce the shared 18-image limit', () => {
  const base = { name: 'Bounded product', category: 'wired' };
  const imageIds = Array.from({ length: CATALOG_IMAGE_MAX_COUNT }, (_, index) => `img-${index}`);

  for (const collection of ['products', 'overstock']) {
    const def = getCollection(collection);
    assert.ok(def, `${collection} collection must be registered`);
    const schema = buildWriteSchema(def);
    const values =
      collection === 'products' ? base : { name: 'Bounded overstock', category: 'electronics' };
    assert.deepEqual(schema.parse({ ...values, imageIds }).imageIds, imageIds);
    assert.throws(() => schema.parse({ ...values, imageIds: [...imageIds, 'img-over-limit'] }));
    assert.throws(() => schema.partial().parse({ imageIds: [...imageIds, 'img-over-limit'] }));
  }
});

test('catalog image limits preserve legacy malformed-value compatibility and stay scoped', () => {
  const productSchema = buildWriteSchema(productsDef());
  const base = { name: 'Legacy product', category: 'wired' };
  for (const imageIds of [null, 'img-1', [], ['']]) {
    assert.deepEqual(productSchema.parse({ ...base, imageIds }).imageIds, imageIds);
  }

  const successStories = getCollection('successStories');
  assert.ok(successStories);
  const unrelatedImageIds = Array.from(
    { length: CATALOG_IMAGE_MAX_COUNT + 1 },
    (_, index) => `story-image-${index}`,
  );
  assert.deepEqual(
    buildWriteSchema(successStories).parse({
      title: 'Story',
      summary: 'Summary',
      imageIds: unrelatedImageIds,
    }).imageIds,
    unrelatedImageIds,
  );
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

test('StorageBackedImageMetadataDoc requires lifecycle/storage fields; isStorageBackedImage narrows', () => {
  // Required fields — omitting any of these would fail tsc, which is the point:
  // the strict contract media actions / public delivery write + read through.
  const backed: StorageBackedImageMetadataDoc = {
    _id: 'img1',
    name: 'product.jpg',
    mimeType: 'image/jpeg',
    purpose: 'catalog-image',
    storageProvider: 'cloudbase-storage',
    storageFileId: 'cloud://x',
    storagePath: 'catalog/2026/06/img1/original-product.jpg',
    status: 'active',
    publishedRefCount: 1,
  };
  assert.equal(isStorageBackedImage(backed), true);

  // A raw legacy row lacks the storage/lifecycle fields → guard returns false.
  const legacy: ImageMetadataDoc = {
    _id: 'img2',
    name: 'placeholder.svg',
    mimeType: 'image/svg+xml',
    data: 'PHN2Zz4=',
  };
  assert.equal(isStorageBackedImage(legacy), false);

  // A half-written storage row (provider set, but no fileId/status yet) is also
  // rejected — callers cannot treat an incomplete row as active/public.
  const pending: ImageMetadataDoc = {
    _id: 'img3',
    name: 'p.jpg',
    mimeType: 'image/jpeg',
    storageProvider: 'cloudbase-storage',
  };
  assert.equal(isStorageBackedImage(pending), false);
});

// --- OEM file (attachment) foundation — MIU-08 -----------------------------

function filesDef() {
  const def = getCollection('files');
  assert.ok(def, 'files collection must be registered');
  return def;
}

test('files generic write schema accepts only safe metadata (name)', () => {
  const schema = buildWriteSchema(filesDef());
  assert.deepEqual(schema.parse({ name: 'drawing.pdf' }), { name: 'drawing.pdf' });
  assert.deepEqual(
    writableFields(filesDef()).map((f) => f.name),
    ['name'],
  );
});

test('files generic write schema rejects every server-managed storage/lifecycle field', () => {
  const schema = buildWriteSchema(filesDef());
  const forgeries: Record<string, unknown>[] = [
    { mimeType: 'text/html' },
    { data: 'AAAA' },
    { status: 'active' },
    { storageProvider: 'cloudbase-storage' },
    { storageMode: 'classic-nosql-storage' },
    { storageFileId: 'cloud://forged' },
    { storagePath: 'oem/2026/06/x/drawing.pdf' },
    { byteSize: 10 },
    { checksumSha256: 'deadbeef' },
    { purpose: 'oem-drawing' },
    { ownerProjectId: 'proj1' },
    { uploadIntentId: 'intent1' },
    { uploadSecretHash: 'hash' },
    { uploadSourceHash: 'srchash' },
    { finalizeClaim: 1 },
    { uploadExpiresAt: new Date().toISOString() },
  ];
  for (const forged of forgeries) {
    assert.throws(
      () => schema.parse({ name: 'd', mimeType: 'application/pdf', ...forged }),
      `expected files generic write to reject ${JSON.stringify(forged)}`,
    );
  }
});

test('files generic UPDATE (partial) write schema also rejects forged readOnly keys', () => {
  // The upload secret must NEVER be settable through generic CRUD — forging it
  // (or the storage id / status) on the update path must throw, not be stripped.
  const schema = buildWriteSchema(filesDef()).partial();
  assert.throws(() => schema.parse({ uploadSecretHash: 'hash' }));
  assert.throws(() => schema.parse({ storageFileId: 'cloud://forged' }));
  assert.throws(() => schema.parse({ status: 'active' }));
  assert.throws(() => schema.parse({ mimeType: 'text/html' }));
  assert.deepEqual(schema.parse({ name: 'renamed.pdf' }), { name: 'renamed.pdf' });
});

test('OEM upload constants expose the abuse-control policy', () => {
  assert.equal(OEM_FILE_MAX_BYTES, 10 * 1024 * 1024);
  assert.equal(OEM_UPLOAD_INTENT_TTL_MS, 15 * 60 * 1000);
  assert.equal(OEM_MAX_PENDING_INTENTS_PER_SOURCE, 3);
  assert.equal(OEM_UPLOAD_RATE_WINDOW_MS, 60 * 1000);
  assert.equal(OEM_UPLOAD_RATE_MAX_PER_WINDOW, 5);
  // Global emergency ceilings are enforced in addition to (and are higher than)
  // the per-source caps, bounding total abuse if the source signal is absent.
  assert.equal(OEM_UPLOAD_RATE_MAX_PER_WINDOW_GLOBAL, 30);
  assert.equal(OEM_MAX_PENDING_INTENTS_GLOBAL, 50);
  assert.ok(OEM_UPLOAD_RATE_MAX_PER_WINDOW_GLOBAL > OEM_UPLOAD_RATE_MAX_PER_WINDOW);
  assert.ok(OEM_MAX_PENDING_INTENTS_GLOBAL > OEM_MAX_PENDING_INTENTS_PER_SOURCE);
  // Archive, CAD, and image families are all represented.
  for (const ext of ['pdf', 'zip', 'rar', 'step', 'dwg', 'dxf', 'png', 'jpg']) {
    assert.ok(
      (OEM_FILE_EXTENSIONS as readonly string[]).includes(ext),
      `expected ${ext} to be an accepted OEM extension`,
    );
  }
});

test('fileExtension extracts the lowercase extension, or empty string', () => {
  assert.equal(fileExtension('Drawing.PDF'), 'pdf');
  assert.equal(fileExtension('archive.tar.GZ'), 'gz');
  assert.equal(fileExtension('a.STEP'), 'step');
  assert.equal(fileExtension('noext'), '');
  assert.equal(fileExtension('trailingdot.'), '');
});

test('isAllowedOemExtension gates by the extension allowlist (case-insensitive)', () => {
  assert.equal(isAllowedOemExtension('part.STEP'), true);
  assert.equal(isAllowedOemExtension('drawing.pdf'), true);
  assert.equal(isAllowedOemExtension('bundle.zip'), true);
  assert.equal(isAllowedOemExtension('malware.exe'), false);
  assert.equal(isAllowedOemExtension('script.svg'), false);
  assert.equal(isAllowedOemExtension('noextension'), false);
});

test('oemFileUploadSchema accepts allowlisted types incl. CAD, rejects the rest', () => {
  for (const fileName of [
    'part.step',
    'model.STP',
    'plan.dwg',
    'sheet.dxf',
    'doc.pdf',
    'imgs.zip',
  ]) {
    const parsed = oemFileUploadSchema.parse({
      fileName,
      mimeType: 'application/octet-stream',
      byteSize: 4096,
    });
    assert.equal(parsed.fileName, fileName);
  }
  // Unsupported extension is rejected even with a benign MIME.
  assert.throws(() =>
    oemFileUploadSchema.parse({
      fileName: 'x.exe',
      mimeType: 'application/octet-stream',
      byteSize: 10,
    }),
  );
  // An extension-less filename cannot pass the allowlist.
  assert.throws(() =>
    oemFileUploadSchema.parse({ fileName: 'drawing', mimeType: 'application/pdf', byteSize: 10 }),
  );
});

test('oemFileUploadSchema enforces byteSize bounds (int, positive, capped)', () => {
  const base = { fileName: 'part.step', mimeType: 'application/octet-stream' };
  assert.throws(() => oemFileUploadSchema.parse({ ...base, byteSize: 0 }));
  assert.throws(() => oemFileUploadSchema.parse({ ...base, byteSize: -1 }));
  assert.throws(() => oemFileUploadSchema.parse({ ...base, byteSize: 3.5 }));
  assert.throws(() => oemFileUploadSchema.parse({ ...base, byteSize: OEM_FILE_MAX_BYTES + 1 }));
  assert.throws(() => oemFileUploadSchema.parse(base)); // byteSize missing
  // Exactly at the cap is allowed (inclusive max).
  assert.equal(
    oemFileUploadSchema.parse({ ...base, byteSize: OEM_FILE_MAX_BYTES }).byteSize,
    OEM_FILE_MAX_BYTES,
  );
});

test('FileMetadataDoc models both storage-backed and legacy OEM records', () => {
  const storage: FileMetadataDoc = {
    _id: 'file1',
    name: 'assembly.step',
    mimeType: 'application/octet-stream',
    purpose: 'oem-drawing',
    storageProvider: 'cloudbase-storage',
    storageFileId: 'cloud://oem/x',
    storagePath: 'oem/2026/06/file1/assembly.step',
    byteSize: 4096,
    status: 'pending',
    uploadIntentId: 'intent1',
    uploadSecretHash: 'hash',
    uploadExpiresAt: new Date().toISOString(),
  };
  // A legacy inline-base64 row: only identity + purpose + data, no lifecycle.
  const legacy: FileMetadataDoc = {
    _id: 'file2',
    name: 'old.pdf',
    mimeType: 'application/pdf',
    purpose: 'oem-drawing',
    storageProvider: 'legacy-base64',
    data: 'JVBERi0=',
  };
  assert.equal(storage.storageProvider, 'cloudbase-storage');
  assert.equal(storage.status, 'pending');
  assert.equal(legacy.data, 'JVBERi0=');
  assert.equal(legacy.status, undefined);
});
