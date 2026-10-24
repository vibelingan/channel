// Runs only in a disposable smoke-test subprocess, never in a deployed function.
// Keep the real bundled handler, adapter, SDK and query serializer. Replace only
// HTTP transport so tests cannot touch a real environment or need credentials.
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const { Writable, Readable } = require('node:stream');

process.on('uncaughtException', (error) => {
  console.error(error.stack);
  process.exit(1);
});
process.env.TENCENTCLOUD_SECRETID = 'artifact-fake-id';
process.env.TENCENTCLOUD_SECRETKEY = 'artifact-fake-key';
process.env.TENCENTCLOUD_SESSIONTOKEN = 'artifact-fake-session';
process.env.SCF_NAMESPACE = 'artifact-smoke-env';
const calls = [];
const collections = new Set(JSON.parse(process.env.CHANNEL_SMOKE_COLLECTIONS || '[]'));
const product = {
  _id: 'smoke-product',
  name: 'Legacy smoke product',
  published: true,
  imageIds: [],
};

net.connect = net.createConnection = () => {
  throw new Error('Real network forbidden in artifact probe');
};
net.Socket.prototype.connect = () => {
  throw new Error('Real socket forbidden in artifact probe');
};
globalThis.fetch = async () => {
  throw new Error('Real fetch forbidden in artifact probe');
};
http.request = https.request = (_url, _options, callback) => {
  const chunks = [];
  const request = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(Buffer.from(chunk));
      done();
    },
    final(done) {
      const params = JSON.parse(Buffer.concat(chunks).toString());
      assert.ok(
        ['database.calculateDocument', 'database.getDocument'].includes(params.action),
        `Unexpected SDK action: ${params.action}`,
      );
      const name = params.collectionName;
      calls.push({ action: params.action, collection: name });
      let body;
      if (!collections.has(name)) {
        body = { code: 'DATABASE_COLLECTION_NOT_EXIST', message: `Missing collection: ${name}` };
      } else if (params.action === 'database.calculateDocument') {
        body = { data: { total: name === 'products' ? 1 : 0 } };
      } else {
        body = { data: { list: name === 'products' ? [JSON.stringify(product)] : [] } };
      }
      const response = Readable.from([
        Buffer.from(JSON.stringify({ ...body, requestId: 'smoke-only' })),
      ]);
      response.statusCode = 200;
      response.headers = { 'content-type': 'application/json' };
      callback(response);
      done();
    },
  });
  request.setTimeout = () => request;
  return request;
};

async function run() {
  const { main } = require(process.argv[2]);
  assert.equal(typeof main, 'function');
  const health = await main({ path: '/api/health', httpMethod: 'GET' });
  assert.equal(health.statusCode, 200);
  if (process.env.CHANNEL_EXPECTED_RELEASE) {
    assert.equal(
      JSON.parse(health.body).data.releaseId,
      process.env.CHANNEL_EXPECTED_RELEASE,
      'Prepared release was overwritten or built without its release id',
    );
  }
  const response = await main({
    path: '/api/products',
    httpMethod: 'GET',
    queryStringParameters: { page: '1', pageSize: '5' },
  });
  assert.equal(response.statusCode, 200);
  const result = JSON.parse(response.body);
  assert.equal(result.ok, true);
  assert.equal(result.data.total, 1);
  assert.equal(result.data.items[0]._id, product._id);
  assert.equal(Object.hasOwn(result.data.items[0], 'variants'), false);
  assert.ok(calls.some((c) => c.collection === 'products'));
  assert.ok(calls.some((c) => c.collection === 'productVariants'));
  console.log(
    'public-api: packaged health + legacy product/variant DB read passed (offline transport)',
  );
}
run().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
