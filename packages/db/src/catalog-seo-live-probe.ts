import assert from 'node:assert/strict';
import { createHash, timingSafeEqual } from 'node:crypto';
import cloudbase from '@cloudbase/node-sdk';
import { catalogPublicRecordId } from './catalog-public-changes.ts';
import { type CatalogSeoDatabase, createCatalogSeoStore } from './catalog-seo-cloud.ts';
import { consumeCatalogSeoRequest } from './catalog-seo-consumer.ts';
import { catalogSeoControlId } from './catalog-seo-control.ts';
import { createCatalogSeoDelivery } from './catalog-seo-delivery.ts';
import { createCloudCatalogSeoPageReader } from './catalog-seo-pages.ts';
import { createCatalogSeoRequest } from './catalog-seo-requests.ts';
import { mutateCatalogRowInCloudBase } from './cloudbase-adapter.ts';
type ProbeTransaction = Parameters<Parameters<CatalogSeoDatabase['runTransaction']>[0]>[0];
const environment = 'diversity-123-d9grnqfux221323bb';
export const probeCollections = [
  'products',
  'productVariants',
  'catalogTaxonomies',
  'catalogSeoRequests',
  'catalogPublicHeads',
  'catalogSeoTasks',
  'catalogSeoPages',
  'catalogSeoControl',
] as const;
export async function main(event: unknown) {
  if (process.env.TCB_ENV !== environment || !/^\d{8,20}$/.test(process.env.SEO_PROBE_RUN ?? ''))
    throw Error('Wrong isolated probe target');
  if (!event || typeof event !== 'object' || Reflect.get(event, 'action') !== 'run')
    throw Error('Unplanned probe action');
  const token = Reflect.get(event, 'token');
  const digest = process.env.SEO_PROBE_DIGEST;
  if (
    typeof token !== 'string' ||
    !/^[a-f0-9]{64}$/.test(token) ||
    !digest ||
    !/^[a-f0-9]{64}$/.test(digest) ||
    !timingSafeEqual(Buffer.from(digest, 'hex'), createHash('sha256').update(token).digest())
  )
    throw Error('Probe authentication failed');
  const prefix = `seo_probe_${process.env.SEO_PROBE_RUN}_`;
  const native = cloudbase.init({ env: environment }).database();
  const name = (value: string) => {
    if (!probeCollections.some((c) => c === value))
      throw Error('Probe cannot access business collections');
    return prefix + value;
  };
  let failRequest = false;
  const db = {
    command: native.command,
    collection: (value: string) => native.collection(name(value)),
    runTransaction: (fn: Parameters<CatalogSeoDatabase['runTransaction']>[0]) =>
      native.runTransaction(async (tx: ProbeTransaction) =>
        fn({
          collection: (value: string) => {
            const collection = tx.collection(name(value));
            return {
              doc: (id: string) => {
                const doc = collection.doc(id);
                return {
                  ...doc,
                  get: () => doc.get(),
                  set: async (data: Record<string, unknown>) => {
                    const answer = await doc.set(data);
                    if (failRequest && value === 'catalogSeoRequests')
                      throw Error('Injected probe rollback');
                    return answer;
                  },
                  update: (data: Record<string, unknown>) => doc.update(data),
                  remove: () => doc.remove(),
                };
              },
            };
          },
        }),
      ),
  };
  // The adapter below is the exact production SDK path, restricted only by collection names.
  function checked(value: unknown): asserts value is CatalogSeoDatabase {
    assert.ok(value && typeof value === 'object');
    assert.equal(typeof Reflect.get(value, 'collection'), 'function');
    assert.equal(typeof Reflect.get(value, 'runTransaction'), 'function');
    assert.equal(typeof Reflect.get(Reflect.get(value, 'command'), 'gt'), 'function');
  }
  checked(db);
  for (const value of probeCollections) {
    const rows = await native.collection(name(value)).limit(1).get();
    assert.equal(rows.data.length, 0, 'Probe collections must be fresh');
  }
  const store = createCatalogSeoStore(db);
  const site = 'https://supplychainsai.com';
  const config = { siteOrigin: site, detailEnabled: false };
  const now = () => new Date().toISOString();
  const results: string[] = [];
  await native
    .collection(name('products'))
    .doc('probe-product')
    .set({ name: 'Isolated probe A', published: true, productFamily: 'misc' });
  const save = (data: Record<string, unknown>) =>
    mutateCatalogRowInCloudBase(
      db,
      { action: 'update', collection: 'products', id: 'probe-product', data },
      now(),
      config,
    );
  const requestId = createCatalogSeoRequest(
    site,
    { kind: 'product', productId: 'probe-product', previouslyPublic: true },
    now(),
  )._id;
  const consume = async () =>
    consumeCatalogSeoRequest(
      store,
      await store.get('catalogSeoRequests', requestId),
      config,
      now(),
    );
  assert.equal((await save({ name: 'Isolated probe B' })).status, 'written');
  const initial = await consume();
  assert.equal(initial.status, 'checked');
  results.push('real-product-save-and-request-transaction');
  const headId = catalogPublicRecordId(site, 'probe-product');
  const first = await store.get('catalogPublicHeads', headId);
  assert.equal(first?.sequence, 1);
  assert.equal((await consume()).status, 'already-checked');
  results.push('repeat-consumption-does-not-duplicate');
  await save({ name: 'Isolated probe C' });
  await consume();
  assert.equal((await store.get('catalogPublicHeads', headId))?.sequence, 2);
  results.push('public-change-advances-version');
  failRequest = true;
  await assert.rejects(save({ name: 'Must roll back' }), /Injected probe rollback/);
  failRequest = false;
  assert.equal((await store.get('products', 'probe-product'))?.name, 'Isolated probe C');
  results.push('real-database-aborts-product-and-queue-together');
  const writes = (await store.get('catalogSeoControl', catalogSeoControlId(site)))?.writes;
  assert.equal(typeof writes, 'number');
  const delivery = createCatalogSeoDelivery(store, site, Number(writes), 'cloud-probe', now);
  const ticket = await delivery.begin(['probe-product']);
  await assert.rejects(save({ name: 'Must wait' }));
  assert.equal((await store.get('products', 'probe-product'))?.name, 'Isolated probe C');
  await delivery.end(ticket, 'verified');
  await delivery.accept([{ productId: 'probe-product', htmlSha256: 'a'.repeat(64) }]);
  results.push('real-transaction-blocks-save-during-delivery');
  assert.equal((await store.get('catalogSeoPages', headId))?.ready, true);
  const ready = await createCloudCatalogSeoPageReader(db, site).read([
    'probe-product',
    'missing-probe',
  ]);
  assert.equal(ready.get('probe-product'), true);
  assert.equal(ready.get('missing-probe'), false);
  results.push('real-batched-page-availability-query');
  await save({ published: false });
  await consume();
  assert.equal((await store.get('catalogPublicHeads', headId))?.visible, false);
  assert.equal((await store.get('catalogSeoPages', headId))?.ready, false);
  results.push('withdrawal-invalidates-ready-page');
  const latest = Number((await store.get('catalogSeoControl', catalogSeoControlId(site)))?.writes);
  const uncertain = createCatalogSeoDelivery(store, site, latest, 'cloud-probe-unknown', now);
  const held = await uncertain.begin(['probe-product']);
  await uncertain.end(held, 'unknown');
  await assert.rejects(
    createCatalogSeoDelivery(store, site, latest, 'other-run', now).begin(['probe-product']),
  );
  results.push('unknown-outcome-prevents-takeover');
  return {
    purpose: 'catalog-seo-live-probe-v1',
    environment,
    prefix,
    checks: results,
    passed: results.length,
    businessCollectionsAccessed: 0,
    websiteWrites: 0,
    htmlDeliveryVerified: false,
  };
}
