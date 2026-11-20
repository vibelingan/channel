import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  Gallery,
  GalleryThumbnailList,
  boundedGalleryImages,
  gallerySessionKey,
  visibleGalleryThumbnails,
} from './Gallery.tsx';
import { detailScrollBehavior } from './HeadphonesPage.tsx';
import {
  CatalogHeroImageApiOrigin,
  ProductMedia,
  createProductMediaState,
  productMediaImageKey,
  productMediaKey,
  productMediaReducer,
} from './ProductMedia.tsx';

const SOURCES = [
  'https://media.example.test/one.jpg',
  'https://media.example.test/two.jpg',
  'https://media.example.test/three.jpg',
] as const;

test('initial product HTML shows the photos and waits to enable their controls', () => {
  const html = renderToStaticMarkup(
    createElement(Gallery, { images: SOURCES, alt: 'Product photo', layout: 'detail' }),
  );
  const thumbnails = [...html.matchAll(/<button\b[^>]*data-gallery-thumbnail="\d+"[^>]*>/g)];
  assert.equal(thumbnails.length, SOURCES.length);
  assert.ok(thumbnails.every(([button]) => /\sdisabled=""/.test(button)));
  assert.match(html, /id="gallery-thumbnails"[^>]*aria-busy="true"/);
  assert.match(html, /alt="Product photo"/);
});

test('responsive SSR preserves photo identity and alt and uses actual widths and thumbnail slot sizes', () => {
  const source = '/api/images/ready';
  const mediumOnly = '/api/images/medium-only';
  const imagePresentation = {
    [source]: [
      { url: `${source}?w=160`, width: 160, height: 100 },
      { url: `${source}?w=640`, width: 640, height: 400 },
      { url: `${source}?w=1280`, width: 800, height: 500 },
    ],
    [mediumOnly]: [{ url: `${mediumOnly}?w=640`, width: 640, height: 400 }],
  };
  const html = renderToStaticMarkup(
    createElement(Gallery, {
      images: [source, mediumOnly, '/api/images/other'],
      alt: 'Human caption',
      layout: 'detail',
      imagePresentation,
    }),
  );
  assert.match(html, /src="\/api\/images\/ready"/);
  assert.match(html, /alt="Human caption"/);
  assert.match(html, /srcSet="[^"]*\?w=160 160w[^\"]*\?w=640 640w[^\"]*\?w=1280 800w"/);
  assert.equal(html.includes('1280w'), false, 'A maximum request is not the actual pixel width');
  assert.match(html, /sizes="80px"/);
  const thumbnails = [
    ...html.matchAll(/<button[^>]*data-gallery-thumbnail="\d+"[\s\S]*?<\/button>/g),
  ];
  assert.equal(thumbnails.length, 3);
  assert.match(thumbnails[0]?.[0] ?? '', /loading="lazy" fetchPriority="auto"/);
  assert.match(thumbnails[1]?.[0] ?? '', /loading="lazy" fetchPriority="low"/);
  assert.match(thumbnails[2]?.[0] ?? '', /loading="lazy" fetchPriority="low"/);
  const fallback = renderToStaticMarkup(
    createElement(ProductMedia, {
      sources: ['/api/images/other'],
      alt: 'Other photo',
      imagePresentation,
    }),
  );
  assert.equal(
    fallback.includes('srcSet='),
    false,
    'A different fallback never inherits the old photo candidates',
  );
});

test('the approved storefront renders the main photo at its own origin and keeps other images unchanged', () => {
  const origin = 'https://public-api.example.test';
  const source = `${origin}/api/images/current`;
  const imagePresentation = {
    [source]: [{ url: `${source}?w=640`, width: 640, height: 480 }],
  };
  const media = (url: string, primary = true) =>
    createElement(ProductMedia, {
      sources: [url],
      alt: 'Headphones',
      preferSiteImage: primary,
      ...(primary ? { loading: 'eager', fetchPriority: 'high' } : {}),
      imagePresentation,
    });
  const render = (url: string, primary?: boolean) =>
    renderToStaticMarkup(
      createElement(CatalogHeroImageApiOrigin.Provider, { value: origin }, media(url, primary)),
    );
  assert.match(render(source), /src="\/api\/images\/current"/);
  assert.match(render(source), /srcSet="\/api\/images\/current\?w=640 640w"/);
  assert.match(render(source), /imageSrcSet="\/api\/images\/current\?w=640 640w"/);
  assert.match(render(source, false), /https:\/\/public-api\.example\.test\/api\/images\/current/);
  assert.match(render(SOURCES[0]), /https:\/\/media\.example\.test\/one\.jpg/);
  assert.match(
    render(`${origin}/api/admin/images/current`),
    /https:\/\/public-api\.example\.test\/api\/admin/,
  );
  assert.match(
    renderToStaticMarkup(media(source)),
    /https:\/\/public-api\.example\.test\/api\/images\/current/,
  );
  const standalone = renderToStaticMarkup(
    createElement(ProductMedia, {
      sources: [source],
      alt: 'Headphones category hero',
      siteImageApiOrigin: origin,
      preferSiteImage: true,
      loading: 'eager',
    }),
  );
  assert.match(standalone, /src="\/api\/images\/current"/);
  assert.match(standalone, /alt="Headphones category hero"/);
});

test('a legacy photo shown as both the first main image and a thumbnail uses one URL', () => {
  const api = 'https://public-api.example.test';
  const first = `${api}/api/images/first`;
  const other = `${api}/api/images/other`;
  const html = renderToStaticMarkup(
    createElement(
      CatalogHeroImageApiOrigin.Provider,
      { value: api },
      createElement(Gallery, {
        images: [first, other],
        alt: 'Headphones',
        layout: 'detail',
        mainImagePriority: 'high',
      }),
    ),
  );
  assert.equal((html.match(/<img[^>]+src="\/api\/images\/first"/g) ?? []).length, 2);
  assert(!html.includes(`src="${first}"`));
  assert(html.includes(`src="${other}"`));
});

test('supplier gallery requests never send the admin preview URL as a referrer', () => {
  const html = renderToStaticMarkup(
    createElement(ProductMedia, { sources: SOURCES, alt: 'Headset' }),
  );
  assert.match(html, /referrerPolicy="no-referrer"/i);
});

test('product media advances each failed source once and terminates after exhaustion', () => {
  let state = createProductMediaState();

  state = productMediaReducer(state, {
    type: 'sourceFailed',
    sourceIndex: 0,
    source: SOURCES[0],
    sources: SOURCES,
  });
  assert.equal(state.activeIndex, 1);

  const afterDuplicate = productMediaReducer(state, {
    type: 'sourceFailed',
    sourceIndex: 0,
    source: SOURCES[0],
    sources: SOURCES,
  });
  assert.strictEqual(afterDuplicate, state);

  state = productMediaReducer(state, {
    type: 'sourceFailed',
    sourceIndex: 1,
    source: SOURCES[1],
    sources: SOURCES,
  });
  state = productMediaReducer(state, {
    type: 'sourceFailed',
    sourceIndex: 2,
    source: SOURCES[2],
    sources: SOURCES,
  });

  assert.equal(state.activeIndex, SOURCES.length);
  assert.deepEqual(state.failedSourceIndexes, [0, 1, 2]);
});

test('product media exhausts repeated source URLs by ordered index', () => {
  const repeatedSources = [SOURCES[0], SOURCES[0], SOURCES[1]];
  let state = createProductMediaState();

  for (const sourceIndex of repeatedSources.keys()) {
    state = productMediaReducer(state, {
      type: 'sourceFailed',
      sourceIndex,
      source: repeatedSources[sourceIndex] ?? '',
      sources: repeatedSources,
    });
  }

  assert.equal(state.activeIndex, repeatedSources.length);
  assert.deepEqual(state.failedSourceIndexes, [0, 1, 2]);
});

test('product media identity changes when the ordered source list changes', () => {
  assert.notEqual(productMediaKey(SOURCES), productMediaKey(SOURCES.slice(1)));
  assert.equal(productMediaKey(SOURCES), productMediaKey([...SOURCES]));
  assert.notEqual(productMediaImageKey(0, SOURCES[0]), productMediaImageKey(1, SOURCES[0]));
});

test('Gallery session identity includes the product even when media is identical', () => {
  assert.notEqual(gallerySessionKey('product-a', SOURCES), gallerySessionKey('product-b', SOURCES));
  assert.equal(
    gallerySessionKey('product-a', SOURCES),
    gallerySessionKey('product-a', [...SOURCES]),
  );
});

test('Gallery defensively clamps normalized product media to nine', () => {
  const images = Array.from({ length: 25 }, (_, index) => ` /api/images/image-${index + 1} `);
  const bounded = boundedGalleryImages(images);

  assert.equal(bounded.length, 9);
  assert.equal(bounded[0], '/api/images/image-1');
  assert.equal(bounded.at(-1), '/api/images/image-9');
});

test('collapsed Gallery keeps an out-of-range active thumbnail visible and selected', () => {
  const images = Array.from({ length: 6 }, (_, index) => `image-${index + 1}`);

  assert.deepEqual(visibleGalleryThumbnails(images, 4, false), [
    { image: 'image-1', index: 0, key: 'image-1:1' },
    { image: 'image-2', index: 1, key: 'image-2:1' },
    { image: 'image-3', index: 2, key: 'image-3:1' },
    { image: 'image-5', index: 4, key: 'image-5:1' },
  ]);
  assert.deepEqual(
    visibleGalleryThumbnails(images, 4, true).map(({ index }) => index),
    [0, 1, 2, 3, 4, 5],
  );
});

test('collapsed Gallery preserves full-list occurrence keys for duplicate URLs', () => {
  const images = ['one', 'two', 'three', 'duplicate', 'duplicate', 'six'];

  const expanded = visibleGalleryThumbnails(images, 4, true);
  const collapsed = visibleGalleryThumbnails(images, 4, false);

  assert.equal(expanded[3]?.key, 'duplicate:1');
  assert.equal(expanded[4]?.key, 'duplicate:2');
  assert.deepEqual(
    collapsed.map(({ index, key }) => ({ index, key })),
    [
      { index: 0, key: 'one:1' },
      { index: 1, key: 'two:1' },
      { index: 2, key: 'three:1' },
      { index: 4, key: 'duplicate:2' },
    ],
  );
});

test('Headphones detail uses reduced-motion scrolling and typed Gallery copy', () => {
  assert.equal(detailScrollBehavior(false), 'smooth');
  assert.equal(detailScrollBehavior(true), 'auto');

  // MIU 13 moved the Gallery mount out of the controller and into the detail
  // presentation component, which consumes the same typed detail contract.
  const source = readFileSync(new URL('./HeadphonesProductDetail.tsx', import.meta.url), 'utf8');
  assert.match(source, /viewAllLabel=\{detail\.viewAllLabel\}/);
  assert.match(source, /unavailableLabel=\{detail\.imageUnavailableLabel\}/);
  assert.doesNotMatch(source, /zoomHint/);
});

test('Gallery and every detail caller remove the retired zoom API', () => {
  for (const file of ['Gallery.tsx', 'ProductDetail.tsx', 'OverstockDetail.tsx']) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /zoomHint/, file);
  }
});

test('product media reserves square geometry and renders meaningful and empty alt text', () => {
  const meaningful = renderToStaticMarkup(
    createElement(ProductMedia, { sources: SOURCES, alt: 'Wireless headphones' }),
  );
  assert.match(meaningful, /data-product-media="image"/);
  assert.match(meaningful, /width="800"/);
  assert.match(meaningful, /height="800"/);
  assert.match(meaningful, /alt="Wireless headphones"/);
  assert.match(meaningful, /object-contain/);

  const decorative = renderToStaticMarkup(
    createElement(ProductMedia, { sources: SOURCES, alt: '' }),
  );
  assert.match(decorative, /alt=""/);

  const empty = renderToStaticMarkup(
    createElement(ProductMedia, { sources: [], alt: 'Wireless headphones' }),
  );
  assert.match(empty, /data-product-media="fallback"/);
  assert.match(empty, /<output/);
  assert.match(empty, /aria-live="polite"/);
  assert.match(empty, /<output[^>]*><\/output>/);
  assert.doesNotMatch(empty, />Wireless headphones\. Product image unavailable<\/output>/);
  assert.match(empty, /data-product-media="fallback"[^>]+aria-hidden="true"/);
  assert.equal((empty.match(/Product image unavailable/g) ?? []).length, 1);
  assert.match(empty, /aspect-square/);

  const decorativeFallback = renderToStaticMarkup(
    createElement(ProductMedia, { sources: [], alt: '' }),
  );
  assert.match(decorativeFallback, /aria-hidden="true"/);
  assert.doesNotMatch(decorativeFallback, /<output/);
});

test('gallery renders four previews initially and expands all previews inline', () => {
  const images = Array.from(
    { length: 6 },
    (_, index) => `https://media.example.test/gallery-${index + 1}.jpg`,
  );
  const initial = renderToStaticMarkup(
    createElement(Gallery, {
      images,
      alt: 'Wireless headphones',
      viewAllLabel: 'View All',
    }),
  );
  assert.equal((initial.match(/data-gallery-thumbnail=/g) ?? []).length, 4);
  assert.match(initial, />View All</);
  assert.match(initial, /aria-expanded="false"/);
  assert.match(initial, /aria-controls="gallery-thumbnails"/);
  assert.match(initial, /motion-reduce:transition-none/);
  assert.doesNotMatch(initial, /role="dialog"/);

  const expanded = renderToStaticMarkup(
    createElement(GalleryThumbnailList, {
      images,
      activeIndex: 0,
      expanded: true,
      viewAllLabel: 'View All',
      showLessLabel: 'Show Less',
      onSelect: () => undefined,
      onToggle: () => undefined,
    }),
  );
  assert.equal((expanded.match(/data-gallery-thumbnail=/g) ?? []).length, images.length);
  assert.match(expanded, /aria-expanded="true"/);
  assert.match(expanded, /aria-controls="gallery-thumbnails"/);
  assert.match(expanded, />Show Less</);
  assert.doesNotMatch(expanded, /role="dialog"/);
});

test('controlled Gallery renders the explicit source, not index zero or an invented fallback', () => {
  const html = renderToStaticMarkup(
    createElement(Gallery, {
      images: [...SOURCES],
      alt: 'Selected product',
      selection: { source: SOURCES[2], onChange: () => undefined },
    }),
  );
  const frame = html.split('data-gallery-frame')[1]?.split('</div>')[0] ?? '';
  assert.match(frame, /src="https:\/\/media.example.test\/three.jpg"/);
  assert.match(html, /data-gallery-thumbnail="2"[^>]*aria-pressed="true"/);
  const unknown = renderToStaticMarkup(
    createElement(Gallery, {
      images: [...SOURCES],
      alt: 'Selected product',
      selection: { source: 'unrelated', onChange: () => undefined },
    }),
  );
  const emptyFrame = unknown.split('data-gallery-frame')[1]?.split('</div>')[0] ?? '';
  assert.match(emptyFrame, /data-product-media="fallback"/);
  assert.doesNotMatch(unknown, /aria-pressed="true"/);
});

test('detail layout retains every merged photo in order without changing legacy gallery limits', () => {
  const images = Array.from({ length: 12 }, (_, i) => `/api/images/${i}`);
  const detail = renderToStaticMarkup(
    createElement(Gallery, {
      images: [' ', ...images, images[0]],
      alt: 'Detail',
      layout: 'detail',
    }),
  );
  assert.equal((detail.match(/data-gallery-thumbnail=/g) ?? []).length, 12);
  assert.deepEqual(
    [...detail.matchAll(/data-gallery-thumbnail="\d+"[\s\S]*?<img[^>]*src="([^"]+)"/g)].map(
      (match) => match[1],
    ),
    images,
  );
  assert.match(detail, />1 \/ 12</);
  assert.match(detail, /overflow-x-auto/);
  assert.match(detail, /sm:h-\[360px\]/);
  assert.match(detail, /lg:h-\[420px\]/);
  assert.match(detail, /max-w-\[560px\]/);
  assert.match(detail, /data-gallery-count/);
  assert.doesNotMatch(detail, /data-gallery-view-all/);
  const legacy = renderToStaticMarkup(createElement(Gallery, { images, alt: 'Legacy' }));
  assert.deepEqual(boundedGalleryImages(images), images.slice(0, 9));
  assert.equal((legacy.match(/data-gallery-thumbnail=/g) ?? []).length, 4);
  assert.match(legacy, /aspect-square[^>]*max-w-\[520px\]/);
  assert.match(legacy, /data-gallery-view-all/);
});

test('ProductMedia skips blanks before resolver mapping and uses the first normalized unique source', () => {
  const html = renderToStaticMarkup(
    createElement(ProductMedia, { sources: ['  ', ' api/image ', '/api/image'], alt: 'Media' }),
  );
  assert.match(html, /src="\/api\/image"/);
  assert.equal((html.match(/<img/g) ?? []).length, 1);
});
