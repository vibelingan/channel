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
