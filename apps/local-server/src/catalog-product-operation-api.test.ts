import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { signSession } from '@vibelingan-channel/auth/jwt';
import { manageCatalogProductOperation, setAdapter } from '@vibelingan-channel/db';
import { handleAdminRequest } from '../../functions/admin/src/handler.ts';
import { JsonFileAdapter } from './json-adapter.ts';

const at = '2026-10-18T00:00:00.000Z';
const operationId = '12345678-1234-4234-8234-123456789012';
const query = { action: 'product-operation-get', productId: 'p', operationId };
const start = {
  ...query,
  action: 'product-operation-start',
  intent: 'save-draft',
  expectedUpdatedAt: at,
  values: { description: 'My reviewed draft' },
};
async function fixture(t: { after(callback: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), 'channel-operation-api-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'db.json');
  writeFileSync(
    file,
    JSON.stringify({
      users: [
        { _id: 'admin', role: 'admin', status: 'active' },
        { _id: 'other', role: 'admin', status: 'active' },
        { _id: 'guest', role: 'member', status: 'active' },
      ],
      products: [
        {
          _id: 'p',
          name: 'Clock',
          description: '',
          productFamily: 'misc',
          published: false,
          archived: false,
          imageIds: [],
          updatedAt: at,
        },
      ],
    }),
  );
  const adapter = new JsonFileAdapter(file);
  setAdapter(adapter);
  const config = { jwtSecret: 'operation-api-test-only', enableDetailApproval: true };
  const token = await signSession(config.jwtSecret, {
    sub: 'admin',
    role: 'admin',
    name: 'Admin',
    email: 'admin@example.test',
  });
  const invoke = (data: unknown, configOverride = config) =>
    handleAdminRequest({ action: 'catalogDetailApproval', token, data }, configOverride);
  return { file, adapter, config, invoke, bytes: () => readFileSync(file, 'utf8') };
}
function object(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

test('real admin handler starts and queries one bounded original operation without publishing or exposing its patch', async (t) => {
  const h = await fixture(t);
  const before = await h.adapter.get('products', 'p');
  const response = await h.invoke(start);
  assert.ok(response.ok, JSON.stringify(response));
  const status = object(response.data);
  assert.equal(status.kind, 'product-operation');
  assert.equal(status.state, 'reserved');
  assert.equal(status.productId, 'p');
  assert.equal(status.operationId, operationId);
  assert.equal(status.intent, 'save-draft');
  assert.equal(status.current, true);
  assert.equal(status.revisionCurrent, true);
  assert.equal(status.expired, false);
  assert.match(String(status.inputDigest), /^[a-f0-9]{64}$/);
  assert.equal('record' in status, false);
  assert.equal('values' in status, false);
  assert.doesNotMatch(JSON.stringify(status), /My reviewed draft/);
  assert.ok(Buffer.byteLength(JSON.stringify(status)) <= 4096);
  assert.deepEqual(await h.adapter.get('products', 'p'), before);
  const bytes = h.bytes();
  utimesSync(h.file, new Date(1000), new Date(1000));
  setAdapter(new JsonFileAdapter(h.file));
  assert.deepEqual(await h.invoke(query), response);
  assert.equal(h.bytes(), bytes);
  assert.equal(statSync(h.file).mtimeMs, 1000);
  assert.deepEqual(await h.invoke(start), response);
  assert.equal(h.bytes(), bytes);
});

test('normal 30000-character edit passes the operation endpoint and returns only a small status', async (t) => {
  const h = await fixture(t);
  const response = await h.invoke({ ...start, values: { description: '中'.repeat(30000) } });
  assert.ok(response.ok, JSON.stringify(response));
  assert.ok(Buffer.byteLength(JSON.stringify(response.data)) < 4096);
  assert.doesNotMatch(JSON.stringify(response), /中/);
  assert.equal((await h.adapter.get('products', 'p'))?.description, '');
});

test('explicit cancellation through the real handler is durable and repeat is read-only', async (t) => {
  const h = await fixture(t);
  const opened = await h.invoke(start);
  assert.ok(opened.ok);
  const inputDigest = object(opened.data).inputDigest;
  const command = { ...query, action: 'product-operation-cancel', inputDigest };
  const cancelled = await h.invoke(command);
  assert.ok(cancelled.ok, JSON.stringify(cancelled));
  assert.equal(object(cancelled.data).state, 'reserved');
  assert.equal(typeof object(cancelled.data).cancelledAt, 'string');
  const before = h.bytes();
  utimesSync(h.file, new Date(1000), new Date(1000));
  assert.deepEqual(await h.invoke(command), cancelled);
  assert.equal(h.bytes(), before);
  assert.equal(statSync(h.file).mtimeMs, 1000);
  assert.equal((await h.adapter.get('products', 'p'))?.published, false);
});

for (const action of [
  'operation-recover',
  'operation-start',
  'operation-get',
  'operation-cancel',
  'operation-publish',
  'operation-approval-begin',
  'operation-approval-page',
  'operation-approval-media',
  'operation-approval-references',
  'operation-approval-reference-page',
])
  test(`public operation status endpoint cannot accept internal ${action}`, async (t) => {
    const h = await fixture(t);
    const before = h.bytes();
    const result = await h.invoke({
      ...query,
      action,
      inputDigest: 'a'.repeat(64),
      operationRootId: 'b'.repeat(64),
      prepared: {},
    });
    assert.ok(!result.ok);
    assert.equal(h.bytes(), before);
  });
for (const extra of [
  { actorId: 'other' },
  { submittedInputDigest: 'a'.repeat(64) },
  { record: {} },
  { inputDigest: 'a'.repeat(64) },
  { prepared: {} },
  { values: { published: true } },
  { values: { archived: true } },
  { expectedUpdatedAt: 'wrong' },
])
  test(`operation start refuses untrusted ${JSON.stringify(extra)}`, async (t) => {
    const h = await fixture(t);
    const before = h.bytes();
    const result = await h.invoke({ ...start, ...extra });
    assert.ok(!result.ok && result.error.code === 'VALIDATION_ERROR', JSON.stringify(result));
    assert.equal(h.bytes(), before);
  });

test('existing approval gate and current stored role still protect operation requests', async (t) => {
  const h = await fixture(t);
  let before = h.bytes();
  let result = await h.invoke(start, { ...h.config, enableDetailApproval: false });
  assert.ok(!result.ok && result.error.code === 'FORBIDDEN');
  assert.equal(h.bytes(), before);
  const users = JSON.parse(h.bytes());
  users.users[0].status = 'suspended';
  writeFileSync(h.file, JSON.stringify(users));
  before = h.bytes();
  result = await h.invoke(start);
  assert.ok(!result.ok && result.error.code === 'UNAUTHORIZED');
  assert.equal(h.bytes(), before);
});

test('another admin and a different product cannot read the original operation through HTTP', async (t) => {
  const h = await fixture(t);
  assert.ok((await h.invoke(start)).ok);
  const before = h.bytes();
  const token = await signSession(h.config.jwtSecret, {
    sub: 'other',
    role: 'admin',
    name: 'Other',
    email: 'other@example.test',
  });
  const other = await handleAdminRequest(
    { action: 'catalogDetailApproval', token, data: query },
    h.config,
  );
  assert.ok(!other.ok && other.error.code === 'NOT_FOUND');
  const product = await h.invoke({ ...query, productId: 'other' });
  assert.ok(!product.ok && product.error.code === 'NOT_FOUND');
  assert.equal(h.bytes(), before);
});

test('operation input is captured before its first asynchronous store call', async (t) => {
  const h = await fixture(t);
  const input = { ...start, values: { description: 'Captured description' } };
  const pending = manageCatalogProductOperation('admin', input);
  input.values.description = 'Mutated while waiting';
  input.productId = 'other';
  const result = await pending;
  assert.ok(result.ok, JSON.stringify(result));
  const stored = JSON.parse(h.bytes()).catalogDetailApprovals[0];
  assert.equal(stored.productId, 'p');
  assert.equal(stored.operation.values.description, 'Captured description');
});

test('oversized operation input and oversized old preview remain rejected without writes', async (t) => {
  const h = await fixture(t);
  const before = h.bytes();
  for (const data of [
    { ...start, values: { description: 'x'.repeat(256 * 1024) } },
    { action: 'preview', productId: 'p', unknown: 'x'.repeat(4096) },
  ]) {
    const result = await h.invoke(data);
    assert.ok(!result.ok && result.error.code === 'VALIDATION_ERROR');
  }
  assert.equal(h.bytes(), before);
});

test('HTTP status reads the saved draft receipt after reopen without replaying the save', async (t) => {
  const h = await fixture(t);
  const opened = await h.invoke(start);
  assert.ok(opened.ok);
  const inputDigest = object(opened.data).inputDigest;
  assert.ok(typeof inputDigest === 'string');
  const saved = await h.adapter.saveCatalogProductWithIdentities({
    mode: 'update',
    productId: 'p',
    data: start.values,
    expectedUpdatedAt: at,
    expectedOperation: { actorId: 'admin', operationId, inputDigest },
  });
  assert.equal(saved.result, 'saved');
  setAdapter(new JsonFileAdapter(h.file));
  const before = h.bytes();
  const result = await h.invoke(query);
  assert.ok(result.ok, JSON.stringify(result));
  const status = object(result.data);
  assert.equal(status.state, 'saved');
  assert.equal(status.current, true);
  assert.equal(typeof object(status.saved).productUpdatedAt, 'string');
  assert.equal(h.bytes(), before);
  assert.equal((await h.adapter.get('products', 'p'))?.published, false);
  assert.equal((await h.adapter.get('products', 'p'))?.description, start.values.description);
});

test('expired operation status stays readable without implicitly cancelling or saving', async (t) => {
  const h = await fixture(t);
  assert.ok((await h.invoke(start)).ok);
  const rows = JSON.parse(h.bytes());
  rows.catalogDetailApprovals[0].createdAt = new Date(Date.now() - 3600001).toISOString();
  writeFileSync(h.file, JSON.stringify(rows));
  const before = h.bytes();
  const result = await h.invoke(query);
  assert.ok(result.ok, JSON.stringify(result));
  const status = object(result.data);
  assert.equal(status.expired, true);
  assert.equal(status.state, 'reserved');
  assert.equal('cancelledAt' in status, false);
  assert.equal(h.bytes(), before);
  assert.equal((await h.adapter.get('products', 'p'))?.published, false);
});
test('reusing an operation ID with a different reviewed edit conflicts without changing the original reservation', async (t) => {
  const h = await fixture(t);
  assert.ok((await h.invoke(start)).ok);
  const before = h.bytes();
  const result = await h.invoke({ ...start, values: { description: 'Different edit' } });
  assert.ok(!result.ok && result.error.code === 'CONFLICT');
  assert.equal(h.bytes(), before);
  assert.equal(
    JSON.parse(h.bytes()).catalogDetailApprovals[0].operation.values.description,
    start.values.description,
  );
});

test('operation start reports the website description limit as a field issue before any write', async (t) => {
  const h = await fixture(t);
  const before = h.bytes();
  const result = await h.invoke({ ...start, values: { description: 'x'.repeat(30001) } });
  assert.ok(!result.ok, JSON.stringify(result));
  assert.equal(result.error.code, 'VALIDATION_ERROR');
  assert.match(result.error.message, /description/i);
  const issues = object(result.error).issues;
  assert.ok(Array.isArray(issues));
  assert.ok(issues.some((issue) => issue.path === 'description' && issue.code === 'TOO_LONG'));
  assert.equal(h.bytes(), before);
});
