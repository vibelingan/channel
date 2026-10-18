import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setAdapter } from '@vibelingan-channel/db';
import { setMediaStorage } from '@vibelingan-channel/media-storage';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import {
  buildCatalogImageReferencePlan,
  catalogImageReferenceEntry,
} from '../../../../packages/db/src/catalog-image-references.ts';
import { LocalDiskMediaStorage } from '../../../../packages/media-storage/src/local-disk.ts';
import { JsonFileAdapter } from '../../../local-server/src/json-adapter.ts';
import { handlePublicApiEvent } from './http-adapter.ts';

const bytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABgAAAAQCAYAAAAMJL+VAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAJUlEQVQ4jWMQMglroCVmGLVAaDSIhEZTkdBoRjMZLSpMBnlpCgCQpqoQR9aKMgAAAABJRU5ErkJggg==',
  'base64',
);
type Provider = 'legacy-base64' | 'local-disk' | 'cloudbase-storage';
async function fixture(
  t: { after(callback: () => void): void },
  provider: Provider,
  base: number,
  changes: Array<{ delta: 1 | -1; committed: boolean }>,
) {
  const directory = mkdtempSync(join(tmpdir(), 'channel-reference-delivery-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'db.json');
  const storage = new LocalDiskMediaStorage(join(directory, 'media'));
  const stored = await storage.putObject({
    namespace: 'smoke',
    logicalId: 'image',
    fileName: 'reference.png',
    mimeType: 'image/png',
    content: bytes,
  });
  let storageReads = 0;
  const readBytes = storage.getObjectAsBase64.bind(storage);
  storage.getObjectAsBase64 = async (...args) => {
    storageReads++;
    return readBytes(...args);
  };
  setMediaStorage(storage);
  const plans = changes.map(({ delta }, index) =>
    buildCatalogImageReferencePlan(
      (index + 1).toString(16).padStart(64, '0'),
      delta === -1 ? ['image'] : [],
      delta === 1 ? ['image'] : [],
    ),
  );
  const image: CollectionDoc = {
    _id: 'image',
    storageProvider: provider,
    storageFileId: stored.storageFileId,
    status: 'active',
    mimeType: 'image/png',
    data: bytes.toString('base64'),
    publishedRefCount: base,
    catalogPublishedReferenceLedger: {
      version: 'catalog-image-reference-ledger-v1',
      epoch: 0,
      pending: plans.map((plan) => catalogImageReferenceEntry(plan, 0)),
    },
  };
  const rows: Record<string, CollectionDoc[]> = {
    images: [image],
    catalogDetailApprovals: plans
      .filter((_, index) => changes[index]?.committed)
      .map((plan) => plan.proof),
    products: [{ _id: 'legacy-public', published: true, imageIds: ['image'] }],
  };
  const save = () => writeFileSync(file, JSON.stringify(rows));
  save();
  const adapter = new JsonFileAdapter(file);
  let snapshotReads = 0;
  let listReads = 0;
  const referenceRead = adapter.readCatalogImageReference.bind(adapter);
  adapter.readCatalogImageReference = async (input) => {
    snapshotReads++;
    return referenceRead(input);
  };
  const list = adapter.list.bind(adapter);
  adapter.list = async (input) => {
    listReads++;
    return list(input);
  };
  setAdapter(adapter);
  return {
    adapter,
    image,
    rows,
    plans,
    save,
    file,
    storageReads: () => storageReads,
    snapshotReads: () => snapshotReads,
    listReads: () => listReads,
    bytes: () => readFileSync(file, 'utf8'),
  };
}
const request = (imageId = 'image') =>
  handlePublicApiEvent({ httpMethod: 'GET', path: `/api/images/${imageId}` }, {});

for (const provider of ['legacy-base64', 'local-disk', 'cloudbase-storage'] as const)
  for (const state of [
    'committed-add',
    'committed-remove',
    'pending-add',
    'pending-remove',
  ] as const)
    test(`public ${provider} obeys ${state} proof truth and never settles on read`, async (t) => {
      const delta = state.endsWith('add') ? 1 : -1;
      const base = delta === 1 ? 0 : 1;
      const committed = state.startsWith('committed');
      const h = await fixture(t, provider, base, [{ delta, committed }]);
      const before = h.bytes();
      utimesSync(h.file, new Date(1000), new Date(1000));
      const response = await request();
      const visible = base + (committed ? delta : 0) > 0;
      assert.equal(response.statusCode, visible ? 200 : 404, response.body);
      assert.equal(h.snapshotReads(), 1);
      assert.equal(h.listReads(), 0);
      assert.equal(h.storageReads(), visible && provider !== 'legacy-base64' ? 1 : 0);
      assert.equal(h.bytes(), before);
      assert.equal(statSync(h.file).mtimeMs, 1000);
      if (visible) {
        assert.equal(response.isBase64Encoded, true);
        assert.equal(response.body, bytes.toString('base64'));
        assert.equal(response.headers['Content-Type'], 'image/png');
        assert.equal(response.headers['X-Content-Type-Options'], 'nosniff');
        assert.equal(response.headers['Content-Security-Policy'], "default-src 'none'; sandbox");
      }
      for (const secret of [
        'catalogPublishedReferenceLedger',
        'catalog-image-reference',
        'treeRoot',
        'storageFileId',
        'local-disk:',
      ])
        assert.equal(response.body.includes(secret), false);
    });

for (const count of [3, 80])
  test(`public reference delivery adopts all${count} committed shared references`, async (t) => {
    const h = await fixture(
      t,
      'local-disk',
      0,
      Array.from({ length: count }, () => ({ delta: 1, committed: true })),
    );
    const before = h.bytes();
    const response = await request();
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(h.storageReads(), 1);
    assert.equal(h.listReads(), 0);
    assert.equal(h.bytes(), before);
  });

for (const damage of [
  'ledger',
  'proof',
  'counter',
  'missing-counter',
  'unavailable-adapter',
  'failed-read',
] as const)
  test(`public references refuse ${damage} without raw-counter or legacy fallback`, async (t) => {
    t.mock.method(console, 'error', () => {});
    const h = await fixture(t, 'legacy-base64', 1, [{ delta: -1, committed: false }]);
    if (damage === 'ledger') h.image.catalogPublishedReferenceLedger = null;
    if (damage === 'counter') h.image.publishedRefCount = '1';
    if (damage === 'missing-counter') Reflect.deleteProperty(h.image, 'publishedRefCount');
    if (damage === 'proof') {
      const proof = h.rows.catalogDetailApprovals;
      assert.ok(proof);
      const plan = h.plans[0];
      assert.ok(plan);
      proof.push({ ...plan.proof, treeRoot: 'b'.repeat(64) });
    }
    h.save();
    if (damage === 'unavailable-adapter')
      Reflect.set(h.adapter, 'readCatalogImageReference', undefined);
    if (damage === 'failed-read')
      h.adapter.readCatalogImageReference = async () => {
        throw Error('private storage URL must not reach HTTP');
      };
    const before = h.bytes();
    const response = await request();
    assert.equal(response.statusCode, 404, response.body);
    assert.equal(h.listReads(), 0);
    assert.equal(h.storageReads(), 0);
    assert.equal(h.bytes(), before);
    assert.equal(response.body.includes('private storage URL'), false);
  });

test('ordinary counted images keep their one-get fast path with zero reference transactions', async (t) => {
  const h = await fixture(t, 'local-disk', 1, []);
  Reflect.deleteProperty(h.image, 'catalogPublishedReferenceLedger');
  h.save();
  h.adapter.readCatalogImageReference = async () => {
    throw Error('no transaction expected');
  };
  const response = await request();
  assert.equal(response.statusCode, 200);
  assert.equal(h.snapshotReads(), 0);
  assert.equal(h.listReads(), 0);
  assert.equal(h.storageReads(), 1);
});

test('legacy counter absence still scans published catalogs only when no ledger exists', async (t) => {
  const h = await fixture(t, 'legacy-base64', 0, []);
  Reflect.deleteProperty(h.image, 'publishedRefCount');
  Reflect.deleteProperty(h.image, 'catalogPublishedReferenceLedger');
  h.save();
  const response = await request();
  assert.equal(response.statusCode, 200);
  assert.ok(h.listReads() > 0);
  assert.equal(h.snapshotReads(), 0);
});

test('explicit placeholder remains public and never reads its corrupt ledger', async (t) => {
  const h = await fixture(t, 'legacy-base64', 0, []);
  h.image._id = '_placeholder';
  h.image.catalogPublishedReferenceLedger = null;
  h.save();
  const response = await request('_placeholder');
  assert.equal(response.statusCode, 200);
  assert.equal(h.snapshotReads(), 0);
});

test('delivery uses snapshot status instead of the earlier image status', async (t) => {
  const h = await fixture(t, 'local-disk', 0, [{ delta: 1, committed: true }]);
  const get = h.adapter.get.bind(h.adapter);
  let changed = false;
  h.adapter.get = async (collection, id) => {
    const value = await get(collection, id);
    if (collection === 'images' && !changed) {
      changed = true;
      h.image.status = 'deleted';
      h.save();
    }
    return value;
  };
  const response = await request();
  assert.equal(response.statusCode, 404, response.body);
  assert.equal(h.storageReads(), 0);
  assert.equal(h.snapshotReads(), 1);
});

for (const count of [0, 1])
  test(`a validated empty ledger with count${count} keeps the one-get fast path`, async (t) => {
    const h = await fixture(t, 'local-disk', count, []);
    let transactions = 0;
    h.adapter.readCatalogImageReference = async () => {
      transactions++;
      throw Error('empty ledger needs no proof transaction');
    };
    const before = h.bytes();
    const response = await request();
    assert.equal(response.statusCode, count > 0 ? 200 : 404, response.body);
    assert.equal(transactions, 0);
    assert.equal(h.storageReads(), count > 0 ? 1 : 0);
    assert.equal(h.bytes(), before);
  });

for (const damage of ['epoch', 'version', 'extra'] as const)
  test(`a malformed empty ${damage} ledger cannot use the public fast path`, async (t) => {
    t.mock.method(console, 'error', () => {});
    const h = await fixture(t, 'local-disk', 1, []);
    const ledger = h.image.catalogPublishedReferenceLedger;
    assert.ok(ledger && typeof ledger === 'object');
    Reflect.set(
      ledger,
      damage === 'epoch' ? 'epoch' : damage === 'version' ? 'version' : 'extra',
      damage === 'epoch' ? -1 : 'bad',
    );
    h.save();
    const response = await request();
    assert.equal(response.statusCode, 404);
    assert.equal(h.storageReads(), 0);
    assert.equal(h.listReads(), 0);
  });

for (const damage of [
  'wrong-id',
  'legacy-state',
  'settled-read',
  'fraction',
  'negative',
  'nan',
  'infinity',
  'numeric-string',
] as const)
  test(`public delivery refuses malformed snapshot ${damage} before reading any bytes`, async (t) => {
    const h = await fixture(t, 'local-disk', 1, [{ delta: 1, committed: false }]);
    const read = h.adapter.readCatalogImageReference.bind(h.adapter);
    Reflect.set(
      h.adapter,
      'readCatalogImageReference',
      async (input: Parameters<typeof read>[0]) => {
        const snapshot = await read(input);
        assert.ok(snapshot.state === 'counted');
        if (damage === 'wrong-id')
          return { ...snapshot, image: { ...snapshot.image, _id: 'another-image' } };
        if (damage === 'legacy-state') return { ...snapshot, state: 'legacy' };
        if (damage === 'settled-read') return { ...snapshot, settled: true };
        const value =
          damage === 'fraction'
            ? 1.5
            : damage === 'negative'
              ? -1
              : damage === 'nan'
                ? Number.NaN
                : damage === 'infinity'
                  ? Number.POSITIVE_INFINITY
                  : '1';
        return { ...snapshot, effectiveCount: value };
      },
    );
    const before = h.bytes();
    const response = await request();
    assert.equal(response.statusCode, 404, response.body);
    assert.equal(h.storageReads(), 0);
    assert.equal(h.listReads(), 0);
    assert.equal(h.bytes(), before);
  });

test('public snapshot failures log only a safe code and opaque image id', async (t) => {
  const logs: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => {
    logs.push(args);
  });
  const h = await fixture(t, 'local-disk', 1, [{ delta: 1, committed: false }]);
  h.adapter.readCatalogImageReference = async () => {
    throw Object.assign(Error('private signed storage URL and token'), {
      code: 'https://private.invalid/token',
    });
  };
  const response = await request();
  assert.equal(response.statusCode, 404);
  assert.equal(h.storageReads(), 0);
  assert.deepEqual(logs, [
    [
      '[fn-public-api] image reference snapshot unavailable',
      { imageId: 'image', code: 'UNAVAILABLE' },
    ],
  ]);
  assert.equal(JSON.stringify(logs).includes('private.invalid'), false);
  assert.equal(response.body.includes('private'), false);
});

test('public delivery takes the fresh snapshot body along with its effective count', async (t) => {
  const h = await fixture(t, 'legacy-base64', 0, [{ delta: 1, committed: true }]);
  const get = h.adapter.get.bind(h.adapter);
  let changed = false;
  const fresh = Buffer.from('fresh owned bytes').toString('base64');
  h.adapter.get = async (collection, id) => {
    const value = await get(collection, id);
    if (collection === 'images' && !changed) {
      changed = true;
      h.image.data = fresh;
      h.save();
    }
    return value;
  };
  const response = await request();
  assert.equal(response.statusCode, 200);
  assert.equal(response.body, fresh);
  assert.equal(h.snapshotReads(), 1);
});

test('the initial image lookup cannot return another image under the requested id', async (t) => {
  const h = await fixture(t, 'legacy-base64', 1, []);
  const get = h.adapter.get.bind(h.adapter);
  h.adapter.get = async (collection, id) => {
    const value = await get(collection, id);
    return collection === 'images' && value ? { ...value, _id: 'another-image' } : value;
  };
  const response = await request();
  assert.equal(response.statusCode, 404);
  assert.equal(h.snapshotReads(), 0);
});

for (const base of [0, 1])
  test(`public shared add/remove proof sum from base${base} is settled as one visibility decision`, async (t) => {
    const changes: Array<{ delta: 1 | -1; committed: boolean }> =
      base === 0
        ? [
            { delta: 1, committed: true },
            { delta: -1, committed: true },
          ]
        : [
            { delta: -1, committed: true },
            { delta: 1, committed: true },
          ];
    const h = await fixture(t, 'local-disk', base, changes);
    const before = h.bytes();
    const response = await request();
    assert.equal(response.statusCode, base === 0 ? 404 : 200, response.body);
    assert.equal(h.storageReads(), base === 0 ? 0 : 1);
    assert.equal(h.snapshotReads(), 1);
    assert.equal(h.bytes(), before);
  });

test('a counted snapshot missing its own counter cannot trigger legacy reference fallback', async (t) => {
  const h = await fixture(t, 'legacy-base64', 1, [{ delta: 1, committed: false }]);
  const read = h.adapter.readCatalogImageReference.bind(h.adapter);
  Reflect.set(h.adapter, 'readCatalogImageReference', async (input: Parameters<typeof read>[0]) => {
    const snapshot = await read(input);
    assert.ok(snapshot.state === 'counted');
    const image = { ...snapshot.image };
    Reflect.deleteProperty(image, 'publishedRefCount');
    return { ...snapshot, image, effectiveCount: 0 };
  });
  const response = await request();
  assert.equal(response.statusCode, 404, response.body);
  assert.equal(h.listReads(), 0);
});

test('an inherited counter does not make an empty ledger canonical', async (t) => {
  t.mock.method(console, 'error', () => {});
  const h = await fixture(t, 'legacy-base64', 1, []);
  const get = h.adapter.get.bind(h.adapter);
  h.adapter.get = async (collection, id) => {
    const value = await get(collection, id);
    if (collection !== 'images' || !value) return value;
    const own = { ...value };
    Reflect.deleteProperty(own, 'publishedRefCount');
    return Object.assign(Object.create({ publishedRefCount: 1 }), own);
  };
  const response = await request();
  assert.equal(response.statusCode, 404, response.body);
  assert.equal(h.listReads(), 0);
});
