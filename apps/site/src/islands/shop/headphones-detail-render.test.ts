import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { HeadphonesContent } from '../../i18n/headphones.ts';
import { OEM_INQUIRY_HREF } from '../../lib/site-navigation.ts';
import { HeadphonesProductDetail } from './HeadphonesProductDetail.tsx';
import type { Product } from './catalog-types.ts';

/** Complete detail-content fixture typed against the real contract. */
const DETAIL: HeadphonesContent['detail'] = {
  backLabel: 'Back to headphones',
  backToModelsLabel: 'Back to all models',
  seriesLabel: 'Series',
  modelLabel: 'Model',
  typeLabel: 'Type',
  moqLabel: 'Minimum Order Quantity',
  unitPriceLabel: 'Unit price',
  wholesaleLabel: 'Wholesale price',
  vipLabel: 'VIP price',
  vipLockedLabel: 'Sign in to view VIP price',
  inquiryCta: 'Price inquiry',
  oemInquiryCta: 'Start Your OEM Enquiry',
  viewAllLabel: 'View All',
  showLessLabel: 'Show Less',
  imageUnavailableLabel: 'Product image unavailable',
  notFound: 'Product not found.',
};

const FULL_PRODUCT: Product = {
  _id: 'sy-t8',
  name: 'SY-T8 Wireless',
  category: 'tws',
  series: 'SY',
  modName: 'T8',
  modType: 'TWS',
  description: 'Flagship true wireless model with balanced tuning.',
  productCode: 'SY-T8-BLK',
  moq: 1000,
  unitPrice: 18.9,
  wholesalePrice: 15.5,
  vipPrice: 13.2,
  images: ['https://media.example.test/sy-t8-1.jpg', 'https://media.example.test/sy-t8-2.jpg'],
};

function render(over: {
  product?: Product;
  registered?: boolean;
}): string {
  return renderToStaticMarkup(
    createElement(HeadphonesProductDetail, {
      product: over.product ?? FULL_PRODUCT,
      detail: DETAIL,
      categoryLabel: 'True Wireless',
      registered: over.registered ?? false,
      onBack: () => {},
    }),
  );
}

// --- structure ---------------------------------------------------------------

test('a complete product renders gallery, specs, pricing, focus heading, and Back', () => {
  const html = render({});
  assert.ok(html.includes(`data-product-detail="${FULL_PRODUCT._id}"`));
  // Gallery media flows through the ProductMedia contract.
  assert.ok(html.includes('data-product-media='));
  // Spec sheet rows from the content contract.
  for (const label of [
    DETAIL.seriesLabel,
    DETAIL.typeLabel,
    DETAIL.moqLabel,
    DETAIL.unitPriceLabel,
  ]) {
    assert.ok(html.includes(label), `missing spec label: ${label}`);
  }
  assert.ok(html.includes('SY-T8-BLK'));
  assert.ok(html.includes('$18.90'));
  // Entitlement pricing block.
  assert.ok(html.includes(DETAIL.wholesaleLabel));
  // Focus-target heading: focusable programmatically, marked for the controller.
  assert.ok(/<h2[^>]*tabindex="-1"[^>]*data-detail-heading/.test(html));
  assert.ok(html.includes(FULL_PRODUCT.name));
  // Back is an in-page control: a BUTTON carrying data-detail-back, never a
  // navigation anchor (which would reload the page and drop catalog state).
  assert.ok(html.includes(DETAIL.backToModelsLabel));
  assert.ok(/<button[^>]*data-detail-back/.test(html));
  assert.ok(!/<a[^>]*data-detail-back/.test(html));
});

test('unregistered viewers see the VIP entitlement lock, registered see VIP price', () => {
  const locked = render({ registered: false });
  assert.ok(locked.includes(DETAIL.vipLockedLabel));
  // The locked chip is informational, not a login prerequisite: the detail
  // output must never contain a /login anchor for any viewer.
  assert.ok(!locked.includes('/login'));
  const unlocked = render({ registered: true });
  assert.ok(!unlocked.includes(DETAIL.vipLockedLabel));
  assert.ok(unlocked.includes('$13.20'));
});

// --- enquiry commands --------------------------------------------------------

test('every enquiry command is an anchor to the OEM enquiry section', () => {
  const html = render({ registered: true });
  const anchors = html.match(/<a\s[^>]*href="([^"]+)"/g) ?? [];
  assert.ok(anchors.length >= 1, 'expected at least one enquiry anchor');
  assert.ok(html.includes(`href="${OEM_INQUIRY_HREF}"`));
  assert.ok(html.includes(DETAIL.inquiryCta));
  // No modal, no login prerequisite, no simulated durable success.
  assert.ok(!html.includes('/login'));
  assert.ok(!html.toLowerCase().includes('success'));
  assert.ok(!html.includes('form'));
});

// --- responsive tracks -------------------------------------------------------

test('detail columns sit in min-width-0 tracks so long values wrap, not widen', () => {
  const html = render({});
  // Pin BOTH grid column wrappers, not merely any min-w-0 in the subtree
  // (Gallery internals and spec dd cells carry their own).
  assert.ok(/<div[^>]*data-detail-media-column[^>]*class="[^"]*min-w-0/.test(html));
  assert.ok(/<div[^>]*data-detail-info-column[^>]*class="[^"]*min-w-0/.test(html));
});

// --- media fallback ----------------------------------------------------------

test('a product without media reserves geometry and shows the terminal fallback', () => {
  const html = render({ product: { ...FULL_PRODUCT, images: [] } });
  assert.ok(html.includes('data-product-media="fallback"'));
  assert.ok(html.includes(DETAIL.imageUnavailableLabel));
  assert.ok(html.includes('aspect-square'));
});
