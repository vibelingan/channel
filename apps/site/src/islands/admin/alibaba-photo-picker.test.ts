/** Adding Alibaba photos beyond the ones filled automatically (owner 2026-10-09). */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AlibabaPhotoPicker } from './AlibabaPhotoPicker.tsx';
import { fetchPhotoSources } from './api.ts';

const url = (i: number) => `https://sc04.alicdn.com/d${i}.jpg`;
const sources = Array.from({ length: 20 }, (_, i) => ({
  url: url(i),
  imageId: i < 19 ? `img-d${i}` : null,
}));

test('more Alibaba photos than fit: a notice, and the ones not on the website can be added', () => {
  const html = renderToStaticMarkup(
    createElement(AlibabaPhotoPicker, {
      title: 'Alibaba description photos',
      sources,
      currentIds: Array.from({ length: 17 }, (_, i) => `img-d${i}`),
      limit: 18,
      busyUrl: null,
      onAdd: () => {},
    }),
  );
  assert.ok(html.includes('Alibaba has 20 description photos; up to 18 can be on the website.'));
  assert.equal(html.match(/>On the website</g)?.length, 17);
  // Photos 18, 19 (copied) and 20 (not copied yet) can be added.
  assert.equal(html.match(/>Add<\/button>/g)?.length, 3);
  assert.ok(html.includes('aria-label="Add Alibaba description photo 20"'));
});

test('when every place is taken, adding waits until a photo is removed', () => {
  const html = renderToStaticMarkup(
    createElement(AlibabaPhotoPicker, {
      title: 'Alibaba description photos',
      sources,
      currentIds: Array.from({ length: 18 }, (_, i) => `img-d${i}`),
      limit: 18,
      busyUrl: null,
      onAdd: () => {},
    }),
  );
  assert.ok(html.includes('All 18 places are taken. Remove a photo to add another.'));
  assert.match(html, /<button[^>]*disabled=""[^>]*>Add<\/button>/);
});

test('no notice when everything fits; nothing shown while loading', () => {
  const fits = renderToStaticMarkup(
    createElement(AlibabaPhotoPicker, {
      title: 'Alibaba photos',
      sources: sources.slice(0, 3),
      currentIds: ['img-d0'],
      limit: 9,
      busyUrl: url(1),
      onAdd: () => {},
    }),
  );
  assert.ok(!fits.includes('can be on the website'));
  assert.ok(fits.includes('>Adding…<'));
  const loading = renderToStaticMarkup(
    createElement(AlibabaPhotoPicker, {
      title: 'Alibaba photos',
      sources: null,
      currentIds: [],
      limit: 9,
      busyUrl: null,
      onAdd: () => {},
    }),
  );
  assert.equal(loading, '');
});

test('the photo sources answer is validated', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ ok: true, data: { ok: true, gallery: [], description: sources } }),
  );
  assert.deepEqual(await fetchPhotoSources('p1'), { gallery: [], description: sources });
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ ok: true, data: { ok: true, gallery: 'nope' } }),
  );
  await assert.rejects(fetchPhotoSources('p1'), /photo/i);
});
