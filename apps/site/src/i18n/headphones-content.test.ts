import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import type { HeadphonesContent } from './headphones.ts';

const headphonesContent = readFileSync(
  fileURLToPath(new URL('./content/headphones/en-US.md', import.meta.url)),
  'utf8',
);
const headphonesTypes = readFileSync(
  fileURLToPath(new URL('./headphones.ts', import.meta.url)),
  'utf8',
);

const frontmatterSource = headphonesContent.match(/^---\n([\s\S]*?)\n---/);
assert.ok(frontmatterSource, 'Headphones content has YAML frontmatter');
const frontmatterDocument = parseDocument(frontmatterSource[1], { uniqueKeys: true });
assert.deepEqual(frontmatterDocument.errors, []);
const frontmatter: unknown = frontmatterDocument.toJS();

const expectedHero = {
  eyebrow: 'Factory-Direct Headphones',
  heading: 'OEM Headphones, Built for Your Brand',
  body: 'Wired, wireless, and kid-safe models manufactured for custom branding, packaging, and worldwide delivery.',
  proof: ['MOQ from 500 units', 'OEM / ODM customization', 'Global delivery'],
  primaryCta: 'Request a Quote',
  secondaryCta: 'Browse Products',
  productId: '0e0afdc26a6820b900523bfb27a9a5cd',
  productName:
    'High Quality Wired Headphones BT Noise Cancellation Foldable with pop-up Window Headphones',
  imageAlt: 'Foldable over-ear headphones for OEM customization',
  loadingLabel: 'Loading product image…',
  unavailableLabel: 'Product image unavailable',
  sources: [
    {
      imageId: '0e0afdc26a68209e00523aa031e56460',
      width: 800,
      height: 800,
      sha256: 'c214432ede60268b25c7001dc06873240a533094c3adc89760df95c2f4e7179c',
    },
    {
      imageId: '7b76ee416a68209d0110670520562928',
      width: 800,
      height: 800,
      sha256: '154a9b12ac090bcb8330c5ec968077caf90eaece14cbdc8ce87d8fc477062241',
    },
    {
      imageId: '0e0afdc26a68209c00523a7b50cb8647',
      width: 800,
      height: 800,
      sha256: 'e4480b78b451261611e74a373ab84048dded0fe255803315247d444bf41c1de6',
    },
  ],
} satisfies HeadphonesContent['hero'];

const expectedFrontmatter = {
  locale: 'en-US',
  meta: {
    title: 'Headphones',
    description:
      'Wholesale headphones catalog — wired, office, and Bluetooth models. Request a quote for VIP pricing and full specifications.',
  },
  shopNav: [
    { label: 'Login / Register', href: '/admin' },
    { label: 'Your Cart', href: '/cart' },
    { label: 'Contact Us', href: '/#contact' },
  ],
  hero: expectedHero,
  list: {
    eyebrow: 'Product Line',
    heading: 'Explore Our Headphone Collection',
    subheading:
      'Compare published models, specifications, and order quantities, then request OEM pricing for your market.',
    filterLabel: 'Categories',
    allLabel: 'All categories',
    resultsLabel: 'products',
    loadingLabel: 'Loading headphones…',
    errorLabel: 'We could not load the headphone catalog.',
    retryLabel: 'Try Again',
    emptyLabel: 'No products match the selected categories.',
    emptyStateLabel: 'No published headphone models are available right now.',
    emptyCtaLabel: 'Start an OEM Enquiry',
    loadMoreLabel: 'Load More',
    loadingMoreLabel: 'Loading More…',
    resultProgressLabel: '{loaded} of {total} models',
    categories: [
      { key: 'wired', label: 'Wired Headphones' },
      { key: 'office', label: 'Office Headphones' },
      { key: 'bluetooth', label: 'Bluetooth Headphones' },
    ],
    wholesaleLabel: 'Wholesale',
    vipLabel: 'VIP price',
    vipLockedLabel: 'Sign in to view VIP price',
    viewDetail: 'View details',
    moqLabel: 'MOQ',
  },
  detail: {
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
    imageUnavailableLabel: 'Product image unavailable',
    zoomHint: 'Hover image to zoom',
    notFound: 'Product not found.',
  },
  oemCta: {
    eyebrow: 'Request a Quote',
    heading: 'Ready to Build Your Headphone Line?',
    body: 'Share your target model, quantity, branding, and market requirements with our OEM team.',
    primaryLabel: 'Start Your OEM Enquiry',
    secondaryLabel: 'Explore OEM Capabilities',
  },
  inquiry: {
    title: 'Request price & catalog',
    intro: 'Tell us where to send your quote. Our team typically replies within 24 hours.',
    emailLabel: 'Email',
    companyLabel: 'Company',
    countryLabel: 'Country',
    downloadCatalog: 'Download catalog',
    requestQuote: 'Request a quote',
    submitLabel: 'Send inquiry',
    cancelLabel: 'Cancel',
    successTitle: 'Inquiry received',
    successBody: 'Thank you — our sales team will email your quote and catalog shortly.',
    disclaimer: 'Your details are used only to respond to this inquiry and are kept confidential.',
  },
} satisfies HeadphonesContent & { locale: string };

function assertMediaMetadataOnly(value: unknown, location: string): void {
  if (typeof value === 'string') {
    assert.doesNotMatch(
      value,
      /^(?:https?:|\/\/|\/api\/|\/media\/|data:)|!!binary|base64/i,
      `${location} contains a media location or encoded bytes`,
    );
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertMediaMetadataOnly(item, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;

  for (const [key, child] of Object.entries(value)) {
    assert.doesNotMatch(
      key,
      /(?:url|uri|href|path|file|src|bytes|buffer|binary|base64)/i,
      `${location}.${key} is not approved hero metadata`,
    );
    assertMediaMetadataOnly(child, `${location}.${key}`);
  }
}

test('Headphones content pins the reviewed gated hero media in fallback order', () => {
  assert.match(headphonesTypes, /export interface HeadphonesHeroSource/);
  assert.match(
    headphonesTypes,
    /sources: readonly \[HeadphonesHeroSource, HeadphonesHeroSource, HeadphonesHeroSource\]/,
  );
  assert.deepEqual((frontmatter as { hero: unknown }).hero, expectedHero);
  for (const source of expectedHero.sources) {
    assert.match(source.imageId, /^[a-f0-9]{32}$/);
    assert.equal(source.width, 800);
    assert.equal(source.height, 800);
    assert.match(source.sha256, /^[a-f0-9]{64}$/);
  }
});

test('Headphones content owns recovery, navigation, and persistent OEM CTA copy only', () => {
  assert.deepEqual(frontmatter, expectedFrontmatter);
  const hero = (frontmatter as { hero: Record<string, unknown> }).hero;
  assert.deepEqual(Object.keys(hero), Object.keys(expectedHero));
  assert.ok(Array.isArray(hero.sources));
  for (const [index, source] of expectedHero.sources.entries()) {
    const parsedSource = hero.sources[index] as Record<string, unknown>;
    assert.deepEqual(Object.keys(parsedSource), Object.keys(source));
    assert.match(String(parsedSource.imageId), /^[a-f0-9]{32}$/);
    assert.equal(parsedSource.width, 800);
    assert.equal(parsedSource.height, 800);
    assert.match(String(parsedSource.sha256), /^[a-f0-9]{64}$/);
  }
  assertMediaMetadataOnly(hero, 'hero');
  assert.doesNotMatch(frontmatterSource[1], /^(?:advantages?|quality|certifications?|clients?):/im);
});
