/** Real built Astro server + existing API handler + installed CloudBase SDK with offline transport.
 * This checks HTTP integration; it is deliberately NOT labelled live CloudBase acceptance. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { handlePublicApiEvent } from '../../apps/functions/public-api/src/http-adapter.ts';
import { parseArticleContent } from '../../packages/articles/src/article.ts';
import { createCloudBasePublicArticles } from '../../packages/db/src/article-public-reader.ts';
import { createCloudBaseArticleRepository } from '../../packages/db/src/article-repository.ts';
import { articleSdkFixture } from '../../packages/db/src/article-sdk-fixture.test-helper.ts';

const content = parseArticleContent({
  title: 'Manufacturing guide',
  slug: 'manufacturing-guide',
  authorName: 'Sean',
  excerpt: 'Practical manufacturing guidance.',
  body: {
    schemaVersion: 1,
    document: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'A clear manufacturing brief helps suppliers confirm materials, dimensions and quality checks before production.',
            },
          ],
        },
      ],
    },
  },
});
test('built SSR server publishes, updates and withdraws without a rebuild; real status and SEO HTML', async (t) => {
  const f = articleSdkFixture(t);
  const repo = createCloudBaseArticleRepository(f.db, { mode: 'server' });
  const articles = createCloudBasePublicArticles(f.db, {
    getObjectAsBase64: async () => {
      throw Error('Unexpected media read');
    },
  });
  let offline = false;
  let serverOrigin = '';
  const api = createServer(async (req, res) => {
    // Mirror the production gateway: Blog goes to Node; existing root assets
    // remain on static hosting. Never duplicate the full media tree in the service.
    if (req.url?.startsWith('/blog')) {
      try {
        const response = await fetch(`${serverOrigin}${req.url}`, { redirect: 'manual' });
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch {
        res.writeHead(502).end();
      }
      return;
    }
    if (
      req.url === '/media/logo-channel.svg' ||
      req.url === '/media/logo-diversity.svg' ||
      req.url === '/favicon.svg'
    ) {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      res.end(await readFile(new URL(`../../apps/site/public${req.url}`, import.meta.url)));
      return;
    }
    if (offline) {
      res.writeHead(503).end();
      return;
    }
    const result = await handlePublicApiEvent(
      { httpMethod: req.method, path: req.url, headers: {} },
      { articles },
    );
    res.writeHead(result.statusCode, result.headers);
    res.end(result.isBase64Encoded ? Buffer.from(result.body, 'base64') : result.body);
  });
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  const apiAddress = api.address();
  assert(apiAddress && typeof apiAddress === 'object');
  const placeholder = createServer();
  placeholder.listen(0, '127.0.0.1');
  await once(placeholder, 'listening');
  const address = placeholder.address();
  assert(address && typeof address === 'object');
  await new Promise<void>((r) => placeholder.close(() => r()));
  serverOrigin = `http://127.0.0.1:${address.port}`;
  const origin = `http://127.0.0.1:${apiAddress.port}`;
  const standalone = await mkdtemp(join(tmpdir(), 'channel-blog-standalone-'));
  await cp(new URL('../../apps/site/dist-blog/', import.meta.url), standalone, { recursive: true });
  const server = spawn(process.execPath, ['server/entry.mjs'], {
    cwd: standalone,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(address.port),
      BLOG_API_ORIGIN: `http://127.0.0.1:${apiAddress.port}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  server.stdout.on('data', (b) => {
    output += b;
  });
  server.stderr.on('data', (b) => {
    output += b;
  });
  t.after(async () => {
    t.diagnostic(output);
    server.kill('SIGTERM');
    await once(server, 'exit');
    await rm(standalone, { recursive: true, force: true });
    await new Promise<void>((r) => api.close(() => r()));
  });
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const ready = await fetch(`${serverOrigin}/blog/health.json`);
      if (!ready.ok) throw Error('not ready');
      break;
    } catch {
      if (server.exitCode !== null || attempt === 79) throw Error(output);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const get = (path: string) => fetch(`${origin}${path}`, { redirect: 'error' });
  const draft = await repo.create({ actorId: 'admin', requestId: 'create', content });
  let currentRevision = draft.revision;
  assert.equal((await get('/blog/manufacturing-guide/')).status, 404);
  assert(!(await (await get('/blog/')).text()).includes('A clear manufacturing brief'));
  await repo.releases.request('admin', {
    operation: 'publish',
    articleId: draft.id,
    expectedRevision: 1,
    requestId: 'publish',
  });
  const response = await get('/blog/manufacturing-guide/');
  assert.equal(response.status, 200, output);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const previewOnly = process.env.BLOG_PREVIEW_ONLY === '1';
  assert.equal(response.headers.get('x-robots-tag'), previewOnly ? 'noindex,nofollow' : null);
  const health = await (await get('/blog/health.json')).json();
  const siteOrigin = process.env.SITE_URL || 'http://localhost:4321';
  assert(health !== null && typeof health === 'object');
  assert.equal(Reflect.get(health, 'siteOrigin'), siteOrigin);
  assert.equal(Reflect.get(health, 'previewOnly'), previewOnly);
  assert.match(String(Reflect.get(health, 'releaseId')), /^(?:[a-f0-9]{40}|local)$/);
  assert.equal(response.headers.get('x-channel-blog-version'), Reflect.get(health, 'releaseId'));
  const html = await response.text();
  const header = /<header\b[^>]*data-site-header[\s\S]*?<\/header>/.exec(html)?.[0];
  assert(header?.includes('href="/blog/"'), 'SSR header must expose the public Blog navigation');
  assert.match(html, /A clear manufacturing brief helps suppliers/);
  assert.match(html, /<h1[^>]*>Manufacturing guide<\/h1>/);
  assert(html.includes(`rel="canonical" href="${siteOrigin}/blog/manufacturing-guide/"`));
  assert.match(html, /"@type":"Article"/);
  assert.match(html, /datePublished/);
  assert.match(html, /index,follow/);
  if (process.env.BLOG_SSR_BROWSER === '1') {
    const { chromium } = await import('@playwright/test');
    const browser = await chromium.launch({
      headless: true,
      ignoreDefaultArgs: ['--disable-back-forward-cache'],
    });
    try {
      const evidence = new URL('../../output/blog-server-http/', import.meta.url);
      await mkdir(evidence, { recursive: true });
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      await page.addInitScript(
        "addEventListener('pageshow',event=>{const key='blog-bfcache-observation';const entries=JSON.parse(sessionStorage.getItem(key)||'[]');entries.push({persisted:event.persisted,path:location.pathname});sessionStorage.setItem(key,JSON.stringify(entries));})",
      );
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`${origin}/blog/`);
      await page.getByRole('link', { name: 'Manufacturing guide', exact: true }).click();
      await page.getByRole('heading', { name: 'Manufacturing guide', exact: true }).waitFor();
      assert.match(
        await page.locator('[data-blog-article]').innerText(),
        /A clear manufacturing brief/,
      );
      await page.waitForLoadState('networkidle');
      assert(
        await page
          .locator('img')
          .evaluateAll((images) =>
            images.every((image) => image.complete && image.naturalWidth > 0),
          ),
      );
      await page.screenshot({
        path: new URL('article-desktop.png', evidence).pathname,
        fullPage: true,
      });
      await page.getByRole('link', { name: 'All insights', exact: true }).click();
      await page.screenshot({
        path: new URL('list-desktop.png', evidence).pathname,
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({
        path: new URL('list-mobile.png', evidence).pathname,
        fullPage: true,
      });
      assert(
        await page.locator('html').evaluate((html) => {
          const view = html.ownerDocument.defaultView;
          return view !== null && html.scrollWidth <= view.innerWidth;
        }),
      );
      // Update through the actual repository while the reader is on the list,
      // then use browser history. HTTP cache headers alone do not govern BFCache.
      const revised = await repo.save({
        actorId: 'admin',
        articleId: draft.id,
        expectedRevision: currentRevision,
        content: { ...content, title: 'Revised manufacturing guide' },
      });
      assert(revised);
      currentRevision = revised.revision;
      await repo.releases.request('admin', {
        operation: 'publish',
        articleId: draft.id,
        expectedRevision: currentRevision,
        requestId: 'history-update',
      });
      await page.goBack();
      await page
        .getByRole('heading', { name: 'Revised manufacturing guide', exact: true })
        .waitFor({ timeout: 4000 });
      const history: unknown = await page.evaluate(
        "JSON.parse(sessionStorage.getItem('blog-bfcache-observation')||'[]')",
      );
      t.diagnostic(
        await page.evaluate(
          "JSON.stringify(performance.getEntriesByType('navigation')[0]?.notRestoredReasons)",
        ),
      );
      assert(Array.isArray(history));
      const cacheObserved = history.some((event) => event.persisted === true);
      t.diagnostic(`Real history cache observed: ${cacheObserved}`);
      const restored = await repo.save({
        actorId: 'admin',
        articleId: draft.id,
        expectedRevision: currentRevision,
        content: { ...content, title: 'History refreshed guidance' },
      });
      assert(restored);
      currentRevision = restored.revision;
      await repo.releases.request('admin', {
        operation: 'publish',
        articleId: draft.id,
        expectedRevision: currentRevision,
        requestId: 'restored-page-update',
      });
      // If this browser does not choose BFCache, exercise the same native event
      // explicitly. Only the event is simulated; the reload/API/HTML are real.
      await page.evaluate("dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))");
      await page
        .getByRole('heading', { name: 'History refreshed guidance', exact: true })
        .waitFor({ timeout: 4000 });
      assert.deepEqual(errors, []);
      await writeFile(
        new URL('browser.json', evidence),
        JSON.stringify({
          width: 1440,
          mobileWidth: 390,
          navigation: 'list to article to list',
          historyCacheObserved: cacheObserved,
          simulatedRestorationReload: true,
          pageErrors: errors,
        }),
      );
    } finally {
      await browser.close();
    }
  }
  assert(!html.includes('storageFileId'));
  const stylesheet = /href="([^"]+\.css)"/.exec(html)?.[1];
  assert(stylesheet);
  assert.equal((await get(stylesheet)).status, 200, `Stylesheet ${stylesheet}`);
  assert.match(await (await get('/blog/')).text(), /href="\/blog\/manufacturing-guide\/"/);
  assert(
    (await (await get('/blog/sitemap.xml')).text()).includes(
      `<loc>${siteOrigin}/blog/manufacturing-guide/</loc>`,
    ),
  );
  const updated = await repo.save({
    actorId: 'admin',
    articleId: draft.id,
    expectedRevision: currentRevision,
    content: { ...content, title: 'Updated guidance' },
  });
  assert(updated);
  assert(!(await (await get('/blog/manufacturing-guide/')).text()).includes('Updated guidance'));
  await repo.releases.request('admin', {
    operation: 'publish',
    articleId: draft.id,
    expectedRevision: updated.revision,
    requestId: 'update',
  });
  assert.match(await (await get('/blog/manufacturing-guide/')).text(), /Updated guidance/);
  await repo.releases.request('admin', {
    operation: 'withdraw',
    articleId: draft.id,
    expectedRevision: updated.revision,
    requestId: 'withdraw',
  });
  const missing = await get('/blog/manufacturing-guide/');
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /data-not-found-page/);
  assert(!(await (await get('/blog/sitemap.xml')).text()).includes('manufacturing-guide'));
  offline = true;
  const failed = await get('/blog/manufacturing-guide/');
  assert.equal(failed.status, 503);
  assert.equal(failed.headers.get('retry-after'), '30');
  assert.match(await failed.text(), /temporarily unavailable/);
  assert.equal((await get('/blog/sitemap.xml')).status, 503);
});
