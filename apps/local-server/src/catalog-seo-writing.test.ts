import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CatalogProductOperationStatusSchema } from '@vibelingan-channel/shared/catalog-product-operation';
import { JsonFileAdapter } from './json-adapter.ts';
import { coldOwnedMedia, workspace } from './testing/catalog-operation-workspace.ts';

const config = { siteOrigin: 'https://shop.example', detailEnabled: true };
function fixture(t: { after(fn: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), 'channel-seo-writes-'));
  t.after(() => {
    chmodSync(directory, 0o700);
    rmSync(directory, { recursive: true, force: true });
  });
  const file = join(directory, 'db.json');
  writeFileSync(
    file,
    JSON.stringify({
      products: [{ _id: 'p', name: 'Old headset', published: true, productFamily: 'misc' }],
    }),
  );
  const db = new JsonFileAdapter(file, false, config);
  return { directory, file, db, saved: () => JSON.parse(readFileSync(file, 'utf8')) };
}

test('real local saves persist the product and its pending request, and a duplicate save keeps the token', async (t) => {
  const h = fixture(t);
  await h.db.update('products', 'p', { name: 'New headset' });
  assert.equal(h.saved().products[0].name, 'New headset');
  assert.equal(h.saved().catalogSeoRequests.length, 1);
  assert.equal(h.saved().catalogSeoRequests[0].productId, 'p');
  const token = h.saved().catalogSeoRequests[0].token;
  await h.db.update('products', 'p', { name: 'New headset' });
  assert.equal(h.saved().catalogSeoRequests[0].token, token);
  await h.db.update('products', 'p', { published: false });
  assert.equal(h.saved().catalogSeoRequests.length, 1);
  assert.notEqual(h.saved().catalogSeoRequests[0].token, token);
  assert.equal(h.saved().catalogSeoRequests[0].previouslyPublic, true);
  const reopened = new JsonFileAdapter(h.file, false, config);
  assert.equal((await reopened.get('products', 'p'))?.published, false);
});

test('a failed local atomic write leaves both the file and a subsequent read unchanged', async (t) => {
  const h = fixture(t);
  const initial = readFileSync(h.file, 'utf8');
  chmodSync(h.directory, 0o500);
  await assert.rejects(h.db.update('products', 'p', { name: 'Must not persist' }));
  assert.equal(readFileSync(h.file, 'utf8'), initial);
  chmodSync(h.directory, 0o700);
  assert.equal((await h.db.get('products', 'p'))?.name, 'Old headset');
  assert.equal(h.saved().catalogSeoRequests, undefined);
});

test('the actual Admin publication flow creates a durable request only when the product becomes public', async (t) => {
  const h = await workspace(t, undefined, true, config);
  const media = await coldOwnedMedia(h);
  const scope = await h.start('publish', { description: 'Reviewed product description' });
  assert.equal(JSON.parse(h.bytes()).catalogSeoRequests, undefined);
  let state: string | undefined;
  for (let attempt = 0; attempt < 12 && state !== 'complete'; attempt++) {
    const response = await h.invokeWithConfig(
      { ...scope, action: 'product-operation-continue' },
      media.config,
    );
    assert.ok(response.ok, JSON.stringify(response));
    state = CatalogProductOperationStatusSchema.parse(response.data).state;
    if (state !== 'complete') assert.equal(JSON.parse(h.bytes()).catalogSeoRequests, undefined);
  }
  assert.equal(state, 'complete');
  const saved = JSON.parse(h.bytes());
  assert.equal(saved.products[0].published, true);
  assert.equal(saved.catalogSeoRequests.length, 1);
  assert.equal(saved.catalogSeoRequests[0].productId, h.productId);
  const token = saved.catalogSeoRequests[0].token;
  const replay = await h.invokeWithConfig(
    { ...scope, action: 'product-operation-continue' },
    media.config,
  );
  assert.ok(replay.ok);
  assert.equal(JSON.parse(h.bytes()).catalogSeoRequests[0].token, token);
  const withdrawn = await h.admin('update', {
    collection: 'products',
    id: h.productId,
    values: { published: false },
  });
  assert.ok(withdrawn.ok, JSON.stringify(withdrawn));
  const after = JSON.parse(h.bytes());
  assert.equal(after.products[0].published, false);
  assert.equal(after.catalogSeoRequests.length, 1);
  assert.notEqual(after.catalogSeoRequests[0].token, token);
  assert.equal(after.catalogSeoRequests[0].previouslyPublic, true);
});

test('the prepared Admin workflow commits its final publication and request through the installed CloudBase SDK', async (t) => {
  const { articleSdkFixture } = await import(
    '../../../packages/db/src/article-sdk-fixture.test-helper.ts'
  );
  const { persistStagedApprovalInCloud } = await import(
    '@vibelingan-channel/db/catalog-detail-staging'
  );
  const h = await workspace(t, undefined, false, config);
  const media = await coldOwnedMedia(h);
  const scope = await h.start('publish', { description: 'Reviewed product description' });
  for (let attempt = 0; attempt < 8; attempt++) {
    const response = await h.invokeWithConfig(
      { ...scope, action: 'product-operation-continue' },
      media.config,
    );
    assert.ok(response.ok, JSON.stringify(response));
  }
  const saved: Record<string, Array<Record<string, unknown>>> = JSON.parse(h.bytes());
  assert.equal(saved.products?.[0]?.published, false);
  assert.equal(saved.catalogSeoRequests, undefined);
  const fixture = articleSdkFixture(t);
  for (const [collection, rows] of Object.entries(saved))
    for (const row of rows) {
      assert.equal(typeof row._id, 'string');
      fixture.put(collection, String(row._id), row);
    }
  const native: unknown = fixture.db;
  function isNativeDb(
    value: unknown,
  ): asserts value is import('@vibelingan-channel/db/cloudbase').NodeSdkDatabase {
    assert.ok(value && typeof value === 'object');
    assert.equal(typeof Reflect.get(value, 'runTransaction'), 'function');
    assert.equal(typeof Reflect.get(value, 'collection'), 'function');
    assert.equal(typeof Reflect.get(value, 'command'), 'object');
  }
  isNativeDb(native);
  const command = { ...scope, action: 'operation-publish' as const };
  const result = await persistStagedApprovalInCloud(native, 'admin', command, config);
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(fixture.rows.get(`products/${h.productId}`)?.published, true);
  const requests = [...fixture.rows].filter(([key]) => key.startsWith('catalogSeoRequests/'));
  assert.equal(requests.length, 1);
  const writes = fixture.calls.filter((call) => call.api === 'database.modifyDocument');
  assert.ok(writes.some((call) => call.params.collectionName === 'catalogDetailApprovals'));
  assert.equal(new Set(writes.map((call) => call.params.transactionId)).size, 1);
  const replay = await persistStagedApprovalInCloud(native, 'admin', command, config);
  assert.ok(replay.ok, JSON.stringify(replay));
  assert.deepEqual(
    [...fixture.rows].filter(([key]) => key.startsWith('catalogSeoRequests/')),
    requests,
  );
});
