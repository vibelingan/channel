import assert from 'node:assert/strict';
import test from 'node:test';
import {
  readCatalogDetailPreview,
  readCatalogDetailPreviewCandidate,
} from './catalog-detail-preview.ts';
import {
  inspectCatalogPreparation,
  readCatalogPreparationCandidate,
} from './catalog-preparation-inspect.ts';
import { fixture } from './testing/catalog-source-plan-fixture.ts';
const allow = async () => ({ ok: true as const });
for (const manual of [false, true])
  test(`backend candidate access has no dependency on a human user row, manual=${manual}`, async () => {
    const h = fixture(0);
    if (manual) {
      Reflect.deleteProperty(h.product, 'alibabaPrimarySourceKey');
      h.adapter.list = async () => ({ items: [], total: 0, page: 1, pageSize: 100 });
    }
    h.adapter.rows.users = [];
    const before = structuredClone(h.adapter.rows);
    const gets: string[] = [];
    const get = h.adapter.get.bind(h.adapter);
    h.adapter.get = async (c, id) => {
      gets.push(c);
      return get(c, id);
    };
    const candidate = await readCatalogPreparationCandidate({ productId: h.product._id }, allow);
    assert.ok(candidate.ok, JSON.stringify(candidate));
    assert.equal(candidate.kind, 'unsealed-inspection');
    assert.deepEqual(candidate.imageIds, []);
    assert.equal(gets.includes('users'), false);
    assert.deepEqual(h.adapter.rows, before);
    assert.deepEqual(h.adapter.commands, []);
    assert.deepEqual(await inspectCatalogPreparation('admin', { productId: h.product._id }), {
      ok: false,
      code: 'FORBIDDEN',
    });
  });
test('human preview still rejects a wrong or missing actual admin identity', async () => {
  const h = fixture(0);
  const get = h.adapter.get.bind(h.adapter);
  h.adapter.get = async (c, id) => (c === 'users' ? { _id: 'other', role: 'admin' } : get(c, id));
  assert.deepEqual(
    await readCatalogDetailPreview('admin', { action: 'preview', productId: h.product._id }),
    { ok: false, code: 'FORBIDDEN' },
  );
});
for (const reader of ['preview', 'inspection'] as const)
  test(`backend ${reader} rejects before any data read and projects private failure fields`, async () => {
    const h = fixture(0);
    let reads = 0;
    h.adapter.get = async () => {
      reads++;
      throw Error('must not read');
    };
    const deny = async () => ({
      ok: false as const,
      code: 'CONFLICT' as const,
      secret: 'private diagnostic',
    });
    const result =
      reader === 'preview'
        ? await readCatalogDetailPreviewCandidate(
            { action: 'preview', productId: h.product._id },
            deny,
          )
        : await readCatalogPreparationCandidate({ productId: h.product._id }, deny);
    assert.deepEqual(result, { ok: false, code: 'CONFLICT' });
    assert.equal(reads, 0);
  });
for (const reader of ['preview', 'inspection'] as const)
  test(`backend ${reader} rechecks access after candidate reads`, async () => {
    const h = fixture(0);
    let calls = 0;
    const check = async () =>
      ++calls === 1 ? { ok: true as const } : { ok: false as const, code: 'CONFLICT' as const };
    const before = structuredClone(h.adapter.rows);
    const result =
      reader === 'preview'
        ? await readCatalogDetailPreviewCandidate(
            { action: 'preview', productId: h.product._id },
            check,
          )
        : await readCatalogPreparationCandidate({ productId: h.product._id }, check);
    assert.deepEqual(result, { ok: false, code: 'CONFLICT' });
    assert.equal(calls, 2);
    assert.deepEqual(h.adapter.rows, before);
  });

test('human inspection preserves its established output while private candidate exposes all media IDs', async () => {
  const h = fixture(0);
  const options = { now: () => 1792080000000 };
  const human = await inspectCatalogPreparation('admin', { productId: h.product._id }, options);
  const candidate = await readCatalogPreparationCandidate(
    { productId: h.product._id },
    allow,
    options,
  );
  assert.ok(human.ok && candidate.ok);
  assert.equal(Object.hasOwn(human, 'imageIds'), false);
  assert.equal(Object.hasOwn(candidate, 'imageIds'), true);
  assert.equal(Object.hasOwn(human, 'sourcePhotos'), false);
  const { imageIds: _ids, sourcePhotos: _photos, ...projected } = candidate;
  assert.deepEqual(human, projected);
});
