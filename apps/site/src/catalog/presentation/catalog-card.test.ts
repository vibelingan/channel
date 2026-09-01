import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { CatalogPricingDecision } from '@vibelingan-channel/shared/catalog';
import { type ReactElement, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CatalogCard, type CatalogCardProps } from './CatalogCard.tsx';

const facts = {
  identifier: 'HP-100',
  moq: 100,
  moqLabel: 'MOQ',
  unavailableLabel: 'Pricing unavailable — request a quote',
  actionLabel: 'View details',
  imageUnavailableLabel: 'Image unavailable',
};

const product = {
  _id: 'legacy-id',
  name: 'A deliberately uneven and much longer product title',
  modName: 'HP-100',
  description: 'Two-line description.',
  images: [],
};

function render(
  pricing: CatalogPricingDecision,
  overrides: Partial<CatalogCardProps> = {},
): string {
  return renderToStaticMarkup(
    createElement(CatalogCard, {
      product,
      pricing,
      facts,
      onActivate: () => {},
      ...overrides,
    }),
  );
}

test('slugless oldest product activates by _id and emits no unusable link', () => {
  let activated = '';
  const element = CatalogCard({
    product,
    pricing: { source: 'quote-required' },
    facts,
    onActivate: (id) => {
      activated = id;
    },
  }) as ReactElement<{ onClick: () => void }>;
  element.props.onClick();
  assert.equal(activated, 'legacy-id');
  const html = render({ source: 'quote-required' });
  assert.match(html, /^<button/);
  assert.doesNotMatch(html, /<a |href=/);
});

test('pricing, MOQ, action, and fixed card geometry cover every decision source', () => {
  const cases: Array<[CatalogPricingDecision, string]> = [
    [
      {
        source: 'alibaba',
        pricing: {
          source: 'alibaba',
          state: 'available',
          mode: 'fixed',
          currency: 'USD',
          amountMinor: 250,
          sourceMoq: 50,
        },
      },
      '$2.50',
    ],
    [
      {
        source: 'manual-tiered',
        pricing: {
          schemaVersion: 'manual-catalog-pricing-v1',
          currency: 'USD',
          tiers: [{ minQuantity: 1, unitAmountMinor: 900 }],
        },
      },
      'From $9.00',
    ],
    [{ source: 'scalar', field: 'unitPrice', amount: 12.5, currency: 'USD' }, '$12.50'],
    [{ source: 'quote-required' }, facts.unavailableLabel],
  ];
  for (const [decision, expected] of cases) {
    const html = render(decision);
    assert.ok(html.includes(expected));
    assert.ok(html.includes('aspect-square'));
    assert.ok(html.includes('flex flex-1 flex-col'));
    assert.ok(html.includes('mt-auto'));
    assert.match(html, /data-catalog-card-price[^>]*text-sm font-semibold/);
    assert.match(html, /data-catalog-card-action[^>]*text-xs font-medium/);
  }
});

test('presentation source has no family or provider-field conditionals', () => {
  const source = readFileSync(fileURLToPath(new URL('./CatalogCard.tsx', import.meta.url)), 'utf8');
  assert.doesNotMatch(
    source,
    /Headphones|productFamily|alibabaPrimarySourceKey|alibabaCatalogPricing/,
  );
});
