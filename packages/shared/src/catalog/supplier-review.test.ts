/** Supplier review fields on a product (DEC-19, DEC-20; MIU-40). */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWriteSchema, getCollection } from '../collections.ts';

const products = getCollection('products');
assert.ok(products);
const write = buildWriteSchema(products).partial();
const digest = 'a'.repeat(64);

test('supplier decisions accept a choice per part for one exact incoming value', () => {
  const ok = write.safeParse({
    supplierDecisions: {
      description: { choice: 'keep', incomingDigest: digest },
      gallery: { choice: 'incoming', incomingDigest: digest },
    },
  });
  assert.equal(ok.success, true);
  for (const bad of [
    { price: { choice: 'keep', incomingDigest: digest } },
    { description: { choice: 'maybe', incomingDigest: digest } },
    { description: { choice: 'keep', incomingDigest: 'short' } },
    { description: { choice: 'keep', incomingDigest: digest, extra: 1 } },
    'keep',
  ])
    assert.equal(write.safeParse({ supplierDecisions: bad }).success, false, JSON.stringify(bad));
});

test('configuration photos map a configuration to at most nine image ids', () => {
  assert.equal(
    write.safeParse({ configurationPhotos: { 'variant-1': ['img-1', 'img-2'], 'variant-2': [] } })
      .success,
    true,
  );
  for (const bad of [
    { 'variant-1': Array.from({ length: 10 }, (_, i) => `img-${i}`) },
    { 'variant-1': ['../escape'] },
    { 'variant-1': 'img-1' },
    { '': ['img-1'] },
  ])
    assert.equal(write.safeParse({ configurationPhotos: bad }).success, false, JSON.stringify(bad));
  assert.equal(
    write.safeParse({
      configurationPhotos: Object.fromEntries(
        Array.from({ length: 501 }, (_, i) => [`v${i}`, ['img']]),
      ),
    }).success,
    false,
    'at most 500 configurations',
  );
});
