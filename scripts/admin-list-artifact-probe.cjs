// Disposable artifact probe: keep the bundled handler, native adapter and SDK.
// Only transport is replaced; all writes and real sockets are forbidden.
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
process.env.TCB_ENV = 'owned-native-artifact-env';
process.env.JWT_SECRET = 'owned-native-artifact-secret';
process.env.TENCENTCLOUD_SECRETID = 'artifact-fake-id';
process.env.TENCENTCLOUD_SECRETKEY = 'artifact-fake-key';
process.env.TENCENTCLOUD_SESSIONTOKEN = 'artifact-fake-session';
process.env.SCF_NAMESPACE = process.env.TCB_ENV;
const review = {
  schemaVersion: 'alibaba-source-review-v1',
  provider: 'alibaba',
  externalProductId: 'external',
  sourceCategoryId: 'source-category',
  sourceListingStatus: 'published',
  variantCount: 3,
  offerCount: 4,
  modelNumbers: ['T142'],
  optionNames: ['Color'],
};
let nested = 'value';
for (let i = 0; i < 30; i++) nested = { nested };
const base = {
  productFamily: 'misc',
  subcategoryIds: ['clock'],
  published: false,
  updatedAt: '2026-10-18T00:00:00.000Z',
  alibabaPrimarySourceKey: 'source-key',
  alibabaSourceReview: review,
  description: 'private-description-'.repeat(5000),
  futurePrivateField: 'never-list',
};
const rows = [
  { ...base, _id: 'small', name: 'Small clock' },
  {
    ...base,
    _id: 'large',
    name: 'Large clock',
    alibabaSourceReview: {
      ...review,
      modelNumbers: Array.from({ length: 100 }, () => '中'.repeat(256)),
      optionNames: Array.from({ length: 100 }, () => '中'.repeat(256)),
    },
  },
  { ...base, _id: 'deep', name: 'Deep clock', alibabaSourceReview: { extra: nested } },
  { ...base, _id: 'core', name: `Core name ${'中'.repeat(5000)}` },
];
const before = JSON.stringify(rows);
const calls = [];
const originals = {
  http: http.request,
  https: https.request,
  connect: net.Socket.prototype.connect,
  fetch: globalThis.fetch,
};
const clone = (value) => JSON.parse(JSON.stringify(value));
const selected = (row, projection) => {
  const out = {};
  for (const [path, include] of Object.entries(projection)) {
    assert.deepEqual(include, { $numberInt: '1' });
    let value = row;
    for (const key of path.split('.'))
      value = value && typeof value === 'object' ? value[key] : undefined;
    if (value === undefined) continue;
    const keys = path.split('.');
    let target = out;
    for (const key of keys.slice(0, -1)) {
      if (!target[key]) target[key] = {};
      target = target[key];
    }
    target[keys.at(-1)] = clone(value);
  }
  return out;
};
net.Socket.prototype.connect = () => {
  throw Error('Real socket forbidden in native artifact probe');
};
globalThis.fetch = async () => {
  throw Error('Real fetch forbidden in native artifact probe');
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
        assert.ok(
          ['database.calculateDocument', 'database.getDocument'].includes(params.action),
          params.action,
        );
        const name = params.collectionName;
        assert.ok(['users', 'products'].includes(name), name);
        const query = typeof params.query === 'string' ? JSON.parse(params.query) : params.query;
        const projection = params.projection ? JSON.parse(params.projection) : null;
        calls.push({
          action: params.action,
          collection: name,
          queryType: params.queryType,
          projected: Boolean(projection),
        });
        let response;
        if (params.action === 'database.calculateDocument') {
          assert.equal(name, 'products');
          assert.equal(projection, null);
          response = { data: { total: rows.length } };
        } else {
          let docs = name === 'users' ? [{ _id: 'admin', role: 'admin' }] : rows;
          if (typeof query?._id === 'string') docs = docs.filter((doc) => doc._id === query._id);
          if (name === 'products' && projection) {
            for (const field of [
              '_id',
              'name',
              'published',
              'updatedAt',
              'productFamily',
              'subcategoryIds',
              'alibabaPrimarySourceKey',
              'alibabaSourceReview',
              'alibabaAutoPhotos.gallery',
            ])
              assert.deepEqual(projection[field], { $numberInt: '1' }, field);
            for (const field of [
              'description',
              'series',
              'futurePrivateField',
              'catalogPublication',
              'catalogPreparationReport',
              'alibabaAutoPhotos',
            ])
              assert.equal(Object.hasOwn(projection, field), false, field);
            docs = docs
              .slice(params.offset ?? 0, (params.offset ?? 0) + (params.limit ?? 100))
              .map((doc) => selected(doc, projection));
          }
          response = { data: { list: docs.map((doc) => JSON.stringify(doc)) } };
        }
        const stream = Readable.from([
          Buffer.from(JSON.stringify({ ...response, requestId: 'owned-native-artifact' })),
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
      assert.ok(
        response && typeof response.body === 'string',
        'Admin artifact did not return an HTTP response',
      );
      assert.equal(response.statusCode, 200, response.body.slice(0, 500));
      const wire = JSON.parse(response.body);
      assert.equal(wire.ok, true, JSON.stringify(wire).slice(0, 500));
      return wire;
    };
    const health = await api('health', {});
    const expected = process.argv[3] ?? process.env.CHANNEL_EXPECTED_RELEASE;
    if (expected) assert.equal(health.data.releaseId, expected);
    const complete = await api('get', { collection: 'products', id: 'large' });
    assert.deepEqual(complete.data, rows[1]);
    assert.equal(Object.hasOwn(complete.data, '_adminProductListView'), false);
    const start = calls.length;
    const response = await api('list', {
      collection: 'products',
      catalogListView: 'admin-product-list-v1',
      catalogReadiness: 'all',
      pageSize: 100,
      sort: [{ field: '_id', dir: 'asc' }],
    });
    const native = calls.slice(start);
    assert.equal(native.filter((c) => c.collection === 'users').length, 1);
    assert.equal(
      native.filter((c) => c.collection === 'products' && c.action === 'database.calculateDocument')
        .length,
      1,
    );
    assert.equal(
      native.filter(
        (c) => c.collection === 'products' && c.action === 'database.getDocument' && c.projected,
      ).length,
      1,
    );
    assert.equal(native.length, 3);
    assert.equal(response.data.total, rows.length);
    assert.deepEqual(
      response.data.items.map((row) => row._id).sort(),
      rows.map((row) => row._id).sort(),
    );
    for (const row of response.data.items) {
      assert.ok(
        Buffer.byteLength(JSON.stringify(row)) <= 8192,
        `compiled native projection must bound row ${row._id}`,
      );
      assert.equal(row._adminProductListView, 'admin-product-list-v1');
    }
    assert.ok(Buffer.byteLength(JSON.stringify(response)) <= 1024 * 1024);
    const byId = new Map(response.data.items.map((row) => [row._id, row]));
    assert.equal(Object.hasOwn(byId.get('small'), '_adminProductListLimited'), false);
    for (const id of ['large', 'deep', 'core'])
      assert.equal(byId.get(id)._adminProductListLimited, true, id);
    assert.equal(byId.get('large').alibabaSourceReview.sourceCategoryId, review.sourceCategoryId);
    assert.equal(byId.get('large').alibabaPrimarySourceKey, base.alibabaPrimarySourceKey);
    assert.equal(Object.hasOwn(byId.get('large'), '_adminProductListCoreIncomplete'), false);
    assert.equal(byId.get('core')._adminProductListCoreIncomplete, true);
    for (const row of response.data.items) assert.equal(row.published, false);
    const legacy = await api('list', {
      collection: 'products',
      catalogReadiness: 'all',
      pageSize: 100,
    });
    assert.equal(Object.hasOwn(legacy.data, 'catalogListView'), false);
    assert.deepEqual(legacy.data.items, rows);
    assert.equal(JSON.stringify(rows), before);
    assert.ok(
      calls.every((call) =>
        ['database.calculateDocument', 'database.getDocument'].includes(call.action),
      ),
    );
    console.log(
      JSON.stringify({
        actualBundledNativeAdapter: true,
        actualBundledSdk: true,
        transportOnlyReplacement: true,
        sourceAdapterInjected: false,
        completeGetPreserved: true,
        nativeReadCallsPerList: 3,
        perRowReads: 0,
        writes: 0,
        smallAndLargeAndDeepAndCore: true,
        responseBytes: Buffer.byteLength(JSON.stringify(response)),
        releaseId: health.data.releaseId,
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
