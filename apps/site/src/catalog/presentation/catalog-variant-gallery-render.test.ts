import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { CatalogDetailVariant } from '@vibelingan-channel/shared/catalog-detail';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Gallery } from '../../islands/shop/Gallery.tsx';
import {
  CatalogVariantGallery,
  type CatalogVariantGalleryProps,
} from './CatalogVariantGallery.tsx';

function variant(overrides: Partial<CatalogDetailVariant> = {}): CatalogDetailVariant {
  return {
    id: 'red-sku',
    options: [{ name: 'Color', value: 'Red' }],
    inventory: { state: 'unknown' },
    images: [],
    offers: [],
    ...overrides,
  };
}

function galleryProps(
  overrides: Partial<CatalogVariantGalleryProps> = {},
): CatalogVariantGalleryProps {
  const selected = variant();
  return {
    productId: 'headset',
    name: 'Headset',
    images: ['/general-front.jpg', '/general-back.jpg'],
    selection: { status: 'selected', variant: selected },
    variants: [selected],
    unavailableLabel: 'Product image unavailable',
    ...overrides,
  };
}

function render(props: CatalogVariantGalleryProps): string {
  return renderToStaticMarkup(createElement(CatalogVariantGallery, props));
}

function mainFrame(markup: string): string {
  const frame = markup.match(/<div data-gallery-frame="true"[^>]*>([\s\S]*?)<\/div>/)?.[1];
  assert.ok(frame, 'the existing gallery frame remains present');
  return frame;
}

function thumbnails(markup: string): string[] {
  return [...markup.matchAll(/<button[^>]*data-gallery-thumbnail="\d+"[\s\S]*?<\/button>/g)].map(
    (match) => match[0],
  );
}

test('a configuration without assigned images immediately shows honestly labelled general photos', () => {
  const html = render(galleryProps());
  assert.match(mainFrame(html), /src="\/general-front.jpg"/);
  assert.match(mainFrame(html), /alt="Headset[^\"]*General product photo/);
  assert.doesNotMatch(mainFrame(html), /Red|selected configuration|No photo is assigned/);
  assert.equal(thumbnails(html).length, 2);
  assert.match(html, /1 \/ 2/);
  assert.doesNotMatch(html, /View product gallery|Back to configuration photos/);
});

test('assigned photos lead and general thumbnails are present without changing selection identity', () => {
  const selected = variant({ images: ['/red-front.jpg', '/red-back.jpg'] });
  const props = galleryProps({
    selection: { status: 'selected', variant: selected },
    variants: [
      selected,
      variant({
        id: 'blue-sku',
        options: [{ name: 'Color', value: 'Blue' }],
        images: ['/blue-only.jpg'],
      }),
    ],
  });
  const before = structuredClone(props.selection);
  const html = render(props);
  assert.match(mainFrame(html), /src="\/red-front.jpg"/);
  assert.match(mainFrame(html), /alt="Headset[^\"]*Red[^\"]*selected configuration/);
  assert.deepEqual(
    thumbnails(html).map((thumbnail) => thumbnail.match(/src="([^\"]+)"/)?.[1]),
    ['/red-front.jpg', '/red-back.jpg', '/general-front.jpg', '/general-back.jpg'],
  );
  assert.match(thumbnails(html)[2], /aria-label="[^\"]*General product photo/);
  assert.doesNotMatch(thumbnails(html)[2], /Red|selected configuration/);
  assert.doesNotMatch(html, /View product gallery|Back to configuration photos|blue-only/);
  assert.deepEqual(props.selection, before);
});

test('deduplication preserves source-bound labels after blank and repeated image entries', () => {
  const selected = variant({ images: [' ', ' /red.jpg ', '/red.jpg'] });
  const html = render(
    galleryProps({
      selection: { status: 'selected', variant: selected },
      variants: [selected],
      images: ['/red.jpg', ' /general.jpg ', '/general.jpg'],
    }),
  );
  const thumbs = thumbnails(html);
  assert.equal(thumbs.length, 2);
  assert.match(thumbs[0], /src="\/red.jpg"/);
  assert.match(thumbs[0], /aria-label="[^"]*Configuration 1[^"]*selected configuration/);
  assert.match(thumbs[1], /src="\/general.jpg"/);
  assert.match(thumbs[1], /aria-label="[^\"]*General product photo/);
});

test('unresolved owned assignments retain an unavailable slot without revealing external previews', () => {
  const selected = variant({ images: ['/api/images/owned-red'] });
  const html = render(
    galleryProps({
      selection: { status: 'selected', variant: selected },
      variants: [selected],
      resolveImage: () => undefined,
      sourceImages: ['https://supplier.invalid/unapproved-red.jpg'],
    }),
  );
  assert.match(mainFrame(html), /data-product-media="fallback"/);
  assert.doesNotMatch(mainFrame(html), /<img/);
  assert.equal(thumbnails(html).length, 3);
  assert.match(thumbnails(html)[1], /src="\/general-front.jpg"/);
  assert.doesNotMatch(html, /supplier.invalid|src="\/api\/images\/owned-red"/);
});

test('detail thumbnails keep all merged photos in the existing horizontally scrolling frame', () => {
  const selected = variant({ images: ['/red.jpg'] });
  const html = render(
    galleryProps({
      selection: { status: 'selected', variant: selected },
      variants: [selected],
      images: Array.from({ length: 9 }, (_, index) => `/general-${index}.jpg`),
    }),
  );
  assert.equal(thumbnails(html).length, 10);
  assert.match(html, /1 \/ 10/);
  assert.match(html, /id="gallery-thumbnails" class="[^"]*min-w-0[^"]*overflow-x-auto/);
  assert.ok(thumbnails(html).every((thumbnail) => /h-20 w-20 shrink-0/.test(thumbnail)));
  assert.match(html, /data-gallery-frame="true" class="[^"]*lg:h-\[420px\]/);
});

test('legacy galleries retain the four-thumbnail preview and their original labels', () => {
  const html = renderToStaticMarkup(
    createElement(Gallery, {
      images: Array.from({ length: 6 }, (_, index) => `/photo-${index}.jpg`),
      alt: 'Legacy product',
    }),
  );
  assert.equal(thumbnails(html).length, 4);
  assert.match(html, /data-gallery-view-all="true"/);
  assert.match(html, /aria-label="View image 1"/);
  assert.match(mainFrame(html), /alt="Legacy product"/);
});

test('explicit admin SKU source previews lead only when there are no owned assignments', () => {
  const html = render(
    galleryProps({
      sourceImages: ['https://supplier.invalid/approved-red.jpg'],
      resolveImage: () => undefined,
    }),
  );
  assert.match(mainFrame(html), /src="https:\/\/supplier.invalid\/approved-red.jpg"/);
  assert.match(mainFrame(html), /alt="[^"]*selected configuration/);
  assert.equal(thumbnails(html).length, 3);
  assert.match(thumbnails(html)[1], /General product photo/);
});

test('the admin resolver receives the assigned source and resolved duplicates keep its label', () => {
  const selected = variant({ images: ['/api/images/owned-red'] });
  const requested: string[] = [];
  const html = render(
    galleryProps({
      selection: { status: 'selected', variant: selected },
      variants: [selected],
      images: ['blob:http://localhost/approved-red', '/general.jpg'],
      resolveImage: (source) => {
        requested.push(source);
        return source === '/api/images/owned-red'
          ? 'blob:http://localhost/approved-red'
          : undefined;
      },
    }),
  );
  assert.deepEqual(requested, ['/api/images/owned-red']);
  assert.match(mainFrame(html), /src="blob:http:\/\/localhost\/approved-red"/);
  assert.equal(thumbnails(html).length, 2);
  assert.match(thumbnails(html)[0], /selected configuration/);
  assert.match(thumbnails(html)[1], /General product photo/);
});

test('no selection shows general photos and captions stay escaped without changing image URLs', () => {
  const html = render(
    galleryProps({ selection: { status: 'none' }, name: '<script>title</script>' }),
  );
  assert.match(mainFrame(html), /src="\/general-front.jpg"/);
  assert.match(
    mainFrame(html),
    /alt="&lt;script&gt;title&lt;\/script&gt;[^"]*General product photo/,
  );
  assert.doesNotMatch(html, /<script>|selected configuration/);
});

test('main-image priority and thumbnail lazy loading remain separate', () => {
  const html = render(galleryProps());
  assert.match(mainFrame(html), /loading="eager" fetchPriority="high"/);
  assert.ok(
    thumbnails(html).every((thumbnail) => /loading="lazy" fetchPriority="low"/.test(thumbnail)),
  );
});

test(
  'browser gallery clicks, failures, selection resets, scrolling and legacy controls',
  { skip: process.env.GALLERY_BROWSER_TEST !== '1', timeout: 90_000 },
  async () => {
    const { chromium, expect } = await import('@playwright/test');
    const { createServer } = await import('vite');
    const { default: tailwindcss } = await import('@tailwindcss/vite');
    const server = await createServer({
      configFile: false,
      root: fileURLToPath(new URL('../../../', import.meta.url)),
      plugins: [
        tailwindcss(),
        {
          name: 'gallery-test-page',
          configureServer(server) {
            server.middlewares.use('/gallery-test', (_request, response) => {
              response.setHeader('Content-Type', 'text/html');
              response.end(
                '<!doctype html><html lang="en"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Gallery test</title><body><div id="gallery-test-root"></div></body></html>',
              );
            });
          },
        },
      ],
      server: { host: '127.0.0.1', port: 0 },
    });
    try {
      await server.listen();
      const origin = server.resolvedUrls?.local[0];
      assert.ok(origin);
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.route('**/*.jpg', (route) =>
          route.request().url().endsWith('/broken-red.jpg')
            ? route.fulfill({ status: 404, body: 'Unavailable' })
            : route.fulfill({
                contentType: 'image/png',
                body: Buffer.from(
                  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM1sAAAAASUVORK5CYII=',
                  'base64',
                ),
              }),
        );
        await page.goto(`${origin}gallery-test?variant=red-sku`);
        const mount = (props: CatalogVariantGalleryProps) =>
          page.evaluate(
            async ({ modulePath, props }) => {
              const harness: typeof import('../testing/variant-gallery-browser-harness.tsx') =
                await import(modulePath);
              harness.renderVariant(props);
            },
            { modulePath: '/src/catalog/testing/variant-gallery-browser-harness.tsx', props },
          );
        const frame = page.locator('[data-gallery-frame]');
        const mainImage = frame.locator('img');
        await mount(galleryProps());
        await expect(mainImage).toHaveAttribute('src', '/general-front.jpg');
        await expect(mainImage).toHaveAttribute('alt', /General product photo/);

        const selected = variant({ images: ['/red.jpg'] });
        const props = galleryProps({
          selection: { status: 'selected', variant: selected },
          variants: [selected],
          images: Array.from({ length: 9 }, (_, index) => `/general-${index}.jpg`),
        });
        await mount(props);
        await expect(mainImage).toHaveAttribute('src', '/red.jpg');
        const originalUrl = page.url();
        const staleImage = await mainImage.elementHandle();
        assert.ok(staleImage);
        await page.locator('[data-gallery-thumbnail="1"]').click();
        await expect(mainImage).toHaveAttribute('src', '/general-0.jpg');
        await expect(mainImage).toHaveAttribute('alt', /General product photo/);
        await expect(page.locator('[data-gallery-count]')).toHaveText('2 / 10');
        await expect(page.locator('[data-gallery-selected-id]')).toHaveText('red-sku');
        assert.equal(page.url(), originalUrl);
        await staleImage.evaluate((image) => image.dispatchEvent(new Event('error')));
        await expect(mainImage).toHaveAttribute('src', '/general-0.jpg');
        await staleImage.dispose();

        for (const width of [375, 1280]) {
          await page.setViewportSize({ width, height: 900 });
          const strip = page.locator('#gallery-thumbnails');
          const bounds = await strip.evaluate((element) => ({
            client: element.clientWidth,
            scroll: element.scrollWidth,
            overflow: getComputedStyle(element).overflowX,
            body: document.documentElement.scrollWidth,
            viewport: innerWidth,
          }));
          assert.ok(bounds.scroll > bounds.client, JSON.stringify(bounds));
          assert.equal(bounds.overflow, 'auto');
          assert.ok(bounds.body <= bounds.viewport, JSON.stringify(bounds));
          await page.locator('[data-gallery-thumbnail="9"]').focus();
          await page.keyboard.press('Enter');
          await expect(mainImage).toHaveAttribute('src', '/general-8.jpg');
          assert.ok((await strip.evaluate((element) => element.scrollLeft)) > 0);
          await expect(mainImage).toHaveJSProperty('naturalWidth', 1);
          const before = await mainImage.evaluate((image) => ({
            transform: getComputedStyle(image).transform,
            scale: getComputedStyle(image).scale,
          }));
          await frame.hover();
          assert.deepEqual(
            await mainImage.evaluate((image) => ({
              transform: getComputedStyle(image).transform,
              scale: getComputedStyle(image).scale,
            })),
            before,
          );
          await page.screenshot({ path: `/tmp/channel-gallery-ui-${width}.png` });
        }

        const broken = variant({ images: ['/broken-red.jpg'] });
        await mount(
          galleryProps({ selection: { status: 'selected', variant: broken }, variants: [broken] }),
        );
        await expect(frame.locator('[data-product-media="fallback"]')).toBeVisible();
        await expect(page.locator('[data-gallery-count]')).toHaveText('1 / 3');
        await page.locator('[data-gallery-thumbnail="1"]').click();
        await expect(mainImage).toHaveAttribute('src', '/general-front.jpg');
        await expect(mainImage).toHaveAttribute('alt', /General product photo/);
        await page.locator('[data-gallery-thumbnail="0"]').click();
        await expect(frame.locator('[data-product-media="fallback"]')).toBeVisible();
        await expect(page.locator('[data-gallery-count]')).toHaveText('1 / 3');
        await expect(page.locator('[data-gallery-selected-id]')).toHaveText('red-sku');
        assert.equal(page.url(), originalUrl);

        const blue = variant({ id: 'blue-sku', images: ['/blue.jpg'] });
        await mount(
          galleryProps({ selection: { status: 'selected', variant: blue }, variants: [blue] }),
        );
        await expect(mainImage).toHaveAttribute('src', '/blue.jpg');
        await expect(page.locator('[data-gallery-count]')).toHaveText('1 / 3');
        await expect(
          page.getByRole('button', { name: /View product gallery|Back to configuration photos/ }),
        ).toHaveCount(0);

        await page.evaluate(async (modulePath) => {
          const harness: typeof import('../testing/variant-gallery-browser-harness.tsx') =
            await import(modulePath);
          harness.renderLegacy({
            images: ['', '/first.jpg', '/first.jpg', '/second.jpg'],
            imageLabels: ['Blank', 'First source', 'Duplicate label', 'Second source'],
            alt: 'Legacy',
          });
        }, '/src/catalog/testing/variant-gallery-browser-harness.tsx');
        await expect(mainImage).toHaveAttribute('alt', 'First source');
        await page.locator('[data-gallery-thumbnail="1"]').click();
        await expect(mainImage).toHaveAttribute('alt', 'Second source');
        await page.evaluate(async (modulePath) => {
          const harness: typeof import('../testing/variant-gallery-browser-harness.tsx') =
            await import(modulePath);
          harness.renderLegacy({
            images: Array.from({ length: 6 }, (_, index) => `/legacy-${index}.jpg`),
            alt: 'Legacy',
          });
        }, '/src/catalog/testing/variant-gallery-browser-harness.tsx');
        await expect(page.locator('[data-gallery-thumbnail]')).toHaveCount(4);
        await page.getByRole('button', { name: 'View All', exact: true }).click();
        await expect(page.locator('[data-gallery-thumbnail]')).toHaveCount(6);
        await page.getByRole('button', { name: 'Show Less', exact: true }).click();
        await expect(page.locator('[data-gallery-thumbnail]')).toHaveCount(4);
        assert.deepEqual(errors, []);
      } finally {
        await browser.close();
      }
    } finally {
      await server.close();
    }
  },
);
