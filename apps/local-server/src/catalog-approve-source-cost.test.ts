import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { signSession } from '@vibelingan-channel/auth/jwt';
import { sourceMediaLinkId } from '@vibelingan-channel/catalog-import/observations';
import { setAdapter } from '@vibelingan-channel/db';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { approveInOneRequest } from '../../functions/admin/src/catalog-approve-once.ts';
import { handleAdminRequest } from '../../functions/admin/src/handler.ts';
import { fixture } from '../../functions/admin/src/testing/catalog-source-plan-fixture.ts';
import { getProductDetail } from '../../functions/public-api/src/catalog-detail.ts';
import { JsonFileAdapter } from './json-adapter.ts';

function workspace(t: TestContext, count: number) {
  const directory = mkdtempSync(join(tmpdir(), 'channel-approve-source-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'db.json');
  const { product, adapter: input, observation } = fixture(count);
  product.archived = false;
  product.imageIds = ['image-owned'];
  input.rows.images = [
    {
      _id: 'image-owned',
      status: 'active',
      storageProvider: 'local-disk',
      publishedRefCount: 0,
      refCount: 1,
    },
  ];
  const url = (index: number) => `https://sc04.alicdn.com/source-cost-${index}.png`;
  observation.content.media = [{ sourceUrl: url(count), position: 0, role: 'primary' }];
  for (const [index, variant] of observation.variants.entries())
    variant.media = [{ sourceUrl: url(index), position: 0, role: 'variant' }];
  const stored = input.rows.catalogSourceObservations?.[0];
  assert.ok(stored);
  stored.observation = observation;
  input.rows.catalogSourceLinks = Array.from({ length: count + 1 }, (_, index) => ({
    _id: sourceMediaLinkId('alibaba', url(index)),
    provider: 'alibaba',
    sourceUrl: url(index),
    imageId: 'image-owned',
  }));
  writeFileSync(path, JSON.stringify(input.rows));
  const adapter = new JsonFileAdapter(path);
  setAdapter(adapter);
  return { adapter, product, path };
}
const command = (productId: string) => ({
  action: 'approve',
  productId,
  operationId: randomUUID(),
});

test('one-request approval resolves each source media link once for all 105 configurations and a new request reads fresh data', async (t) => {
  const { adapter, product } = workspace(t, 105);
  const original = adapter.get.bind(adapter);
  let reads = 0;
  let inflight = 0;
  let maximum = 0;
  t.mock.method(adapter, 'get', async (collection: string, id: string) => {
    if (collection !== 'catalogSourceLinks') return original(collection, id);
    reads++;
    inflight++;
    maximum = Math.max(maximum, inflight);
    try {
      return await original(collection, id);
    } finally {
      inflight--;
    }
  });
  const config = { jwtSecret: 'source-cost-local-only', enableDetailApproval: true };
  const token = await signSession(config.jwtSecret, {
    sub: 'admin',
    role: 'admin',
    name: 'Admin',
    email: 'admin@example.test',
  });
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt === 2) {
      const previous = await adapter.get('products', product._id);
      assert.ok(previous);
      const edited = await handleAdminRequest(
        {
          action: 'update',
          token,
          data: {
            collection: 'products',
            id: product._id,
            values: { name: 'Changed website title' },
            expectedUpdatedAt: typeof previous.updatedAt === 'string' ? previous.updatedAt : null,
          },
        },
        config,
      );
      assert.equal(edited.ok, true);
    }
    const request = command(product._id);
    const approved = await approveInOneRequest('admin', request);
    assert.ok(approved.ok && approved.status === 'approved', JSON.stringify(approved));
    assert.equal(reads, attempt * 106, 'one bounded source lookup per distinct URL per request');
    assert.ok(maximum <= 8, `at most eight source lookups concurrently, observed ${maximum}`);
    const saved = await adapter.get('products', product._id);
    assert.equal(saved?.published, false);
    const receipt = saved?.catalogDetailApprovalReceipt;
    assert.ok(receipt && typeof receipt === 'object');
    assert.equal(Reflect.get(receipt, 'operationId'), request.operationId);
    const visibility = (published: boolean) =>
      handleAdminRequest(
        {
          action: 'update',
          token,
          data: { collection: 'products', id: product._id, values: { published } },
        },
        config,
      );
    assert.equal((await visibility(true)).ok, true);
    const publicLast = await getProductDetail(product._id, 3);
    assert.ok(publicLast.ok);
    assert.equal(publicLast.data.name, attempt === 1 ? product.name : 'Changed website title');
    assert.equal(publicLast.data.variants.total, 105);
    assert.equal(publicLast.data.variants.items.at(-1)?.sku, 'SKU-104');
    assert.equal((await visibility(false)).ok, true);
    assert.equal((await adapter.get('products', product._id))?.published, false);
    assert.equal((await adapter.get('images', 'image-owned'))?.publishedRefCount, 0);
  }
});

for (const fault of ['source', 'gallery', 'generation', 'binding', 'actor', 'archive']) {
  test(`a cached one-request source plan still refuses ${fault} changing before its second native page`, async (t) => {
    const { adapter, product, path } = workspace(t, 21);
    const original = adapter.persistCatalogDetailApproval.bind(adapter);
    let injected: string | undefined;
    t.mock.method(
      adapter,
      'persistCatalogDetailApproval',
      async (
        actor: string,
        input: Parameters<JsonFileAdapter['persistCatalogDetailApproval']>[1],
      ) => {
        if (
          input &&
          typeof input === 'object' &&
          Reflect.get(input, 'action') === 'source-page' &&
          Reflect.get(input, 'page') === 1
        ) {
          const data: Record<string, CollectionDoc[]> = JSON.parse(readFileSync(path, 'utf8'));
          const saved = data.products?.[0];
          assert.ok(saved);
          if (fault === 'gallery') saved.imageIds = [];
          if (fault === 'generation')
            saved.catalogContentGeneration = Number(saved.catalogContentGeneration) + 1;
          if (fault === 'archive') saved.archived = true;
          if (fault === 'binding') {
            assert.ok(data.alibabaProductLinks?.[0]);
            data.alibabaProductLinks[0].productId = 'another-product';
          }
          if (fault === 'actor') {
            assert.ok(data.users?.[0]);
            data.users[0].role = 'contributor';
          }
          if (fault === 'source') {
            const row = data.catalogSourceObservations?.[0];
            assert.ok(row);
            const observation = row.observation;
            assert.ok(observation && typeof observation === 'object');
            const source = Reflect.get(observation, 'source');
            assert.ok(source && typeof source === 'object');
            Reflect.set(source, 'observedAt', '2026-10-14T01:00:00.000Z');
          }
          injected = JSON.stringify(data);
          writeFileSync(path, injected);
        }
        return original(actor, input);
      },
    );
    const result = await approveInOneRequest('admin', command(product._id));
    assert.deepEqual(result, { ok: false, code: fault === 'actor' ? 'FORBIDDEN' : 'CONFLICT' });
    assert.ok(injected);
    assert.equal(
      readFileSync(path, 'utf8'),
      injected,
      'refusal is atomic after the injected change',
    );
    const saved = await adapter.get('products', product._id);
    assert.equal(saved?.published, false);
    assert.equal(saved?.detailSourceReady, false);
    assert.equal(saved?.detailSourceNextPage, 1);
    assert.equal(saved?.catalogDetailPublication, undefined);
  });
}
