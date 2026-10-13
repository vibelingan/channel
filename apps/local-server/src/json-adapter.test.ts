import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  type CatalogProductSaveResult,
  get,
  saveCatalogProductWithIdentities,
  setAdapter,
} from '@vibelingan-channel/db';
import { catalogApprovalDigest } from '@vibelingan-channel/db/catalog-detail-commit';
import { prepareStagedApproval } from '@vibelingan-channel/db/catalog-detail-staging';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { JsonFileAdapter } from './json-adapter.ts';

function temporaryDatabase(): { directory: string; file: string } {
  const directory = mkdtempSync(join(tmpdir(), 'channel-catalog-identities-'));
  return { directory, file: join(directory, 'db.json') };
}

function readStore(file: string): Record<string, CollectionDoc[]> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, CollectionDoc[]>;
}

test('classification queue filters before pagination and a saved assignment survives reopen without publishing', async (t) => {
  const { directory, file } = temporaryDatabase();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(
    file,
    JSON.stringify({
      products: [
        { _id: 'clock-a', name: 'Clock A', published: false },
        { _id: 'clock-b', name: 'Clock B', published: false },
        { _id: 'legacy', name: 'Headphones', category: 'wired' },
        { _id: 'toy', name: 'Toy', productFamily: 'toys' },
      ],
    }),
  );
  const adapter = new JsonFileAdapter(file);
  const query = {
    collection: 'products',
    needsClassification: true,
    page: 2,
    pageSize: 1,
    search: '',
    sort: [{ field: '_id', dir: 'asc' as const }],
  };
  const result = await adapter.list(query);
  assert.equal(result.total, 2);
  assert.equal(result.items[0]?._id, 'clock-b');
  setAdapter(adapter);
  const saved = await saveCatalogProductWithIdentities({
    mode: 'update',
    productId: 'clock-b',
    data: { productFamily: 'misc' },
  });
  assert.equal(saved.result, 'saved');
  const reopened = new JsonFileAdapter(file);
  assert.equal((await reopened.list({ ...query, page: 1 })).total, 1);
  assert.equal((await reopened.get('products', 'clock-b'))?.productFamily, 'misc');
  assert.equal((await reopened.get('products', 'clock-b'))?.published, false);
});

test('subcategory scope is ANDed with an OR filter before counting and pagination', async (t) => {
  const { directory, file } = temporaryDatabase();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(
    file,
    JSON.stringify({
      products: [
        { _id: 'a', name: 'Blocks A', productFamily: 'toys', subcategoryIds: ['toys-blocks'] },
        { _id: 'b', name: 'Blocks B', productFamily: 'toys', subcategoryIds: ['toys-blocks'] },
        { _id: 'c', name: 'Dolls C', productFamily: 'toys', subcategoryIds: ['toys-dolls'] },
        { _id: 'd', name: 'Blocks misc', productFamily: 'misc', subcategoryIds: ['toys-blocks'] },
      ],
    }),
  );
  const adapter = new JsonFileAdapter(file);
  const result = await adapter.list({
    collection: 'products',
    productFamily: 'toys',
    productSubcategories: {
      family: 'toys',
      ids: ['toys-blocks'],
      knownIds: ['toys-blocks', 'toys-dolls'],
    },
    filter: {
      combinator: 'or',
      clauses: [
        { field: 'name', op: 'contains', value: 'Blocks' },
        { field: 'name', op: 'contains', value: 'Dolls' },
      ],
    },
    page: 2,
    pageSize: 1,
    search: '',
    sort: [{ field: '_id', dir: 'asc' }],
  });
  assert.equal(result.total, 2);
  assert.deepEqual(
    result.items.map((item) => item._id),
    ['b'],
  );
});

test('RACE: JsonFileAdapter persists exactly one owner for a shared slug and SKU', async (t) => {
  const { directory, file } = temporaryDatabase();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  setAdapter(new JsonFileAdapter(file));

  const results = await Promise.all([
    saveCatalogProductWithIdentities({
      mode: 'create',
      productId: 'product-a',
      data: { name: 'A', slug: 'Desk Lamp', skuCode: 'SKU-100' },
    }),
    saveCatalogProductWithIdentities({
      mode: 'create',
      productId: 'product-b',
      data: { name: 'B', slug: 'desk-lamp', skuCode: 'sku-100' },
    }),
  ]);

  assert.equal(results.filter((result) => result.result === 'saved').length, 1);
  assert.equal(results.filter((result) => result.result === 'conflict').length, 1);
  const persisted = readStore(file);
  assert.equal(persisted.products?.length, 1);
  const owner = persisted.products?.[0]?._id;
  assert.deepEqual(
    persisted.catalogProductIdentities?.map((doc) => [doc._id, doc.productId]).sort(),
    [
      ['sku:sku-100', owner],
      ['slug:desk-lamp', owner],
    ],
  );

  setAdapter(new JsonFileAdapter(file));
  assert.equal((await get('products', String(owner)))?._id, owner);
});

test('JsonFileAdapter update transfers identities and survives a reopened read', async (t) => {
  const { directory, file } = temporaryDatabase();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  setAdapter(new JsonFileAdapter(file));
  await saveCatalogProductWithIdentities({
    mode: 'create',
    productId: 'product-a',
    data: { name: 'A', description: 'Keep me', slug: 'desk-lamp', skuCode: 'sku-100' },
  });
  const saved = await saveCatalogProductWithIdentities({
    mode: 'update',
    productId: 'product-a',
    data: { slug: 'table-lamp', skuCode: 'sku-200' },
  });
  assert.equal(saved.result, 'saved');

  setAdapter(new JsonFileAdapter(file));
  const reread = await get('products', 'product-a');
  assert.deepEqual(reread, saved.result === 'saved' ? saved.doc : null);
  assert.equal(reread?.description, 'Keep me');
  assert.deepEqual(
    readStore(file)
      .catalogProductIdentities?.map((doc) => doc._id)
      .sort(),
    ['sku:sku-200', 'slug:table-lamp'],
  );
});

test('legacy update releases each valid old identity and persists a real createdAt', async (t) => {
  const { directory, file } = temporaryDatabase();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(
    file,
    JSON.stringify({
      products: [
        {
          _id: 'legacy-product',
          name: 'Legacy',
          slug: 'old-slug',
          skuCode: 42,
          createdAt: null,
        },
      ],
      catalogProductIdentities: [
        {
          _id: 'slug:old-slug',
          kind: 'slug',
          normalizedValue: 'old-slug',
          productId: 'legacy-product',
        },
      ],
    }),
    'utf8',
  );
  setAdapter(new JsonFileAdapter(file));

  const saved = await saveCatalogProductWithIdentities({
    mode: 'update',
    productId: 'legacy-product',
    data: { slug: 'new-slug', skuCode: 'sku-200' },
  });
  assert.equal(saved.result, 'saved');
  const persisted = readStore(file);
  assert.equal(typeof persisted.products?.[0]?.createdAt, 'string');
  assert.deepEqual(persisted.catalogProductIdentities?.map((doc) => doc._id).sort(), [
    'sku:sku-200',
    'slug:new-slug',
  ]);
});

test('conflict, corrupt reservation, and malformed facade input produce no writes', async (t) => {
  const { directory, file } = temporaryDatabase();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(
    file,
    JSON.stringify({
      products: [],
      catalogProductIdentities: [
        { _id: 'slug:taken', kind: 'slug', normalizedValue: 'taken', productId: 'other' },
        { _id: 'sku:corrupt', kind: 'slug', normalizedValue: 'wrong', productId: 'product-a' },
      ],
    }),
    'utf8',
  );
  setAdapter(new JsonFileAdapter(file));
  const before = readFileSync(file, 'utf8');

  assert.equal(
    (
      await saveCatalogProductWithIdentities({
        mode: 'create',
        productId: 'product-a',
        data: { slug: 'taken', skuCode: 'free' },
      })
    ).result,
    'conflict',
  );
  assert.equal(
    (
      await saveCatalogProductWithIdentities({
        mode: 'create',
        productId: 'product-a',
        data: { slug: 'free', skuCode: 'corrupt' },
      })
    ).result,
    'conflict',
  );
  assert.throws(
    () =>
      saveCatalogProductWithIdentities({
        mode: 'delete',
        productId: 'product-a',
        data: {},
      } as never),
    /invalid catalog product save input/i,
  );
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('RACE: concurrent archive and publish cannot persist an archived published product', async (t) => {
  const { directory, file } = temporaryDatabase();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  setAdapter(new JsonFileAdapter(file));
  await saveCatalogProductWithIdentities({
    mode: 'create',
    productId: 'product-race',
    data: {
      name: 'Race Product',
      productFamily: 'toys',
      slug: 'race-product',
      skuCode: 'race-100',
      description: 'Complete product.',
      imageIds: ['image-1'],
      published: true,
    },
  });

  const results = await Promise.all([
    saveCatalogProductWithIdentities({
      mode: 'update',
      productId: 'product-race',
      data: { archived: true },
    }),
    saveCatalogProductWithIdentities({
      mode: 'update',
      productId: 'product-race',
      data: { published: true },
    }),
  ]);
  assert.ok(results.some((result) => result.result === 'saved'));
  const persisted = readStore(file).products?.[0];
  assert.equal(persisted?.archived, true);
  assert.equal(persisted?.published, false);
});

test('legacy missing archived plus submitted false remains published', async (t) => {
  const { directory, file } = temporaryDatabase();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(
    file,
    JSON.stringify({
      products: [
        {
          _id: 'legacy-published',
          name: 'Legacy Published',
          productFamily: 'headphones',
          slug: 'legacy-published',
          skuCode: 'legacy-100',
          description: 'Complete legacy product.',
          imageIds: ['image-1'],
          published: true,
        },
      ],
      catalogProductIdentities: [
        {
          _id: 'slug:legacy-published',
          kind: 'slug',
          normalizedValue: 'legacy-published',
          productId: 'legacy-published',
        },
        {
          _id: 'sku:legacy-100',
          kind: 'sku',
          normalizedValue: 'legacy-100',
          productId: 'legacy-published',
        },
      ],
    }),
    'utf8',
  );
  setAdapter(new JsonFileAdapter(file));
  const result = await saveCatalogProductWithIdentities({
    mode: 'update',
    productId: 'legacy-published',
    data: { name: 'Edited', archived: false },
  });
  assert.equal(result.result, 'saved');
  assert.equal(readStore(file).products?.[0]?.published, true);
});

test('RACE: duplicate publish returns one authoritative unpublished previous row', async (t) => {
  const { directory, file } = temporaryDatabase();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  setAdapter(new JsonFileAdapter(file));
  await saveCatalogProductWithIdentities({
    mode: 'create',
    productId: 'product-publish',
    data: {
      name: 'Publish Product',
      productFamily: 'toys',
      slug: 'publish-product',
      skuCode: 'publish-100',
      description: 'Complete product.',
      imageIds: ['image-1'],
      published: false,
    },
  });

  const results = await Promise.all([
    saveCatalogProductWithIdentities({
      mode: 'update',
      productId: 'product-publish',
      data: { published: true },
    }),
    saveCatalogProductWithIdentities({
      mode: 'update',
      productId: 'product-publish',
      data: { published: true },
    }),
  ]);
  const saved = results.filter(
    (result): result is Extract<CatalogProductSaveResult, { result: 'saved' }> =>
      result.result === 'saved',
  );
  assert.equal(saved.length, 2);
  assert.equal(saved.filter((result) => result.previous?.published === false).length, 1);
  assert.equal(saved.filter((result) => result.previous?.published === true).length, 1);
});

for (const writer of ['fenced-upsert', 'fenced-tombstone', 'generic-upsert'] as const) {
  test(`source generation and preparation invalidation share the JSON commit: ${writer}`, async (t) => {
    const { directory, file } = temporaryDatabase();
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const at = '2026-10-13T00:00:00.000Z';
    const source = {
      _id: 'observation',
      provider: 'alibaba',
      sourceProductKey: 'source-a',
      observedAt: at,
      active: true,
      observation: {
        source: { provider: 'alibaba', sourceProductKey: 'source-a', observedAt: at },
        identity: { title: 'Before' },
      },
    };
    writeFileSync(
      file,
      JSON.stringify({
        alibabaSyncLeases: [
          {
            _id: 'primary',
            holder: 'holder',
            fence: 1,
            acquiredAt: at,
            heartbeatAt: at,
            expiresAt: '2026-10-13T00:03:00.000Z',
            releasedAt: '',
          },
        ],
        catalogSourceObservations: [source],
        alibabaProductLinks: [{ _id: 'source-a', sourceKey: 'source-a', productId: 'product' }],
        products: [
          {
            _id: 'product',
            name: 'Website',
            alibabaPrimarySourceKey: 'source-a',
            detailSourceReady: true,
            published: true,
            productFamily: 'misc',
            catalogDetailPublication: { revision: 'old-approved' },
          },
        ],
      }),
    );
    const adapter = new JsonFileAdapter(file);
    const guard = { connectionId: 'primary', holder: 'holder', fence: 1, now: at };
    const patch = {
      ...source,
      observation: { ...source.observation, identity: { title: 'After' } },
    };
    if (writer === 'fenced-upsert')
      await adapter.upsertDocWithAlibabaLease(
        'catalogSourceObservations',
        source._id,
        patch,
        {},
        guard,
      );
    else if (writer === 'fenced-tombstone')
      await adapter.updateDocWithAlibabaLease(
        'catalogSourceObservations',
        source._id,
        { active: false },
        guard,
      );
    else await adapter.upsertCatalogSourceObservation(source._id, patch, {});
    const stored = readStore(file).products?.[0];
    assert.equal(stored?.detailSourceReady, false);
    assert.equal(stored?.catalogContentGeneration, 1);
    assert.equal(stored?.published, true);
    assert.equal(stored?.productFamily, 'misc');
    assert.deepEqual(stored?.catalogDetailPublication, { revision: 'old-approved' });
  });
}

for (const sourceFirst of [true, false]) {
  test(`two JSON adapter instances serialize source invalidation against approval finish (sourceFirst=${sourceFirst})`, async (t) => {
    const { directory, file } = temporaryDatabase();
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const at = '2026-10-13T00:00:00.000Z';
    const header = {
      schemaVersion: 'catalog-product-detail-v1',
      _id: 'p',
      name: 'Clock',
      images: ['/api/images/image'],
      facts: [],
      offers: [],
    };
    const product = {
      _id: 'p',
      name: 'Clock',
      description: 'Website description',
      imageIds: ['image'],
      productFamily: 'misc',
      published: true,
      archived: false,
      alibabaPrimarySourceKey: 'key',
      catalogContentGeneration: 1,
      detailSourceContentGeneration: 1,
      detailSourceReady: true,
      detailSourceOwner: 'alibaba:key',
      detailSourceRevision: 'source-r1',
      detailSourceCandidate: header,
      detailSourceManifest: { revision: 'source-r1', variantIds: [] },
      catalogDetailPublication: { state: 'approved', revision: 'old', header, variantCount: 0 },
    };
    const observation = {
      _id: 'obs',
      provider: 'alibaba',
      sourceProductKey: 'key',
      observedAt: at,
      active: true,
      observation: {
        source: { provider: 'alibaba', sourceProductKey: 'key', observedAt: at },
        identity: { title: 'Before' },
      },
    };
    writeFileSync(
      file,
      JSON.stringify({
        users: [{ _id: 'admin', role: 'admin' }],
        products: [product],
        images: [
          {
            _id: 'image',
            status: 'active',
            storageProvider: 'cloudbase-storage',
            publishedRefCount: 1,
          },
        ],
        catalogSourceObservations: [observation],
        alibabaProductLinks: [{ _id: 'key', sourceKey: 'key', productId: 'p' }],
      }),
    );
    const approval = new JsonFileAdapter(file);
    const writer = new JsonFileAdapter(file);
    const prepared = prepareStagedApproval(
      'admin',
      {
        productId: 'p',
        operationId: '12345678-1234-4234-8234-123456789012',
        expectedRevision: 'old',
        expectedDigest: catalogApprovalDigest(product, []),
      },
      product,
      [],
    );
    assert.ok(prepared.ok);
    assert.equal(
      (
        await approval.persistCatalogDetailApproval('admin', {
          action: 'begin',
          prepared: prepared.value,
        })
      ).ok,
      true,
    );
    const sourceWrite = () =>
      writer.upsertCatalogSourceObservation(
        'obs',
        {
          ...observation,
          observation: { ...observation.observation, identity: { title: 'After' } },
        },
        {},
      );
    const finish = () =>
      approval.persistCatalogDetailApproval('admin', {
        action: 'finish',
        jobId: prepared.value._id,
      });
    const tasks = sourceFirst ? [sourceWrite(), finish()] : [finish(), sourceWrite()];
    const results = await Promise.allSettled(tasks);
    assert.ok(results.every((result) => result.status === 'fulfilled'));
    const result = results[sourceFirst ? 1 : 0];
    assert.ok(result?.status === 'fulfilled');
    assert.equal(Reflect.get(result.value, 'ok'), !sourceFirst);
    const saved = await writer.get('products', 'p');
    assert.equal(saved?.catalogContentGeneration, 2);
    assert.equal(saved?.detailSourceReady, false);
    assert.equal(saved?.published, true);
    assert.equal((await writer.get('images', 'image'))?.publishedRefCount, 1);
    const publication = saved?.catalogDetailPublication as { revision: string };
    if (sourceFirst) assert.equal(publication.revision, 'old');
    else assert.equal(publication.revision, prepared.value.revision);
  });
}

for (const storedRevision of [undefined, null]) {
  test(`two actual adapters cannot both save from the same legacy editor snapshot (${storedRevision})`, async (t) => {
    const { directory, file } = temporaryDatabase();
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    writeFileSync(
      file,
      JSON.stringify({
        products: [
          { _id: 'legacy-editor', name: 'Before', published: false, updatedAt: storedRevision },
        ],
      }),
    );
    const first = new JsonFileAdapter(file);
    const second = new JsonFileAdapter(file);
    const attempts = await Promise.allSettled(
      [first, second].map((adapter, i) =>
        adapter.saveCatalogProductWithIdentities({
          mode: 'update',
          productId: 'legacy-editor',
          expectedUpdatedAt: null,
          data: { name: `Editor ${i}` },
        }),
      ),
    );
    assert.equal(attempts.filter((result) => result.status === 'rejected').length, 0);
    const outcomes = attempts.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value.result] : [],
    );
    assert.equal(outcomes.filter((result) => result === 'saved').length, 1);
    assert.equal(outcomes.filter((result) => result === 'stale').length, 1);
    const saved = readStore(file).products?.find((doc) => doc._id === 'legacy-editor');
    assert.match(String(saved?.name), /^Editor [01]$/);
    assert.equal(typeof saved?.updatedAt, 'string');
  });
}
