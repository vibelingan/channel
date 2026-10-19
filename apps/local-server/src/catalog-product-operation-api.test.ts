import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { signSession } from '@vibelingan-channel/auth/jwt';
import { sourceObservationDocumentId } from '@vibelingan-channel/catalog-import/observations';
import {
  manageCatalogProductOperation,
  persistCatalogDetailApproval,
  setAdapter,
} from '@vibelingan-channel/db';
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
  'operation-photo-claim',
  'operation-photo-release',
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

async function supplierEditApiFixture(t: { after(callback: () => void): void }) {
  const h = await fixture(t);
  const rows = JSON.parse(h.bytes());
  Object.assign(rows.products[0], {
    description: 'Supplier text',
    alibabaPrimarySourceKey: 's',
    alibabaReviewPending: true,
    alibabaReviewReason: 'changed',
    catalogDetailPublication: {
      state: 'approved',
      revision: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      header: {
        _id: 'p',
        schemaVersion: 'catalog-product-detail-v1',
        name: 'Clock',
        categoryLabel: 'Misc',
        descriptionText: 'Old supplier text',
        images: [],
        facts: [],
        offers: [],
      },
      variantCount: 0,
    },
    catalogDetailApprovalReceipt: {
      supplierParts: { description: true, gallery: true, descriptionImages: true },
    },
  });
  rows.catalogSourceObservations = [
    {
      _id: sourceObservationDocumentId('alibaba', 's'),
      observation: {
        schemaVersion: 'catalog-source-observation-v1',
        source: {
          provider: 'alibaba',
          sourceProductKey: 's',
          externalProductId: 'external-s',
          observedAt: at,
          captureMode: 'selected',
          completeness: 'full-product',
        },
        identity: { title: 'Supplier clock', matchHints: {}, attributes: [] },
        content: {
          description: {
            text: 'Supplier text',
            placeholder: false,
            sanitized: true,
            provenance: 'provider-description',
          },
          media: [],
        },
        lifecycle: { sourceListingStatus: 'published' },
        variants: [],
        offers: [],
        evidence: [{ kind: 'raw-payload', evidenceId: 'a'.repeat(64) }],
        warnings: [],
      },
    },
  ];
  writeFileSync(h.file, JSON.stringify(rows));
  return h;
}
function saveCommand(opened: { ok: true; data: unknown }) {
  return {
    ...query,
    action: 'product-operation-save',
    inputDigest: object(opened.data).inputDigest,
  };
}
function assertSaved(response: Awaited<ReturnType<typeof handleAdminRequest>>) {
  assert.ok(response.ok, JSON.stringify(response));
  const status = object(response.data);
  assert.equal(status.kind, 'product-operation');
  assert.equal(status.state, 'saved');
  assert.equal(status.current, true);
  assert.equal(status.revisionCurrent, true);
  assert.ok(Buffer.byteLength(JSON.stringify(status)) <= 4096);
  for (const key of ['record', 'values', 'submittedInputDigest', 'source', 'doc'])
    assert.equal(key in status, false);
  return status;
}
test('actual Admin start freezes keep decisions and saves only that original supplier edit', async (t) => {
  const h = await supplierEditApiFixture(t);
  const before = object(await h.adapter.get('products', 'p'));
  const opened = await h.invoke(start);
  assert.ok(opened.ok, JSON.stringify(opened));
  const root = JSON.parse(h.bytes()).catalogDetailApprovals[0];
  assert.equal(root.operation.values.supplierDecisions.description.choice, 'keep');
  assert.equal((await h.adapter.get('products', 'p'))?.description, 'Supplier text');
  const saved = assertSaved(await h.invoke(saveCommand(opened)));
  assert.equal('approval' in saved, false);
  const product = object(await h.adapter.get('products', 'p'));
  assert.equal(product.description, start.values.description);
  assert.equal(product.published, false);
  assert.equal(product.alibabaReviewPending, true);
  assert.deepEqual(product.supplierDecisions, root.operation.values.supplierDecisions);
  for (const field of ['productFamily', 'category', 'subcategoryIds']) {
    assert.equal(Object.hasOwn(product, field), Object.hasOwn(before, field));
    assert.deepEqual(product[field], before[field]);
  }
});
test('actual Admin normalized start/save retry never recalculates a newer incoming supplier value', async (t) => {
  const h = await supplierEditApiFixture(t);
  const opened = await h.invoke(start);
  assert.ok(opened.ok);
  const response = await h.invoke(saveCommand(opened));
  assertSaved(response);
  const rows = JSON.parse(h.bytes());
  rows.catalogSourceObservations[0].observation.content.description.text =
    'New incoming supplier text';
  writeFileSync(h.file, JSON.stringify(rows));
  const before = h.bytes();
  utimesSync(h.file, new Date(1000), new Date(1000));
  setAdapter(new JsonFileAdapter(h.file));
  assert.deepEqual(await h.invoke(start), response);
  assert.deepEqual(await h.invoke(saveCommand(opened)), response);
  assert.equal(h.bytes(), before);
  assert.equal(statSync(h.file).mtimeMs, 1000);
});
test('actual Admin owned draft save uses original atomic URL and SKU normalization', async (t) => {
  const h = await fixture(t);
  const opened = await h.invoke({
    ...start,
    values: { name: 'Edited clock', slug: '  Clock-URL  ', skuCode: '  sku-001  ' },
  });
  assert.ok(opened.ok, JSON.stringify(opened));
  assertSaved(await h.invoke(saveCommand(opened)));
  const product = object(await h.adapter.get('products', 'p'));
  assert.equal(product.name, 'Edited clock');
  assert.equal(product.slug, 'clock-url');
  assert.equal(product.skuCode, 'sku-001');
  assert.equal(product.published, false);
});
test('actual Admin saves a 30000-character description without website category or publication', async (t) => {
  const h = await fixture(t);
  const rows = JSON.parse(h.bytes());
  Reflect.deleteProperty(rows.products[0], 'productFamily');
  writeFileSync(h.file, JSON.stringify(rows));
  const description = '中'.repeat(30000);
  const opened = await h.invoke({ ...start, values: { description } });
  assert.ok(opened.ok);
  assertSaved(await h.invoke(saveCommand(opened)));
  const product = object(await h.adapter.get('products', 'p'));
  assert.equal(product.description, description);
  assert.equal(product.published, false);
  assert.equal(Object.hasOwn(product, 'productFamily'), false);
});
for (const extra of [
  { values: { description: 'Another patch' } },
  { expectedOperation: {} },
  { actorId: 'other' },
  { published: true },
  { record: {} },
])
  test(`actual Admin owned save rejects injected ${Object.keys(extra).join(',')}`, async (t) => {
    const h = await fixture(t);
    const opened = await h.invoke(start);
    assert.ok(opened.ok);
    const before = h.bytes();
    const response = await h.invoke({ ...saveCommand(opened), ...extra });
    assert.ok(!response.ok && response.error.code === 'VALIDATION_ERROR', JSON.stringify(response));
    assert.equal(h.bytes(), before);
  });
test('actual Admin owned save cannot create an unreserved operation', async (t) => {
  const h = await fixture(t);
  const before = h.bytes();
  const response = await h.invoke({
    ...query,
    action: 'product-operation-save',
    inputDigest: 'a'.repeat(64),
  });
  assert.ok(!response.ok && response.error.code === 'NOT_FOUND', JSON.stringify(response));
  assert.equal(h.bytes(), before);
});
test('actual Admin owned save refuses the wrong operation digest without changing the draft', async (t) => {
  const h = await fixture(t);
  const opened = await h.invoke(start);
  assert.ok(opened.ok);
  const before = h.bytes();
  const response = await h.invoke({ ...saveCommand(opened), inputDigest: 'a'.repeat(64) });
  assert.ok(!response.ok && response.error.code === 'CONFLICT', JSON.stringify(response));
  assert.equal(h.bytes(), before);
});
test('a second admin cannot save the original admin operation', async (t) => {
  const h = await fixture(t);
  const opened = await h.invoke(start);
  assert.ok(opened.ok);
  const before = h.bytes();
  const token = await signSession(h.config.jwtSecret, {
    sub: 'other',
    role: 'admin',
    name: 'Other',
    email: 'other@example.test',
  });
  const response = await handleAdminRequest(
    { action: 'catalogDetailApproval', token, data: saveCommand(opened) },
    h.config,
  );
  assert.ok(!response.ok);
  assert.equal(h.bytes(), before);
});
for (const change of ['edit', 'publish', 'archive', 'cancel', 'expire', 'revoke'])
  test(`actual Admin owned save refuses ${change} before saving`, async (t) => {
    const h = await fixture(t);
    const opened = await h.invoke(start);
    assert.ok(opened.ok);
    if (change === 'cancel') {
      const response = await h.invoke({
        ...saveCommand(opened),
        action: 'product-operation-cancel',
      });
      assert.ok(response.ok);
    } else {
      const rows = JSON.parse(h.bytes());
      if (change === 'edit') {
        rows.products[0].name = 'Another writer';
        rows.products[0].updatedAt = '2026-10-18T00:00:01.000Z';
      }
      if (change === 'publish') rows.products[0].published = true;
      if (change === 'archive') rows.products[0].archived = true;
      if (change === 'expire')
        rows.catalogDetailApprovals[0].createdAt = '2000-01-01T00:00:00.000Z';
      if (change === 'revoke') rows.users[0].role = 'member';
      writeFileSync(h.file, JSON.stringify(rows));
    }
    const before = h.bytes();
    const response = await h.invoke(saveCommand(opened));
    assert.ok(!response.ok, JSON.stringify(response));
    assert.equal(h.bytes(), before);
  });
test('atomic save rechecks a role revoked after operation status was read', async (t) => {
  const h = await fixture(t);
  const opened = await h.invoke(start);
  assert.ok(opened.ok);
  const original = h.adapter.saveCatalogProductWithIdentities.bind(h.adapter);
  let afterRevocation = '';
  h.adapter.saveCatalogProductWithIdentities = async (input) => {
    await h.adapter.update('users', 'admin', { role: 'member' });
    afterRevocation = h.bytes();
    return original(input);
  };
  const response = await h.invoke(saveCommand(opened));
  assert.ok(!response.ok, JSON.stringify(response));
  assert.equal(h.bytes(), afterRevocation);
  assert.equal((await h.adapter.get('products', 'p'))?.description, '');
});
test('actual Admin recovers a committed owned save after its answer is lost and process is reopened', async (t) => {
  const h = await fixture(t);
  const opened = await h.invoke(start);
  assert.ok(opened.ok);
  const original = h.adapter.saveCatalogProductWithIdentities.bind(h.adapter);
  h.adapter.saveCatalogProductWithIdentities = async (input) => {
    const result = await original(input);
    assert.equal(result.result, 'saved');
    throw Error('controlled committed save response lost');
  };
  const failed = await h.invoke(saveCommand(opened));
  assert.ok(!failed.ok);
  assert.equal((await h.adapter.get('products', 'p'))?.description, start.values.description);
  const before = h.bytes();
  utimesSync(h.file, new Date(1000), new Date(1000));
  setAdapter(new JsonFileAdapter(h.file));
  const status = await h.invoke(query);
  assertSaved(status);
  assert.deepEqual(await h.invoke(saveCommand(opened)), status);
  assert.equal(h.bytes(), before);
  assert.equal(statSync(h.file).mtimeMs, 1000);
});
test('two actual Admin owned save clicks share one saved receipt', async (t) => {
  const h = await fixture(t);
  const opened = await h.invoke(start);
  assert.ok(opened.ok);
  const [one, two] = await Promise.all([
    h.invoke(saveCommand(opened)),
    h.invoke(saveCommand(opened)),
  ]);
  assertSaved(one);
  assert.deepEqual(two, one);
  assert.equal(
    JSON.parse(h.bytes()).catalogDetailApprovals.filter(
      (row: { operationId?: string }) => row.operationId === operationId,
    ).length,
    1,
  );
});
test('actual Admin owned save reports the conflicting URL as an editable field', async (t) => {
  const h = await fixture(t);
  await h.adapter.saveCatalogProductWithIdentities({
    mode: 'create',
    productId: 'another',
    data: { name: 'Other', slug: 'used-url', published: false },
  });
  const opened = await h.invoke({ ...start, values: { slug: 'used-url' } });
  assert.ok(opened.ok);
  const before = h.bytes();
  const response = await h.invoke(saveCommand(opened));
  assert.ok(!response.ok && response.error.code === 'VALIDATION_ERROR', JSON.stringify(response));
  assert.ok('issues' in response.error);
  assert.ok(
    response.error.issues?.some((issue) => issue.path === 'slug' && issue.remedy === 'edit'),
  );
  assert.equal(h.bytes(), before);
});
test('actual Admin owned save reports new unprepared photos without changing the original draft', async (t) => {
  const h = await fixture(t);
  const opened = await h.invoke({ ...start, values: { imageIds: ['new-photo'] } });
  assert.ok(opened.ok);
  const before = h.bytes();
  const response = await h.invoke(saveCommand(opened));
  assert.ok(!response.ok && response.error.code === 'VALIDATION_ERROR', JSON.stringify(response));
  assert.ok('issues' in response.error);
  assert.ok(
    response.error.issues?.some((issue) => issue.path === 'imageIds' && issue.remedy === 'edit'),
  );
  assert.equal(h.bytes(), before);
});
test('owned draft save refuses a live refresh intent without altering its public content', async (t) => {
  const h = await fixture(t);
  const rows = JSON.parse(h.bytes());
  rows.products[0].published = true;
  writeFileSync(h.file, JSON.stringify(rows));
  const opened = await h.invoke({ ...start, intent: 'refresh-live' });
  assert.ok(opened.ok, JSON.stringify(opened));
  const before = h.bytes();
  const response = await h.invoke(saveCommand(opened));
  assert.ok(!response.ok && response.error.code === 'CONFLICT', JSON.stringify(response));
  assert.equal(h.bytes(), before);
});

for (const values of [{ slug: 'admin' }, { skuCode: 'x'.repeat(121) }])
  test(`actual Admin start locates invalid identity ${Object.keys(values).join(',')}`, async (t) => {
    const h = await fixture(t);
    const before = h.bytes();
    const response = await h.invoke({ ...start, values });
    assert.ok(!response.ok && response.error.code === 'VALIDATION_ERROR', JSON.stringify(response));
    assert.ok('issues' in response.error);
    assert.ok(
      response.error.issues?.some(
        (issue) => issue.remedy === 'edit' && issue.path === Object.keys(values)[0],
      ),
    );
    assert.equal(h.bytes(), before);
  });

test('a saved operation later changed by another writer remains a readonly historical save result', async (t) => {
  const h = await fixture(t);
  const opened = await h.invoke(start);
  assert.ok(opened.ok);
  assertSaved(await h.invoke(saveCommand(opened)));
  await h.adapter.update('products', 'p', {
    name: 'New external name',
    updatedAt: '2030-01-01T00:00:00.000Z',
  });
  const before = h.bytes();
  const response = await h.invoke(saveCommand(opened));
  assert.ok(response.ok, JSON.stringify(response));
  assert.equal(object(response.data).state, 'saved');
  assert.equal(object(response.data).current, false);
  assert.equal(object(response.data).revisionCurrent, false);
  assert.equal(h.bytes(), before);
  assert.equal((await h.adapter.get('products', 'p'))?.name, 'New external name');
});

test('actual Admin publish intent saves the frozen draft without approving or publishing it', async (t) => {
  const h = await fixture(t);
  const opened = await h.invoke({ ...start, intent: 'publish' });
  assert.ok(opened.ok, JSON.stringify(opened));
  const saved = assertSaved(await h.invoke(saveCommand(opened)));
  assert.equal(saved.intent, 'publish');
  assert.equal('completion' in saved, false);
  assert.equal((await h.adapter.get('products', 'p'))?.published, false);
});

for (const slug of ['clock-url', '  Clock URL '])
  test(`legacy reserved identity ${JSON.stringify(slug)} stays immutable at the public save boundary`, async (t) => {
    const h = await fixture(t);
    const internal = await persistCatalogDetailApproval('admin', {
      ...start,
      action: 'operation-start',
      intent: 'save-draft',
      values: { slug },
    });
    assert.ok(internal.ok);
    const opened = await h.invoke(query);
    assert.ok(opened.ok);
    const before = h.bytes();
    const response = await h.invoke(saveCommand(opened));
    if (slug === 'clock-url') {
      assertSaved(response);
      assert.equal((await h.adapter.get('products', 'p'))?.slug, 'clock-url');
    } else {
      assert.ok(
        !response.ok && response.error.code === 'VALIDATION_ERROR',
        JSON.stringify(response),
      );
      assert.ok('issues' in response.error);
      assert.ok(
        response.error.issues?.some(
          (issue) => issue.code === 'INPUT_CHANGED' && issue.remedy === 'reload',
        ),
      );
      assert.equal(h.bytes(), before);
    }
  });

test('actual Admin owned save preserves intentional clearing of optional website identities', async (t) => {
  const h = await fixture(t);
  const opened = await h.invoke({ ...start, values: { slug: '  ', skuCode: '\t' } });
  assert.ok(opened.ok, JSON.stringify(opened));
  assertSaved(await h.invoke(saveCommand(opened)));
  const product = object(await h.adapter.get('products', 'p'));
  assert.equal(product.slug, '');
  assert.equal(product.skuCode, '');
});

test('actual Admin save racing cancellation cannot reactivate the cancelled operation', async (t) => {
  const h = await fixture(t);
  const opened = await h.invoke(start);
  assert.ok(opened.ok);
  const command = saveCommand(opened);
  const results = await Promise.allSettled([
    h.invoke(command),
    h.invoke({ ...command, action: 'product-operation-cancel' }),
  ]);
  for (const result of results) assert.equal(result.status, 'fulfilled');
  const cancelled = await h.invoke(query);
  assert.ok(cancelled.ok, JSON.stringify(cancelled));
  const status = object(cancelled.data);
  assert.equal(typeof status.cancelledAt, 'string');
  assert.equal(status.current, false);
  const product = object(await h.adapter.get('products', 'p'));
  assert.equal(product.published, false);
  assert.equal(product.description, status.state === 'reserved' ? '' : start.values.description);
  const before = h.bytes();
  const replayed = await h.invoke(command);
  assert.ok(!replayed.ok && replayed.error.code === 'CONFLICT', JSON.stringify(replayed));
  assert.equal(h.bytes(), before);
});

test('actual Admin owned save and another versioned editor cannot both overwrite the same original draft', async (t) => {
  const h = await fixture(t);
  const opened = await h.invoke(start);
  assert.ok(opened.ok);
  const [owned, other] = await Promise.allSettled([
    h.invoke(saveCommand(opened)),
    h.adapter.saveCatalogProductWithIdentities({
      mode: 'update',
      productId: 'p',
      data: { description: 'Other editor' },
      expectedUpdatedAt: at,
    }),
  ]);
  assert.equal(owned.status, 'fulfilled');
  assert.equal(other.status, 'fulfilled');
  assert.ok(owned.status === 'fulfilled' && other.status === 'fulfilled');
  const ownedWon = owned.value.ok;
  const otherWon = other.value.result === 'saved';
  assert.equal(Number(ownedWon) + Number(otherWon), 1);
  assert.equal(
    (await h.adapter.get('products', 'p'))?.description,
    ownedWon ? start.values.description : 'Other editor',
  );
  assert.equal((await h.adapter.get('products', 'p'))?.published, false);
});
