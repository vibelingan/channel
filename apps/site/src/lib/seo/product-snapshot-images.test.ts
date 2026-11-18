import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { detailFixture } from '../../catalog/testing/detail-fixture.ts';
import {
  createProductSnapshotImages,
  decodeProductSnapshotImages,
  readProductSnapshotImages,
} from './product-snapshot-images.ts';
import { collectProductRefreshWithImages, decodeProductSnapshot } from './product-snapshot.ts';

const site = 'https://example.com';
const source = '/api/images/configuration-photo';
const detail = { ...detailFixture(1), images: [source] };
assert.ok(detail.revision);
const snapshot = decodeProductSnapshot(
  {
    schemaVersion: 1,
    purpose: 'public',
    total: 1,
    siteOrigin: site,
    apiOrigin: site,
    products: [
      { product: { _id: detail._id, name: detail.name }, detail, revision: detail.revision },
    ],
  },
  site,
);
const images = createProductSnapshotImages(snapshot, [
  {
    productId: detail._id,
    revision: detail.revision,
    images: { [source]: [{ url: `${source}?w=640`, width: 640, height: 400 }] },
  },
]);

test('image hints refuse foreign sites, unrelated sources, stale revisions, duplicates and unsafe URLs', () => {
  assert.deepEqual(decodeProductSnapshotImages(images, snapshot), images);
  assert.throws(() =>
    decodeProductSnapshotImages({ ...images, siteOrigin: 'https://other.example' }, snapshot),
  );
  const row = images.products[0];
  assert.ok(row);
  for (const invalid of [
    { ...row, productId: 'another-product' },
    { ...row, revision: 'approved-r2' },
    {
      ...row,
      images: {
        '/api/images/foreign-photo': [
          { url: '/api/images/foreign-photo?w=160', width: 160, height: 100 },
        ],
      },
    },
    {
      ...row,
      images: {
        [source]: [{ url: 'https://other.example/private-file', width: 160, height: 100 }],
      },
    },
  ])
    assert.throws(() => decodeProductSnapshotImages({ ...images, products: [invalid] }, snapshot));
  assert.throws(() => decodeProductSnapshotImages({ ...images, products: [row, row] }, snapshot));
});

test('legacy absent hints remain readable; malformed or mismatched files fail instead of silently falling back', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'snapshot-hints-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'products.json');
  assert.deepEqual((await readProductSnapshotImages(file, snapshot)).products, []);
  await writeFile(`${file}.images.json`, JSON.stringify(images));
  assert.deepEqual(await readProductSnapshotImages(file, snapshot), images);
  await writeFile(`${file}.images.json`, '{broken');
  await assert.rejects(() => readProductSnapshotImages(file, snapshot));
});

test('accepted reuse retains unchanged hints and drops withdrawn or replaced revisions', () => {
  assert.deepEqual(createProductSnapshotImages(snapshot, images.products), images);
  const withdrawn = { ...snapshot, total: 0, products: [] };
  assert.deepEqual(createProductSnapshotImages(withdrawn, images.products).products, []);
  assert.deepEqual(
    createProductSnapshotImages(
      {
        ...snapshot,
        products: snapshot.products.map((entry) => ({ ...entry, revision: 'approved-r2' })),
      },
      images.products,
    ).products,
    [],
  );
});

test('incremental update retains unchanged image hints with no additional detail calls, then replaces them for a changed revision', async () => {
  const row = snapshot.products[0]?.product;
  assert.ok(row);
  const calls: URL[] = [];
  const transport =
    (revision: string, width: number): typeof fetch =>
    async (input) => {
      const url = new URL(String(input));
      calls.push(url);
      return Response.json({
        ok: true,
        data: url.pathname.endsWith('/detail')
          ? {
              ...detail,
              revision,
              imagePresentation: {
                [source]: [{ url: `${source}?w=${width}`, width, height: width }],
              },
            }
          : { items: [row], total: 1, page: 1, pageSize: 48 },
      });
    };
  const retained = await collectProductRefreshWithImages(
    snapshot,
    [],
    site,
    site,
    images,
    transport('approved-r1', 160),
  );
  assert.deepEqual(retained.images, images);
  assert.equal(calls.filter((url) => url.pathname.endsWith('/detail')).length, 0);
  calls.length = 0;
  const changed = await collectProductRefreshWithImages(
    snapshot,
    [
      {
        productId: detail._id,
        visible: true,
        sequence: 1,
        semanticHash: 'a'.repeat(64),
        detailRevision: 'approved-r2',
        changedAt: null,
      },
    ],
    site,
    site,
    images,
    transport('approved-r2', 160),
  );
  assert.equal(changed.images.products[0]?.images[source]?.[0]?.width, 160);
  assert.equal(changed.snapshot.products[0]?.detail?.imagePresentation, undefined);
  assert.equal(calls.filter((url) => url.pathname.endsWith('/detail')).length, 2);
  assert.equal(
    calls.filter((url) => url.pathname.endsWith('/detail') && url.searchParams.has('media')).length,
    1,
  );
});
