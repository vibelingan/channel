import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { CatalogDetailPublicationSchema } from '@vibelingan-channel/shared/catalog-detail';
import { approvedVariantDocumentId } from './catalog-detail-storage.ts';
import { manageInquiryInCloud, saveQuoteInCloud } from './catalog-inquiry-cloud.ts';
import type { NodeSdkDatabase } from './cloudbase-adapter.ts';

function harness() {
  const state: Record<string, Record<string, CollectionDoc>> = {
    users: { admin: { _id: 'admin', role: 'admin', username: 'Admin' } },
    products: {
      p: {
        _id: 'p',
        published: true,
        catalogDetailPublication: {
          state: 'approved',
          revision: 'r',
          variantCount: 1,
          header: {
            schemaVersion: 'catalog-product-detail-v1',
            _id: 'p',
            name: 'Server headset',
            images: [],
            facts: [],
            offers: [],
          },
        },
      },
    },
    productVariants: {
      v: {
        _id: 'v',
        productId: 'p',
        catalogDetailRevision: 'r',
        catalogDetailApproved: {
          id: 'v',
          options: [],
          images: [],
          inventory: { state: 'unknown' },
          offers: [],
        },
      },
    },
  };
  let queue = Promise.resolve();
  let failCommit = false;
  const db: NodeSdkDatabase = {
    command: { set: (v) => v },
    async runTransaction(operation) {
      const work = queue.then(async () => {
        const copy = structuredClone(state);
        const result = await operation({
          collection: (name) => ({
            doc: (id) => ({
              get: async () => ({ data: copy[name]?.[id] ? [copy[name][id]] : [] }),
              update: async (patch) => {
                if (copy[name]?.[id]) Object.assign(copy[name][id], patch);
                return {};
              },
              set: async (data) => {
                assert.ok(!('_id' in data), 'SDK set must not receive _id');
                copy[name] ??= {};
                copy[name][id] = { ...data, _id: id };
                return {};
              },
              remove: async () => ({ deleted: 0 }),
            }),
          }),
        });
        if (failCommit) throw new Error('commit failed');
        Object.assign(state, copy);
        return result;
      });
      queue = work.then(
        () => {},
        () => {},
      );
      return work;
    },
  };
  return {
    db,
    state,
    fail: () => {
      failCommit = true;
    },
  };
}
const input = () => ({
  idempotencyKey: randomUUID(),
  target: { intent: 'variant_quote', productId: 'p', revision: 'r', variantId: 'v' },
  fields: {
    intent: 'variant_quote',
    quantity: '1',
    deliveryDate: '',
    customizationTypes: [],
    brief: '',
    contactName: 'Test Buyer',
    company: 'Test',
    email: 'buyer@example.test',
    country: 'HK',
  },
});

test('cloud RFQ reads the approved immutable SKU copy, never an unreviewed canonical row', async () => {
  for (const corrupt of [false, true]) {
    const h = harness();
    const product = h.state.products?.p;
    const variant = h.state.productVariants?.v;
    assert.ok(product && variant);
    product.catalogDetailPublication = {
      ...CatalogDetailPublicationSchema.parse(product.catalogDetailPublication),
      variantStorage: 'immutable-v1',
    };
    const id = approvedVariantDocumentId('p', 'r', 'v');
    h.state.catalogDetailVariants = {
      [id]: { ...structuredClone(variant), _id: id, variantId: corrupt ? 'wrong-variant' : 'v' },
    };
    variant.catalogDetailRevision = 'unreviewed';
    const saved = await saveQuoteInCloud(h.db, input());
    if (corrupt) {
      assert.equal(saved.ok, false);
      assert.equal(Object.keys(h.state.catalogQuoteRequests ?? {}).length, 0);
    } else {
      assert.ok(saved.ok);
      const inquiry = await manageInquiryInCloud(h.db, 'admin', {
        action: 'get',
        id: saved.requestId,
      });
      assert.ok(inquiry.ok && inquiry.data.kind === 'detail');
      assert.equal(inquiry.data.item.snapshot.variant?.id, 'v');
      assert.doesNotMatch(JSON.stringify(inquiry), new RegExp(id));
    }
  }
});

test('durable cap is shared across requests, and same-key retries do not spend another slot', async () => {
  const h = harness();
  const body = input();
  const first = await saveQuoteInCloud(h.db, body);
  assert.ok(first.ok);
  for (let i = 1; i < 30; i++) assert.ok((await saveQuoteInCloud(h.db, input())).ok);
  assert.deepEqual(await saveQuoteInCloud(h.db, input()), { ok: false, code: 'rate-limit' });
  assert.deepEqual(await saveQuoteInCloud(h.db, body), first);
  assert.equal(h.state.catalogInquiryLimits?.['public-submit']?.count, 30);
  assert.equal(Object.keys(h.state.catalogQuoteRequests ?? {}).length, 30);
});
test('cloud transaction persists one authoritative inquiry, handles retry and rejects competing admin versions', async () => {
  const h = harness();
  const body = input();
  const [saved, repeated] = await Promise.all([
    saveQuoteInCloud(h.db, body),
    saveQuoteInCloud(h.db, body),
  ]);
  assert.ok(saved.ok);
  assert.deepEqual(repeated, saved);
  assert.equal(Object.keys(h.state.catalogQuoteRequests ?? {}).length, 1);
  const got = await manageInquiryInCloud(h.db, 'admin', { action: 'get', id: saved.requestId });
  assert.ok(got.ok && got.data.kind === 'detail');
  assert.equal(got.data.item.snapshot.productName, 'Server headset');
  assert.equal(got.data.item.notification, 'disabled');
  assert.doesNotMatch(JSON.stringify(got), /keyHash|fingerprint/);
  const command = {
    action: 'update',
    id: saved.requestId,
    version: 0,
    operationId: randomUUID(),
    status: 'in_progress',
  };
  const [a, b] = await Promise.all([
    manageInquiryInCloud(h.db, 'admin', command),
    manageInquiryInCloud(h.db, 'admin', {
      ...command,
      operationId: randomUUID(),
      note: 'Competing edit',
    }),
  ]);
  assert.ok(a.ok);
  assert.deepEqual(b, { ok: false, code: 'VERSION_CONFLICT' });
  assert.deepEqual(await manageInquiryInCloud(h.db, 'admin', command), a);
  assert.equal(
    (await manageInquiryInCloud(h.db, 'admin', { ...command, note: 'Changed replay' })).ok,
    false,
  );
  assert.equal(
    (
      await manageInquiryInCloud(h.db, 'admin', {
        ...command,
        version: 1,
        operationId: randomUUID(),
        status: 'completed',
        note: 'Follow-up finished offline',
      })
    ).ok,
    true,
  );
  assert.equal(h.state.catalogQuoteRequests?.[saved.requestId]?.status, 'completed');
  const actor = h.state.users?.admin;
  assert.ok(actor);
  actor.role = 'member';
  assert.deepEqual(await manageInquiryInCloud(h.db, 'admin', command), {
    ok: false,
    code: 'FORBIDDEN',
  });
});
test('cloud failed commit cannot return success or leave partial inquiry; unapproved product cannot submit', async () => {
  const h = harness();
  h.fail();
  await assert.rejects(saveQuoteInCloud(h.db, input()), /commit failed/);
  assert.equal(Object.keys(h.state.catalogQuoteRequests ?? {}).length, 0);
  const invalid = harness();
  const product = invalid.state.products?.p;
  assert.ok(product);
  product.published = false;
  assert.deepEqual(await saveQuoteInCloud(invalid.db, input()), { ok: false, code: 'unavailable' });
});
