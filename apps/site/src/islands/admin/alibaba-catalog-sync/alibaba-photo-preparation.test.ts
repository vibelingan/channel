/** Alibaba photos copied ahead; new drafts appear ready (PT-G). */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AlibabaPhotoPreparation } from './AlibabaPhotoPreparation.tsx';
import { fetchPhotoPreparationStatus, prepareAlibabaPhotos } from './alibaba-api.ts';

const page = (overrides: Record<string, unknown>) => ({
  afterProductId: '',
  nextProductId: '',
  done: false,
  visited: 0,
  prepared: 0,
  photosCopied: 0,
  photosReused: 0,
  photosFailed: 0,
  busy: 0,
  failures: [],
  ...overrides,
});

test('photo preparation runs page after page to the end and adds up the progress', async (t) => {
  const requests: Record<string, unknown>[] = [];
  const pages = [
    page({
      nextProductId: 'p-100',
      visited: 100,
      prepared: 3,
      photosCopied: 40,
      photosFailed: 1,
      failures: [{ productId: 'p-7', reason: 'invalid-product' }],
    }),
    page({ afterProductId: 'p-100', nextProductId: 'p-100', prepared: 1, photosCopied: 9 }),
    page({ afterProductId: 'p-100', nextProductId: 'p-180', done: true, visited: 80, busy: 1 }),
  ];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    requests.push(body.data);
    return Response.json({ ok: true, data: pages[requests.length - 1] });
  });
  const seen: number[] = [];
  const total = await prepareAlibabaPhotos((progress) => seen.push(progress.prepared), {
    pendingOnly: true,
  });
  assert.deepEqual(
    requests.map((data) => data.afterProductId),
    ['', 'p-100', 'p-100'],
    'a product that ran out of time resumes',
  );
  assert.ok(requests.every((data) => data.pendingOnly === true));
  assert.deepEqual(total, {
    prepared: 4,
    photosCopied: 49,
    photosReused: 0,
    photosFailed: 1,
    busy: 1,
    waiting: 0,
    failures: 1,
    failedProducts: ['p-7'],
  });
  assert.deepEqual(seen, [3, 4, 4]);
});

test('a page that does not continue from where it was asked is refused', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ ok: true, data: page({ afterProductId: 'elsewhere' }) }),
  );
  await assert.rejects(prepareAlibabaPhotos(), /invalid page/);
});

test('the photo status is read and validated', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({
      ok: true,
      data: { hiddenDrafts: 2, draftsToFill: 958, draftsMissingPhotos: 4 },
    }),
  );
  assert.deepEqual(await fetchPhotoPreparationStatus(), {
    hiddenDrafts: 2,
    draftsToFill: 958,
    draftsMissingPhotos: 4,
  });
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ ok: true, data: { hiddenDrafts: -1 } }),
  );
  await assert.rejects(fetchPhotoPreparationStatus(), /status/);
});

test('the Product photos section says what is left and what happens automatically', () => {
  const markup = renderToStaticMarkup(
    createElement(AlibabaPhotoPreparation, {
      status: { hiddenDrafts: 2, draftsToFill: 958, draftsMissingPhotos: 4 },
      progress: {
        prepared: 12,
        photosCopied: 240,
        photosReused: 30,
        photosFailed: 3,
        busy: 0,
        waiting: 2,
        failures: 1,
        failedProducts: ['p-7'],
      },
      running: true,
      onRun: () => {},
    }),
  );
  assert.ok(markup.includes('Product photos'));
  assert.ok(markup.includes('automatically after each sync'));
  assert.ok(markup.includes('Copy photos now also tries again the photos Alibaba'));
  assert.ok(markup.includes('2 new drafts being prepared'));
  assert.ok(markup.includes('958 drafts waiting for photos'));
  assert.ok(markup.includes('12 drafts ready'));
  assert.ok(markup.includes('240 photos copied'));
  assert.ok(markup.includes('3 could not be copied'));
  assert.ok(markup.includes('4 drafts with photos Alibaba could not provide (skipped)'));
  assert.ok(
    markup.includes(
      '2 drafts waiting to try again in 10 minutes (while this page stays open, or at the next sync)',
    ),
  );
  assert.ok(markup.includes('1 draft could not be saved'));
  assert.ok(markup.includes('p-7'));
  assert.match(markup, /<button[^>]*disabled=""[^>]*>Copying photos…<\/button>/);
  const done = renderToStaticMarkup(
    createElement(AlibabaPhotoPreparation, {
      status: { hiddenDrafts: 0, draftsToFill: 0, draftsMissingPhotos: 0 },
      progress: null,
      running: false,
      onRun: () => {},
    }),
  );
  assert.ok(done.includes('Every draft has its photos.'));
  assert.match(done, /<button[^>]*>Copy photos now<\/button>/);
});

test('the sync page copies photos automatically after every sync and finishes hidden drafts on open', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('./AlibabaCatalogSyncPage.tsx', import.meta.url), 'utf8');
  // After Run now, after Create missing drafts, after syncing one product —
  // also when the sync failed partway.
  assert.equal(source.match(/void syncThenPhotos\(async \(\) => \{/g)?.length, 3);
  assert.match(source, /finally \{\s*void runPhotoPreparationRef\.current\?\.\('all'\);/);
  assert.match(source, /hiddenDrafts > 0\) void runPhotoPreparation\('pending'\)/);
  // "Copy photos now" also tries photos earlier found unavailable.
  assert.match(
    source,
    /onRun=\{\(\) => \{\s*retryUnavailableNext\.current = true;\s*void runPhotoPreparation\('all'\);/,
  );
  assert.match(source, /\.\.\.\(retryUnavailable \? \{ retryUnavailable: true \} : \{\}\)/);
  // Products waiting on a photo are tried again while the page stays open.
  assert.match(
    source,
    /if \(total && total\.waiting > 0\)\s*photoRetry\.current = setTimeout\(\s*\(\) => void runPhotoPreparationRef\.current\?\.\('all'\),\s*PHOTO_RETRY_AFTER_MS,/,
  );
  assert.match(source, /const PHOTO_RETRY_AFTER_MS = 10\.5 \* 60 \* 1000;/);
  assert.match(source, /clearTimeout\(photoRetry\.current\)/);
});

test('a retry run starts on the server clock and passes that start to its later calls', async (t) => {
  const requests: Record<string, unknown>[] = [];
  const start = '2026-10-09T10:00:00.000Z';
  const pages = [
    page({ nextProductId: 'p-100', visited: 100, retryFailedBefore: start }),
    page({ afterProductId: 'p-100', nextProductId: 'p-150', done: true, visited: 50 }),
  ];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)).data);
    return Response.json({ ok: true, data: pages[requests.length - 1] });
  });
  await prepareAlibabaPhotos(undefined, { retryUnavailable: true });
  assert.deepEqual(requests, [
    { afterProductId: '', retryUnavailable: true },
    { afterProductId: 'p-100', retryFailedBefore: start },
  ]);
});
