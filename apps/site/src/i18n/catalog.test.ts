import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PRODUCT_FAMILY_OPTIONS } from '@vibelingan-channel/shared';
import sharp from 'sharp';
import { parseDocument } from 'yaml';

const source = readFileSync(
  fileURLToPath(new URL('./content/catalog/en-US.md', import.meta.url)),
  'utf8',
);
const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
assert.ok(frontmatter, 'catalog content has YAML frontmatter');
const content = parseDocument(frontmatter[1]).toJS() as {
  menu: { label: string; allLabel: string };
  families: Array<{
    key: string;
    label: string;
    href: string;
    image: string;
    imageAlt: string;
    imageWidth: number;
    imageHeight: number;
    categories: unknown[];
  }>;
};

test('catalog content defines exactly four unique families and five menu destinations', () => {
  assert.deepEqual(
    content.families.map((family) => family.key),
    PRODUCT_FAMILY_OPTIONS,
  );
  assert.equal(new Set(content.families.map((family) => family.href)).size, 4);
  assert.deepEqual(
    content.families.map((family) => family.href),
    ['/headphones/', '/ai-gadgets/', '/toys/', '/misc/'],
  );
  assert.equal(content.menu.allLabel.length > 0, true);
});

test('every family references a real inspectable image with descriptive alt text', async () => {
  for (const family of content.families) {
    assert.ok(family.image.startsWith('/media/'));
    assert.ok(family.imageAlt.length >= 20);
    const file = fileURLToPath(new URL(`../../public${family.image}`, import.meta.url));
    assert.equal(existsSync(file), true, family.image);
    const metadata = await sharp(file).metadata();
    assert.equal(metadata.width, family.imageWidth, `${family.image} width`);
    assert.equal(metadata.height, family.imageHeight, `${family.image} height`);
  }
});

test('catalog UI copy contains no VIP or video feature language', () => {
  assert.equal(/\bvip\b/i.test(source), false);
  assert.equal(/\bvideo\b/i.test(source), false);
});
