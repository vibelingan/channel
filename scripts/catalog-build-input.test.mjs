import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
const { require: tsxRequire } = createRequire(
  new URL('../apps/site/package.json', import.meta.url),
)('tsx/cjs/api');
const { catalogPublicRecordId } = tsxRequire(
  '../packages/db/src/catalog-public-changes.ts',
  import.meta.url,
);
const { idleCatalogSeoControl } = tsxRequire(
  '../packages/db/src/catalog-seo-control.ts',
  import.meta.url,
);
const {
  assertCatalogBuildInputCurrent,
  assertPrebuiltCatalogMode,
  sealCatalogBuildInput,
  versionFreshCatalogBuildSnapshot,
} = tsxRequire('./catalog-build-input.ts', import.meta.url);
const { prepareCatalogRefresh } = tsxRequire('./catalog-refresh.ts', import.meta.url);
const { createCatalogSeoRequest } = tsxRequire(
  '../packages/db/src/catalog-seo-requests.ts',
  import.meta.url,
);
const config = { siteOrigin: 'https://fixture.example', detailEnabled: true };
const now = '2026-11-01T00:00:00.000Z';
const head = (productId = 'p1', patch = {}) => ({
  _id: catalogPublicRecordId(config.siteOrigin, productId),
  schemaVersion: 1,
  siteOrigin: config.siteOrigin,
  productId,
  sequence: 1,
  visible: true,
  semanticHash: 'a'.repeat(64),
  detailRevision: null,
  changedAt: now,
  latestEventId: 'b'.repeat(64),
  ...patch,
});
const capture = (patch = {}) => ({ writes: 10, heads: [head()], ...patch });
function snapshot(heads = [head()], patchEntry = {}) {
  return Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      purpose: 'public',
      siteOrigin: config.siteOrigin,
      products: heads
        .filter((h) => h.visible)
        .map((h) => ({
          product: { _id: h.productId, name: 'Public headphone' },
          publicVersion: {
            sequence: h.sequence,
            semanticHash: h.semanticHash,
            changedAt: h.changedAt,
          },
          ...(h.detailRevision ? { detail: { revision: h.detailRevision } } : {}),
          ...patchEntry,
        })),
    }),
  );
}
const options = () => ({
  config,
  source: 'fresh',
  snapshot: snapshot(),
  before: capture(),
  after: capture(),
});
test('a frozen build can acknowledge only its original public content version', () => {
  const x = options();
  const proof = sealCatalogBuildInput(x);
  assertCatalogBuildInputCurrent({ ...x, proof, current: capture() });
  assert.throws(
    () =>
      assertCatalogBuildInputCurrent({
        ...x,
        proof,
        current: capture({
          writes: 11,
          heads: [head('p1', { sequence: 2, semanticHash: 'c'.repeat(64) })],
        }),
      }),
    /Products changed/,
  );
  assert.throws(
    () =>
      assertCatalogBuildInputCurrent({
        ...x,
        proof,
        snapshot: Buffer.from('changed frozen input'),
        current: capture(),
      }),
    /Products changed/,
  );
});
for (const [name, patch] of [
  ['same ID changed body, price, variant or category', { semanticHash: 'c'.repeat(64) }],
  ['detail revision changed', { detailRevision: 'revision-2' }],
  ['withdrawn product', { visible: false }],
  ['new public version', { sequence: 2 }],
  ['last modification changed', { changedAt: '2026-11-01T00:01:00.000Z' }],
])
  test(`capture and upload both reject ${name}`, () => {
    const x = options();
    const proof = sealCatalogBuildInput(x);
    const changed = capture({ heads: [head('p1', patch)] });
    assert.throws(() => sealCatalogBuildInput({ ...x, after: changed }), /Products changed/);
    assert.throws(
      () => assertCatalogBuildInputCurrent({ ...x, proof, current: changed }),
      /Products changed/,
    );
  });
test('new inventory, changed-back content and recording enabled after capture cannot be accepted', () => {
  const x = options();
  const proof = sealCatalogBuildInput(x);
  for (const current of [capture({ heads: [head(), head('p2')] }), capture({ writes: 12 })])
    assert.throws(
      () => assertCatalogBuildInputCurrent({ ...x, proof, current }),
      /Products changed/,
    );
  for (const missing of [undefined, null, { ...proof, tracked: false }])
    assert.throws(() =>
      assertCatalogBuildInputCurrent({ ...x, proof: missing, current: capture() }),
    );
});
test('ordering and task metadata cannot alter the public content fingerprint', () => {
  const x = {
    ...options(),
    before: capture({ heads: [head(), head('p2')] }),
    after: capture({ heads: [head('p2'), head('p1', { latestEventId: 'c'.repeat(64) })] }),
  };
  const proof = sealCatalogBuildInput(x);
  assertCatalogBuildInputCurrent({ ...x, proof, current: x.before });
});
test('a historical accepted snapshot requires matching public versions, including withdrawals and detail', () => {
  const x = { ...options(), source: 'accepted' };
  const proof = sealCatalogBuildInput(x);
  assertCatalogBuildInputCurrent({ ...x, proof, current: capture() });
  for (const input of [
    snapshot([], {}),
    snapshot([head()], { publicVersion: undefined }),
    snapshot([head()], {
      publicVersion: { sequence: 2, semanticHash: 'a'.repeat(64), changedAt: now },
    }),
    snapshot([head()], { detail: { revision: 'other' } }),
    snapshot([head('p2')]),
  ])
    assert.throws(() => sealCatalogBuildInput({ ...x, snapshot: input }));
});
test('proof cannot be transplanted to another site, detail mode, source or modified receipt', () => {
  const x = options();
  const proof = sealCatalogBuildInput(x);
  for (const patch of [
    { source: 'accepted' },
    { config: { ...config, detailEnabled: false } },
    { proof: { ...proof, extra: 'unreviewed' } },
    { config: { ...config, siteOrigin: 'https://other.example' } },
  ])
    assert.throws(() =>
      assertCatalogBuildInputCurrent({ ...x, proof, current: capture(), ...patch }),
    );
});
test('the real paginated preparation rechecks the write counter after reading heads', async () => {
  let control = idleCatalogSeoControl(config.siteOrigin, now);
  const store = {
    get: async () => structuredClone(control),
    list: async (collection) => {
      if (collection === 'catalogSeoRequests') return [];
      control = { ...control, writes: control.writes + 1 };
      return [head()];
    },
    transaction: async () => {
      throw Error('No transaction expected');
    },
  };
  await assert.rejects(prepareCatalogRefresh(store, config, 'run1'), /Public products changed/);
});
test('settled preparation returns all heads without touching business data', async () => {
  const store = {
    get: async () => idleCatalogSeoControl(config.siteOrigin, now),
    list: async (collection) => (collection === 'catalogSeoRequests' ? [] : [head()]),
    transaction: async () => {
      throw Error('No transaction expected');
    },
  };
  const result = await prepareCatalogRefresh(store, config, 'run1');
  assert.equal(result.writes, 0);
  assert.deepEqual(result.heads, [head()]);
});

test('fresh capture binds versions before HTML build and remains reusable as an accepted snapshot', () => {
  const x = { ...options(), snapshot: snapshot([head()], { publicVersion: undefined }) };
  const bytes = versionFreshCatalogBuildSnapshot(x);
  assert.deepEqual(JSON.parse(bytes).products[0].publicVersion, {
    sequence: 1,
    semanticHash: head().semanticHash,
    changedAt: now,
  });
  const proof = sealCatalogBuildInput({ ...x, snapshot: bytes, source: 'accepted' });
  assertCatalogBuildInputCurrent({
    ...x,
    snapshot: bytes,
    source: 'accepted',
    proof,
    current: capture(),
  });
  assert.throws(() => versionFreshCatalogBuildSnapshot({ ...x, after: capture({ writes: 11 }) }));
  assert.throws(() =>
    versionFreshCatalogBuildSnapshot({ ...x, snapshot: snapshot([head('other')]) }),
  );
  assert.throws(() =>
    versionFreshCatalogBuildSnapshot({
      ...x,
      snapshot: snapshot([head()], { detail: { revision: 'stale' } }),
    }),
  );
});

test('prebuilt HTML is never mixed with newly generated refresh, bootstrap or restoration inputs', () => {
  const env = {
    SITE_DELIVERY_BUILT_INPUT: '1',
    SITE_DELIVERY_MODE: 'publish',
    SITE_PRODUCT_SOURCE: 'fresh',
  };
  assertPrebuiltCatalogMode(env);
  assertPrebuiltCatalogMode({ ...env, SITE_PRODUCT_SOURCE: 'accepted' });
  for (const patch of [
    { SITE_PRODUCT_SOURCE: 'refresh' },
    { SITE_CATALOG_BOOTSTRAP: '1' },
    { SITE_DELIVERY_MODE: 'restore' },
    { SITE_PRODUCT_SOURCE: undefined },
  ])
    assert.throws(() => assertPrebuiltCatalogMode({ ...env, ...patch }), /Prebuilt HTML/);
  assertPrebuiltCatalogMode({
    ...env,
    SITE_DELIVERY_BUILT_INPUT: undefined,
    SITE_PRODUCT_SOURCE: 'refresh',
  });
});

test('pre-existing product requests are consumed before capture and remain pending for HTML delivery', async () => {
  const product = { _id: 'p1', published: true, name: 'Current headset', productFamily: 'misc' };
  const request = createCatalogSeoRequest(
    config.siteOrigin,
    { kind: 'product', productId: 'p1', previouslyPublic: true },
    now,
  );
  let rows = new Map([
    ['products/p1', product],
    [`catalogSeoRequests/${request._id}`, request],
  ]);
  const get = async (collection, id) => structuredClone(rows.get(`${collection}/${id}`) ?? null);
  const store = {
    get,
    list: async (collection, filter, cursor, limit) =>
      [...rows.entries()]
        .filter(
          ([key, row]) =>
            key.startsWith(`${collection}/`) &&
            row._id > (cursor ?? '') &&
            Object.entries(filter).every(([k, v]) => row[k] === v),
        )
        .map(([, row]) => structuredClone(row))
        .sort((a, b) => (a._id < b._id ? -1 : 1))
        .slice(0, limit),
    transaction: async (operation) => {
      const copy = structuredClone(rows);
      const result = await operation({
        get: async (collection, id) => structuredClone(copy.get(`${collection}/${id}`) ?? null),
        set: async (collection, row) => {
          assert(collection !== 'products', 'No business data writes');
          copy.set(`${collection}/${row._id}`, structuredClone(row));
        },
      });
      rows = copy;
      return result;
    },
  };
  const result = await prepareCatalogRefresh(store, config, 'run1');
  assert.equal((await get('catalogSeoRequests', request._id)).state, 'checked');
  assert.equal(result.heads.length, 1);
  assert.equal(result.heads[0].visible, true);
  assert.equal((await get('catalogSeoTasks', result.heads[0]._id)).state, 'pending');
  assert.deepEqual(await get('products', 'p1'), product);
});
