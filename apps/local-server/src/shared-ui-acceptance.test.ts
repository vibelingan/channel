import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptanceCatalog } from './shared-ui-acceptance.ts';

test('acceptance clone excludes buyers, credentials, inquiries and provider source links', () => {
  const data = acceptanceCatalog({
    products: [{ _id: 'p', localDetailClone: true }],
    productVariants: [],
    images: [],
    users: [{ passwordHash: 'secret' }],
    catalogQuoteRequests: [{ email: 'private@example.test' }],
    catalogSourceLinks: [{ secret: 'provider' }],
  });
  assert.deepEqual(Object.keys(data).sort(), ['images', 'productVariants', 'products']);
  assert.ok(!JSON.stringify(data).includes('secret'));
  assert.ok(!JSON.stringify(data).includes('private@example.test'));
});
test('acceptance refuses non-clones, empty and unbounded sources', () => {
  for (const products of [
    [],
    [{ _id: 'p' }],
    Array.from({ length: 11 }, (_, i) => ({ _id: String(i), localDetailClone: true })),
  ])
    assert.throws(() => acceptanceCatalog({ products, productVariants: [], images: [] }));
});
