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

test('Gallery defensively clamps normalized media to the shared maximum', () => {
  const images = Array.from({ length: 25 }, (_, index) => ` /api/images/image-${index + 1} `);
  const bounded = boundedGalleryImages(images);

  assert.equal(bounded.length, 18);
  assert.equal(bounded[0], '/api/images/image-1');
  assert.equal(bounded.at(-1), '/api/images/image-18');
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
