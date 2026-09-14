import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Select, moveSelectIndex, normalizeSelectOptions } from './Select.tsx';

const options = [
  { value: 'headphones', label: 'Headphones' },
  { value: 'ai-gadgets', label: 'AI Gadgets', disabled: true },
  { value: 'toys', label: 'Toys' },
] as const;

test('server rendering preserves a visible native form control as the no-JS fallback', () => {
  const html = renderToStaticMarkup(
    createElement(Select, {
      name: 'productFamily',
      label: 'Product Family',
      options,
      placeholder: 'Select…',
      required: true,
    }),
  );

  assert.match(html, /<select[^>]*name="productFamily"/);
  assert.match(html, /required=""/);
  assert.match(html, /<option value="" selected="">Select…<\/option>/);
  assert.doesNotMatch(html, /role="listbox"/);
});

test('option normalization supports strings and explicit value-label pairs', () => {
  assert.deepEqual(normalizeSelectOptions(['USD', 'CNY']), [
    { value: 'USD', label: 'USD', disabled: false },
    { value: 'CNY', label: 'CNY', disabled: false },
  ]);
  assert.deepEqual(normalizeSelectOptions(options), [
    { value: 'headphones', label: 'Headphones', disabled: false },
    { value: 'ai-gadgets', label: 'AI Gadgets', disabled: true },
    { value: 'toys', label: 'Toys', disabled: false },
  ]);
});

test('keyboard movement wraps and skips disabled options', () => {
  const normalized = normalizeSelectOptions(options);
  assert.equal(moveSelectIndex(normalized, 0, 1), 2);
  assert.equal(moveSelectIndex(normalized, 2, 1), 0);
  assert.equal(moveSelectIndex(normalized, 0, -1), 2);
  assert.equal(moveSelectIndex(normalized, -1, 1), 0);
});
