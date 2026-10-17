// Exercise the packaged handler, native adapter and SDK; only HTTP transport is replaced.
const assert = require('node:assert/strict');
const { resolve } = require('node:path');
const { createHmac } = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const { Writable, Readable } = require('node:stream');

function sessionToken(secret) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const input = `${encode({ alg: 'HS256' })}.${encode({ sub: 'admin', role: 'admin', email: 'admin@example.test', name: 'Admin', iss: 'channel-portal', aud: 'channel-session', iat: now, exp: now + 300 })}`;
  return `${input}.${createHmac('sha256', secret).update(input).digest('base64url')}`;
}
Object.assign(process.env, {
  TCB_ENV: 'product-write-artifact-env',
  SCF_NAMESPACE: 'product-write-artifact-env',
  JWT_SECRET: 'product-write-artifact-secret',
  TENCENTCLOUD_SECRETID: 'artifact-fake-id',
  TENCENTCLOUD_SECRETKEY: 'artifact-fake-key',
  TENCENTCLOUD_SESSIONTOKEN: 'artifact-fake-session',
  CATALOG_DETAIL_APPROVAL_ENABLED: '1',
});
const clone = (value) => JSON.parse(JSON.stringify(value));
let store = {
  users: [{ _id: 'admin', role: 'admin' }],
  products: [],
  catalogProductIdentities: [],
};
const transactions = new Map();
const calls = [];
let nextTransaction = 0;
let fault = null;
const decode = (value) => {
  if (Array.isArray(value)) return value.map(decode);
  if (!value || typeof value !== 'object') return value;
  for (const key of ['$numberInt', '$numberLong', '$numberDouble'])
    if (Object.keys(value).length === 1 && Object.hasOwn(value, key)) return Number(value[key]);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)]));
};
const originals = {
  http: http.request,
  https: https.request,
  connect: net.Socket.prototype.connect,
  fetch: globalThis.fetch,
};
net.Socket.prototype.connect = () => {
  throw Error('Real socket forbidden in product write artifact probe');
};
globalThis.fetch = async () => {
  throw Error('Real fetch forbidden in product write artifact probe');
};
http.request = https.request = (_url, _options, callback) => {
  const chunks = [];
  const request = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(Buffer.from(chunk));
      done();
    },
    final(done) {
      try {
        const params = JSON.parse(Buffer.concat(chunks).toString());
        calls.push({
          action: params.action,
          collection: params.collectionName,
          merge: params.merge,
          upsert: params.upsert,
        });
        let response;
        if (params.action === 'database.startTransaction') {
          const transactionId = `product-write-${++nextTransaction}`;
          transactions.set(transactionId, clone(store));
          response = { transactionId };
        } else if (params.action === 'database.commitTransaction') {
          assert.ok(transactions.has(params.transactionId));
          store = transactions.get(params.transactionId);
          transactions.delete(params.transactionId);
          response = {};
        } else if (params.action === 'database.abortTransaction') {
          assert.ok(transactions.delete(params.transactionId));
          response = {};
        } else {
          assert.ok(
            ['database.getDocument', 'database.modifyDocument', 'database.removeDocument'].includes(
              params.action,
            ),
            params.action,
          );
          assert.ok(Object.hasOwn(store, params.collectionName), params.collectionName);
          const tx = params.transactionId ? transactions.get(params.transactionId) : null;
          if (params.transactionId) assert.ok(tx);
          const scope = tx || store;
          const query = JSON.parse(params.query);
          assert.equal(typeof query._id, 'string');
          const rows = scope[params.collectionName];
          const index = rows.findIndex((row) => row._id === query._id);
          if (params.action === 'database.getDocument') {
            response = { data: { list: index < 0 ? [] : [JSON.stringify(rows[index])] } };
          } else {
            assert.ok(tx, 'every write must belong to the SDK transaction');
            const matches =
              fault &&
              fault.collection === params.collectionName &&
              fault.action === params.action &&
              (!fault.id || fault.id === query._id);
            if (matches) {
              fault.hits++;
              response =
                fault.kind === 'coded'
                  ? { code: 'OWNED_WRITE_REJECTED', message: 'synthetic SDK write refusal' }
                  : params.action === 'database.removeDocument'
                    ? { data: { deleted: 0 } }
                    : {
                        data: {
                          updated: 0,
                          ...(fault.kind === 'wrong-upsert'
                            ? { upsert_id: 'different-document' }
                            : {}),
                        },
                      };
            } else if (params.action === 'database.removeDocument') {
              assert.ok(index >= 0);
              rows.splice(index, 1);
              response = { data: { deleted: 1 } };
            } else {
              const wire = decode(JSON.parse(params.data));
              const isUpdate = params.merge === true;
              assert.equal(params.upsert, !isUpdate);
              if (isUpdate) assert.deepEqual(Object.keys(wire), ['$set']);
              const values = isUpdate ? wire.$set : wire;
              assert.equal(Object.hasOwn(values, '_id'), false);
              assert.ok(Object.keys(values).every((key) => !key.includes('.')));
              if (isUpdate) {
                assert.ok(index >= 0);
                rows[index] = { ...rows[index], ...values };
                response = { data: { updated: 1 } };
              } else if (index >= 0) {
                rows[index] = { _id: query._id, ...values };
                response = { data: { updated: 1 } };
              } else {
                rows.push({ _id: query._id, ...values });
                response = { data: { updated: 0, upsert_id: query._id } };
              }
            }
          }
        }
        const stream = Readable.from([
          Buffer.from(JSON.stringify({ ...response, requestId: 'product-write-probe' })),
        ]);
        stream.statusCode = 200;
        stream.headers = { 'content-type': 'application/json' };
        callback(stream);
        done();
      } catch (error) {
        done(error);
      }
    },
  });
  request.setTimeout = () => request;
  return request;
};

async function run() {
  try {
    const { main } = require(resolve(process.argv[2]));
    const token = sessionToken(process.env.JWT_SECRET);
    const api = async (action, data) => {
      const response = await main({
        httpMethod: 'POST',
        headers: {},
        body: JSON.stringify({ action, token, data }),
      });
      assert.equal(typeof response?.body, 'string');
      return JSON.parse(response.body);
    };
    const health = await api('health', {});
    assert.equal(health.ok, true);
    const original = {
      name: 'Artifact clock',
      productFamily: 'misc',
      slug: 'artifact-old',
      skuCode: 'artifact-old',
      imageIds: [],
      description: '',
    };
    const create = () => api('create', { collection: 'products', values: original });
    let refused = 0;
    const refuse = async (control, action) => {
      const before = JSON.stringify(store);
      fault = { ...control, hits: 0 };
      const result = await action();
      assert.ok(fault.hits > 0, 'failure must reach the actual SDK write');
      assert.equal(
        result.ok,
        false,
        `unacknowledged ${control.collection} ${control.action} ${control.kind} must not return success`,
      );
      assert.equal(
        JSON.stringify(store),
        before,
        'failed write must roll back product and identity changes',
      );
      assert.equal(transactions.size, 0);
      fault = null;
      refused++;
    };
    for (const kind of ['zero', 'wrong-upsert', 'coded'])
      await refuse({ collection: 'products', action: 'database.modifyDocument', kind }, create);
    assert.equal(store.products.length, 0);
    assert.equal(store.catalogProductIdentities.length, 0);
    const created = await create();
    assert.equal(created.ok, true, JSON.stringify(created));
    const id = created.data._id;
    assert.equal(store.products.length, 1);
    assert.equal(store.catalogProductIdentities.length, 2);
    assert.ok(store.catalogProductIdentities.every((row) => row.productId === id));
    const rename = () =>
      api('update', {
        collection: 'products',
        id,
        expectedUpdatedAt: store.products[0].updatedAt,
        values: { name: 'Renamed artifact clock', slug: 'artifact-new', skuCode: 'artifact-new' },
      });
    for (const kind of ['zero', 'coded'])
      await refuse({ collection: 'products', action: 'database.modifyDocument', kind }, rename);
    for (const kind of ['zero', 'wrong-upsert', 'coded'])
      for (const identity of ['slug', 'sku'])
        await refuse(
          {
            collection: 'catalogProductIdentities',
            action: 'database.modifyDocument',
            id: `${identity}:artifact-new`,
            kind,
          },
          rename,
        );
    for (const kind of ['zero', 'coded'])
      await refuse(
        {
          collection: 'catalogProductIdentities',
          action: 'database.removeDocument',
          id: 'slug:artifact-old',
          kind,
        },
        rename,
      );
    const renamed = await rename();
    assert.equal(renamed.ok, true, JSON.stringify(renamed));
    assert.equal(store.products[0].name, 'Renamed artifact clock');
    assert.equal(store.catalogProductIdentities.length, 2);
    assert.deepEqual(store.catalogProductIdentities.map((row) => row._id).sort(), [
      'sku:artifact-new',
      'slug:artifact-new',
    ]);
    assert.ok(
      calls.some(
        (call) =>
          call.action === 'database.modifyDocument' && call.merge === true && call.upsert === false,
      ),
    );
    assert.ok(
      calls.some(
        (call) =>
          call.action === 'database.modifyDocument' && call.merge === false && call.upsert === true,
      ),
    );
    assert.ok(calls.some((call) => call.action === 'database.removeDocument'));
    assert.ok(calls.some((call) => call.action === 'database.abortTransaction'));
    assert.equal(transactions.size, 0);
    console.log(
      JSON.stringify({
        actualBundledNativeAdapter: true,
        actualBundledSdk: true,
        transportOnlyReplacement: true,
        productWriteAcknowledgements: true,
        createAndRename: true,
        refusedWrites: refused,
        rollbackAndRetry: true,
        releaseId: health.data.releaseId,
        liveCloud: false,
        realNetwork: false,
      }),
    );
  } finally {
    http.request = originals.http;
    https.request = originals.https;
    net.Socket.prototype.connect = originals.connect;
    globalThis.fetch = originals.fetch;
  }
}
run().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
