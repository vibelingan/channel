import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCatalogQuantity } from './catalog-quantity-state.ts';
test('empty stays editable and invalid quantity is never silently repaired', () => {
  assert.deepEqual(parseCatalogQuantity(''), { status: 'empty' });
  for (const input of [
    null,
    undefined,
    1,
    ' ',
    '0',
    '-1',
    '1.2',
    '1e3',
    '+2',
    '02',
    ' 2',
    '9007199254740992',
  ])
    assert.deepEqual(parseCatalogQuantity(input), { status: 'invalid' });
});
test('quantity accepts exact safe positive integers without inventing a business MOQ', () => {
  assert.deepEqual(parseCatalogQuantity('1'), { status: 'valid', value: 1 });
  assert.deepEqual(parseCatalogQuantity('500'), { status: 'valid', value: 500 });
  assert.deepEqual(parseCatalogQuantity('9007199254740991'), {
    status: 'valid',
    value: 9007199254740991,
  });
});
