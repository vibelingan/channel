import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import type { ArticleDatabase } from './article-repository.ts';
import { articleSdkFixture } from './article-sdk-fixture.test-helper.ts';
import {
  type CatalogPublicChangeStore,
  type CatalogPublicState,
  CatalogPublicStateSchema,
  planCatalogPublicChange,
  writeCatalogPublicChange,
} from './catalog-public-changes.ts';
import { assertDocumentWrite, sdkAnswer } from './cloudbase-sdk-answer.ts';

type Transaction = Parameters<Parameters<ArticleDatabase['runTransaction']>[0]>[0];
type Fixture = ReturnType<typeof articleSdkFixture>;
const rowSchema = z.object({ _id: z.string() }).passthrough();
const siteOrigin = 'https://shop.example';
const now = '2026-10-29T01:00:00.000Z';
const productId = 'product-1';
const publicA = {
  productId,
  visible: true,
  semanticHash: 'a'.repeat(64),
  detailRevision: 'approval-a',
} as const;

/** Translate only the existing SDK get/set contract; no network or live credentials. */
function storeFor(transaction: Transaction): CatalogPublicChangeStore {
  return {
    get: async (collection, id) => {
      const response = z
        .object({ data: z.unknown() })
        .passthrough()
        .parse(sdkAnswer(await transaction.collection(collection).doc(id).get()));
      return response.data === null ? null : rowSchema.parse(response.data);
    },
    set: async (collection, row) => {
      const { _id, ...data } = row;
      assertDocumentWrite(await transaction.collection(collection).doc(_id).set(data), _id, 'set');
    },
  };
}

function commit(fixture: Fixture, after: CatalogPublicState) {
  return fixture.db.runTransaction(async (transaction) => {
    const store = storeFor(transaction);
    const current = await store.get('products', after.productId);
    const before = current
      ? CatalogPublicStateSchema.parse(current.publicState)
      : { productId: after.productId, visible: false };
    const plan = await planCatalogPublicChange(store, { siteOrigin, before, after, now });
    await store.set('products', { _id: after.productId, publicState: after });
    await writeCatalogPublicChange(store, plan);
    return plan;
  });
}

function records(fixture: Fixture, collection: string) {
  return [...fixture.rows]
    .filter(([key]) => key.startsWith(`${collection}/`))
    .map(([, row]) => row);
}

test('installed SDK sends product, public head and refresh task in one native transaction', async (t) => {
  const fixture = articleSdkFixture(t);
  await commit(fixture, publicA);
  const writes = fixture.calls.filter((call) => call.api === 'database.modifyDocument');
  assert.deepEqual(
    writes.map((call) => call.params.collectionName),
    ['products', 'catalogPublicHeads', 'catalogSeoTasks'],
  );
  assert.equal(new Set(writes.map((call) => call.params.transactionId)).size, 1);
  assert.ok(writes.every((call) => typeof call.params.transactionId === 'string'));
  assert.equal(fixture.calls.at(-1)?.api, 'database.commitTransaction');
  assert.equal(records(fixture, 'catalogPublicHeads')[0]?.sequence, 1);
  assert.equal(records(fixture, 'catalogSeoTasks')[0]?.requestedSequence, 1);
});

test('concurrent SDK callers do not create a second public version for the same content', async (t) => {
  const fixture = articleSdkFixture(t);
  await Promise.all([commit(fixture, publicA), commit(fixture, publicA)]);
  assert.equal(records(fixture, 'catalogPublicHeads').length, 1);
  assert.equal(records(fixture, 'catalogPublicHeads')[0]?.sequence, 1);
  assert.equal(records(fixture, 'catalogSeoTasks').length, 1);
});

test('a native transaction conflict reruns the change with a fresh transaction-bound plan', async (t) => {
  const fixture = articleSdkFixture(t);
  let conflict = true;
  fixture.control.beforeCommit = () => {
    if (!conflict) return;
    conflict = false;
    fixture.put('products', productId, { publicState: { productId, visible: false } });
  };
  await commit(fixture, publicA);
  assert.equal(records(fixture, 'catalogPublicHeads').length, 1);
  assert.equal(records(fixture, 'catalogPublicHeads')[0]?.sequence, 1);
  assert.equal(records(fixture, 'catalogSeoTasks').length, 1);
  assert.equal(fixture.calls.filter((call) => call.api === 'database.startTransaction').length, 2);
  assert.equal(fixture.calls.filter((call) => call.api === 'database.commitTransaction').length, 2);
});

test('installed SDK discards all staged rows on commit failure and a fresh retry starts at version one', async (t) => {
  const fixture = articleSdkFixture(t);
  const before = structuredClone(fixture.rows);
  fixture.control.failNextCommit = true;
  await assert.rejects(commit(fixture, publicA), /Synthetic commit failure/);
  assert.deepEqual(fixture.rows, before);
  assert.equal(fixture.calls.at(-1)?.api, 'database.abortTransaction');
  await commit(fixture, publicA);
  assert.equal(records(fixture, 'catalogPublicHeads')[0]?.sequence, 1);
});

test('a native read permission failure cannot be mistaken for missing public records', async (t) => {
  const fixture = articleSdkFixture(t);
  const before = structuredClone(fixture.rows);
  fixture.control.returnedReadError = true;
  await assert.rejects(commit(fixture, publicA), { code: 'DATABASE_PERMISSION_DENIED' });
  assert.deepEqual(fixture.rows, before);
  assert.equal(
    fixture.calls.some((call) => call.api === 'database.modifyDocument'),
    false,
  );
});

test('an unacknowledged native head write aborts the transaction including the business row', async (t) => {
  const fixture = articleSdkFixture(t);
  const before = structuredClone(fixture.rows);
  await assert.rejects(
    fixture.db.runTransaction(async (transaction) => {
      const store = storeFor(transaction);
      const plan = await planCatalogPublicChange(store, {
        siteOrigin,
        before: { productId, visible: false },
        after: publicA,
        now,
      });
      await store.set('products', { _id: productId, publicState: publicA });
      fixture.control.zeroNextWrite = true;
      await writeCatalogPublicChange(store, plan);
    }),
    /not acknowledged/,
  );
  assert.deepEqual(fixture.rows, before);
  assert.equal(fixture.calls.at(-1)?.api, 'database.abortTransaction');
});
