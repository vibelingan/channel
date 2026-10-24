import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAlibabaProductLink } from './alibaba-link-identity.ts';

const link = {
  _id: 'source',
  sourceKey: 'source',
  connectionId: 'connection',
  sourceProductId: 'external',
  productId: 'product',
  linkedAt: '2026-01-01T00:00:00.000Z',
};

test('link decoder retains identity and excludes unrelated capture metadata', () => {
  assert.deepEqual(
    parseAlibabaProductLink({
      ...link,
      categoryAssignmentFence: 'capture',
      updatedAt: 'later',
      linkedByUserId: 'actor',
    }),
    link,
  );
});

test('link decoder refuses missing, malformed, whitespace and mismatched identity fields', () => {
  for (const field of ['_id', 'sourceKey', 'connectionId', 'sourceProductId', 'linkedAt']) {
    for (const value of [undefined, null, 0, '', ' '])
      assert.equal(
        parseAlibabaProductLink({ ...link, [field]: value }),
        null,
        `${field}: ${String(value)}`,
      );
  }
  for (const value of [undefined, null, 1, [], {}])
    assert.equal(parseAlibabaProductLink(value), null);
  assert.equal(parseAlibabaProductLink({ ...link, sourceKey: 'another-source' }), null);
});

test('only an explicitly allowed empty legacy claim can omit its product', () => {
  const empty = { ...link, productId: '' };
  assert.equal(parseAlibabaProductLink(empty), null);
  assert.deepEqual(parseAlibabaProductLink(empty, true), empty);
  for (const value of [undefined, null, 1, ' '])
    assert.equal(parseAlibabaProductLink({ ...link, productId: value }, true), null);
});
