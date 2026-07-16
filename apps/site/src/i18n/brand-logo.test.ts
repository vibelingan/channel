import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { orderPrimaryNavItems } from '../lib/site-navigation.ts';

// Source-of-truth markdown (the i18n loader needs Vite's import.meta.glob, which
// isn't available under `tsx --test`), so we assert the brand config directly.
const enUS = readFileSync(fileURLToPath(new URL('./content/en-US.md', import.meta.url)), 'utf8');
const headerSource = readFileSync(
  fileURLToPath(new URL('../components/SiteHeader.astro', import.meta.url)),
  'utf8',
);
const heroSource = readFileSync(
  fileURLToPath(new URL('../components/AIHero.astro', import.meta.url)),
  'utf8',
);

test('brand.logo points to the configured client logo', () => {
  const match = enUS.match(/^\s*logo:\s*(\S+)\s*$/m);
  assert.ok(match, 'brand.logo is defined');
  assert.equal(match[1], '/media/logo-channel.svg');
});

test('the referenced brand logo asset exists in public/media', () => {
  const asset = fileURLToPath(new URL('../../public/media/logo-channel.svg', import.meta.url));
  assert.ok(existsSync(asset), 'logo-channel.svg present in public/media');
});

test('logo-channel.svg is the approved historical CHANNEL wordmark', () => {
  const asset = readFileSync(
    fileURLToPath(new URL('../../public/media/logo-channel.svg', import.meta.url)),
    'utf8',
  );
  assert.match(asset, /width="226"/);
  assert.match(asset, /height="30"/);
  assert.match(asset, /viewBox="0 0 226 30"/);
  assert.match(asset, /#153687/i, 'CHANNEL navy is present');
  assert.match(asset, /#ff5f00/i, 'CHANNEL orange accent is present');
  assert.ok(!asset.includes('#ef802e'), 'Diversity Innovations orange is absent');
  assert.equal((asset.match(/<path\b/g) ?? []).length, 2, 'historical two-path wordmark');
});

test('site header renders only the CHANNEL wordmark and prioritizes OEM Development', () => {
  assert.equal(
    headerSource.match(/\{brand\.name\}/g)?.length,
    1,
    'company name is present only as accessible logo text',
  );
  assert.ok(headerSource.includes('alt={brand.name}'), 'logo keeps accessible company text');
  assert.ok(!headerSource.includes('{brand.minOrder}'), 'header does not render the MOQ badge');
  assert.ok(
    headerSource.includes('orderedMenuItems.map'),
    'desktop and mobile menus consume OEM-first items',
  );
  assert.ok(
    headerSource.includes('border-b-2 border-brand-700'),
    'header uses the approved brand-blue lower border',
  );
});

test('OEM navigation remains first when its final URL includes the What We Do fragment', () => {
  const ordered = orderPrimaryNavItems([
    { label: 'Success Stories', href: '/portfolio' },
    { label: 'Teardown Lab', href: '/teardown-lab' },
    { label: 'OEM Development', href: '/oem#what-we-do' },
    { label: 'Blue Ocean', href: '/blue-ocean' },
  ]);

  assert.deepEqual(
    ordered.map((item) => item.href),
    ['/oem#what-we-do', '/portfolio', '/teardown-lab', '/blue-ocean'],
  );
});

test('homepage hero fills the viewport below the fixed header without changing its visual layers', () => {
  assert.ok(
    heroSource.includes('min-h-[calc(100svh-var(--spacing-header))]'),
    'hero reserves the viewport height below the fixed header',
  );
  assert.ok(heroSource.includes('bg-surface-dark'), 'existing dark background remains');
  assert.ok(heroSource.includes('background-size: 60px 60px'), 'existing grid remains');
  assert.ok(heroSource.includes('bg-brand-500/30'), 'existing left glow remains');
  assert.ok(heroSource.includes('bg-accent-500/20'), 'existing right glow remains');
});
