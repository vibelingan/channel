/**
 * The corpus may only contain pages the website actually publishes.
 *
 * This exists because it did not. `overstock/en-US.md` was ingested against the
 * URL `/overstock`, while `apps/site/src/pages/_overstock.astro` is deliberately
 * unrouted and a separate test asserts it stays that way. The assistant would
 * have answered from an unpublished page and cited a link that 404s — a leak
 * that arrives with a footnote making it look verified.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  assertSourcesArePublished,
  contentToText,
  preflightPublicTargets,
  publishedRoutes,
} from './ai-ingest-content.mjs';

function fakePages(names) {
  const dir = mkdtempSync(join(tmpdir(), 'pages-'));
  for (const name of names) writeFileSync(join(dir, name), '');
  return dir;
}

test('an underscored page is not a published route', () => {
  const routes = publishedRoutes(fakePages(['index.astro', 'oem.astro', '_overstock.astro']));
  assert.ok(routes.has('/'));
  assert.ok(routes.has('/oem'));
  assert.ok(!routes.has('/overstock'), '_overstock.astro must not count as a route');
});

test('the real repository still routes every page this manifest cites', () => {
  // Runs against the ACTUAL pages directory, so publishing or un-publishing a
  // page without updating the manifest fails here rather than in production.
  assert.doesNotThrow(() => assertSourcesArePublished());
});

test('public corpus projection drops internal media identifiers and integrity metadata', () => {
  const text = contentToText(
    `---
hero:
  title: Customer-visible product
  sources:
    - imageId: 0e0afdc26a68209e00523aa031e56460
      width: 800
      height: 800
      sha256: c214432ede60268b25c7001dc06873240a533094c3adc89760df95c2f4e7179c
  imageWidth: 825
  imageHeight: 776
  proof: MOQ from 500 units
---
`,
    { title: 'Products', url: '/headphones' },
  );

  assert.match(text, /Customer-visible product/);
  assert.match(text, /MOQ from 500 units/);
  assert.doesNotMatch(text, /image id|imageId|sha256|0e0afdc|c214432e|800/i);
});

test('a source pointing at an underscored page is refused, naming the page', () => {
  const pages = fakePages(['index.astro', '_overstock.astro']);
  assert.throws(
    () =>
      assertSourcesArePublished(
        [{ file: 'overstock/en-US.md', title: 'Overstock', url: '/overstock' }],
        pages,
      ),
    /refusing to ingest unpublished content[\s\S]*\/overstock/,
  );
});

test('a source pointing at a route that does not exist at all is refused', () => {
  const pages = fakePages(['index.astro']);
  assert.throws(
    () => assertSourcesArePublished([{ file: 'en-US.md', title: 'Ghost', url: '/ghost' }], pages),
    /no published route serves this URL/,
  );
});

test('a source whose content file is missing is refused before any upload', () => {
  const pages = fakePages(['index.astro', 'ghost.astro']);
  assert.throws(
    () =>
      assertSourcesArePublished([{ file: 'nope/en-US.md', title: 'Nope', url: '/ghost' }], pages),
    /content file is missing/,
  );
});

// ── preflight ──────────────────────────────────────────────────────────────

const sources = [{ file: 'en-US.md', title: 'Home', url: '/' }];

test('preflight passes when every target answers 200 on the configured site', async () => {
  const seen = [];
  const checked = await preflightPublicTargets(sources, 'https://site.example', async (url) => {
    seen.push(url);
    return { status: 200 };
  });
  assert.deepEqual(seen, ['https://site.example/']);
  assert.deepEqual(checked, ['https://site.example/']);
});

test('a 404 target aborts the whole ingest, and says nothing was uploaded', async () => {
  await assert.rejects(
    preflightPublicTargets(
      [{ file: 'overstock/en-US.md', title: 'Overstock', url: '/overstock' }],
      'https://site.example',
      async () => ({ status: 404 }),
    ),
    /returned HTTP 404[\s\S]*previous corpus is still serving/,
  );
});

test('a redirect is not a live page, because the citation would land elsewhere', async () => {
  await assert.rejects(
    preflightPublicTargets(sources, 'https://site.example', async () => ({ status: 301 })),
    /returned HTTP 301/,
  );
});

test('an unreachable site aborts rather than uploading against a guess', async () => {
  await assert.rejects(
    preflightPublicTargets(sources, 'https://site.example', async () => {
      throw new Error('ECONNREFUSED');
    }),
    /could not be reached/,
  );
});

test('a target that resolves off the configured origin is refused, not fetched', async () => {
  let fetched = false;
  await assert.rejects(
    preflightPublicTargets(
      [{ file: 'x.md', title: 'X', url: 'https://evil.example/x' }],
      'https://site.example',
      async () => {
        fetched = true;
        return { status: 200 };
      },
    ),
    /resolves to https:\/\/evil\.example/,
  );
  assert.equal(fetched, false, 'a cross-origin target must never be fetched');
});

test('a plain-http site origin is refused unless it is localhost', async () => {
  await assert.rejects(
    preflightPublicTargets(sources, 'http://kb.example.com', async () => ({ status: 200 })),
    /must be https/,
  );
  await assert.doesNotReject(
    preflightPublicTargets(sources, 'http://localhost:4321', async () => ({ status: 200 })),
  );
});
