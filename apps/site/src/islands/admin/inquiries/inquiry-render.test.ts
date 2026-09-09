import assert from 'node:assert/strict';
import test from 'node:test';
import { InquiryDetailSchema } from '@vibelingan-channel/shared/catalog-inquiry';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { InquiryStatusBadge } from './InquiryStatusBadge.tsx';
import { InquirySummary } from './InquirySummary.tsx';

test('workflow badges expose explicit text plus distinct attention/completion styling', () => {
  const pending = renderToStaticMarkup(createElement(InquiryStatusBadge, { status: 'new' }));
  assert.match(pending, /Unprocessed/);
  assert.match(pending, /bg-amber-100/);
  const completed = renderToStaticMarkup(
    createElement(InquiryStatusBadge, { status: 'completed' }),
  );
  assert.match(completed, /Completed/);
  assert.match(completed, /bg-emerald-100/);
});

test('printable inquiry shows snapshot/configuration/contact and currency, escapes text and excludes internal audit', () => {
  const item = InquiryDetailSchema.parse({
    id: '12345678-1234-4123-8123-123456789abc',
    target: { intent: 'variant_quote', productId: 'p1', revision: 'r1', variantId: 'v1' },
    fields: {
      intent: 'variant_quote',
      quantity: '500',
      deliveryDate: '',
      customizationTypes: [],
      brief: '<script>alert(1)</script>',
      contactName: 'Buyer',
      company: 'A&B',
      email: 'buyer@example.test',
      country: 'HK',
    },
    snapshot: {
      productId: 'p1',
      revision: 'r1',
      productName: 'Submitted headset',
      images: [],
      productOffers: [],
      variant: {
        id: 'v1',
        options: [{ name: 'Color', value: 'Pink' }],
        images: [],
        inventory: { state: 'unknown' },
        offers: [
          {
            kind: 'supplier',
            basis: 'source-quote',
            pricing: { mode: 'fixed', currency: 'USD', amountMinor: 570 },
          },
        ],
      },
    },
    status: 'in_progress',
    version: 1,
    notification: 'disabled-local',
    createdAt: '2026-09-06T16:00:00.000Z',
    updatedAt: '2026-09-06T16:01:00.000Z',
    events: [
      {
        id: '22345678-1234-4123-8123-123456789abc',
        actorId: 'admin',
        actorName: 'Private Agent',
        at: '2026-09-06T16:01:00.000Z',
        from: 'new',
        to: 'in_progress',
        note: 'INTERNAL SECRET',
        version: 1,
      },
    ],
  });
  const html = renderToStaticMarkup(createElement(InquirySummary, { item }));
  for (const text of [
    'Submitted headset',
    'Pink',
    '500',
    'Hong Kong',
    'USD',
    '5.70',
    'A&amp;B',
    'buyer@example.test',
  ])
    assert.ok(html.includes(text), text);
  assert.ok(html.includes('&lt;script&gt;'));
  assert.doesNotMatch(html, /<script|INTERNAL SECRET|Private Agent|<button/);
  assert.ok(html.includes('Not a quotation, invoice or order'));
});
