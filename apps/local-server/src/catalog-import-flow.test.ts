/**
 * End-to-end tests for the catalog import, against the REAL file-backed
 * adapter rather than a mock.
 *
 * A mock would prove the code calls the functions it calls. These prove the
 * things the merchant actually cares about: importing the same file twice does
 * not double their catalog, editing a title in the admin is not undone by the
 * next export, and nothing the importer does touches an Alibaba-owned field.
 */
import { strict as assert } from 'node:assert';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { sourceObservationDocumentId } from '@vibelingan-channel/catalog-import/observations';
import { buildAcceptanceWorkbook } from '@vibelingan-channel/catalog-import/testing/dianxiaomi-acceptance';
import { get, list, setAdapter, updateDoc, upsertDocWithId } from '@vibelingan-channel/db';
import { migrateImageLocally } from '@vibelingan-channel/fn-admin/catalog-import-media';
import { publishImportedSample } from '@vibelingan-channel/fn-admin/catalog-import-publish';
import {
  computeImportDelta,
  runCatalogImport,
} from '@vibelingan-channel/fn-admin/catalog-import-service';
import { setMediaStorage } from '@vibelingan-channel/media-storage';
import { LocalDiskMediaStorage } from '@vibelingan-channel/media-storage/local-disk';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { JsonFileAdapter } from './json-adapter.ts';

const WORKBOOK = buildAcceptanceWorkbook();
const CHANGED = buildAcceptanceWorkbook({ revision: 'changed' });

interface Harness {
  dir: string;
  cleanup: () => void;
}

/** A private database and media directory per test, torn down afterwards. */
function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'catalog-import-'));
  setAdapter(new JsonFileAdapter(join(dir, 'db.json')));
  setMediaStorage(new LocalDiskMediaStorage(join(dir, 'media')));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function countOf(collection: string): Promise<number> {
  const page = await list({ collection, page: 1, pageSize: 1 });
  return page.total;
}

async function allOf(collection: string): Promise<CollectionDoc[]> {
  const page = await list({ collection, page: 1, pageSize: 2000 });
  return page.items;
}

// --- staging ----------------------------------------------------------------

test('a fresh import stages a job and one item per product family', async (t) => {
  const { cleanup } = harness();
  t.after(cleanup);

  const run = await runCatalogImport({ bytes: WORKBOOK, sourceFileName: 'export.xlsx' });
  assert.equal(run.reused, false);
  assert.equal(run.job.status, 'previewReady');
  assert.equal(await countOf('catalogImportJobs'), 1);
  assert.equal(await countOf('catalogImportItems'), 77);
  assert.equal(await countOf('catalogSourceObservations'), 77);

  const counts = run.job.counts as Record<string, number>;
  assert.equal(counts.rows, 312);
  assert.equal(counts.parentSkus, 77);
  assert.equal(counts.skus, 289);
  assert.equal(counts.storeProducts, 100);
  assert.equal(counts.storeVariants, 312);
  assert.equal(counts.uniqueImageUrls, 452);

  const summary = run.job.summary as Record<string, number>;
  assert.equal(summary.products, 77);
  assert.equal(summary.variants, 289);
  assert.equal(summary.inventoryConflict, 0);

  const observations = await allOf('catalogSourceObservations');
  const first = observations[0];
  assert.ok(first);
  assert.equal(first.provider, 'dianxiaomi');
  assert.equal(first.schemaVersion, 'catalog-source-observation-v1');
  assert.equal(first.firstSeenOperationId, run.job._id);
  assert.equal(first.lastSeenOperationId, run.job._id);
  assert.equal(first.evidenceId, run.job.sourceFileSha256);
  assert.equal(
    first._id,
    sourceObservationDocumentId('dianxiaomi', String(first.sourceProductKey)),
  );
  assert.equal(await countOf('products'), 0, 'observations never auto-promote canonical products');
});

test('the workbook itself is never stored, only its digest', async (t) => {
  const { cleanup } = harness();
  t.after(cleanup);
  const run = await runCatalogImport({ bytes: WORKBOOK, sourceFileName: 'export.xlsx' });
  const serialized = JSON.stringify(run.job);
  assert.equal(typeof run.job.sourceFileSha256, 'string');
  assert.equal(String(run.job.sourceFileSha256).length, 64);
  assert.equal(serialized.includes('PK'), false, 'no archive bytes in the job record');
  assert.equal(Object.hasOwn(run.job, 'sourceBytes'), false);
});

test('re-importing identical bytes creates no new job, item or record', async (t) => {
  const { cleanup } = harness();
  t.after(cleanup);

  const first = await runCatalogImport({ bytes: WORKBOOK, sourceFileName: 'export.xlsx' });
  const before = {
    jobs: await countOf('catalogImportJobs'),
    items: await countOf('catalogImportItems'),
    observations: await countOf('catalogSourceObservations'),
  };

  const second = await runCatalogImport({ bytes: WORKBOOK, sourceFileName: 'export.xlsx' });
  assert.equal(second.reused, true);
  assert.equal(second.job._id, first.job._id);
  assert.equal(await countOf('catalogImportJobs'), before.jobs);
  assert.equal(await countOf('catalogImportItems'), before.items);
  assert.equal(await countOf('catalogSourceObservations'), before.observations);
});

test('an explicit replay is a new job that remembers what it replays', async (t) => {
  const { cleanup } = harness();
  t.after(cleanup);

  const first = await runCatalogImport({ bytes: WORKBOOK, sourceFileName: 'export.xlsx' });
  const replay = await runCatalogImport({
    bytes: WORKBOOK,
    sourceFileName: 'export.xlsx',
    replay: true,
  });
  assert.equal(replay.reused, false);
  assert.notEqual(replay.job._id, first.job._id);
  assert.equal(replay.job.replayOfJobId, first.job._id);
  assert.equal(await countOf('catalogImportJobs'), 2);
  assert.equal(await countOf('catalogSourceObservations'), 77);
  for (const observation of await allOf('catalogSourceObservations')) {
    assert.equal(observation.firstSeenOperationId, first.job._id);
    assert.equal(observation.lastSeenOperationId, replay.job._id);
  }
});

test('RACE: two concurrent replays of the same file never collide on one attempt id', async (t) => {
  // startImportJob's replay branch used to find the next free attempt id by
  // reading, then writing -- two concurrent replays could both see attempt 1
  // as free before either one's write landed, and the second writer would
  // silently overwrite the first's job record. It now creates each attempt
  // id with a genuine create-if-absent, so this must always resolve to two
  // distinct jobs, whichever order the writes actually land in.
  const { cleanup } = harness();
  t.after(cleanup);

  await runCatalogImport({ bytes: WORKBOOK, sourceFileName: 'export.xlsx' });

  const [a, b] = await Promise.all([
    runCatalogImport({ bytes: WORKBOOK, sourceFileName: 'export.xlsx', replay: true }),
    runCatalogImport({ bytes: WORKBOOK, sourceFileName: 'export.xlsx', replay: true }),
  ]);

  assert.equal(a.reused, false);
  assert.equal(b.reused, false);
  assert.notEqual(a.job._id, b.job._id, 'a read-then-write race would let both land on attempt 1');
  assert.equal(await countOf('catalogImportJobs'), 3);
});

test('a workbook that cannot be read still leaves a failed job behind', async (t) => {
  const { cleanup } = harness();
  t.after(cleanup);

  const run = await runCatalogImport({
    bytes: Buffer.from('not a workbook', 'utf8'),
    sourceFileName: 'broken.xlsx',
  });
  assert.equal(run.job.status, 'failed');
  assert.ok(String(run.job.errorSummary).length > 0);
  assert.equal(await countOf('catalogImportItems'), 0);
});

// --- publication ------------------------------------------------------------

async function importAndPublish(limit: number) {
  const run = await runCatalogImport({ bytes: WORKBOOK, sourceFileName: 'export.xlsx' });
  const published = await publishImportedSample({ jobId: String(run.job._id), limit });
  return { run, published };
}

test('publishing a bounded sample writes products, variants and source links', async (t) => {
  const { cleanup } = harness();
  t.after(cleanup);

  const { published } = await importAndPublish(3);
  assert.equal(published.products, 3);
  assert.equal(published.variants, 24);
  assert.equal(published.sourceLinks, 24);
  assert.deepEqual(published.blocked, []);

  assert.equal(await countOf('products'), 3);
  assert.equal(await countOf('productVariants'), 24);

  const links = await allOf('catalogSourceLinks');
  const kinds = links.reduce<Record<string, number>>((acc, doc) => {
    const kind = String(doc.linkKind);
    acc[kind] = (acc[kind] ?? 0) + 1;
    return acc;
  }, {});
  assert.deepEqual(kinds, { group: 3, variant: 24, store: 24 });
});

test('imported products land unpublished, so nothing reaches the storefront unreviewed', async (t) => {
  const { cleanup } = harness();
  t.after(cleanup);
  await importAndPublish(2);
  for (const product of await allOf('products')) {
    assert.equal(product.published, false, `${String(product.name)} must not auto-publish`);
  }
});

test('publishing the same sample twice creates no duplicates', async (t) => {
  const { cleanup } = harness();
  t.after(cleanup);

  const { run } = await importAndPublish(3);
  const before = {
    products: await countOf('products'),
    variants: await countOf('productVariants'),
    links: await countOf('catalogSourceLinks'),
  };

  await publishImportedSample({ jobId: String(run.job._id), limit: 3 });
  assert.equal(await countOf('products'), before.products);
  assert.equal(await countOf('productVariants'), before.variants);
  assert.equal(await countOf('catalogSourceLinks'), before.links);
});

test('a Channel product keeps its own id, not a provider key', async (t) => {
  const { cleanup } = harness();
  t.after(cleanup);
  await importAndPublish(1);
  const [product] = await allOf('products');
  assert.ok(product);
  const id = String(product._id);
  assert.equal(id.includes('dianxiaomi'), false, 'Channel identity is not a provider key');
  assert.match(id, /^[0-9a-f-]{36}$/);
});

test('operator edits survive a repeat import', async (t) => {
  const { cleanup } = harness();
  t.after(cleanup);

  const { run } = await importAndPublish(2);
  const [product] = await allOf('products');
  assert.ok(product);
  const productId = String(product._id);

  // The operator rewrites the imported content, the way they would in admin.
  await updateDoc('products', productId, {
    name: 'Operator chosen name',
    description: 'Operator written description',
    productFamily: 'misc',
    imageIds: ['operator-image-1'],
  });

  const replay = await runCatalogImport({
    bytes: WORKBOOK,
    sourceFileName: 'export.xlsx',
    replay: true,
  });
  await publishImportedSample({ jobId: String(replay.job._id), limit: 2 });

  const after = await get('products', productId);
  assert.equal(after?.name, 'Operator chosen name');
  assert.equal(after?.description, 'Operator written description');
  assert.equal(after?.productFamily, 'misc');
  assert.deepEqual(after?.imageIds, ['operator-image-1']);
});

// --- inventory --------------------------------------------------------------

test('a SKU sold in two shops carries ONE exact quantity, not the sum', async (t) => {
  const { cleanup } = harness();
  t.after(cleanup);

  const run = await runCatalogImport({ bytes: WORKBOOK, sourceFileName: 'export.xlsx' });
  // The repeated SKUs live in the families that carry no marketplace id, so
  // publish enough of the catalog to reach one.
  await publishImportedSample({ jobId: String(run.job._id), limit: 25 });

  const variants = await allOf('productVariants');
  const shared = variants.filter(
    (variant) => Array.isArray(variant.inventorySnapshots) && variant.inventorySnapshots.length > 1,
  );
  assert.ok(shared.length > 0, 'expected at least one SKU listed in two shops');
  for (const variant of shared) {
    const snapshots = variant.inventorySnapshots as { quantity: number }[];
    const total = snapshots.reduce((sum, snapshot) => sum + snapshot.quantity, 0);
    assert.equal(variant.inventoryState, 'known');
    assert.equal(variant.inventoryQuantity, snapshots[0]?.quantity);
    assert.notEqual(variant.inventoryQuantity, total, 'the displayed count must not be the sum');
    assert.equal(snapshots.length > 1, true, 'every shop snapshot is preserved for review');
  }
});

test('source prices are stored as CNY minor units and never as a USD field', async (t) => {
  const { cleanup } = harness();
  t.after(cleanup);
  await importAndPublish(2);

  for (const variant of await allOf('productVariants')) {
    const price = variant.sourceRegularPrice as { amountMinor: number; currency: string };
    assert.equal(price.currency, 'CNY');
    assert.equal(Number.isSafeInteger(price.amountMinor), true);
  }
  for (const product of await allOf('products')) {
    assert.equal(product.unitPrice, undefined);
    assert.equal(product.wholesalePrice, undefined);
    assert.equal(product.vipPrice, undefined);
  }
});

// --- Alibaba isolation ------------------------------------------------------

test('no import write ever lands an alibaba field on a product', async (t) => {
  const { cleanup } = harness();
  t.after(cleanup);
  await importAndPublish(5);

  for (const product of await allOf('products')) {
    for (const key of Object.keys(product)) {
      assert.equal(key.startsWith('alibaba'), false, `${key} must not be written by the import`);
    }
  }
  for (const collection of ['productVariants', 'catalogSourceLinks', 'catalogImportItems']) {
    for (const doc of await allOf(collection)) {
      for (const key of Object.keys(doc)) {
        assert.equal(key.startsWith('alibaba'), false, `${collection}.${key}`);
      }
    }
  }
});

test('an existing Alibaba-linked product is left exactly as it was', async (t) => {
  const { cleanup } = harness();
  t.after(cleanup);

  const linked = {
    name: 'Existing linked product',
    productFamily: 'headphones',
    category: 'bluetooth',
    description: 'Pre-existing description',
    imageIds: ['img-1'],
    published: true,
    archived: false,
    alibabaPrimarySourceKey: 'abc123',
    alibabaSourceStatus: 'available',
    alibabaCatalogPricing: { schemaVersion: '1', source: 'alibaba', mode: 'fixed' },
  };
  await upsertDocWithId('products', 'pre-existing-alibaba', linked);
  const before = JSON.stringify(await get('products', 'pre-existing-alibaba'));

  await importAndPublish(5);

  const after = JSON.stringify(await get('products', 'pre-existing-alibaba'));
  assert.equal(after, before, 'the Alibaba-linked product must be byte-identical afterwards');
});

test('an existing unlinked product is left exactly as it was', async (t) => {
  const { cleanup } = harness();
  t.after(cleanup);

  await upsertDocWithId('products', 'pre-existing-plain', {
    name: 'Hand-entered product',
    productFamily: 'toys',
    description: 'Written by a person',
    imageIds: ['img-9'],
    published: true,
    archived: false,
  });
  const before = JSON.stringify(await get('products', 'pre-existing-plain'));
  await importAndPublish(5);
  assert.equal(JSON.stringify(await get('products', 'pre-existing-plain')), before);
});

// --- delta ------------------------------------------------------------------

test('the first import against an empty catalog is all additions', async (t) => {
  const { cleanup } = harness();
  t.after(cleanup);

  const run = await runCatalogImport({ bytes: WORKBOOK, sourceFileName: 'export.xlsx' });
  const delta = await computeImportDelta(run.detail);
  assert.equal(delta.added.length, 312);
  assert.equal(delta.changed.length, 0);
  assert.equal(delta.sourceMissing.length, 0);
  assert.equal(delta.completeSource, true);
});

test('a repeat import reports only the source-owned fields that moved', async (t) => {
  const { cleanup } = harness();
  t.after(cleanup);

  const { run } = await importAndPublish(3);
  const unchanged = await computeImportDelta(run.detail);
  assert.equal(unchanged.changed.length, 0);
  assert.equal(unchanged.unchanged.length, 24);

  const changedRun = await runCatalogImport({
    bytes: CHANGED,
    sourceFileName: 'export-2.xlsx',
  });
  const delta = await computeImportDelta(changedRun.detail);
  assert.ok(delta.changed.length > 0);
  const fields = new Set(delta.changed.flatMap((entry) => entry.changes.map((c) => c.field)));
  assert.ok(fields.has('sourceRegularPrice'));
  assert.ok(fields.has('quantity'));
  // A SKU dropped from the export is reported, never deleted.
  assert.equal(delta.sourceMissing.length, 1);
  assert.equal(await countOf('products'), 3, 'nothing was removed from the catalog');
});

test('a workbook that cannot be read never marks anything source-missing', async (t) => {
  const { cleanup } = harness();
  t.after(cleanup);

  await importAndPublish(3);
  const broken = await runCatalogImport({
    bytes: Buffer.from('truncated garbage', 'utf8'),
    sourceFileName: 'broken.xlsx',
  });
  const delta = await computeImportDelta(broken.detail);
  assert.equal(delta.completeSource, false);
  assert.deepEqual(delta.sourceMissing, [], 'an unreadable file proves nothing about absence');
});

// --- local media proof ------------------------------------------------------

const JPEG_A = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(128, 11)]);
const JPEG_B = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(128, 22)]);

function fetched(bytes: Buffer) {
  return {
    ok: true as const,
    bytes,
    mimeType: 'image/jpeg' as const,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    finalUrl: 'https://cdn.example/a.jpg',
    dimensions: { width: 200, height: 100 },
  };
}

test('a migrated image lands on disk as an active images record', async (t) => {
  const { dir, cleanup } = harness();
  t.after(cleanup);

  const seen = new Map<string, string>();
  const migrated = await migrateImageLocally(fetched(JPEG_A), 'P-001 primary', seen);
  assert.equal(migrated.reused, false);

  const doc = await get('images', migrated.imageId);
  assert.equal(doc?.status, 'active');
  assert.equal(doc?.mimeType, 'image/jpeg');
  assert.equal(doc?.purpose, 'catalog-image');
  assert.equal(doc?.storageProvider, 'local-disk');
  assert.equal(doc?.byteSize, JPEG_A.length);
  assert.equal(doc?.publishedRefCount, 0);
  assert.equal(String(doc?.checksumSha256).length, 64);
  assert.ok(readdirSync(join(dir, 'media')).length > 0, 'bytes were written to the media dir');
});

test('identical bytes behind two URLs are stored once', async (t) => {
  const { cleanup } = harness();
  t.after(cleanup);

  const seen = new Map<string, string>();
  const first = await migrateImageLocally(fetched(JPEG_A), 'a', seen);
  const again = await migrateImageLocally(fetched(JPEG_A), 'b', seen);
  const other = await migrateImageLocally(fetched(JPEG_B), 'c', seen);

  assert.equal(again.reused, true);
  assert.equal(again.imageId, first.imageId);
  assert.equal(other.reused, false);
  assert.notEqual(other.imageId, first.imageId);
  assert.equal(await countOf('images'), 2);
});

test('an unreachable image costs its own image and nothing else', async (t) => {
  const { cleanup } = harness();
  t.after(cleanup);

  // The acceptance fixture points at a domain that does not resolve, which is
  // exactly the failure this must absorb.
  const run = await runCatalogImport({ bytes: WORKBOOK, sourceFileName: 'export.xlsx' });
  const published = await publishImportedSample({
    jobId: String(run.job._id),
    limit: 2,
    fetchImages: 3,
  });
  assert.equal(published.imagesFailed, 3);
  assert.equal(published.imagesMigrated, 0);
  assert.equal(published.products, 2, 'the products still imported');
  assert.equal(published.variants > 0, true);
});
