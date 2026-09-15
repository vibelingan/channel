import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogContentView } from './catalog-content-view.ts';
test('conflicts between approved attributes and description never become headline facts', () => {
  const view = catalogContentView([{ name: 'Material', value: 'ABS' }], {
    schemaVersion: 'catalog-content-v1',
    specifications: [{ name: 'material', value: 'Metal' }],
    packaging: [],
    notes: [],
  });
  assert.deepEqual(view.highlights, []);
  assert.deepEqual(view.specifications, []);
  assert.deepEqual(view.notes, ['Material — ABS', 'material — Metal']);
});
test('identical facts deduplicate and SKU-dependent claims are excluded from highlights', () => {
  const view = catalogContentView(
    [
      { name: 'Material', value: 'ABS' },
      { name: 'Microphone', value: 'Yes' },
    ],
    {
      schemaVersion: 'catalog-content-v1',
      specifications: [{ name: 'Material', value: 'ABS' }],
      packaging: [],
      notes: [],
    },
  );
  assert.equal(view.specifications.length, 2);
  assert.deepEqual(view.highlights, [{ name: 'Material', value: 'ABS' }]);
});
