import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detailFixture } from '../testing/detail-fixture.ts';
import { startDetailPages } from './catalog-detail-pages.ts';
import { matchVariantOptions, resolveVariantSelection } from './catalog-variant-state.ts';

function pages(total = 3) {
  const result = startDetailPages(detailFixture(total), 1000);
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') throw new Error('Invalid fixture');
  return result.value;
}

test('default uses canonical order, not positive inventory; zero differs from unknown', () => {
  const input = pages();
  input.currentPage.variants.items[0].inventory = {
    state: 'reported',
    quantity: 0,
    semantics: 'onHand',
    basis: 'source',
  };
  const selection = resolveVariantSelection(input);
  assert.equal(selection.status, 'selected');
  if (selection.status !== 'selected') throw new Error('Expected selection');
  assert.equal(selection.variant.id, 'variant-1');
  assert.equal(selection.variant.inventory.state, 'reported');
  assert.equal(input.items[1].inventory.state, 'unknown');
});

test('URL selection stays pending until complete coverage, then invalid without fallback', () => {
  assert.deepEqual(resolveVariantSelection(pages(51), 'variant-51'), {
    status: 'pending',
    requestedId: 'variant-51',
  });
  assert.deepEqual(resolveVariantSelection(pages(), 'missing'), {
    status: 'invalid',
    requestedId: 'missing',
  });
  assert.deepEqual(resolveVariantSelection(pages(501), 'missing'), {
    status: 'pending',
    requestedId: 'missing',
  });
  assert.deepEqual(resolveVariantSelection(pages(51)), { status: 'unselected' });
  assert.deepEqual(resolveVariantSelection(pages(0)), { status: 'none' });
});

test('never synthesizes combinations or builds a matrix from partial pages', () => {
  const input = pages(2);
  input.currentPage.variants.items[0].options = [
    { name: 'Color', value: 'Black' },
    { name: 'Connector', value: 'USB-C' },
  ];
  input.currentPage.variants.items[1].options = [
    { name: 'Color', value: 'White' },
    { name: 'Connector', value: 'USB-A' },
  ];
  assert.deepEqual(
    matchVariantOptions(input, [
      { name: 'Color', value: 'Black' },
      { name: 'Connector', value: 'USB-A' },
    ]),
    { status: 'no-match' },
  );
  assert.deepEqual(matchVariantOptions(pages(51), []), { status: 'incomplete' });
  assert.deepEqual(matchVariantOptions(pages(501), []), { status: 'incomplete' });
  const match = matchVariantOptions(input, [{ name: 'Connector', value: 'USB-A' }]);
  assert.equal(match.status, 'matched');
  if (match.status === 'matched') assert.equal(match.variant.id, 'variant-2');
});

test('duplicate options require explicit canonical identity even with duplicate SKU labels', () => {
  const input = pages(2);
  for (const variant of input.currentPage.variants.items) {
    variant.options = [{ name: 'Color', value: 'Black' }];
    variant.sku = 'same-label';
  }
  const match = matchVariantOptions(input, [{ name: 'Color', value: 'Black' }]);
  assert.equal(match.status, 'ambiguous');
  if (match.status === 'ambiguous')
    assert.deepEqual(
      match.variants.map((v) => v.id),
      ['variant-1', 'variant-2'],
    );
  const selected = resolveVariantSelection(input, 'variant-2');
  assert.equal(selected.status, 'selected');
  if (selected.status === 'selected') assert.equal(selected.variant.id, 'variant-2');
});

test('empty options and absent sku remain directly selectable without invented labels', () => {
  const input = pages(1);
  input.currentPage.variants.items[0].options = [];
  const selected = resolveVariantSelection(input, 'variant-1');
  assert.equal(selected.status, 'selected');
  if (selected.status === 'selected') {
    assert.equal(selected.variant.sku, undefined);
    assert.deepEqual(selected.variant.options, []);
  }
});

test('conflicting duplicate axes require direct IDs; exact names remain case sensitive', () => {
  const input = pages(1);
  input.currentPage.variants.items[0].options = [
    { name: 'Color', value: 'Black' },
    { name: 'Color', value: 'White' },
  ];
  assert.deepEqual(matchVariantOptions(input, [{ name: 'Color', value: 'Black' }]), {
    status: 'identity-required',
  });
  assert.equal(resolveVariantSelection(input, 'variant-1').status, 'selected');
  assert.deepEqual(matchVariantOptions(pages(1), [{ name: 'color', value: 'Color 1' }]), {
    status: 'no-match',
  });
  assert.deepEqual(
    matchVariantOptions(pages(1), [
      { name: 'Color', value: 'Color 1' },
      { name: 'Color', value: 'different' },
    ]),
    { status: 'invalid-options' },
  );
});
