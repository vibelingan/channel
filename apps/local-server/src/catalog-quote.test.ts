import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import express from 'express';
import { registerLocalQuoteRoutes } from './catalog-quote-routes.ts';
import { closeServer } from './catalog-routes.ts';
import { JsonFileAdapter } from './json-adapter.ts';

const fields = {
  intent: 'variant_quote',
  quantity: '1',
  deliveryDate: '',
  customizationTypes: [],
  brief: '',
  contactName: 'Test Buyer',
  email: 'buyer@example.test',
  company: 'Test Co',
  country: 'HK',
};
const target = { intent: 'variant_quote', productId: 'p1', revision: 'r1', variantId: 'v1' };
const input = { idempotencyKey: '12345678-1234-4123-8123-123456789abc', target, fields };
const approvedVariant = {
  id: 'v1',
  options: [{ name: 'Color', value: 'Pink' }],
  images: [],
  inventory: { state: 'unknown' },
  offers: [],
};
async function setup(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'channel-local-rfq-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'db.json');
  const db = new JsonFileAdapter(file);
  await db.create('products', {
    _id: 'p1',
    published: true,
    archived: false,
    localDetailClone: true,
    catalogDetailPublication: {
      state: 'approved',
      revision: 'r1',
      variantCount: 1,
      header: {
        schemaVersion: 'catalog-product-detail-v1',
        _id: 'p1',
        name: 'Approved Headset',
        images: [],
        facts: [],
        offers: [],
      },
    },
  });
  await db.create('productVariants', {
    _id: 'v1',
    productId: 'p1',
    archived: false,
    catalogDetailRevision: 'r1',
    catalogDetailApproved: approvedVariant,
  });
  return { db, file };
}
test('local RFQ atomically stores authoritative context and deduplicates concurrent retries across adapter reload', async (t) => {
  const { db, file } = await setup(t);
  const results = await Promise.all(Array.from({ length: 8 }, () => db.submitCatalogQuote(input)));
  assert.equal(
    results.every((r) => r.ok),
    true,
  );
  assert.equal(new Set(results.map((r) => (r.ok ? r.requestId : ''))).size, 1);
  const stored = JSON.parse(readFileSync(file, 'utf8')).catalogQuoteRequests;
  assert.equal(stored.length, 1);
  assert.equal(stored[0].snapshot.productName, 'Approved Headset');
  assert.equal(stored[0].snapshot.variant.options[0].value, 'Pink');
  assert.equal(stored[0].fields.country, 'HK');
  assert.equal(stored[0].status, 'new');
  assert.equal(stored[0].notification, 'disabled-local');
  assert.deepEqual(await new JsonFileAdapter(file).submitCatalogQuote(input), results[0]);
  // Publication mutations use the very same queue: the accepted request remains
  // retryable, while a new request queued after unpublish must be rejected.
  const [, denied] = await Promise.all([
    db.update('products', 'p1', { published: false }),
    db.submitCatalogQuote({ ...input, idempotencyKey: '22345678-1234-4123-8123-123456789abc' }),
  ]);
  assert.deepEqual(denied, { ok: false, code: 'unavailable' });
  assert.deepEqual(await db.submitCatalogQuote(input), results[0]);
  assert.deepEqual(
    await db.submitCatalogQuote({ ...input, fields: { ...fields, quantity: '2' } }),
    { ok: false, code: 'idempotency-conflict' },
  );
});
test('local RFQ rejects forged data, missing foreign archived stale and unpublished context without saving', async (t) => {
  const { db, file } = await setup(t);
  for (const body of [
    null,
    { ...input, price: 1 },
    { ...input, fields: { ...fields, country: 'ZZ' } },
    { ...input, target: { ...target, revision: 'old' } },
    { ...input, target: { ...target, variantId: 'missing' } },
    { ...input, target: { ...target, intent: 'customization' } },
  ]) {
    assert.equal((await db.submitCatalogQuote(body)).ok, false);
  }
  await db.update('productVariants', 'v1', { productId: 'foreign' });
  assert.equal((await db.submitCatalogQuote(input)).ok, false);
  await db.update('productVariants', 'v1', { productId: 'p1', archived: true });
  assert.equal((await db.submitCatalogQuote(input)).ok, false);
  await db.update('productVariants', 'v1', { archived: false });
  await db.update('products', 'p1', { published: false });
  assert.equal((await db.submitCatalogQuote(input)).ok, false);
  const rows = JSON.parse(readFileSync(file, 'utf8')).catalogQuoteRequests ?? [];
  assert.equal(rows.length, 0);
});
test('local quote HTTP route requires explicit origin and JSON header, limits body, and never exposes buyer records', async (t) => {
  const { db } = await setup(t);
  const app = express();
  registerLocalQuoteRoutes(app, db);
  const server = app.listen(0, '127.0.0.1');
  t.after(() => closeServer(server));
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/api/catalog-quote-requests`;
  const headers = {
    origin: 'http://127.0.0.1:4328',
    'content-type': 'application/json',
    'x-local-catalog-quote': '1',
  };
  assert.equal(
    (
      await fetch(url, {
        method: 'POST',
        headers: { ...headers, origin: 'https://evil.test' },
        body: JSON.stringify(input),
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(url, {
        method: 'POST',
        headers: { origin: headers.origin, 'content-type': 'text/plain' },
        body: '{}',
      })
    ).status,
    415,
  );
  assert.equal((await fetch(url, { method: 'POST', headers, body: '{' })).status, 400);
  assert.equal(
    (
      await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ text: 'x'.repeat(18000) }),
      })
    ).status,
    413,
  );
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(input) });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.ok(result && typeof result === 'object');
  assert.deepEqual(Object.keys(result).sort(), ['ok', 'requestId']);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(url, { headers })).status, 405);
});
