import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { list, readCatalogImageReference, setAdapter } from '@vibelingan-channel/db';
import { bindCatalogWebImage, catalogWebImagePath } from '@vibelingan-channel/db/catalog-web-image';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { CatalogImagePresentationSchema } from '@vibelingan-channel/shared/catalog-image-presentation';
import {
  buildCatalogImageReferencePlan,
  catalogImageReferenceEntry,
} from '../../../../packages/db/src/catalog-image-references.ts';
import { JsonFileAdapter } from '../../../local-server/src/json-adapter.ts';
import { budgetImagePresentation, publicImagePresentation } from './image-presentation.ts';

function image(id: string): CollectionDoc {
  const row: CollectionDoc = {
    _id: id,
    status: 'active',
    storageProvider: 'local-disk',
    storagePath: `source/${id}.png`,
    storageFileId: `local-disk:source/${id}.png`,
    mimeType: 'image/png',
    byteSize: 4_800_000,
    checksumSha256: 'a'.repeat(64),
    publishedRefCount: 1,
  };
  const web = (width: number, sha: string) => {
    const storagePath = catalogWebImagePath(id, String(row.checksumSha256), sha.repeat(64));
    return bindCatalogWebImage(row, {
      storageProvider: 'local-disk',
      storagePath,
      storageFileId: `local-disk:${storagePath}`,
      mimeType: 'image/webp',
      width,
      height: width / 2,
      byteSize: width,
      checksumSha256: sha.repeat(64),
    });
  };
  return {
    ...row,
    catalogWebImage: web(800, 'b'),
    catalogWebVariants: { '160': web(160, 'c'), '640': web(640, 'd') },
  };
}

test('opted-in metadata batches 101 image identities into two bounded reads without storage IDs or fake widths', async () => {
  const rows = Array.from({ length: 101 }, (_, index) => image(`image-${index}`));
  let calls = 0;
  const read: typeof list = async (query) => {
    calls++;
    assert.equal(query.collection, 'images');
    assert.ok(query.pageSize && query.pageSize <= 100);
    const clause = query.filter?.clauses[0];
    assert.ok(clause?.op === 'in' && Array.isArray(clause.value));
    const ids = clause.value;
    assert.ok(query.filter?.clauses.some((filter) => filter.field === 'storageProvider'));
    const items = rows.filter((row) => ids.includes(row._id));
    return { items, total: items.length, page: 1, pageSize: query.pageSize };
  };
  const urls = rows.map((row) => `/api/images/${row._id}`);
  const result = await publicImagePresentation(
    [...urls, urls[0] ?? '', 'https://supplier.invalid/a.png'],
    read,
  );
  assert.equal(calls, 2);
  assert.equal(Object.keys(result).length, 101);
  assert.deepEqual(
    result[urls[0] ?? '']?.map((candidate) => candidate.width),
    [160, 640, 800],
  );
  assert.ok(CatalogImagePresentationSchema.safeParse(result).success);
  assert.equal(JSON.stringify(result).includes('local-disk:'), false);
  assert.equal(JSON.stringify(result).includes('sourceDigest'), false);
});

test('private, corrupt, unprepared and unresolved images do not acquire public size descriptions', async () => {
  const rows = [image('private'), image('partial'), image('corrupt'), image('unknown-count')];
  if (rows[0]) rows[0].publishedRefCount = 0;
  if (rows[1]) rows[1].catalogWebVariants = {};
  if (rows[2]) rows[2].catalogWebVariants = { '320': {} };
  if (rows[3]) rows[3].publishedRefCount = '1';
  const read: typeof list = async () => ({ items: rows, total: rows.length, page: 1, pageSize: 4 });
  assert.deepEqual(
    await publicImagePresentation(
      rows.map((row) => `/api/images/${row._id}`),
      read,
    ),
    {},
  );
});

test('approved detail can resolve pending image links with bounded read-only checks', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'channel-image-presentation-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'db.json');
  const visible = image('visible');
  const revoked = image('revoked');
  const withdrawnImages = [revoked, image('withdrawn-2'), image('withdrawn-3')];
  const stillUnchecked = image('overflow');
  const rows = [visible, ...withdrawnImages, stillUnchecked];
  const added = buildCatalogImageReferencePlan(
    'a'.repeat(64),
    [],
    [visible._id, stillUnchecked._id],
  );
  const removed = buildCatalogImageReferencePlan(
    'b'.repeat(64),
    withdrawnImages.map((row) => row._id),
    [],
  );
  visible.publishedRefCount = 0;
  stillUnchecked.publishedRefCount = 0;
  for (const row of rows) {
    const plan = withdrawnImages.includes(row) ? removed : added;
    row.catalogPublishedReferenceLedger = {
      version: 'catalog-image-reference-ledger-v1',
      epoch: 0,
      pending: [
        catalogImageReferenceEntry(
          plan,
          plan.changes.findIndex((change) => change.imageId === row._id),
        ),
      ],
    };
  }
  const sourceData = JSON.stringify({
    images: rows,
    catalogDetailApprovals: [added.proof, removed.proof],
  });
  writeFileSync(file, sourceData);
  const adapter = new JsonFileAdapter(file);
  setAdapter(adapter);
  const calls: string[] = [];
  const read: typeof readCatalogImageReference = (command) => {
    assert.equal(command.action, 'read');
    assert.equal(command.maxDocumentOperations, 8);
    calls.push(command.imageId);
    return readCatalogImageReference(command);
  };
  const sources = [...rows, visible].map((row) => `/api/images/${row._id}`);
  assert.deepEqual(await publicImagePresentation(sources, list), {});
  const result = await publicImagePresentation(sources, list, read);
  assert.deepEqual(Object.keys(result), ['/api/images/visible']);
  assert.deepEqual(
    calls.sort(),
    rows
      .slice(0, 4)
      .map((row) => row._id)
      .sort(),
  );
  assert.equal(readFileSync(file, 'utf8'), sourceData);
});

test('optional size hints respect the response byte budget without truncating an image entry', () => {
  const source = '/api/images/图像';
  const first = { [source]: [{ url: `${source}?w=160`, width: 160, height: 100 }] };
  const bytes = Buffer.byteLength(JSON.stringify(first));
  const second = {
    ...first,
    '/api/images/other': [{ url: '/api/images/other?w=640', width: 640, height: 400 }],
  };
  assert.deepEqual(budgetImagePresentation(second, bytes), first);
  assert.deepEqual(budgetImagePresentation(first, bytes - 1), {});
  assert.deepEqual(budgetImagePresentation(first, -100), {});
});

test('optional image lookup failure keeps existing URLs and stops further batch reads', async () => {
  let calls = 0;
  const read: typeof list = async () => {
    calls++;
    throw Error('Private provider diagnostics must not enter a public response');
  };
  assert.deepEqual(
    await publicImagePresentation(
      Array.from({ length: 101 }, (_, index) => `/api/images/image-${index}`),
      read,
    ),
    {},
  );
  assert.equal(calls, 1);
});
