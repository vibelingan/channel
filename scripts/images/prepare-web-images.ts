import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  isStoredCatalogImageRecord,
  storedCatalogImageInputDigest,
} from '../../packages/db/src/catalog-image-input.ts';
import {
  catalogWebImagePath,
  readCatalogWebImage,
} from '../../packages/db/src/catalog-web-image.ts';
import { createCatalogWebImage } from '../../packages/media-storage/src/web-image.ts';
import type { CollectionDoc } from '../../packages/shared/src/index.ts';

// Pure local preparation. It cannot upload files, register metadata or change permissions.
const [sourceFile, originalDirectory, outputDirectory] = process.argv.slice(2);
assert(
  sourceFile && originalDirectory && outputDirectory,
  'Usage: prepare-web-images.ts sources.json originals-directory output-directory',
);
const rows: unknown = JSON.parse(await readFile(resolve(sourceFile), 'utf8'));
assert(Array.isArray(rows), 'Expected an explicitly selected source list');
const root = resolve(outputDirectory);
await mkdir(root, { recursive: true });
const prepared = [];
for (const input of rows) {
  assert(
    input &&
      typeof input === 'object' &&
      typeof input._id === 'string' &&
      /^[A-Za-z0-9_-]{1,200}$/.test(input._id),
    'Invalid image identity',
  );
  const row: CollectionDoc = input;
  assert(isStoredCatalogImageRecord(row, row._id), 'Unverified source metadata');
  assert(
    row.storageProvider === 'cloudbase-storage',
    'This command only prepares the observed CloudBase image set',
  );
  const bytes = await readFile(join(resolve(originalDirectory), `${row._id}.source`));
  assert(
    bytes.byteLength === row.byteSize &&
      createHash('sha256').update(bytes).digest('hex') === row.checksumSha256,
    'Original bytes differ from recorded source',
  );
  const web = await createCatalogWebImage(bytes, row.mimeType);
  const storagePath = catalogWebImagePath(row._id, row.checksumSha256, web.checksumSha256);
  const bucket = /^cloud:\/\/([^/]+)\//.exec(row.storageFileId)?.[1];
  assert(bucket, 'Source is not a permanent CloudBase object');
  const descriptor = {
    schemaVersion: 1,
    sourceDigest: storedCatalogImageInputDigest(row),
    storageProvider: row.storageProvider,
    storageFileId: `cloud://${bucket}/${storagePath}`,
    storagePath,
    mimeType: web.mimeType,
    byteSize: web.byteSize,
    width: web.width,
    height: web.height,
    checksumSha256: web.checksumSha256,
  };
  assert(
    readCatalogWebImage({ ...row, catalogWebImage: descriptor }),
    'Prepared descriptor did not bind the source',
  );
  const localPath = join(root, `${row._id}.webp`);
  await writeFile(localPath, web.bytes, { flag: 'wx' });
  prepared.push({
    imageId: row._id,
    sourceDigest: descriptor.sourceDigest,
    sourceBytes: row.byteSize,
    localPath,
    descriptor,
  });
  console.log(
    JSON.stringify({
      imageId: row._id,
      sourceBytes: row.byteSize,
      webBytes: web.byteSize,
      width: web.width,
      height: web.height,
    }),
  );
}
await writeFile(
  join(root, 'prepared.json'),
  `${JSON.stringify({ schemaVersion: 1, prepared }, null, 2)}\n`,
  { flag: 'wx' },
);
