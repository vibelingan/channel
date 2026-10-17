import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { sourceObservationDocumentId } from '@vibelingan-channel/catalog-import/observations';
import { setAdapter, unfinishedApprovalUsingImage } from '@vibelingan-channel/db';
import { catalogApprovalDigest } from '@vibelingan-channel/db/catalog-detail-commit';
import { prepareStagedApproval } from '@vibelingan-channel/db/catalog-detail-staging';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { planCatalogDetailApproval } from '@vibelingan-channel/shared/catalog-detail-approval';
import { JsonFileAdapter } from './json-adapter.ts';

const at = '2026-10-18T00:00:00.000Z';
const operationId = '12345678-1234-4234-8234-123456789012';
const values = { description: 'Reviewed draft', slug: 'reviewed-clock', skuCode: 'REVIEWED' };
const start = {
  action: 'operation-start' as const,
  productId: 'p',
  operationId,
  intent: 'save-draft' as const,
  expectedUpdatedAt: at,
  values,
};
const query = { action: 'operation-get' as const, productId: 'p', operationId };
function fixture(t: { after(callback: () => void): void }, extra: Record<string, unknown> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'channel-operation-save-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'db.json');
  writeFileSync(
    file,
    JSON.stringify({
      users: [
        { _id: 'admin', role: 'admin' },
        { _id: 'other', role: 'admin' },
        { _id: 'guest', role: 'member' },
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
          ...extra,
        },
      ],
    }),
  );
  const adapter = new JsonFileAdapter(file);
  return { file, adapter, bytes: () => readFileSync(file, 'utf8') };
}
async function reserve(adapter: JsonFileAdapter, command = start) {
  const answer = await adapter.persistCatalogDetailApproval('admin', command);
  assert.ok(answer.ok && 'record' in answer, JSON.stringify(answer));
  return {
    answer,
    input: {
      mode: 'update' as const,
      productId: 'p',
      data: structuredClone(command.values),
      expectedUpdatedAt: command.expectedUpdatedAt,
      expectedOperation: {
        actorId: 'admin',
        operationId,
        inputDigest: answer.record.operation.inputDigest,
      },
    },
  };
}

test('draft save and own receipt persist together; lost response is recoverable after reopen with zero repeated writes', async (t) => {
  const h = fixture(t);
  const { input, answer: reserved } = await reserve(h.adapter);
  const saved = await h.adapter.saveCatalogProductWithIdentities(input);
  assert.equal(saved.result, 'saved');
  const reopened = new JsonFileAdapter(h.file);
  const receipt = await reopened.persistCatalogDetailApproval('admin', query);
  assert.ok(receipt.ok && 'record' in receipt && receipt.current);
  assert.equal(receipt.record.state, 'saved');
  assert.deepEqual(
    receipt.record.operation.base,
    reserved.record.operation.base,
    'initial baseline remains immutable',
  );
  const row = await reopened.get('products', 'p');
  assert.equal(row?.description, values.description);
  assert.equal(row?.catalogContentGeneration, 1);
  assert.equal(row?.published, false);
  const bytes = h.bytes();
  utimesSync(h.file, new Date(1000), new Date(1000));
  const retry = await reopened.saveCatalogProductWithIdentities(input);
  assert.equal(retry.result, 'saved');
  assert.deepEqual(await reopened.get('products', 'p'), row);
  assert.equal(h.bytes(), bytes);
  assert.equal(
    statSync(h.file).mtimeMs,
    1000,
    'an acknowledged retry does not rewrite product, aliases or receipt',
  );
  const repeatedStart = await reopened.persistCatalogDetailApproval('admin', start);
  assert.ok(repeatedStart.ok && 'record' in repeatedStart && repeatedStart.current);
  assert.deepEqual(repeatedStart.record, receipt.record);
  assert.equal(statSync(h.file).mtimeMs, 1000);
});

for (const mutation of [
  'wrong-actor',
  'member',
  'wrong-operation',
  'wrong-digest',
  'changed-patch',
  'changed-guard',
  'missing-guard',
  'wrong-product',
  'create-mode',
] as const)
  test(`bound draft save refuses ${mutation} without changing any storage`, async (t) => {
    const h = fixture(t);
    const { input } = await reserve(h.adapter);
    const changed = structuredClone(input);
    if (mutation === 'wrong-actor') changed.expectedOperation.actorId = 'other';
    if (mutation === 'member') changed.expectedOperation.actorId = 'guest';
    if (mutation === 'wrong-operation')
      changed.expectedOperation.operationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    if (mutation === 'wrong-digest') changed.expectedOperation.inputDigest = '0'.repeat(64);
    if (mutation === 'changed-patch') changed.data.description = 'Unreviewed';
    if (mutation === 'changed-guard') changed.expectedUpdatedAt = '2026-10-18T00:00:01.000Z';
    if (mutation === 'missing-guard') Reflect.deleteProperty(changed, 'expectedUpdatedAt');
    if (mutation === 'wrong-product') changed.productId = 'other';
    if (mutation === 'create-mode') Reflect.set(changed, 'mode', 'create');
    const before = h.bytes();
    const result = await h.adapter.saveCatalogProductWithIdentities(changed);
    assert.notEqual(result.result, 'saved');
    assert.equal(h.bytes(), before);
  });

for (const change of [
  { description: 'Other administrator edit' },
  { published: false },
  { archived: true },
  { alibabaPrimarySourceKey: 'changed-source' },
  { alibabaLinkRevision: 2 },
])
  for (const afterSave of [false, true])
    test(`foreign change refuses the original ${afterSave ? 'saved' : 'reserved'} operation ${JSON.stringify(change)}`, async (t) => {
      const h = fixture(t, { alibabaPrimarySourceKey: 'original-source', alibabaLinkRevision: 1 });
      const { input } = await reserve(h.adapter);
      if (afterSave)
        assert.equal((await h.adapter.saveCatalogProductWithIdentities(input)).result, 'saved');
      assert.equal(
        (
          await h.adapter.saveCatalogProductWithIdentities({
            mode: 'update',
            productId: 'p',
            data: change,
          })
        ).result,
        'saved',
      );
      const before = h.bytes();
      const receipt = await h.adapter.persistCatalogDetailApproval('admin', query);
      assert.ok(receipt.ok && 'record' in receipt);
      assert.equal(receipt.current, false);
      assert.equal(receipt.record.state, afterSave ? 'saved' : 'reserved');
      const result = await h.adapter.saveCatalogProductWithIdentities(input);
      assert.notEqual(result.result, 'saved');
      assert.equal(h.bytes(), before);
    });

for (const patch of [
  { name: 'n'.repeat(1001) },
  { description: 'd'.repeat(30001) },
  { imageIds: ['new-image'], description: 'Do not partly save text' },
  { descriptionImageIds: ['new-image'] },
  { configurationPhotos: { variant: ['new-image'] } },
  { published: true },
])
  test(`bound draft never partially saves unsupported or invalid input ${Object.keys(patch).join(',')}`, async (t) => {
    const h = fixture(t);
    const result = await h.adapter.persistCatalogDetailApproval('admin', {
      ...start,
      values: patch,
    });
    if (!result.ok) return;
    assert.ok('record' in result);
    const before = h.bytes();
    const saved = await h.adapter.saveCatalogProductWithIdentities({
      mode: 'update',
      productId: 'p',
      data: patch,
      expectedUpdatedAt: at,
      expectedOperation: {
        actorId: 'admin',
        operationId,
        inputDigest: result.record.operation.inputDigest,
      },
    });
    assert.equal(saved.result, 'invalid-product');
    assert.ok(
      saved.result === 'invalid-product' &&
        saved.issues.some((issue) => issue.field === Object.keys(patch)[0]),
    );
    assert.equal(h.bytes(), before);
  });

test('bound draft can repair text with bad unchanged supplier data and reorder or remove existing image references', async (t) => {
  const h = fixture(t, {
    name: 'n'.repeat(1001),
    imageIds: ['one', 'two'],
    descriptionImageIds: ['old'],
    alibabaSourceReview: { broken: 'source capture retained' },
  });
  const patch = {
    name: 'Repaired clock',
    description: 'Reviewed',
    imageIds: ['two', 'one'],
    descriptionImageIds: [],
  };
  const begun = await h.adapter.persistCatalogDetailApproval('admin', { ...start, values: patch });
  assert.ok(begun.ok && 'record' in begun);
  const result = await h.adapter.saveCatalogProductWithIdentities({
    mode: 'update',
    productId: 'p',
    data: patch,
    expectedUpdatedAt: at,
    expectedOperation: {
      actorId: 'admin',
      operationId,
      inputDigest: begun.record.operation.inputDigest,
    },
  });
  assert.equal(result.result, 'saved');
  const row = await h.adapter.get('products', 'p');
  assert.deepEqual(row?.imageIds, ['two', 'one']);
  assert.deepEqual(row?.descriptionImageIds, []);
  assert.deepEqual(row?.alibabaSourceReview, { broken: 'source capture retained' });
  const receipt = await h.adapter.persistCatalogDetailApproval('admin', query);
  assert.ok(receipt.ok && 'record' in receipt && receipt.current);
  assert.equal(receipt.record.state, 'saved');
});

test('a past-policy own receipt stays readable but cannot authorize another save', async (t) => {
  const h = fixture(t);
  const { input } = await reserve(h.adapter);
  assert.equal((await h.adapter.saveCatalogProductWithIdentities(input)).result, 'saved');
  const rows: Record<string, CollectionDoc[]> = JSON.parse(h.bytes());
  const record = rows.catalogDetailApprovals?.[0];
  assert.ok(record);
  assert.ok(record.operation && typeof record.operation === 'object');
  Reflect.set(record.operation, 'policy', {
    preparation: 'past-policy',
    media: 'past-policy',
    pixels: 'past-policy',
  });
  writeFileSync(h.file, JSON.stringify(rows));
  const adapter = new JsonFileAdapter(h.file);
  const before = h.bytes();
  const old = await adapter.persistCatalogDetailApproval('admin', query);
  assert.ok(old.ok && 'record' in old, 'policy migration cannot erase an existing receipt');
  assert.equal(old.current, false);
  assert.equal((await adapter.saveCatalogProductWithIdentities(input)).result, 'stale');
  assert.equal(h.bytes(), before);
});

test('bound JSON save freezes the patch and binding before waiting for its storage lock', async (t) => {
  const h = fixture(t);
  const { input } = await reserve(h.adapter);
  const pending = h.adapter.saveCatalogProductWithIdentities(input);
  input.data.description = 'Changed after dispatch';
  input.expectedOperation.inputDigest = '0'.repeat(64);
  assert.equal((await pending).result, 'saved');
  assert.equal((await h.adapter.get('products', 'p'))?.description, values.description);
});

for (const intent of ['refresh-live', 'unpublish', 'archive'] as const)
  test(`the draft stage cannot execute a reserved ${intent} intent`, async (t) => {
    const h = fixture(t, intent === 'refresh-live' ? { published: true } : {});
    const answer = await h.adapter.persistCatalogDetailApproval('admin', { ...start, intent });
    assert.ok(answer.ok && 'record' in answer);
    const before = h.bytes();
    const result = await h.adapter.saveCatalogProductWithIdentities({
      mode: 'update',
      productId: 'p',
      data: values,
      expectedUpdatedAt: at,
      expectedOperation: {
        actorId: 'admin',
        operationId,
        inputDigest: answer.record.operation.inputDigest,
      },
    });
    assert.equal(result.result, 'stale');
    assert.equal(h.bytes(), before);
  });

test('two adapters racing a draft operation share one saved receipt and content generation', async (t) => {
  const h = fixture(t);
  const { input } = await reserve(h.adapter);
  const other = new JsonFileAdapter(h.file);
  const results = await Promise.allSettled([
    h.adapter.saveCatalogProductWithIdentities(input),
    other.saveCatalogProductWithIdentities(input),
  ]);
  assert.equal(
    results.filter((result) => result.status === 'fulfilled' && result.value.result === 'saved')
      .length,
    2,
    'the second request reads the first own receipt',
  );
  const row = await new JsonFileAdapter(h.file).get('products', 'p');
  assert.equal(row?.catalogContentGeneration, 1);
  const data: Record<string, CollectionDoc[]> = JSON.parse(h.bytes());
  assert.ok(data.catalogDetailApprovals);
  assert.equal(data.catalogDetailApprovals.length, 1);
  assert.equal(data.catalogDetailApprovals[0]?.state, 'saved');
});

test('an operation cannot reserve a live product as save-draft', async (t) => {
  const h = fixture(t, { published: true });
  const before = h.bytes();
  const answer = await h.adapter.persistCatalogDetailApproval('admin', start);
  assert.equal(answer.ok, false);
  assert.equal(h.bytes(), before);
});

for (const operationFirst of [true, false])
  test(`draft operation and another guarded save serialize; operation first=${operationFirst}`, async (t) => {
    const h = fixture(t);
    const { input } = await reserve(h.adapter);
    const other = new JsonFileAdapter(h.file);
    const ownSave = () => h.adapter.saveCatalogProductWithIdentities(input);
    const foreignSave = () =>
      other.saveCatalogProductWithIdentities({
        mode: 'update',
        productId: 'p',
        data: { description: 'Other guarded save' },
        expectedUpdatedAt: at,
      });
    const results = await Promise.allSettled(
      (operationFirst ? [ownSave, foreignSave] : [foreignSave, ownSave]).map((save) => save()),
    );
    const answers = results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    assert.equal(answers.filter((answer) => answer.result === 'saved').length, 1);
    assert.equal(answers.filter((answer) => answer.result === 'stale').length, 1);
    const adapter = new JsonFileAdapter(h.file);
    const row = await adapter.get('products', 'p');
    assert.equal(row?.description, operationFirst ? values.description : 'Other guarded save');
    assert.equal(row?.catalogContentGeneration, 1);
    const receipt = await adapter.persistCatalogDetailApproval('admin', query);
    assert.ok(receipt.ok && 'record' in receipt);
    assert.equal(receipt.record.state, operationFirst ? 'saved' : 'reserved');
    assert.equal(receipt.current, operationFirst);
  });

test('real JSON rename failure cannot commit only a product or receipt; the original input can retry', async (t) => {
  const h = fixture(t);
  const { input } = await reserve(h.adapter);
  const before = h.bytes();
  const original: unknown = Reflect.get(h.adapter, 'persist');
  assert.ok(typeof original === 'function');
  const memory: unknown = structuredClone(Reflect.get(h.adapter, 'store'));
  Reflect.set(h.adapter, 'persist', () => {
    const backup = `${h.file}.before`;
    renameSync(h.file, backup);
    mkdirSync(h.file);
    try {
      Reflect.apply(original, h.adapter, []);
    } finally {
      rmSync(h.file, { recursive: true, force: true });
      renameSync(backup, h.file);
    }
  });
  try {
    await assert.rejects(
      h.adapter.saveCatalogProductWithIdentities(input),
      /EISDIR|ENOTDIR|directory/i,
    );
  } finally {
    Reflect.set(h.adapter, 'persist', original);
  }
  assert.equal(h.bytes(), before);
  assert.deepEqual(Reflect.get(h.adapter, 'store'), memory);
  assert.equal((await h.adapter.saveCatalogProductWithIdentities(input)).result, 'saved');
  const receipt = await h.adapter.persistCatalogDetailApproval('admin', query);
  assert.ok(receipt.ok && 'record' in receipt && receipt.current);
  assert.equal(receipt.record.state, 'saved');
});

test('a bound draft save preserves legacy absence of published rather than inventing false', async (t) => {
  const h = fixture(t, { published: undefined, archived: undefined, updatedAt: undefined });
  const begun = await h.adapter.persistCatalogDetailApproval('admin', {
    ...start,
    expectedUpdatedAt: null,
  });
  assert.ok(begun.ok && 'record' in begun);
  const result = await h.adapter.saveCatalogProductWithIdentities({
    mode: 'update',
    productId: 'p',
    data: values,
    expectedUpdatedAt: null,
    expectedOperation: {
      actorId: 'admin',
      operationId,
      inputDigest: begun.record.operation.inputDigest,
    },
  });
  assert.equal(result.result, 'saved');
  const row = await h.adapter.get('products', 'p');
  assert.ok(row);
  assert.equal(Object.hasOwn(row, 'published'), false);
  assert.equal(Object.hasOwn(row, 'archived'), false);
});

test('an expired saved receipt is historical, read-only and cannot resume writes', async (t) => {
  const h = fixture(t);
  const { input } = await reserve(h.adapter);
  assert.equal((await h.adapter.saveCatalogProductWithIdentities(input)).result, 'saved');
  const data: Record<string, CollectionDoc[]> = JSON.parse(h.bytes());
  const record = data.catalogDetailApprovals?.[0];
  assert.ok(record);
  record.createdAt = '2000-01-01T00:00:00.000Z';
  writeFileSync(h.file, JSON.stringify(data));
  const adapter = new JsonFileAdapter(h.file);
  const before = h.bytes();
  const read = await adapter.persistCatalogDetailApproval('admin', query);
  assert.ok(read.ok && 'record' in read && read.expired);
  assert.equal(read.record.state, 'saved');
  assert.equal((await adapter.saveCatalogProductWithIdentities(input)).result, 'stale');
  assert.equal(h.bytes(), before);
});

for (const expectedUpdatedAt of [undefined, '2026-10-18T00:00:01.000Z'])
  test(`saved replay still requires its original explicit revision: ${expectedUpdatedAt}`, async (t) => {
    const h = fixture(t);
    const { input } = await reserve(h.adapter);
    assert.equal((await h.adapter.saveCatalogProductWithIdentities(input)).result, 'saved');
    const before = h.bytes();
    const changed = structuredClone(input);
    if (expectedUpdatedAt === undefined) Reflect.deleteProperty(changed, 'expectedUpdatedAt');
    else changed.expectedUpdatedAt = expectedUpdatedAt;
    assert.equal((await h.adapter.saveCatalogProductWithIdentities(changed)).result, 'stale');
    assert.equal(h.bytes(), before);
  });

for (const [field, text] of [
  ['name', 'n'.repeat(1001)],
  ['description', 'd'.repeat(30001)],
] as const)
  test(`invalid ${field} reports its field rather than telling the user to reload`, async (t) => {
    const h = fixture(t);
    const begun = await h.adapter.persistCatalogDetailApproval('admin', {
      ...start,
      values: { [field]: text },
    });
    assert.ok(begun.ok && 'record' in begun);
    const before = h.bytes();
    const result = await h.adapter.saveCatalogProductWithIdentities({
      mode: 'update',
      productId: 'p',
      data: { [field]: text },
      expectedUpdatedAt: at,
      expectedOperation: {
        actorId: 'admin',
        operationId,
        inputDigest: begun.record.operation.inputDigest,
      },
    });
    assert.equal(result.result, 'invalid-product');
    assert.ok(
      result.result === 'invalid-product' && result.issues.some((issue) => issue.field === field),
    );
    assert.equal(h.bytes(), before);
  });

for (const [index, description] of [
  '',
  '   ',
  '  Reviewed note  ',
  '\nReviewed note\n',
  'd'.repeat(30000),
  `  ${'d'.repeat(30000)}  `,
].entries())
  test(`normal description edit ${index} preserves editor text and follows actual approval projection`, async (t) => {
    const h = fixture(t, { description: 'Original description' });
    const patch = { description };
    const begun = await h.adapter.persistCatalogDetailApproval('admin', {
      ...start,
      values: patch,
    });
    assert.ok(begun.ok && 'record' in begun);
    const result = await h.adapter.saveCatalogProductWithIdentities({
      mode: 'update',
      productId: 'p',
      data: patch,
      expectedUpdatedAt: at,
      expectedOperation: {
        actorId: 'admin',
        operationId,
        inputDigest: begun.record.operation.inputDigest,
      },
    });
    assert.equal(result.result, 'saved');
    const row = await h.adapter.get('products', 'p');
    assert.equal(row?.description, description);
    const plan = planCatalogDetailApproval({
      product: {
        ...row,
        detailSourceReady: true,
        detailSourceOwner: 'owned-source',
        detailSourceCandidate: {
          _id: 'p',
          name: 'Clock',
          schemaVersion: 'catalog-product-detail-v1',
          descriptionText: 'Old source',
          images: [],
          facts: [],
          offers: [],
        },
      },
      variants: [],
      revision: 'owned-review',
    });
    assert.equal(plan.publication.header.descriptionText, description.trim() || undefined);
    const read = await h.adapter.persistCatalogDetailApproval('admin', query);
    assert.ok(read.ok && 'record' in read && read.current);
    assert.equal(read.record.state, 'saved');
  });

test('a valid unclassified draft save retains missing family, category and subcategories', async (t) => {
  const h = fixture(t, { productFamily: undefined });
  const { input } = await reserve(h.adapter);
  assert.equal((await h.adapter.saveCatalogProductWithIdentities(input)).result, 'saved');
  const row = await h.adapter.get('products', 'p');
  assert.ok(row);
  for (const field of ['productFamily', 'category', 'subcategoryIds'])
    assert.equal(Object.hasOwn(row, field), false);
});

test('a saved draft receipt cannot be consumed by legacy approval finish or publish anything', async (t) => {
  const h = fixture(t);
  const { input, answer } = await reserve(h.adapter);
  assert.equal((await h.adapter.saveCatalogProductWithIdentities(input)).result, 'saved');
  const before = h.bytes();
  const finish = await h.adapter.persistCatalogDetailApproval('admin', {
    action: 'finish',
    jobId: answer.record._id,
  });
  assert.deepEqual(finish, { ok: false, code: 'NOT_FOUND' });
  assert.equal(h.bytes(), before);
  assert.equal((await h.adapter.get('products', 'p'))?.published, false);
});

for (const afterSave of [false, true])
  test(`metadata-only revision change expires the ${afterSave ? 'saved' : 'reserved'} resume guard consistently`, async (t) => {
    const h = fixture(t);
    const { input } = await reserve(h.adapter);
    if (afterSave)
      assert.equal((await h.adapter.saveCatalogProductWithIdentities(input)).result, 'saved');
    const before = await h.adapter.get('products', 'p');
    assert.equal(
      (
        await h.adapter.saveCatalogProductWithIdentities({
          mode: 'update',
          productId: 'p',
          data: { alibabaSourceLastSyncedAt: '2026-10-18T00:00:01.000Z' },
        })
      ).result,
      'saved',
    );
    const row = await h.adapter.get('products', 'p');
    assert.equal(row?.catalogContentGeneration ?? 0, before?.catalogContentGeneration ?? 0);
    assert.notEqual(row?.updatedAt, before?.updatedAt);
    const bytes = h.bytes();
    const read = await h.adapter.persistCatalogDetailApproval('admin', query);
    assert.ok(read.ok && 'record' in read);
    assert.equal(read.current, true, 'capture metadata does not become new website content');
    assert.equal(read.revisionCurrent, false, 'the original row revision cannot be resumed');
    assert.equal(read.record.state, afterSave ? 'saved' : 'reserved');
    assert.equal((await h.adapter.saveCatalogProductWithIdentities(input)).result, 'stale');
    assert.equal(h.bytes(), bytes);
  });

for (const afterSave of [false, true])
  test(`changed website input with an unchanged raw revision cannot resume ${afterSave ? 'saved' : 'reserved'} work`, async (t) => {
    const h = fixture(t);
    const { input } = await reserve(h.adapter);
    if (afterSave)
      assert.equal((await h.adapter.saveCatalogProductWithIdentities(input)).result, 'saved');
    const data: Record<string, CollectionDoc[]> = JSON.parse(h.bytes());
    const row = data.products?.[0];
    assert.ok(row);
    row.description = 'Changed by an old writer without updating counters or revision';
    writeFileSync(h.file, JSON.stringify(data));
    const adapter = new JsonFileAdapter(h.file);
    const before = h.bytes();
    const read = await adapter.persistCatalogDetailApproval('admin', query);
    assert.ok(read.ok && 'record' in read);
    assert.equal(read.current, false);
    assert.equal(read.revisionCurrent, true);
    assert.equal((await adapter.saveCatalogProductWithIdentities(input)).result, 'stale');
    assert.equal(h.bytes(), before);
  });

for (const patch of [{}, { description: '' }])
  test(`an acknowledged unchanged own draft save cancels an older unfinished approval: ${Object.keys(patch).join(',') || 'empty patch'}`, async (t) => {
    const h = fixture(t, {
      detailSourceReady: true,
      detailSourceOwner: 'owned-source',
      detailSourceRevision: 'source-r1',
      detailSourceContentGeneration: 0,
      detailSourceManifest: { revision: 'source-r1', variantIds: [] },
      detailSourceCandidate: {
        _id: 'p',
        name: 'Clock',
        schemaVersion: 'catalog-product-detail-v1',
        images: [],
        facts: [],
        offers: [],
      },
    });
    const product = await h.adapter.get('products', 'p');
    assert.ok(product);
    const older = prepareStagedApproval(
      'admin',
      {
        productId: 'p',
        operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        expectedRevision: null,
        expectedDigest: catalogApprovalDigest(product, []),
      },
      product,
      [],
    );
    assert.ok(older.ok);
    assert.equal(
      (
        await h.adapter.persistCatalogDetailApproval('admin', {
          action: 'begin',
          prepared: older.value,
        })
      ).ok,
      true,
    );
    const newer = await h.adapter.persistCatalogDetailApproval('admin', {
      ...start,
      values: patch,
    });
    assert.ok(newer.ok && 'record' in newer);
    const input = {
      mode: 'update' as const,
      productId: 'p',
      data: patch,
      expectedUpdatedAt: at,
      expectedOperation: {
        actorId: 'admin',
        operationId,
        inputDigest: newer.record.operation.inputDigest,
      },
    };
    assert.equal((await h.adapter.saveCatalogProductWithIdentities(input)).result, 'saved');
    const row = await h.adapter.get('products', 'p');
    assert.equal(row?.catalogContentGeneration ?? 0, 0, 'no content change is invented');
    const before = h.bytes();
    assert.deepEqual(
      await h.adapter.persistCatalogDetailApproval('admin', {
        action: 'finish',
        jobId: older.value._id,
      }),
      { ok: false, code: 'CONFLICT' },
    );
    assert.equal(h.bytes(), before);
    assert.equal((await h.adapter.saveCatalogProductWithIdentities(input)).result, 'saved');
    assert.equal(h.bytes(), before, 'replay must not add a second cancellation barrier');
  });

for (const afterOwnSave of [false, true])
  test(`another completed approval invalidates the frozen own draft despite unchanged timestamp: saved=${afterOwnSave}`, async (t) => {
    const h = fixture(t, {
      detailSourceReady: true,
      detailSourceOwner: 'owned-source',
      detailSourceRevision: 'source-r1',
      detailSourceContentGeneration: 0,
      detailSourceManifest: { revision: 'source-r1', variantIds: [] },
      detailSourceCandidate: {
        _id: 'p',
        name: 'Clock',
        schemaVersion: 'catalog-product-detail-v1',
        images: [],
        facts: [],
        offers: [],
      },
    });
    const command = { ...start, values: {} };
    const begun = await h.adapter.persistCatalogDetailApproval('admin', command);
    assert.ok(begun.ok && 'record' in begun);
    const input = {
      mode: 'update' as const,
      productId: 'p',
      data: {},
      expectedUpdatedAt: at,
      expectedOperation: {
        actorId: 'admin',
        operationId,
        inputDigest: begun.record.operation.inputDigest,
      },
    };
    if (afterOwnSave)
      assert.equal((await h.adapter.saveCatalogProductWithIdentities(input)).result, 'saved');
    const product = await h.adapter.get('products', 'p');
    assert.ok(product);
    const next = prepareStagedApproval(
      'admin',
      {
        productId: 'p',
        operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        expectedRevision: null,
        expectedDigest: catalogApprovalDigest(product, []),
      },
      product,
      [],
    );
    assert.ok(next.ok);
    assert.equal(
      (
        await h.adapter.persistCatalogDetailApproval('admin', {
          action: 'begin',
          prepared: next.value,
        })
      ).ok,
      true,
    );
    const finished = await h.adapter.persistCatalogDetailApproval('admin', {
      action: 'finish',
      jobId: next.value._id,
    });
    assert.ok(finished.ok && 'complete' in finished && finished.complete);
    assert.equal((await h.adapter.get('products', 'p'))?.updatedAt, product.updatedAt);
    const bytes = h.bytes();
    const queried = await h.adapter.persistCatalogDetailApproval('admin', query);
    assert.ok(queried.ok && 'record' in queried);
    assert.equal(queried.current, false, 'another approval is not this operation stage');
    assert.equal(queried.revisionCurrent, true, 'timestamp alone misses the approval replacement');
    assert.equal((await h.adapter.saveCatalogProductWithIdentities(input)).result, 'stale');
    assert.equal(h.bytes(), bytes);
  });

test('a real price-summary backfill preserves an own saved stage and its zero-write replay', async (t) => {
  const h = fixture(t, {
    detailSourceReady: true,
    detailSourceOwner: 'owned-source',
    detailSourceRevision: 'source-r1',
    detailSourceContentGeneration: 0,
    detailSourceManifest: { revision: 'source-r1', variantIds: [] },
    detailSourceCandidate: {
      _id: 'p',
      name: 'Clock',
      schemaVersion: 'catalog-product-detail-v1',
      images: [],
      facts: [],
      offers: [],
    },
  });
  const product = await h.adapter.get('products', 'p');
  assert.ok(product);
  const prepared = prepareStagedApproval(
    'admin',
    {
      productId: 'p',
      operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      expectedRevision: null,
      expectedDigest: catalogApprovalDigest(product, []),
    },
    product,
    [],
  );
  assert.ok(prepared.ok);
  assert.equal(
    (
      await h.adapter.persistCatalogDetailApproval('admin', {
        action: 'begin',
        prepared: prepared.value,
      })
    ).ok,
    true,
  );
  const done = await h.adapter.persistCatalogDetailApproval('admin', {
    action: 'finish',
    jobId: prepared.value._id,
  });
  assert.ok(done.ok && 'complete' in done && done.complete);
  const approved = await h.adapter.get('products', 'p');
  assert.ok(approved);
  const command = { ...start, expectedUpdatedAt: String(approved.updatedAt), values: {} };
  const reserved = await h.adapter.persistCatalogDetailApproval('admin', command);
  assert.ok(reserved.ok && 'record' in reserved);
  const input = {
    mode: 'update' as const,
    productId: 'p',
    data: {},
    expectedUpdatedAt: command.expectedUpdatedAt,
    expectedOperation: {
      actorId: 'admin',
      operationId,
      inputDigest: reserved.record.operation.inputDigest,
    },
  };
  assert.equal((await h.adapter.saveCatalogProductWithIdentities(input)).result, 'saved');
  const backfill = await h.adapter.persistCatalogDetailApproval('admin', {
    action: 'price-summary-backfill',
    productId: 'p',
    revision: prepared.value.revision,
    priceSummary: {
      source: 'product',
      pricing: { mode: 'fixed', currency: 'USD', amountMinor: 300 },
    },
  });
  assert.deepEqual(backfill, { ok: true, backfill: 'applied' });
  const before = h.bytes();
  const status = await h.adapter.persistCatalogDetailApproval('admin', query);
  assert.ok(status.ok && 'record' in status && status.current && status.revisionCurrent);
  assert.equal((await h.adapter.saveCatalogProductWithIdentities(input)).result, 'saved');
  assert.equal(h.bytes(), before);
});

test('an old saved receipt missing the approval binding stays readable and refuses replay', async (t) => {
  const h = fixture(t);
  const { input } = await reserve(h.adapter);
  assert.equal((await h.adapter.saveCatalogProductWithIdentities(input)).result, 'saved');
  const raw = JSON.parse(h.bytes());
  const receipt = raw.catalogDetailApprovals[0];
  Reflect.deleteProperty(receipt.operation.base, 'approvalDigest');
  Reflect.deleteProperty(receipt.saved.snapshot, 'approvalDigest');
  writeFileSync(h.file, JSON.stringify(raw));
  const reopened = new JsonFileAdapter(h.file);
  const before = h.bytes();
  const status = await reopened.persistCatalogDetailApproval('admin', query);
  assert.ok(status.ok && 'record' in status);
  assert.equal(status.record.state, 'saved');
  assert.equal(status.current, false);
  assert.equal((await reopened.saveCatalogProductWithIdentities(input)).result, 'stale');
  assert.equal(h.bytes(), before);
});

for (const linked of [false, true])
  test(`a publish intent saves only its own unpublished draft and retains the source binding: linked=${linked}`, async (t) => {
    const h = fixture(t);
    const raw = JSON.parse(h.bytes());
    if (linked) {
      Object.assign(raw.products[0], { alibabaPrimarySourceKey: 's', alibabaLinkRevision: 1 });
      raw.alibabaSourceProducts = [
        {
          _id: 's',
          sourceKey: 's',
          connectionId: 'c',
          sourceProductId: 'ext',
          sourceCategoryId: '100',
          contentHash: 'a'.repeat(64),
          active: true,
        },
      ];
      raw.alibabaProductLinks = [
        {
          _id: 's',
          sourceKey: 's',
          connectionId: 'c',
          sourceProductId: 'ext',
          productId: 'p',
          linkedAt: at,
        },
      ];
      raw.catalogSourceObservations = [];
      writeFileSync(h.file, JSON.stringify(raw));
    }
    const adapter = new JsonFileAdapter(h.file);
    const begun = await adapter.persistCatalogDetailApproval('admin', {
      ...start,
      intent: 'publish',
    });
    assert.ok(begun.ok && 'record' in begun);
    const input = {
      mode: 'update' as const,
      productId: 'p',
      data: structuredClone(values),
      expectedUpdatedAt: at,
      expectedOperation: {
        actorId: 'admin',
        operationId,
        inputDigest: begun.record.operation.inputDigest,
      },
    };
    assert.equal((await adapter.saveCatalogProductWithIdentities(input)).result, 'saved');
    const product = await adapter.get('products', 'p');
    assert.equal(product?.published, false);
    assert.equal(product?.description, values.description);
    assert.equal(product?.catalogDetailApprovalReceipt, undefined);
    assert.equal(product?.catalogDetailPublication, undefined);
    const status = await adapter.persistCatalogDetailApproval('admin', query);
    assert.ok(status.ok && 'record' in status && status.current && status.revisionCurrent);
    assert.equal(status.record.state, 'saved');
    if (status.record.state !== 'saved') return;
    assert.deepEqual(status.record.operation.base, begun.record.operation.base);
    assert.deepEqual(status.record.saved.snapshot.source, begun.record.operation.base.source);
    assert.equal(Boolean(status.record.saved.snapshot.source), linked);
    const before = h.bytes();
    assert.equal(
      (await new JsonFileAdapter(h.file).saveCatalogProductWithIdentities(input)).result,
      'saved',
    );
    assert.equal(h.bytes(), before);
  });

function linkedPublishFixture(t: { after(callback: () => void): void }) {
  const h = fixture(t, { alibabaPrimarySourceKey: 's', alibabaLinkRevision: 1 });
  const raw = JSON.parse(h.bytes());
  raw.alibabaSourceProducts = [
    {
      _id: 's',
      sourceKey: 's',
      connectionId: 'c',
      sourceProductId: 'ext',
      sourceCategoryId: '100',
      contentHash: 'a'.repeat(64),
      active: true,
    },
  ];
  raw.alibabaProductLinks = [
    {
      _id: 's',
      sourceKey: 's',
      connectionId: 'c',
      sourceProductId: 'ext',
      productId: 'p',
      linkedAt: at,
    },
  ];
  raw.catalogSourceObservations = [
    {
      _id: sourceObservationDocumentId('alibaba', 's'),
      sourceContentHash: 'a'.repeat(64),
      observation: {
        source: {
          provider: 'alibaba',
          sourceProductKey: 's',
          externalProductId: 'ext',
          observedAt: at,
        },
        attributes: [{ name: 'Size', value: '10' }],
      },
    },
  ];
  writeFileSync(h.file, JSON.stringify(raw));
  return { ...h, adapter: new JsonFileAdapter(h.file) };
}
async function reservePublish(adapter: JsonFileAdapter) {
  const answer = await adapter.persistCatalogDetailApproval('admin', {
    ...start,
    intent: 'publish',
  });
  assert.ok(answer.ok && 'record' in answer);
  return {
    answer,
    input: {
      mode: 'update' as const,
      productId: 'p',
      data: structuredClone(values),
      expectedUpdatedAt: at,
      expectedOperation: {
        actorId: 'admin',
        operationId,
        inputDigest: answer.record.operation.inputDigest,
      },
    },
  };
}
for (const afterSave of [false, true])
  for (const collection of [
    'alibabaSourceProducts',
    'catalogSourceObservations',
    'alibabaProductLinks',
  ])
    test(`publish draft refuses changed frozen ${collection} with no partial save: saved=${afterSave}`, async (t) => {
      const h = linkedPublishFixture(t);
      const { input, answer } = await reservePublish(h.adapter);
      if (afterSave)
        assert.equal((await h.adapter.saveCatalogProductWithIdentities(input)).result, 'saved');
      const raw = JSON.parse(h.bytes());
      const row = raw[collection][0];
      if (collection === 'alibabaSourceProducts') row.sourceCategoryId = '200';
      else if (collection === 'catalogSourceObservations')
        row.observation.attributes = [{ name: 'Size', value: '20' }];
      else row.productId = 'another-product';
      writeFileSync(h.file, JSON.stringify(raw));
      const adapter = new JsonFileAdapter(h.file);
      const before = h.bytes();
      const status = await adapter.persistCatalogDetailApproval('admin', query);
      assert.ok(status.ok && 'record' in status);
      assert.equal(status.current, false);
      assert.deepEqual(status.record.operation.base, answer.record.operation.base);
      assert.equal((await adapter.saveCatalogProductWithIdentities(input)).result, 'stale');
      assert.equal(h.bytes(), before);
    });
test('capture-only source metadata permits a publish draft save and durable replay', async (t) => {
  const h = linkedPublishFixture(t);
  const { input, answer } = await reservePublish(h.adapter);
  const raw = JSON.parse(h.bytes());
  raw.alibabaSourceProducts[0].lastSeenAt = '2026-10-18T00:01:00.000Z';
  raw.alibabaProductLinks[0].updatedAt = '2026-10-18T00:01:00.000Z';
  raw.catalogSourceObservations[0].observation.source.observedAt = '2026-10-18T00:01:00.000Z';
  writeFileSync(h.file, JSON.stringify(raw));
  const adapter = new JsonFileAdapter(h.file);
  assert.equal((await adapter.saveCatalogProductWithIdentities(input)).result, 'saved');
  const status = await adapter.persistCatalogDetailApproval('admin', query);
  assert.ok(status.ok && 'record' in status && status.current);
  assert.equal(status.record.state, 'saved');
  if (status.record.state !== 'saved') return;
  assert.deepEqual(status.record.saved.snapshot.source, answer.record.operation.base.source);
  const before = h.bytes();
  assert.equal((await adapter.saveCatalogProductWithIdentities(input)).result, 'saved');
  assert.equal(h.bytes(), before);
});
test('two adapters resume one publish draft without a second lifecycle barrier', async (t) => {
  const h = linkedPublishFixture(t);
  const { input } = await reservePublish(h.adapter);
  const results = await Promise.allSettled([
    h.adapter.saveCatalogProductWithIdentities(input),
    new JsonFileAdapter(h.file).saveCatalogProductWithIdentities(input),
  ]);
  for (const result of results) {
    assert.equal(result.status, 'fulfilled');
    if (result.status === 'fulfilled') assert.equal(result.value.result, 'saved');
  }
  const product = await new JsonFileAdapter(h.file).get('products', 'p');
  assert.equal(product?.published, false);
  assert.equal(product?.catalogLifecycleVersion, 1);
  assert.equal(product?.catalogContentGeneration, 1);
  const raw = JSON.parse(h.bytes());
  assert.equal(raw.catalogDetailApprovals.length, 1);
  assert.equal(raw.catalogDetailApprovals[0].state, 'saved');
});

test('publish draft stage preserves missing classification and visibility fields', async (t) => {
  const h = fixture(t, {
    productFamily: undefined,
    subcategoryIds: undefined,
    published: undefined,
    archived: undefined,
  });
  const { input } = await reservePublish(h.adapter);
  assert.equal((await h.adapter.saveCatalogProductWithIdentities(input)).result, 'saved');
  const row = await h.adapter.get('products', 'p');
  assert.ok(row);
  for (const key of ['productFamily', 'subcategoryIds', 'published', 'archived'])
    assert.equal(Object.hasOwn(row, key), false, key);
  const before = h.bytes();
  assert.equal((await h.adapter.saveCatalogProductWithIdentities(input)).result, 'saved');
  assert.equal(h.bytes(), before);
});
test('publish draft stage refuses an existing live product before attempting a save', async (t) => {
  const h = fixture(t, { published: true });
  const { input } = await reservePublish(h.adapter);
  const before = h.bytes();
  assert.equal((await h.adapter.saveCatalogProductWithIdentities(input)).result, 'stale');
  assert.equal(h.bytes(), before);
});
test('publish draft stage refuses new configuration media without partially saving text', async (t) => {
  const h = fixture(t);
  const patch = { ...values, configurationPhotos: { sku: ['new-owned'] } };
  const begun = await h.adapter.persistCatalogDetailApproval('admin', {
    ...start,
    intent: 'publish',
    values: patch,
  });
  assert.ok(begun.ok && 'record' in begun);
  const before = h.bytes();
  const result = await h.adapter.saveCatalogProductWithIdentities({
    mode: 'update',
    productId: 'p',
    data: patch,
    expectedUpdatedAt: at,
    expectedOperation: {
      actorId: 'admin',
      operationId,
      inputDigest: begun.record.operation.inputDigest,
    },
  });
  assert.equal(result.result, 'invalid-product');
  if (result.result !== 'invalid-product') return;
  assert.ok(result.issues.some((issue) => issue.field === 'configurationPhotos'));
  assert.equal(h.bytes(), before);
});
test('an unchanged source-bound publish draft cancels old intent without invalidating ready content', async (t) => {
  const h = linkedPublishFixture(t);
  const raw = JSON.parse(h.bytes());
  Object.assign(raw.products[0], {
    detailSourceReady: true,
    detailSourceOwner: 'owned-source',
    detailSourceRevision: 'source-r1',
    detailSourceContentGeneration: 0,
  });
  writeFileSync(h.file, JSON.stringify(raw));
  const adapter = new JsonFileAdapter(h.file);
  const begun = await adapter.persistCatalogDetailApproval('admin', {
    ...start,
    intent: 'publish',
    values: {},
  });
  assert.ok(begun.ok && 'record' in begun);
  const input = {
    mode: 'update' as const,
    productId: 'p',
    data: {},
    expectedUpdatedAt: at,
    expectedOperation: {
      actorId: 'admin',
      operationId,
      inputDigest: begun.record.operation.inputDigest,
    },
  };
  assert.equal((await adapter.saveCatalogProductWithIdentities(input)).result, 'saved');
  const product = await adapter.get('products', 'p');
  assert.equal(product?.detailSourceReady, true);
  assert.equal(product?.catalogContentGeneration ?? 0, 0);
  assert.equal(product?.catalogLifecycleVersion, 1);
  assert.equal(product?.published, false);
  const status = await adapter.persistCatalogDetailApproval('admin', query);
  assert.ok(status.ok && 'record' in status && status.current && status.revisionCurrent);
  const before = h.bytes();
  assert.equal((await adapter.saveCatalogProductWithIdentities(input)).result, 'saved');
  assert.equal(h.bytes(), before);
});

for (const intent of ['save-draft', 'publish'] as const)
  test(`operation reservation captures nested inputs before the file lock: ${intent}`, async (t) => {
    const h = fixture(t);
    const input = {
      ...start,
      intent,
      values: {
        description: 'Original submitted draft',
        configurationPhotos: { sku: ['original-image'] },
      },
    };
    const pending = h.adapter.persistCatalogDetailApproval('admin', input);
    input.values.description = 'Changed after dispatch';
    input.values.configurationPhotos.sku[0] = 'changed-image';
    const result = await pending;
    assert.ok(result.ok && 'record' in result);
    assert.equal(result.record.operation.values.description, 'Original submitted draft');
    assert.deepEqual(result.record.operation.values.configurationPhotos, {
      sku: ['original-image'],
    });
    const queryResult = await h.adapter.persistCatalogDetailApproval('admin', query);
    assert.ok(queryResult.ok && 'record' in queryResult);
    assert.deepEqual(queryResult.record, result.record);
  });
test('operation-get captures its selector before the file lock instead of following another selected job', async (t) => {
  const h = fixture(t);
  const first = await h.adapter.persistCatalogDetailApproval('admin', start);
  assert.ok(first.ok && 'record' in first);
  const otherId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const second = await h.adapter.persistCatalogDetailApproval('admin', {
    ...start,
    operationId: otherId,
    values: { description: 'Another selected job' },
  });
  assert.ok(second.ok && 'record' in second);
  const input = { ...query };
  const pending = h.adapter.persistCatalogDetailApproval('admin', input);
  input.operationId = otherId;
  const result = await pending;
  assert.ok(result.ok && 'record' in result);
  assert.deepEqual(result.record, first.record);
});
test('legacy approval begin captures the reviewed header before waiting for the file lock', async (t) => {
  const h = fixture(t, {
    detailSourceReady: true,
    detailSourceOwner: 'owned-source',
    detailSourceRevision: 'source-r1',
    detailSourceContentGeneration: 0,
    detailSourceManifest: { revision: 'source-r1', variantIds: [] },
    detailSourceCandidate: {
      _id: 'p',
      name: 'Clock',
      schemaVersion: 'catalog-product-detail-v1',
      images: [],
      facts: [],
      offers: [],
    },
  });
  const product = await h.adapter.get('products', 'p');
  assert.ok(product);
  const prepared = prepareStagedApproval(
    'admin',
    {
      productId: 'p',
      operationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      expectedRevision: null,
      expectedDigest: catalogApprovalDigest(product, []),
    },
    product,
    [],
  );
  assert.ok(prepared.ok);
  const reviewed = JSON.parse(JSON.stringify(prepared.value));
  const pending = h.adapter.persistCatalogDetailApproval('admin', {
    action: 'begin',
    prepared: prepared.value,
  });
  prepared.value.publication.header.name = 'Changed after dispatch';
  assert.equal((await pending).ok, true);
  const job = await h.adapter.get('catalogDetailApprovals', reviewed._id);
  assert.deepEqual(job, reviewed);
});

for (const [label, value] of [
  ['function', () => 'unsupported'],
  ['symbol', Symbol('unsupported')],
  ['weak-map', new WeakMap<object, unknown>()],
] as const)
  test(`unclonable ${label} command is an actionable validation error without local writes`, async (t) => {
    const h = fixture(t);
    const before = h.bytes();
    const result = await h.adapter.persistCatalogDetailApproval('admin', {
      ...start,
      values: { description: value },
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'VALIDATION_ERROR');
    assert.equal(result.validation?.issues[0]?.remedy, 'reload');
    assert.equal(h.bytes(), before);
  });
test('capturing a large legal UTF-8 legacy approval does not apply the smaller operation-start budget', async (t) => {
  const facts = Array.from({ length: 256 }, (_, i) => ({
    name: `Fact ${i}`,
    value: '中'.repeat(600),
  }));
  const h = fixture(t, {
    detailSourceReady: true,
    detailSourceOwner: 'owned-source',
    detailSourceRevision: 'source-r1',
    detailSourceContentGeneration: 0,
    detailSourceManifest: { revision: 'source-r1', variantIds: [] },
    detailSourceCandidate: {
      _id: 'p',
      name: 'Clock',
      schemaVersion: 'catalog-product-detail-v1',
      images: [],
      facts,
      offers: [],
    },
  });
  const product = await h.adapter.get('products', 'p');
  assert.ok(product);
  const prepared = prepareStagedApproval(
    'admin',
    {
      productId: 'p',
      operationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      expectedRevision: null,
      expectedDigest: catalogApprovalDigest(product, []),
    },
    product,
    [],
  );
  assert.ok(prepared.ok);
  const reviewed = JSON.parse(JSON.stringify(prepared.value));
  const bytes = Buffer.byteLength(JSON.stringify(reviewed));
  assert.ok(bytes > 256 * 1024 && bytes < 512 * 1024);
  const pending = h.adapter.persistCatalogDetailApproval('admin', {
    action: 'begin',
    prepared: prepared.value,
  });
  const first = prepared.value.publication.header.facts[0];
  assert.ok(first);
  first.value = 'Changed after dispatch';
  assert.equal((await pending).ok, true);
  assert.deepEqual(await h.adapter.get('catalogDetailApprovals', reviewed._id), reviewed);
});

async function jsonOwnApprovalFixture(
  t: { after(callback: () => void): void },
  extra: Record<string, unknown> = {},
) {
  const h = fixture(t, {
    ...values,
    detailSourceReady: true,
    detailSourceOwner: 'owned-source',
    detailSourceRevision: 'r1',
    detailSourceContentGeneration: 0,
    detailSourceManifest: { revision: 'r1', variantIds: [] },
    detailSourceCandidate: {
      _id: 'p',
      name: 'Clock',
      schemaVersion: 'catalog-product-detail-v1',
      images: [],
      facts: [],
      offers: [],
    },
    ...extra,
  });
  const { input, answer } = await reservePublish(h.adapter);
  assert.equal((await h.adapter.saveCatalogProductWithIdentities(input)).result, 'saved');
  const product = await h.adapter.get('products', 'p');
  assert.ok(product);
  const planned = prepareStagedApproval(
    'admin',
    {
      productId: 'p',
      operationId,
      expectedRevision: null,
      expectedDigest: catalogApprovalDigest(product, []),
    },
    product,
    [],
  );
  assert.ok(planned.ok, JSON.stringify(planned));
  return {
    ...h,
    input,
    command: {
      action: 'operation-approval-begin' as const,
      productId: 'p',
      operationId,
      inputDigest: answer.record.operation.inputDigest,
      prepared: planned.value,
    },
  };
}
test('own approval cursor survives an adapter reopen and a repeat saved-draft request without rewriting the file', async (t) => {
  const h = await jsonOwnApprovalFixture(t);
  const begun = await h.adapter.persistCatalogDetailApproval('admin', h.command);
  assert.ok(begun.ok && 'record' in begun, JSON.stringify(begun));
  assert.equal(begun.record.state, 'staging');
  assert.equal(begun.current, true);
  const reopened = new JsonFileAdapter(h.file);
  const bytes = h.bytes();
  utimesSync(h.file, new Date(1000), new Date(1000));
  // JSON persistence omits optional undefined publication fields.
  const persisted = JSON.parse(JSON.stringify(begun));
  assert.deepEqual(await reopened.persistCatalogDetailApproval('admin', query), persisted);
  assert.deepEqual(await reopened.persistCatalogDetailApproval('admin', h.command), persisted);
  assert.equal((await reopened.saveCatalogProductWithIdentities(h.input)).result, 'saved');
  assert.equal(h.bytes(), bytes);
  assert.equal(statSync(h.file).mtimeMs, 1000);
  assert.equal((await reopened.get('products', 'p'))?.published, false);
});
test('unfinished image deletion guard recognises the publication inside an owned staging root', async (t) => {
  const h = await jsonOwnApprovalFixture(t, { imageIds: ['held-own'] });
  assert.deepEqual(h.command.prepared.publication.header.images, ['/api/images/held-own']);
  const begun = await h.adapter.persistCatalogDetailApproval('admin', h.command);
  assert.ok(begun.ok);
  setAdapter(new JsonFileAdapter(h.file));
  assert.equal(await unfinishedApprovalUsingImage('held-own'), 'p');
  assert.equal(await unfinishedApprovalUsingImage('unrelated'), null);
});
