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
import {
  persistCatalogDetailApproval,
  setAdapter,
  unfinishedApprovalUsingImage,
} from '@vibelingan-channel/db';
import { catalogApprovalDigest } from '@vibelingan-channel/db/catalog-detail-commit';
import { prepareStagedApproval } from '@vibelingan-channel/db/catalog-detail-staging';
import { createCatalogPreparationAuthority } from '@vibelingan-channel/db/catalog-preparation-authority';
import { catalogSealedImageIdsDigest } from '@vibelingan-channel/db/catalog-preparation-media-seal';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { planCatalogDetailApproval } from '@vibelingan-channel/shared/catalog-detail-approval';
import { finishOwnedMediaFixture } from '../../../packages/db/src/catalog-owned-media.fixture.ts';
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
  variantCount = 0,
) {
  const variants: CollectionDoc[] = Array.from({ length: variantCount }, (_, position) => ({
    _id: `v${position}`,
    productId: 'p',
    position,
    sku: `sku-${position}`,
    detailSourceOwner: 'owned-source',
    detailSourceRevision: 'r1',
    detailSourceMissing: false,
    imageIds: [],
    optionValues: { Color: String(position) },
    detailSourceCandidate: {
      id: `v${position}`,
      options: [],
      images: [],
      offers: [],
      inventory: { state: 'unknown' },
    },
  }));
  const h = fixture(t, {
    ...values,
    detailSourceReady: true,
    detailSourceOwner: 'owned-source',
    detailSourceRevision: 'r1',
    detailSourceContentGeneration: 0,
    detailSourceManifest: { revision: 'r1', variantIds: variants.map((row) => row._id) },
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
  const raw = JSON.parse(h.bytes());
  raw.productVariants = variants;
  raw.catalogDetailVariants = [];
  writeFileSync(h.file, JSON.stringify(raw));
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
      expectedDigest: catalogApprovalDigest(product, variants),
    },
    product,
    variants,
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

test('own pages resume after file reopen and duplicate requests leave21immutable rows without publishing', async (t) => {
  const h = await jsonOwnApprovalFixture(t, {}, 21);
  assert.equal((await h.adapter.persistCatalogDetailApproval('admin', h.command)).ok, true);
  const page = {
    action: 'operation-approval-page' as const,
    productId: 'p',
    operationId,
    inputDigest: h.command.inputDigest,
    page: 0,
  };
  const first = await h.adapter.persistCatalogDetailApproval('admin', page);
  assert.ok(
    first.ok && 'record' in first && first.record.state === 'staging',
    JSON.stringify(first),
  );
  assert.equal(first.record.nextPage, 1);
  const reopened = new JsonFileAdapter(h.file);
  const before = h.bytes();
  utimesSync(h.file, new Date(1000), new Date(1000));
  const status = await reopened.persistCatalogDetailApproval('admin', query);
  assert.deepEqual(status, JSON.parse(JSON.stringify(first)));
  assert.deepEqual(await reopened.persistCatalogDetailApproval('admin', page), status);
  assert.equal((await reopened.saveCatalogProductWithIdentities(h.input)).result, 'saved');
  assert.equal(h.bytes(), before);
  assert.equal(statSync(h.file).mtimeMs, 1000);
  const second = await reopened.persistCatalogDetailApproval('admin', { ...page, page: 1 });
  assert.ok(second.ok && 'record' in second && second.record.state === 'staging');
  assert.equal(second.record.nextPage, 2);
  const raw = JSON.parse(h.bytes());
  assert.equal(raw.catalogDetailVariants.length, 21);
  assert.equal(new Set(raw.catalogDetailVariants.map((row: CollectionDoc) => row._id)).size, 21);
  assert.equal(raw.products[0].published, false);
  assert.equal(raw.products[0].catalogDetailPublication, undefined);
  assert.equal(raw.products[0].catalogDetailApprovalReceipt, undefined);
});

for (const stage of ['reserved', 'saved', 'staging'] as const)
  test(`cancelled ${stage} operation survives JSON reopen and cannot replay its draft save`, async (t) => {
    const approval =
      stage === 'staging' ? await jsonOwnApprovalFixture(t, { imageIds: ['held-own'] }, 21) : null;
    const h = approval ?? fixture(t);
    const reserved = approval === null ? await reserve(h.adapter) : null;
    if (stage === 'saved') {
      assert.ok(reserved);
      assert.equal(
        (await h.adapter.saveCatalogProductWithIdentities(reserved.input)).result,
        'saved',
      );
    }
    if (approval)
      assert.equal(
        (await h.adapter.persistCatalogDetailApproval('admin', approval.command)).ok,
        true,
      );
    const current = await h.adapter.persistCatalogDetailApproval('admin', query);
    assert.ok(current.ok && 'record' in current);
    const command = {
      ...query,
      action: 'operation-cancel' as const,
      inputDigest: current.record.operation.inputDigest,
    };
    const beforeProduct = await h.adapter.get('products', 'p');
    await h.adapter.persistCatalogDetailApproval('admin', command); // Discard the response before reopening.
    const reopened = new JsonFileAdapter(h.file);
    setAdapter(reopened);
    const result = await reopened.persistCatalogDetailApproval('admin', query);
    assert.ok(result.ok && 'record' in result && !result.current);
    assert.equal(typeof result.record.operation.cancelledAt, 'string');
    const input = approval?.input ?? reserved?.input;
    assert.ok(input);
    const bytes = h.bytes();
    utimesSync(h.file, new Date(1000), new Date(1000));
    assert.equal((await reopened.saveCatalogProductWithIdentities(input)).result, 'stale');
    assert.deepEqual(await reopened.persistCatalogDetailApproval('admin', command), result);
    if (approval) {
      assert.equal(
        (await reopened.persistCatalogDetailApproval('admin', approval.command)).ok,
        false,
      );
      assert.equal(await unfinishedApprovalUsingImage('held-own'), null);
    }
    assert.deepEqual(await reopened.get('products', 'p'), beforeProduct);
    assert.equal(h.bytes(), bytes);
    assert.equal(statSync(h.file).mtimeMs, 1000);
  });

test('concurrent JSON page/cancel serialize on the original root and preserve permanent cancellation', async (t) => {
  const h = await jsonOwnApprovalFixture(t, {}, 21);
  assert.equal((await h.adapter.persistCatalogDetailApproval('admin', h.command)).ok, true);
  const page = {
    ...query,
    action: 'operation-approval-page' as const,
    inputDigest: h.command.inputDigest,
    page: 0,
  };
  const cancel = {
    ...query,
    action: 'operation-cancel' as const,
    inputDigest: h.command.inputDigest,
  };
  const other = new JsonFileAdapter(h.file);
  const answers = await Promise.allSettled([
    h.adapter.persistCatalogDetailApproval('admin', page),
    other.persistCatalogDetailApproval('admin', cancel),
  ]);
  assert.ok(answers.every((answer) => answer.status === 'fulfilled'));
  const reopened = new JsonFileAdapter(h.file);
  const result = await reopened.persistCatalogDetailApproval('admin', query);
  assert.ok(result.ok && 'record' in result && !result.current);
  assert.equal(typeof result.record.operation.cancelledAt, 'string');
  const bytes = h.bytes();
  assert.equal(
    (await reopened.persistCatalogDetailApproval('admin', { ...page, page: 1 })).ok,
    false,
  );
  assert.equal((await reopened.saveCatalogProductWithIdentities(h.input)).result, 'stale');
  assert.equal(h.bytes(), bytes);
  assert.equal((await reopened.get('products', 'p'))?.published, false);
});

test('concurrent JSON draft save/cancel keep the cancellation barrier without reverting a saved draft', async (t) => {
  const h = fixture(t);
  const reserved = await reserve(h.adapter);
  const command = {
    ...query,
    action: 'operation-cancel' as const,
    inputDigest: reserved.answer.record.operation.inputDigest,
  };
  const other = new JsonFileAdapter(h.file);
  const answers = await Promise.allSettled([
    h.adapter.saveCatalogProductWithIdentities(reserved.input),
    other.persistCatalogDetailApproval('admin', command),
  ]);
  assert.ok(answers.every((answer) => answer.status === 'fulfilled'));
  const reopened = new JsonFileAdapter(h.file);
  const status = await reopened.persistCatalogDetailApproval('admin', query);
  assert.ok(status.ok && 'record' in status && !status.current);
  assert.equal(typeof status.record.operation.cancelledAt, 'string');
  const product = await reopened.get('products', 'p');
  assert.equal(product?.published, false);
  assert.ok(product?.description === '' || product?.description === values.description);
  const bytes = h.bytes();
  assert.equal((await reopened.saveCatalogProductWithIdentities(reserved.input)).result, 'stale');
  assert.equal(h.bytes(), bytes);
});

test('a new explicit operation can continue after cancellation without reusing the cancelled identity', async (t) => {
  const h = fixture(t);
  const reserved = await reserve(h.adapter);
  const command = {
    ...query,
    action: 'operation-cancel' as const,
    inputDigest: reserved.answer.record.operation.inputDigest,
  };
  assert.equal((await h.adapter.persistCatalogDetailApproval('admin', command)).ok, true);
  const newer = await h.adapter.persistCatalogDetailApproval('admin', {
    ...start,
    operationId: '22345678-1234-4234-8234-123456789012',
  });
  assert.ok(newer.ok && 'record' in newer && newer.current);
  assert.notEqual(newer.record._id, reserved.answer.record._id);
  assert.equal(newer.record.operation.cancelledAt, undefined);
  const old = await h.adapter.persistCatalogDetailApproval('admin', query);
  assert.ok(old.ok && 'record' in old && !old.current);
  assert.equal(typeof old.record.operation.cancelledAt, 'string');
});

async function readyJsonOwnMedia(adapter: JsonFileAdapter) {
  const authority = createCatalogPreparationAuthority({
    secret: 'own-json-media-test',
    environmentId: 'own-json-media-test',
  });
  const run = (input: Parameters<JsonFileAdapter['manageCatalogPreparationJob']>[1]) =>
    adapter.manageCatalogPreparationJob(authority, input);
  const start = await run({ action: 'start', actorId: 'admin', productId: 'p' });
  assert.ok(start.ok && 'progress' in start);
  const jobId = start.progress.jobId;
  const dispatched = await run({ action: 'dispatch', actorId: 'admin', jobId });
  assert.ok(dispatched.ok && 'call' in dispatched);
  const claimed = await run({ action: 'claim', call: dispatched.call, owner: 'own-json-worker' });
  assert.ok(claimed.ok && 'lease' in claimed);
  const scope = { jobId, lease: claimed.lease };
  const planDigest = 'f'.repeat(64);
  assert.equal((await run({ ...scope, action: 'bind-media-plan', planDigest, total: 0 })).ok, true);
  assert.equal((await run({ ...scope, action: 'bind-media-seal', planDigest })).ok, true);
  const job = await adapter.get('catalogPreparationJobs', jobId);
  assert.ok(
    job && typeof job.inputDigest === 'string' && typeof job.contentGeneration === 'number',
  );
  const done = await run({
    ...scope,
    action: 'finish-preparation',
    inputDigest: job.inputDigest,
    contentGeneration: job.contentGeneration,
    planDigest,
    imageIdsDigest: catalogSealedImageIdsDigest([]),
    imageCount: 0,
    previewReady: true,
    issues: [],
  });
  assert.ok(done.ok && 'report' in done && done.report.state === 'ready');
  return done.report;
}

test('owned media receipt survives JSON reopen, lost answer and both configuration pages', async (t) => {
  const h = await jsonOwnApprovalFixture(t, {}, 21);
  const report = await readyJsonOwnMedia(h.adapter);
  assert.equal((await h.adapter.persistCatalogDetailApproval('admin', h.command)).ok, true);
  const command = {
    ...query,
    action: 'operation-approval-media' as const,
    inputDigest: h.command.inputDigest,
  };
  await h.adapter.persistCatalogDetailApproval('admin', command); // Discard the answer before reopening.
  const reopened = new JsonFileAdapter(h.file);
  const before = h.bytes();
  utimesSync(h.file, new Date(1000), new Date(1000));
  const status = await reopened.persistCatalogDetailApproval('admin', query);
  assert.ok(
    status.ok && 'record' in status && status.record.state === 'staging' && status.record.media,
  );
  assert.equal(status.record.media.ready.receiptId, report.seal.receiptId);
  assert.equal((await reopened.persistCatalogDetailApproval('admin', command)).ok, true);
  assert.equal((await reopened.persistCatalogDetailApproval('admin', h.command)).ok, true);
  assert.equal(h.bytes(), before);
  assert.equal(statSync(h.file).mtimeMs, 1000);
  for (const page of [0, 1])
    assert.equal(
      (
        await reopened.persistCatalogDetailApproval('admin', {
          ...command,
          action: 'operation-approval-page',
          page,
        })
      ).ok,
      true,
    );
  const last = await new JsonFileAdapter(h.file).persistCatalogDetailApproval('admin', query);
  assert.ok(last.ok && 'record' in last && last.record.state === 'staging');
  assert.deepEqual(last.record.media, status.record.media);
  assert.equal(last.record.nextPage, 2);
  assert.equal(JSON.parse(h.bytes()).catalogDetailVariants.length, 21);
  assert.equal((await reopened.get('products', 'p'))?.published, false);
});

for (const concurrent of ['media', 'page', 'cancel'] as const)
  test(`concurrent JSON media/${concurrent} serialize without losing receipt or progress`, async (t) => {
    const h = await jsonOwnApprovalFixture(t, {}, 21);
    await readyJsonOwnMedia(h.adapter);
    assert.equal((await h.adapter.persistCatalogDetailApproval('admin', h.command)).ok, true);
    const command = {
      ...query,
      action: 'operation-approval-media' as const,
      inputDigest: h.command.inputDigest,
    };
    const other = new JsonFileAdapter(h.file);
    const second =
      concurrent === 'media'
        ? command
        : concurrent === 'page'
          ? { ...command, action: 'operation-approval-page' as const, page: 0 }
          : { ...command, action: 'operation-cancel' as const };
    const settled = await Promise.allSettled([
      h.adapter.persistCatalogDetailApproval('admin', command),
      other.persistCatalogDetailApproval('admin', second),
    ]);
    assert.ok(settled.every((answer) => answer.status === 'fulfilled'));
    const reopened = new JsonFileAdapter(h.file);
    const status = await reopened.persistCatalogDetailApproval('admin', query);
    assert.ok(status.ok && 'record' in status && status.record.state === 'staging');
    assert.equal(status.current, concurrent !== 'cancel');
    if (concurrent === 'cancel') {
      assert.equal(typeof status.record.operation.cancelledAt, 'string');
      const before = h.bytes();
      assert.equal((await reopened.persistCatalogDetailApproval('admin', command)).ok, false);
      assert.equal(h.bytes(), before);
    } else {
      assert.ok(status.record.media);
      assert.equal(status.record.nextPage, concurrent === 'page' ? 1 : 0);
      const before = h.bytes();
      assert.equal((await reopened.persistCatalogDetailApproval('admin', command)).ok, true);
      assert.equal(h.bytes(), before);
    }
    assert.equal((await reopened.get('products', 'p'))?.published, false);
  });

async function jsonOwnReferenceFixture(t: { after(callback: () => void): void }) {
  const h = await jsonOwnApprovalFixture(t, {}, 21);
  await readyJsonOwnMedia(h.adapter);
  assert.equal((await h.adapter.persistCatalogDetailApproval('admin', h.command)).ok, true);
  const scope = { ...query, inputDigest: h.command.inputDigest };
  assert.equal(
    (
      await h.adapter.persistCatalogDetailApproval('admin', {
        ...scope,
        action: 'operation-approval-media',
      })
    ).ok,
    true,
  );
  for (const page of [0, 1])
    assert.equal(
      (
        await h.adapter.persistCatalogDetailApproval('admin', {
          ...scope,
          action: 'operation-approval-page',
          page,
        })
      ).ok,
      true,
    );
  return { ...h, referenceCommand: { ...scope, action: 'operation-approval-references' as const } };
}
test('frozen own references survive discarded response and JSON reopen with zero repeat writes', async (t) => {
  const h = await jsonOwnReferenceFixture(t);
  const others = JSON.stringify(
    Object.fromEntries(
      Object.entries(JSON.parse(h.bytes())).filter(([key]) => key !== 'catalogDetailApprovals'),
    ),
  );
  await h.adapter.persistCatalogDetailApproval('admin', h.referenceCommand);
  const reopened = new JsonFileAdapter(h.file);
  const recovered = await reopened.persistCatalogDetailApproval('admin', query);
  assert.ok(
    recovered.ok &&
      'record' in recovered &&
      recovered.record.state === 'staging' &&
      recovered.record.references,
  );
  assert.equal(recovered.record.references.operationRootId, recovered.record._id);
  assert.equal(recovered.record.references.leafCount, 0);
  assert.equal(recovered.record.nextPage, 2);
  assert.equal(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(JSON.parse(h.bytes())).filter(([key]) => key !== 'catalogDetailApprovals'),
      ),
    ),
    others,
  );
  const before = h.bytes();
  utimesSync(h.file, new Date(1000), new Date(1000));
  assert.deepEqual(
    await reopened.persistCatalogDetailApproval('admin', h.referenceCommand),
    recovered,
  );
  assert.deepEqual(await reopened.persistCatalogDetailApproval('admin', h.command), recovered);
  assert.deepEqual(
    await reopened.persistCatalogDetailApproval('admin', {
      ...h.referenceCommand,
      action: 'operation-approval-media',
    }),
    recovered,
  );
  assert.deepEqual(
    await reopened.persistCatalogDetailApproval('admin', {
      ...h.referenceCommand,
      action: 'operation-approval-page',
      page: 0,
    }),
    recovered,
  );
  assert.equal(h.bytes(), before);
  assert.equal(statSync(h.file).mtimeMs, 1000);
  assert.equal((await reopened.get('products', 'p'))?.published, false);
  assert.equal(JSON.parse(h.bytes()).catalogDetailApprovals.length, 1);
});
for (const second of ['references', 'media', 'page', 'cancel'] as const)
  test(`concurrent JSON references/${second} preserve the same operation and cancellation boundary`, async (t) => {
    const h = await jsonOwnReferenceFixture(t);
    const other = new JsonFileAdapter(h.file);
    const command =
      second === 'references'
        ? h.referenceCommand
        : second === 'media'
          ? { ...h.referenceCommand, action: 'operation-approval-media' as const }
          : second === 'page'
            ? { ...h.referenceCommand, action: 'operation-approval-page' as const, page: 0 }
            : { ...h.referenceCommand, action: 'operation-cancel' as const };
    const results = await Promise.allSettled([
      h.adapter.persistCatalogDetailApproval('admin', h.referenceCommand),
      other.persistCatalogDetailApproval('admin', command),
    ]);
    assert.ok(results.every((result) => result.status === 'fulfilled'));
    const reopened = new JsonFileAdapter(h.file);
    const current = await reopened.persistCatalogDetailApproval('admin', query);
    assert.ok(current.ok && 'record' in current && current.record.state === 'staging');
    assert.equal(current.record.nextPage, 2);
    assert.ok(current.record.media);
    if (second === 'cancel') {
      assert.equal(current.current, false);
      assert.equal(typeof current.record.operation.cancelledAt, 'string');
      const before = h.bytes();
      assert.deepEqual(await reopened.persistCatalogDetailApproval('admin', h.referenceCommand), {
        ok: false,
        code: 'CONFLICT',
      });
      assert.equal(h.bytes(), before);
    } else {
      assert.equal(current.current, true);
      assert.ok(current.record.references);
      for (const result of results) {
        assert.equal(result.status, 'fulfilled');
        if (result.status === 'fulfilled') assert.equal(result.value.ok, true);
      }
      const before = h.bytes();
      assert.equal(
        (await reopened.persistCatalogDetailApproval('admin', h.referenceCommand)).ok,
        true,
      );
      assert.equal(h.bytes(), before);
    }
    assert.equal((await reopened.get('products', 'p'))?.published, false);
    assert.equal(JSON.parse(h.bytes()).catalogDetailApprovals.length, 1);
  });
test('JSON reference command is copied before awaiting the existing file lock', async (t) => {
  const h = await jsonOwnReferenceFixture(t);
  const command = { ...h.referenceCommand };
  const pending = h.adapter.persistCatalogDetailApproval('admin', command);
  command.productId = 'other';
  command.inputDigest = 'f'.repeat(64);
  const result = await pending;
  assert.ok(
    result.ok &&
      'record' in result &&
      result.record.state === 'staging' &&
      result.record.references,
  );
  assert.equal(result.record.productId, 'p');
});
for (const value of ['null', 'wrong-tree'] as const)
  test(`JSON reopen refuses persisted ${value} reference evidence without rewriting the file`, async (t) => {
    const h = await jsonOwnReferenceFixture(t);
    assert.equal(
      (await h.adapter.persistCatalogDetailApproval('admin', h.referenceCommand)).ok,
      true,
    );
    const rows = JSON.parse(h.bytes());
    if (value === 'null') rows.catalogDetailApprovals[0].references = null;
    else rows.catalogDetailApprovals[0].references.treeRoot = 'f'.repeat(64);
    writeFileSync(h.file, JSON.stringify(rows));
    const before = h.bytes();
    utimesSync(h.file, new Date(1000), new Date(1000));
    const reopened = new JsonFileAdapter(h.file);
    assert.deepEqual(await reopened.persistCatalogDetailApproval('admin', query), {
      ok: false,
      code: 'CONFLICT',
    });
    assert.equal(h.bytes(), before);
    assert.equal(statSync(h.file).mtimeMs, 1000);
  });

async function jsonOwnReferencePageFixture(t: { after(callback: () => void): void }, count = 1) {
  const ids = Array.from({ length: count }, (_, i) => `image${String(i).padStart(2, '0')}`);
  const h = await jsonOwnApprovalFixture(
    t,
    { imageIds: ids.slice(0, 9), descriptionImageIds: ids.slice(9) },
    21,
  );
  const rows = JSON.parse(h.bytes());
  rows.images = ids.map((_id) => ({
    _id,
    status: 'active',
    storageProvider: 'local-disk',
    storageMode: 'local-disk',
    storageFileId: `local-disk:${_id}.png`,
    storagePath: `${_id}.png`,
    mimeType: 'image/png',
    byteSize: 123,
    checksumSha256: 'a'.repeat(64),
    publishedRefCount: 0,
  }));
  writeFileSync(h.file, JSON.stringify(rows));
  assert.equal((await h.adapter.persistCatalogDetailApproval('admin', h.command)).ok, true);
  const scope = { ...query, inputDigest: h.command.inputDigest };
  for (const page of [0, 1])
    assert.equal(
      (
        await h.adapter.persistCatalogDetailApproval('admin', {
          ...scope,
          action: 'operation-approval-page',
          page,
        })
      ).ok,
      true,
    );
  const authority = createCatalogPreparationAuthority({
    secret: 'json-reference-page-metadata',
    environmentId: 'json-reference-page-metadata',
  });
  await finishOwnedMediaFixture(
    (command) => h.adapter.manageCatalogPreparationJob(authority, command),
    h.adapter.get.bind(h.adapter),
    ids,
  );
  assert.equal(
    (
      await h.adapter.persistCatalogDetailApproval('admin', {
        ...scope,
        action: 'operation-approval-media',
      })
    ).ok,
    true,
  );
  assert.equal(
    (
      await h.adapter.persistCatalogDetailApproval('admin', {
        ...scope,
        action: 'operation-approval-references',
      })
    ).ok,
    true,
  );
  return {
    ...h,
    ids,
    pageCommand: { ...scope, action: 'operation-approval-reference-page' as const, cursor: 0 },
    cancelCommand: { ...scope, action: 'operation-cancel' as const },
    mediaCommand: { ...scope, action: 'operation-approval-media' as const },
  };
}
test('JSON27 private images recover the20+7 cursor after lost answers and permanent cancellation', async (t) => {
  const h = await jsonOwnReferencePageFixture(t, 27);
  await h.adapter.persistCatalogDetailApproval('admin', h.pageCommand);
  const reopened = new JsonFileAdapter(h.file);
  const first = await reopened.persistCatalogDetailApproval('admin', query);
  assert.ok(
    first.ok &&
      'record' in first &&
      first.record.state === 'staging' &&
      first.record.referenceStage,
  );
  assert.equal(first.record.referenceStage.cursor, 20);
  const before = h.bytes();
  utimesSync(h.file, new Date(1000), new Date(1000));
  assert.deepEqual(await reopened.persistCatalogDetailApproval('admin', h.pageCommand), first);
  assert.equal(h.bytes(), before);
  assert.equal(statSync(h.file).mtimeMs, 1000);
  const next = await reopened.persistCatalogDetailApproval('admin', {
    ...h.pageCommand,
    cursor: 20,
  });
  assert.ok(
    next.ok && 'record' in next && next.record.state === 'staging' && next.record.referenceStage,
  );
  assert.equal(next.record.referenceStage.cursor, 27);
  assert.equal((await reopened.get('products', 'p'))?.published, false);
  const cancelled = await reopened.persistCatalogDetailApproval('admin', h.cancelCommand);
  assert.ok(cancelled.ok && 'record' in cancelled && !cancelled.current);
  const proofs = JSON.parse(h.bytes()).catalogDetailApprovals;
  assert.equal(proofs.length, 2);
  assert.equal(
    proofs.filter((row: { kind?: unknown }) => row.kind === 'catalog-image-reference-cancel-v1')
      .length,
    1,
  );
  for (const imageId of h.ids) {
    const settled = await reopened.readCatalogImageReference({ action: 'settle', imageId });
    assert.ok(settled.state === 'counted');
    assert.equal(settled.effectiveCount, 0);
    const ledger = settled.image.catalogPublishedReferenceLedger;
    assert.ok(ledger && typeof ledger === 'object');
    assert.deepEqual(Reflect.get(ledger, 'pending'), []);
  }
  const final = h.bytes();
  assert.deepEqual(
    await reopened.persistCatalogDetailApproval('admin', h.cancelCommand),
    cancelled,
  );
  assert.equal(h.bytes(), final);
  assert.equal((await reopened.get('products', 'p'))?.published, false);
});
for (const concurrent of ['page', 'cancel', 'media', 'begin'] as const)
  test(`JSON two adapters serialize reference-page/${concurrent} without lost progress or revived cancellation`, async (t) => {
    const h = await jsonOwnReferencePageFixture(t);
    const other = new JsonFileAdapter(h.file);
    const command =
      concurrent === 'page'
        ? h.pageCommand
        : concurrent === 'cancel'
          ? h.cancelCommand
          : concurrent === 'media'
            ? h.mediaCommand
            : h.command;
    const results = await Promise.allSettled([
      h.adapter.persistCatalogDetailApproval('admin', h.pageCommand),
      other.persistCatalogDetailApproval('admin', command),
    ]);
    assert.ok(results.every((result) => result.status === 'fulfilled'));
    const reopened = new JsonFileAdapter(h.file);
    const status = await reopened.persistCatalogDetailApproval('admin', query);
    assert.ok(status.ok && 'record' in status && status.record.state === 'staging');
    if (concurrent === 'cancel') {
      assert.equal(status.current, false);
      assert.equal(typeof status.record.operation.cancelledAt, 'string');
      const before = h.bytes();
      assert.deepEqual(await reopened.persistCatalogDetailApproval('admin', h.pageCommand), {
        ok: false,
        code: 'CONFLICT',
      });
      assert.equal(h.bytes(), before);
    } else {
      assert.equal(status.current, true);
      assert.equal(status.record.referenceStage?.cursor, 1);
      for (const result of results) {
        assert.equal(result.status, 'fulfilled');
        if (result.status === 'fulfilled') assert.equal(result.value.ok, true);
      }
    }
    const image = await reopened.readCatalogImageReference({
      action: 'read',
      imageId: h.ids[0] ?? '',
    });
    assert.ok(image.state === 'counted');
    assert.equal(image.effectiveCount, 0);
    assert.equal((await reopened.get('products', 'p'))?.published, false);
  });
for (const phase of ['page', 'cancel'] as const)
  test(`JSON ${phase} disk failure rolls back root/proof/images in memory and on disk`, async (t) => {
    const h = await jsonOwnReferencePageFixture(t);
    if (phase === 'cancel')
      assert.equal((await h.adapter.persistCatalogDetailApproval('admin', h.pageCommand)).ok, true);
    const command = phase === 'page' ? h.pageCommand : h.cancelCommand;
    const before = h.bytes();
    const persist = Reflect.get(h.adapter, 'persist');
    assert.equal(typeof persist, 'function');
    try {
      Reflect.set(h.adapter, 'persist', () => {
        throw Error('owned reference disk unavailable');
      });
      await assert.rejects(
        h.adapter.persistCatalogDetailApproval('admin', command),
        /owned reference disk unavailable/,
      );
      assert.equal(h.bytes(), before);
      assert.equal(
        JSON.stringify(Reflect.get(h.adapter, 'store')),
        JSON.stringify(JSON.parse(before)),
      );
    } finally {
      Reflect.set(h.adapter, 'persist', persist);
    }
    assert.equal((await h.adapter.persistCatalogDetailApproval('admin', command)).ok, true);
    assert.equal((await h.adapter.get('products', 'p'))?.published, false);
  });
for (const phase of ['page', 'cancel'] as const)
  test(`JSON applied ${phase} with lost confirmation recovers once after reopen`, async (t) => {
    const h = await jsonOwnReferencePageFixture(t);
    if (phase === 'cancel')
      assert.equal((await h.adapter.persistCatalogDetailApproval('admin', h.pageCommand)).ok, true);
    const command = phase === 'page' ? h.pageCommand : h.cancelCommand;
    const persist = Reflect.get(h.adapter, 'persist');
    assert.ok(typeof persist === 'function');
    try {
      Reflect.set(h.adapter, 'persist', function (this: JsonFileAdapter) {
        Reflect.apply(persist, this, []);
        throw Error('owned reference applied answer lost');
      });
      await assert.rejects(
        h.adapter.persistCatalogDetailApproval('admin', command),
        /owned reference applied answer lost/,
      );
    } finally {
      Reflect.set(h.adapter, 'persist', persist);
    }
    const before = h.bytes();
    utimesSync(h.file, new Date(1000), new Date(1000));
    const reopened = new JsonFileAdapter(h.file);
    const status = await reopened.persistCatalogDetailApproval('admin', query);
    assert.ok(status.ok && 'record' in status && status.record.state === 'staging');
    assert.equal(status.record.referenceStage?.cursor, 1);
    assert.equal(status.current, phase !== 'cancel');
    assert.equal((await reopened.persistCatalogDetailApproval('admin', command)).ok, true);
    assert.equal(h.bytes(), before);
    assert.equal(statSync(h.file).mtimeMs, 1000);
    assert.equal((await reopened.get('products', 'p'))?.published, false);
  });
test('JSON reference-page input is copied before its existing mutation lock yields', async (t) => {
  const h = await jsonOwnReferencePageFixture(t);
  const command = { ...h.pageCommand };
  const pending = h.adapter.persistCatalogDetailApproval('admin', command);
  command.cursor = 1000;
  command.productId = 'other';
  const result = await pending;
  assert.ok(result.ok && 'record' in result && result.record.state === 'staging');
  assert.equal(result.record.referenceStage?.cursor, 1);
  assert.equal(result.record.productId, 'p');
});
for (const corrupt of ['null', 'cursor'] as const)
  test(`JSON reopened ${corrupt} reference progress is refused without a file write`, async (t) => {
    const h = await jsonOwnReferencePageFixture(t);
    assert.equal((await h.adapter.persistCatalogDetailApproval('admin', h.pageCommand)).ok, true);
    const rows = JSON.parse(h.bytes());
    if (corrupt === 'null') rows.catalogDetailApprovals[0].referenceStage = null;
    else rows.catalogDetailApprovals[0].referenceStage.cursor = 0;
    writeFileSync(h.file, JSON.stringify(rows));
    const before = h.bytes();
    utimesSync(h.file, new Date(1000), new Date(1000));
    const reopened = new JsonFileAdapter(h.file);
    assert.deepEqual(await reopened.persistCatalogDetailApproval('admin', query), {
      ok: false,
      code: 'CONFLICT',
    });
    assert.equal(h.bytes(), before);
    assert.equal(statSync(h.file).mtimeMs, 1000);
  });

async function jsonOwnPublishFixture(t: { after(callback: () => void): void }, count = 1) {
  const h = await jsonOwnReferencePageFixture(t, count);
  for (let cursor = 0; cursor < count; cursor += 20)
    assert.equal(
      (await h.adapter.persistCatalogDetailApproval('admin', { ...h.pageCommand, cursor })).ok,
      true,
    );
  const { cursor: _cursor, ...scope } = h.pageCommand;
  return { ...h, finishCommand: { ...scope, action: 'operation-publish' as const } };
}
test('JSON own publish recovers the committed operation after a discarded response with zero writes', async (t) => {
  const h = await jsonOwnPublishFixture(t, 27);
  await h.adapter.persistCatalogDetailApproval('admin', h.finishCommand);
  const reopened = new JsonFileAdapter(h.file);
  const before = h.bytes();
  utimesSync(h.file, new Date(1000), new Date(1000));
  const recovered = await reopened.persistCatalogDetailApproval('admin', query);
  assert.ok(recovered.ok && 'record' in recovered && recovered.record.state === 'complete');
  assert.equal(recovered.current, true);
  assert.deepEqual(
    await reopened.persistCatalogDetailApproval('admin', h.finishCommand),
    recovered,
  );
  assert.equal(h.bytes(), before);
  assert.equal(statSync(h.file).mtimeMs, 1000);
  assert.equal((await reopened.get('products', 'p'))?.published, true);
  for (const imageId of h.ids) {
    const image = await reopened.readCatalogImageReference({ action: 'read', imageId });
    assert.ok(image.state === 'counted');
    assert.equal(image.effectiveCount, 1);
  }
});
for (const lost of [false, true])
  test(`JSON own publication ${lost ? 'applied but answer lost' : 'disk failure'} never leaves a partial proof/root/product`, async (t) => {
    const h = await jsonOwnPublishFixture(t);
    const before = h.bytes();
    const persist = Reflect.get(h.adapter, 'persist');
    assert.ok(typeof persist === 'function');
    try {
      Reflect.set(h.adapter, 'persist', function (this: JsonFileAdapter) {
        if (lost) Reflect.apply(persist, this, []);
        throw Error('owned publication disk response lost');
      });
      await assert.rejects(
        h.adapter.persistCatalogDetailApproval('admin', h.finishCommand),
        /owned publication disk response lost/,
      );
      if (!lost) {
        assert.equal(h.bytes(), before);
        assert.deepEqual(Reflect.get(h.adapter, 'store'), JSON.parse(before));
      }
    } finally {
      Reflect.set(h.adapter, 'persist', persist);
    }
    const reopened = new JsonFileAdapter(h.file);
    if (lost) {
      const committed = h.bytes();
      utimesSync(h.file, new Date(1000), new Date(1000));
      assert.equal(
        (await reopened.persistCatalogDetailApproval('admin', h.finishCommand)).ok,
        true,
      );
      assert.equal(h.bytes(), committed);
      assert.equal(statSync(h.file).mtimeMs, 1000);
    } else
      assert.equal(
        (await reopened.persistCatalogDetailApproval('admin', h.finishCommand)).ok,
        true,
      );
    assert.equal((await reopened.get('products', 'p'))?.published, true);
    const rows = JSON.parse(h.bytes());
    assert.equal(
      rows.catalogDetailApprovals.filter(
        (row: { kind?: unknown }) => row.kind === 'catalog-image-reference-commit-v1',
      ).length,
      1,
    );
  });
for (const first of ['publish', 'cancel'] as const)
  test(`JSON own publication/cancel race with ${first} queued first has one immutable terminal result`, async (t) => {
    const h = await jsonOwnPublishFixture(t);
    const other = new JsonFileAdapter(h.file);
    const operations =
      first === 'publish' ? [h.finishCommand, h.cancelCommand] : [h.cancelCommand, h.finishCommand];
    const results = await Promise.allSettled(
      operations.map((command, i) =>
        (i === 0 ? h.adapter : other).persistCatalogDetailApproval('admin', command),
      ),
    );
    assert.ok(results.every((result) => result.status === 'fulfilled'));
    const values = results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    assert.equal(values.filter((value) => value.ok).length, 1);
    const rows = JSON.parse(h.bytes());
    const committed = rows.catalogDetailApprovals.filter(
      (row: { kind?: unknown }) => row.kind === 'catalog-image-reference-commit-v1',
    );
    const cancelled = rows.catalogDetailApprovals.filter(
      (row: { kind?: unknown }) => row.kind === 'catalog-image-reference-cancel-v1',
    );
    assert.equal(committed.length + cancelled.length, 1);
    assert.equal((await other.get('products', 'p'))?.published, committed.length === 1);
    const image = await other.readCatalogImageReference({
      action: 'read',
      imageId: h.ids[0] ?? '',
    });
    assert.ok(image.state === 'counted');
    assert.equal(image.effectiveCount, committed.length);
  });
test('JSON simultaneous own publication replay commits one proof and one lifecycle increment', async (t) => {
  const h = await jsonOwnPublishFixture(t);
  const other = new JsonFileAdapter(h.file);
  const before = await other.get('products', 'p');
  const results = await Promise.allSettled([
    h.adapter.persistCatalogDetailApproval('admin', h.finishCommand),
    other.persistCatalogDetailApproval('admin', h.finishCommand),
  ]);
  assert.ok(results.every((result) => result.status === 'fulfilled' && result.value.ok));
  const product = await other.get('products', 'p');
  assert.equal(product?.catalogLifecycleVersion, Number(before?.catalogLifecycleVersion ?? 0) + 1);
  assert.equal(JSON.parse(h.bytes()).catalogDetailApprovals.length, 2);
});
test('JSON own publication captures its input before waiting for the file mutation lock', async (t) => {
  const h = await jsonOwnPublishFixture(t);
  const command = { ...h.finishCommand };
  const pending = h.adapter.persistCatalogDetailApproval('admin', command);
  command.productId = 'other';
  command.inputDigest = 'f'.repeat(64);
  const result = await pending;
  assert.ok(result.ok && 'record' in result && result.record.state === 'complete');
  assert.equal(result.record.productId, 'p');
});

test('JSON a concurrent ordinary image write cannot invalidate the staged bytes before own publication', async (t) => {
  const h = await jsonOwnPublishFixture(t);
  const other = new JsonFileAdapter(h.file);
  const imageId = h.ids[0] ?? '';
  const original = await h.adapter.get('images', imageId);
  const results = await Promise.allSettled([
    other.update('images', imageId, {
      status: 'failed',
      storageFileId: 'local-disk:replacement.png',
    }),
    h.adapter.persistCatalogDetailApproval('admin', h.finishCommand),
  ]);
  assert.equal(results[0]?.status, 'rejected');
  assert.ok(results[1]?.status === 'fulfilled' && results[1].value.ok);
  const image = await other.get('images', imageId);
  assert.equal(image?.status, original?.status);
  assert.equal(image?.storageFileId, original?.storageFileId);
  const effective = await other.readCatalogImageReference({ action: 'read', imageId });
  assert.ok(effective.state === 'counted');
  assert.equal(effective.effectiveCount, 1);
  assert.equal((await other.get('products', 'p'))?.published, true);
});

async function jsonTrustedRecoveryFixture(
  t: { after(callback: () => void): void },
  expired = true,
) {
  const h = await jsonOwnPublishFixture(t);
  const rows = JSON.parse(h.bytes());
  rows.users.push({ _id: 'reviewer', role: 'admin' }, { _id: 'reviewer2', role: 'admin' });
  const root = rows.catalogDetailApprovals.find(
    (row: { state?: unknown }) => row.state === 'staging',
  );
  assert.ok(root);
  if (expired) root.createdAt = new Date(Date.now() - 3600001).toISOString();
  writeFileSync(h.file, JSON.stringify(rows));
  const operationRootId: unknown = root._id;
  assert.ok(typeof operationRootId === 'string');
  return {
    ...h,
    recoveryCommand: {
      ...query,
      action: 'operation-recover' as const,
      operationRootId,
      inputDigest: h.finishCommand.inputDigest,
    },
  };
}
test('JSON trusted recovery persists the original owner and first recovering actor after reopen', async (t) => {
  const h = await jsonTrustedRecoveryFixture(t);
  const beforeProduct = await h.adapter.get('products', 'p');
  const result = await h.adapter.persistCatalogDetailApproval('reviewer', h.recoveryCommand);
  assert.ok(result.ok && 'record' in result && result.recovery === 'cancelled');
  assert.equal(result.record.actorId, 'admin');
  assert.equal(result.record.operation.recovery?.actorId, 'reviewer');
  const reopened = new JsonFileAdapter(h.file);
  const before = h.bytes();
  utimesSync(h.file, new Date(1000), new Date(1000));
  const repeated = await reopened.persistCatalogDetailApproval('reviewer2', h.recoveryCommand);
  assert.ok(repeated.ok && 'record' in repeated && repeated.recovery === 'already-cancelled');
  assert.deepEqual(repeated.record, result.record);
  assert.equal(h.bytes(), before);
  assert.equal(statSync(h.file).mtimeMs, 1000);
  assert.deepEqual(await reopened.get('products', 'p'), beforeProduct);
  const effective = await reopened.readCatalogImageReference({
    action: 'read',
    imageId: h.ids[0] ?? '',
  });
  assert.ok(effective.state === 'counted');
  assert.equal(effective.effectiveCount, 0);
});
for (const lost of [false, true])
  test(`JSON trusted recovery ${lost ? 'applied but lost answer' : 'disk failure'} keeps cancellation root and proof atomic`, async (t) => {
    const h = await jsonTrustedRecoveryFixture(t);
    const before = h.bytes();
    const persist = Reflect.get(h.adapter, 'persist');
    assert.ok(typeof persist === 'function');
    try {
      Reflect.set(h.adapter, 'persist', function (this: JsonFileAdapter) {
        if (lost) Reflect.apply(persist, this, []);
        throw Error('recovery disk result unavailable');
      });
      await assert.rejects(
        h.adapter.persistCatalogDetailApproval('reviewer', h.recoveryCommand),
        /recovery disk result unavailable/,
      );
      if (!lost) {
        assert.equal(h.bytes(), before);
        assert.deepEqual(Reflect.get(h.adapter, 'store'), JSON.parse(before));
      }
    } finally {
      Reflect.set(h.adapter, 'persist', persist);
    }
    const reopened = new JsonFileAdapter(h.file);
    const applied = h.bytes();
    const result = await reopened.persistCatalogDetailApproval('reviewer', h.recoveryCommand);
    assert.ok(
      result.ok &&
        'record' in result &&
        result.recovery === (lost ? 'already-cancelled' : 'cancelled'),
    );
    if (lost) assert.equal(h.bytes(), applied);
    assert.equal(
      JSON.parse(h.bytes()).catalogDetailApprovals.filter(
        (row: { kind?: unknown }) => row.kind === 'catalog-image-reference-cancel-v1',
      ).length,
      1,
    );
  });
for (const peer of ['owner-cancel', 'other-recovery'] as const)
  test(`JSON trusted recovery/${peer} race retains one immutable cancellation`, async (t) => {
    const h = await jsonTrustedRecoveryFixture(t);
    const other = new JsonFileAdapter(h.file);
    const results = await Promise.allSettled([
      h.adapter.persistCatalogDetailApproval('reviewer', h.recoveryCommand),
      peer === 'owner-cancel'
        ? other.persistCatalogDetailApproval('admin', h.cancelCommand)
        : other.persistCatalogDetailApproval('reviewer2', h.recoveryCommand),
    ]);
    assert.ok(results.every((result) => result.status === 'fulfilled' && result.value.ok));
    const rows = JSON.parse(h.bytes());
    assert.equal(
      rows.catalogDetailApprovals.filter(
        (row: { kind?: unknown }) => row.kind === 'catalog-image-reference-cancel-v1',
      ).length,
      1,
    );
    assert.equal(rows.products[0].published, false);
    const before = h.bytes();
    const repeated = await other.persistCatalogDetailApproval('reviewer2', h.recoveryCommand);
    assert.ok(repeated.ok && 'record' in repeated && repeated.recovery === 'already-cancelled');
    assert.equal(h.bytes(), before);
  });
test('JSON healthy trusted recovery is read-only and does not prevent the original publication', async (t) => {
  const h = await jsonTrustedRecoveryFixture(t, false);
  const before = h.bytes();
  utimesSync(h.file, new Date(1000), new Date(1000));
  const result = await h.adapter.persistCatalogDetailApproval('reviewer', h.recoveryCommand);
  assert.ok(result.ok && 'record' in result && result.recovery === 'not-needed');
  assert.equal(h.bytes(), before);
  assert.equal(statSync(h.file).mtimeMs, 1000);
  assert.equal((await h.adapter.persistCatalogDetailApproval('admin', h.finishCommand)).ok, true);
});
test('JSON trusted recovery captures its scope before the original file lock yields', async (t) => {
  const h = await jsonTrustedRecoveryFixture(t);
  const command = { ...h.recoveryCommand };
  const pending = h.adapter.persistCatalogDetailApproval('reviewer', command);
  command.productId = 'other';
  command.operationRootId = 'f'.repeat(64);
  const result = await pending;
  assert.ok(result.ok && 'record' in result && result.recovery === 'cancelled');
  assert.equal(result.record.productId, 'p');
});

async function jsonFullReferenceSlotFixture(t: { after(callback: () => void): void }) {
  const h = await jsonOwnPublishFixture(t);
  const initial = await h.adapter.persistCatalogDetailApproval('admin', query);
  assert.ok(initial.ok && 'record' in initial && initial.record.state === 'staging');
  const originalProduct = await h.adapter.get('products', 'p');
  assert.ok(originalProduct);
  const rows = JSON.parse(h.bytes());
  rows.users.push({ _id: 'reviewer', role: 'admin' });
  writeFileSync(h.file, JSON.stringify(rows));
  let lastPage: typeof h.pageCommand | undefined;
  for (let index = 1; index <= 80; index++) {
    const current = await h.adapter.get('products', 'p');
    assert.ok(current);
    const operationId = `12345678-1234-4234-8234-${String(index).padStart(12, '0')}`;
    const expectedUpdatedAt = typeof current.updatedAt === 'string' ? current.updatedAt : null;
    const started = await h.adapter.persistCatalogDetailApproval('admin', {
      action: 'operation-start',
      productId: 'p',
      operationId,
      intent: 'publish',
      expectedUpdatedAt,
      values: {},
    });
    assert.ok(started.ok && 'record' in started && started.record.state === 'reserved');
    const inputDigest = started.record.operation.inputDigest;
    assert.equal(
      (
        await h.adapter.saveCatalogProductWithIdentities({
          mode: 'update',
          productId: 'p',
          data: {},
          expectedUpdatedAt,
          expectedOperation: { actorId: 'admin', operationId, inputDigest },
        })
      ).result,
      'saved',
    );
    const product = await h.adapter.get('products', 'p');
    assert.ok(product);
    const variants: CollectionDoc[] = [];
    for (const id of initial.record.variantIds) {
      const row = await h.adapter.get('productVariants', id);
      assert.ok(row);
      variants.push(row);
    }
    const prepared = prepareStagedApproval(
      'admin',
      {
        productId: 'p',
        operationId,
        expectedRevision: null,
        expectedDigest: catalogApprovalDigest(product, variants),
      },
      product,
      variants,
    );
    assert.ok(prepared.ok, JSON.stringify(prepared));
    const scope = { productId: 'p', operationId, inputDigest };
    assert.equal(
      (
        await h.adapter.persistCatalogDetailApproval('admin', {
          ...scope,
          action: 'operation-approval-begin',
          prepared: prepared.value,
        })
      ).ok,
      true,
    );
    for (let page = 0; page < prepared.value.pageHashes.length; page++)
      assert.equal(
        (
          await h.adapter.persistCatalogDetailApproval('admin', {
            ...scope,
            action: 'operation-approval-page',
            page,
          })
        ).ok,
        true,
      );
    for (const action of ['operation-approval-media', 'operation-approval-references'] as const)
      assert.equal(
        (await h.adapter.persistCatalogDetailApproval('admin', { ...scope, action })).ok,
        true,
      );
    const command = { ...scope, action: 'operation-approval-reference-page' as const, cursor: 0 };
    const beforePage = h.bytes();
    const result = await h.adapter.persistCatalogDetailApproval('admin', command);
    if (index < 80) assert.equal(result.ok, true, JSON.stringify(result));
    else {
      assert.deepEqual(result, {
        ok: false,
        code: 'MEDIA_BUSY',
        pendingReferenceImageId: h.ids[0],
      });
      assert.equal(h.bytes(), beforePage);
      lastPage = command;
    }
  }
  assert.ok(lastPage);
  return { h, initial, originalProduct, lastPage };
}

test('JSON80 actual staged roots recover one obsolete operation and resume the original full-slot page', async (t) => {
  const { h, initial, originalProduct, lastPage } = await jsonFullReferenceSlotFixture(t);
  assert.ok(lastPage);
  const recovery = await h.adapter.persistCatalogDetailApproval('reviewer', {
    ...query,
    action: 'operation-recover',
    operationRootId: initial.record._id,
    inputDigest: initial.record.operation.inputDigest,
  });
  assert.ok(recovery.ok && 'record' in recovery && recovery.recovery === 'cancelled');
  assert.equal(recovery.record.operation.recovery?.reason, 'input-changed');
  const resumed = await h.adapter.persistCatalogDetailApproval('admin', lastPage);
  assert.ok(resumed.ok && 'record' in resumed && resumed.record.state === 'staging');
  assert.equal(resumed.record.operationId, lastPage.operationId);
  assert.equal(resumed.record.referenceStage?.cursor, 1);
  const image = await h.adapter.readCatalogImageReference({
    action: 'read',
    imageId: h.ids[0] ?? '',
  });
  assert.ok(image.state === 'counted');
  assert.equal(image.effectiveCount, 0);
  const ledger = image.image.catalogPublishedReferenceLedger;
  assert.ok(ledger && typeof ledger === 'object');
  const pending: unknown = Reflect.get(ledger, 'pending');
  assert.ok(Array.isArray(pending));
  assert.equal(pending.length, 80);
  const product = await h.adapter.get('products', 'p');
  assert.ok(product);
  assert.equal(product.published, false);
  for (const field of ['productFamily', 'category', 'subcategoryIds']) {
    assert.equal(Object.hasOwn(product, field), Object.hasOwn(originalProduct, field));
    assert.deepEqual(product[field], originalProduct[field]);
  }
  assert.equal(
    JSON.parse(h.bytes()).catalogDetailApprovals.filter(
      (row: { kind?: unknown }) => row.kind === 'catalog-image-reference-commit-v1',
    ).length,
    0,
  );
  t.after(() => assert.throws(() => readFileSync(h.file), { code: 'ENOENT' }));
});

test('JSON80 production index automatically retires an obsolete holder and resumes the original full-slot page', async (t) => {
  const { h, initial, originalProduct, lastPage } = await jsonFullReferenceSlotFixture(t);
  setAdapter(h.adapter);
  const imageBefore = await h.adapter.get('images', h.ids[0] ?? '');
  assert.ok(imageBefore);
  const beforeLedger = imageBefore.catalogPublishedReferenceLedger;
  assert.ok(beforeLedger && typeof beforeLedger === 'object');
  const beforePending: unknown = Reflect.get(beforeLedger, 'pending');
  assert.ok(Array.isArray(beforePending));
  const expectedRoots = beforePending
    .map((entry) => {
      assert.ok(entry && typeof entry === 'object');
      return Reflect.get(entry, 'operationRootId');
    })
    .filter((id) => id !== initial.record._id);
  const result = await persistCatalogDetailApproval('admin', lastPage);
  assert.ok(
    result.ok && 'record' in result && result.record.state === 'staging',
    JSON.stringify(result),
  );
  assert.equal(result.record.operationId, lastPage.operationId);
  assert.equal(result.record.referenceStage?.cursor, 1);
  const old = await h.adapter.get('catalogDetailApprovals', initial.record._id);
  assert.ok(old);
  const operation = old.operation;
  assert.ok(operation && typeof operation === 'object');
  assert.equal(typeof Reflect.get(operation, 'cancelledAt'), 'string');
  const audit = Reflect.get(operation, 'recovery');
  assert.ok(audit && typeof audit === 'object');
  assert.equal(Reflect.get(audit, 'actorId'), 'admin');
  assert.equal(Reflect.get(audit, 'reason'), 'input-changed');
  const image = await h.adapter.readCatalogImageReference({
    action: 'read',
    imageId: h.ids[0] ?? '',
  });
  assert.ok(image.state === 'counted');
  assert.equal(image.effectiveCount, 0);
  const ledger = image.image.catalogPublishedReferenceLedger;
  assert.ok(ledger && typeof ledger === 'object');
  const pending: unknown = Reflect.get(ledger, 'pending');
  assert.ok(Array.isArray(pending));
  assert.equal(pending.length, 80);
  assert.deepEqual(
    new Set(pending.map((entry) => Reflect.get(entry, 'operationRootId'))),
    new Set([...expectedRoots, result.record._id]),
  );
  const product = await h.adapter.get('products', 'p');
  assert.ok(product);
  assert.equal(product.published, false);
  for (const field of ['productFamily', 'category', 'subcategoryIds']) {
    assert.equal(Object.hasOwn(product, field), Object.hasOwn(originalProduct, field));
    assert.deepEqual(product[field], originalProduct[field]);
  }
  const before = h.bytes();
  assert.deepEqual(await persistCatalogDetailApproval('admin', lastPage), result);
  assert.equal(h.bytes(), before);
  assert.equal(
    JSON.parse(h.bytes()).catalogDetailApprovals.filter(
      (row: { kind?: unknown }) => row.kind === 'catalog-image-reference-commit-v1',
    ).length,
    0,
  );
});
