/** Admin side-by-side review of supplier changes and configuration photos (DEC-19, DEC-20). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getCollection } from '@vibelingan-channel/shared';
import type { SupplierReview } from '@vibelingan-channel/shared/catalog-supplier-review';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfigurationPhotosEditor } from './ConfigurationPhotosEditor.tsx';
import { RecordForm } from './RecordForm.tsx';
import { SupplierChangesPanel } from './SupplierChangesPanel.tsx';
import { fetchSupplierReview } from './api.ts';
import { formatPricing, undecidedParts, withSupplierChoices } from './supplier-review-ui.ts';

const digest = (char: string) => char.repeat(64);
const review: SupplierReview = {
  ok: true,
  parts: [
    {
      part: 'description',
      website: { text: 'Our own words' },
      incoming: { text: 'New supplier text' },
      origin: 'admin',
      incomingDigest: digest('a'),
    },
    {
      part: 'gallery',
      website: { imageIds: ['img-a'] },
      incoming: {
        urls: ['https://sc04.alicdn.com/c.jpg', 'https://sc04.alicdn.com/a.jpg'],
        imageIds: [null, 'img-a'],
      },
      origin: 'supplier',
      incomingDigest: digest('b'),
      decision: 'keep',
    },
  ],
  changes: {
    configurationsAdded: ['Green'],
    configurationsRemoved: [],
    prices: [
      {
        configuration: 'Black',
        before: [{ mode: 'fixed', currency: 'USD', amountMinor: 258 }],
        after: [{ mode: 'fixed', currency: 'USD', amountMinor: 240 }],
      },
    ],
    options: [],
  },
  configurations: [
    { id: 'v-white', label: 'White', supplierImageIds: null, adminImageIds: ['img-b'] },
    { id: 'v-black', label: 'Black', supplierImageIds: ['img-black'], adminImageIds: null },
  ],
};

test('prices read the way buyers see them', () => {
  assert.equal(formatPricing({ mode: 'fixed', currency: 'USD', amountMinor: 258 }), 'USD 2.58');
  assert.equal(
    formatPricing({
      mode: 'range',
      currency: 'USD',
      minimumAmountMinor: 230,
      maximumAmountMinor: 258,
    }),
    'USD 2.30–2.58',
  );
  assert.equal(
    formatPricing({
      mode: 'tiered',
      currency: 'USD',
      tiers: [
        { minimumQuantity: 2, maximumQuantity: 999, unitAmountMinor: 258 },
        { minimumQuantity: 1000, unitAmountMinor: 139 },
      ],
    }),
    '2–999: USD 2.58 · ≥1000: USD 1.39',
  );
  assert.equal(formatPricing({ mode: 'unavailable' }), 'Request a quote');
});

test('the panel shows each change side by side, where ours came from, and the choices', () => {
  const html = renderToStaticMarkup(
    createElement(SupplierChangesPanel, {
      review,
      choices: {},
      busyPart: null,
      error: '',
      onKeep: () => {},
      onUseIncoming: () => {},
    }),
  );
  assert.ok(html.includes('Supplier changes'));
  assert.ok(html.includes('Our own words'));
  assert.ok(html.includes('New supplier text'));
  assert.ok(html.includes('Edited here'), 'admin origin');
  assert.ok(html.includes('From Alibaba at the last approval'), 'supplier origin');
  assert.ok(html.includes('>Keep website version<'));
  assert.ok(html.includes('>Use Alibaba’s<'));
  // The gallery was already decided for exactly this incoming value.
  assert.ok(html.includes('Decided: kept the website version'));
  // Prices and configurations are taken on approval, shown old → new.
  assert.ok(html.includes('Black: USD 2.58 → USD 2.40'));
  assert.ok(html.includes('Added: Green'));
  assert.ok(html.includes('1 change still needs a decision'));
});

test('undecided parts count choices made in this form', () => {
  assert.deepEqual(undecidedParts(review, {}), ['description']);
  assert.deepEqual(
    undecidedParts(review, { description: { choice: 'incoming', incomingDigest: digest('a') } }),
    [],
  );
});

test('Save carries the decisions and photo choices, merged with earlier ones', () => {
  const values = withSupplierChoices(
    { name: 'Headset' },
    {
      supplierDecisions: {
        gallery: { choice: 'keep', incomingDigest: digest('b') },
      },
    },
    { description: { choice: 'keep', incomingDigest: digest('a') } },
    { 'v-white': ['img-b'] },
  );
  assert.deepEqual(values, {
    name: 'Headset',
    supplierDecisions: {
      gallery: { choice: 'keep', incomingDigest: digest('b') },
      description: { choice: 'keep', incomingDigest: digest('a') },
    },
    configurationPhotos: { 'v-white': ['img-b'] },
  });
  assert.deepEqual(withSupplierChoices({ name: 'Headset' }, {}, {}, undefined), {
    name: 'Headset',
  });
});

test('configuration photos: each configuration picks from the gallery', () => {
  const html = renderToStaticMarkup(
    createElement(ConfigurationPhotosEditor, {
      configurations: review.configurations,
      galleryIds: ['img-a', 'img-b'],
      value: { 'v-white': ['img-b'] },
      onChange: () => {},
    }),
  );
  assert.ok(html.includes('Photos for each configuration'));
  assert.ok(html.includes('White'));
  assert.ok(html.includes('Black'));
  assert.ok(html.includes('Alibaba photo'), 'Black has its own supplier photo');
  assert.match(html, /aria-pressed="true"[^>]*aria-label="White: gallery photo 2"/);
  assert.match(html, /aria-pressed="false"[^>]*aria-label="White: gallery photo 1"/);
  assert.ok(html.includes('(1 of 2 chosen)'));
});

test('configuration photos no longer in the gallery are not counted or shown as chosen', () => {
  const html = renderToStaticMarkup(
    createElement(ConfigurationPhotosEditor, {
      configurations: review.configurations,
      galleryIds: ['img-a'],
      value: { 'v-white': ['img-b'] },
      onChange: () => {},
    }),
  );
  assert.ok(html.includes('(0 of 2 chosen)'));
  assert.doesNotMatch(html, /aria-pressed="true"/);
});

test('a contributor sees why a flagged product is read-only, and cannot save it', () => {
  const products = getCollection('products');
  assert.ok(products);
  const html = renderToStaticMarkup(
    createElement(RecordForm, {
      collection: products,
      title: 'Edit Product',
      initial: { _id: 'p1', name: 'Headset', published: true },
      submitting: false,
      error: null,
      onSubmit: () => undefined,
      onCancel: () => undefined,
      readOnlyReason: 'This product has Alibaba changes waiting for an admin’s review.',
    }),
  );
  assert.ok(html.includes('waiting for an admin’s review'));
  assert.match(html, /<button type="submit" disabled=""/);
  // The form sections (and every field inside them) are disabled too, not only Save.
  assert.match(html, /<fieldset disabled=""/);
});

test('the supplier review answer is validated before use', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ok: true, data: review }));
  assert.deepEqual(await fetchSupplierReview('p1'), review);
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ ok: true, data: { ok: true, parts: 'nope' } }),
  );
  await assert.rejects(fetchSupplierReview('p1'), /supplier review/i);
});
