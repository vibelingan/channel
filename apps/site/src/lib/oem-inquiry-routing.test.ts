import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { OEM_INQUIRY_HREF } from './site-navigation.ts';

const siteContent = readFileSync(
  fileURLToPath(new URL('../i18n/content/en-US.md', import.meta.url)),
  'utf8',
);
const portfolioContent = readFileSync(
  fileURLToPath(new URL('../i18n/content/portfolio/en-US.md', import.meta.url)),
  'utf8',
);
const oemContent = readFileSync(
  fileURLToPath(new URL('../i18n/content/oem/en-US.md', import.meta.url)),
  'utf8',
);
const resultPage = readFileSync(
  fileURLToPath(new URL('../pages/oem_submit_result.astro', import.meta.url)),
  'utf8',
);
const siteTypes = readFileSync(fileURLToPath(new URL('../i18n/site.ts', import.meta.url)), 'utf8');
const successStoriesPage = readFileSync(
  fileURLToPath(new URL('../pages/success-stories/index.astro', import.meta.url)),
  'utf8',
);
const routedPageSources = [
  { path: '../pages/blue-ocean/index.astro', expectedLinks: 1 },
  { path: '../pages/blue-ocean/[slug].astro', expectedLinks: 2 },
  { path: '../pages/teardown-lab/index.astro', expectedLinks: 1 },
  { path: '../pages/teardown-lab/[slug].astro', expectedLinks: 1 },
].map(({ path, expectedLinks }) => ({
  path,
  expectedLinks,
  source: readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8'),
}));

test('canonical OEM inquiry links target the homepage form without changing navigation links', () => {
  assert.equal(OEM_INQUIRY_HREF, '/#oem-inquiry');
  assert.ok(
    siteContent.includes("primaryCta: { label: Start Your Project, href: '/#oem-inquiry' }"),
  );
  assert.ok(
    portfolioContent.includes("primaryCta: { label: Start your project, href: '/#oem-inquiry' }"),
  );
  assert.ok(resultPage.includes("import { OEM_INQUIRY_HREF } from '../lib/site-navigation.ts'"));
  assert.ok(resultPage.includes('href={OEM_INQUIRY_HREF}'));

  assert.ok(siteContent.includes("href: '/oem#what-we-do'"));
  assert.ok(siteContent.includes("- { label: OEM Development, href: '/oem' }"));
  assert.ok(oemContent.includes("primaryCta: { label: Submit your project, href: '#submit' }"));
});

test('Blue Ocean and Teardown OEM-intent CTAs use the canonical homepage form route', () => {
  for (const { path, expectedLinks, source } of routedPageSources) {
    assert.ok(
      source.includes("import { OEM_INQUIRY_HREF } from '../../lib/site-navigation.ts'"),
      `canonical route imported by ${path}`,
    );
    assert.ok(!source.includes('href="/oem"'), `bare /oem CTA removed from ${path}`);
    assert.equal(
      (source.match(/href=\{OEM_INQUIRY_HREF\}/g) ?? []).length,
      expectedLinks,
      `all OEM-intent CTAs routed in ${path}`,
    );
  }
});

test('Success Stories uses the canonical inquiry route and retired homepage CTA links are removed', () => {
  assert.ok(
    successStoriesPage.includes("import { OEM_INQUIRY_HREF } from '../../lib/site-navigation.ts'"),
  );
  assert.ok(!successStoriesPage.includes('href="/oem"'));
  assert.equal((successStoriesPage.match(/href=\{OEM_INQUIRY_HREF\}/g) ?? []).length, 1);

  const ctaContent = siteContent.match(/^ctaSection:\n([\s\S]*?)^footer:/m);
  assert.ok(ctaContent, 'homepage CTA content exists');
  assert.ok(!ctaContent[1].includes('primaryCta'));
  assert.ok(!ctaContent[1].includes('secondaryCta'));
  const ctaType = siteTypes.match(/ {2}ctaSection: \{([\s\S]*?)^ {2}\};/m);
  assert.ok(ctaType, 'homepage CTA type exists');
  assert.ok(!ctaType[1].includes('primaryCta'));
  assert.ok(!ctaType[1].includes('secondaryCta'));
});
