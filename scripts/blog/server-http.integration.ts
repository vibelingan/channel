/** Real built Astro server + existing API handler + installed CloudBase SDK with offline transport.
 * This checks HTTP integration; it is deliberately NOT labelled live CloudBase acceptance. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { handlePublicApiEvent } from '../../apps/functions/public-api/src/http-adapter.ts';
import {
  factoryVideoAsset,
  factoryVideoRangePath,
} from '../../apps/site/src/lib/seo/factory-video.ts';
import { parseArticleContent } from '../../packages/articles/src/article.ts';
import { createCloudBasePublicArticles } from '../../packages/db/src/article-public-reader.ts';
import {
  articleTransaction,
  createCloudBaseArticleRepository,
} from '../../packages/db/src/article-repository.ts';
import { articleSdkFixture } from '../../packages/db/src/article-sdk-fixture.test-helper.ts';
import {
  registerArticleResponsiveMedia,
  registerArticleWebMedia,
} from '../../packages/db/src/article-web-media.ts';
import {
  type StoredMediaObject,
  objectStoragePath,
} from '../../packages/media-storage/src/index.ts';
import { prepareArticleWebMedia } from '../images/article-web-media.ts';

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
  await access(new URL('../../apps/site/dist-blog/server/entry.mjs', import.meta.url));
  const f = articleSdkFixture(t);
  const repo = createCloudBaseArticleRepository(f.db, { mode: 'server' });
  const imageBytes = await readFile(
    new URL('../../apps/site/public/media/factory-oem.webp', import.meta.url),
  );
  const imageHash = createHash('sha256').update(imageBytes).digest('hex');
  const imageId = 'real-http-image';
  const imageTarget = {
    storageFileId: 'cloud://offline/articles/real-http-image',
    storagePath: 'articles/real-http-image',
  };
  const imageObjects = new Map([[imageTarget.storageFileId, imageBytes]]);
  const articles = createCloudBasePublicArticles(f.db, {
    getObjectAsBase64: async (fileId) => {
      const bytes = imageObjects.get(fileId);
      assert(bytes, 'The requested image object must actually exist');
      return { body: bytes.toString('base64') };
    },
  });
  let offline = false;
  let oldApi = false;
  let serverOrigin = '';
  let mediaProxyRequests = 0;
  const api = createServer(async (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://gateway.test').pathname;
    // Mirror the production gateway: Blog goes to Node; existing root assets
    // remain on static hosting. Never duplicate the full media tree in the service.
    if (pathname === '/blog' || pathname.startsWith('/blog/')) {
      if (pathname.startsWith('/blog/media/articles/')) mediaProxyRequests++;
      // Node's fetch ignores a custom Host. Use an actual HTTP proxy request so
      // the integration checks the wire authority rather than a forged JS URL.
      const upstream = httpRequest(
        `${serverOrigin}${req.url}`,
        {
          headers: { host: new URL(process.env.SITE_URL || 'http://localhost:4321').host },
        },
        (response) => {
          res.writeHead(response.statusCode ?? 502, response.headers);
          response.once('error', () => res.destroy());
          response.pipe(res);
        },
      );
      upstream.setTimeout(15000, () => upstream.destroy(Error('Blog fixture proxy timed out')));
      upstream.once('error', () => {
        if (!res.headersSent) res.writeHead(502).end();
        else res.destroy();
      });
      upstream.end();
      return;
    }
    if (
      pathname === '/media/logo-channel.svg' ||
      pathname === '/media/logo-diversity.svg' ||
      pathname === '/favicon.svg'
    ) {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      res.end(await readFile(new URL(`../../apps/site/public${pathname}`, import.meta.url)));
      return;
    }
    if (pathname !== '/api' && !pathname.startsWith('/api/')) {
      res.writeHead(404).end('Not found');
      return;
    }
    if (offline) {
      res.writeHead(503).end();
      return;
    }
    const result = await handlePublicApiEvent(
      {
        httpMethod: req.method,
        path: oldApi ? req.url?.replace('&responsive=1', '') : req.url,
        headers: {},
      },
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
      BLOG_WEB_IMAGES_ENABLED: '1',
      BLOG_RESPONSIVE_ARTICLE: content.slug,
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
  const videoUrl = `${serverOrigin}${factoryVideoRangePath}`;
  const videoRange = await fetch(videoUrl, { headers: { Range: 'bytes=3500000-3501023' } });
  assert.equal(videoRange.status, 206);
  assert.equal(videoRange.headers.get('content-type'), 'video/mp4');
  assert.equal(
    videoRange.headers.get('content-range'),
    `bytes 3500000-3501023/${factoryVideoAsset.bytes}`,
  );
  const expectedVideo = await readFile(
    new URL(`../../apps/site/public${factoryVideoAsset.source}`, import.meta.url),
  );
  assert.deepEqual(
    Buffer.from(await videoRange.arrayBuffer()),
    expectedVideo.subarray(3500000, 3501024),
  );
  const invalidRange = await fetch(videoUrl, {
    headers: { Range: `bytes=${factoryVideoAsset.bytes}-` },
  });
  assert.equal(invalidRange.status, 416);
  assert.equal(invalidRange.headers.get('content-range'), `bytes */${factoryVideoAsset.bytes}`);
  await invalidRange.arrayBuffer();
  const get = (path: string) => fetch(`${origin}${path}`, { redirect: 'error' });
  // Opening the formal host must never open the provider's default address.
  for (const headers of [
    new Headers(),
    new Headers({ 'x-forwarded-host': 'supplychainsai.com' }),
  ]) {
    const temporary = await fetch(`${serverOrigin}/blog/`, { headers });
    assert.equal(temporary.headers.get('x-robots-tag'), 'noindex,nofollow');
    await temporary.arrayBuffer();
  }
  const temporaryRedirect = await fetch(`${serverOrigin}/blog/without-slash`, {
    redirect: 'manual',
  });
  assert.equal(temporaryRedirect.status, 308);
  assert.equal(temporaryRedirect.headers.get('location'), '/blog/without-slash/');
  assert.equal(temporaryRedirect.headers.get('x-robots-tag'), 'noindex,nofollow');
  await temporaryRedirect.arrayBuffer();
  const draft = await repo.create({
    actorId: 'admin',
    requestId: 'create',
    content: parseArticleContent({
      ...content,
      body: {
        schemaVersion: 1,
        document: {
          type: 'doc',
          content: [
            {
              type: 'articleImage',
              attrs: { mediaId: imageId, alt: 'Factory HTTP image', caption: '' },
            },
            ...content.body.document.content,
          ],
        },
      },
    }),
  });
  const activeImage = {
    id: imageId,
    articleId: draft.id,
    purpose: 'article-image',
    requestHash: 'a'.repeat(64),
    createdBy: 'admin',
    createdAt: draft.createdAt,
    expiresAt: new Date(Date.now() + 300000).toISOString(),
    pendingStorage: imageTarget,
    storage: imageTarget,
    status: 'active' as const,
    fileName: 'factory.webp',
    mimeType: 'image/webp' as const,
    byteSize: imageBytes.length,
    checksumSha256: imageHash,
    width: 1228,
    height: 718,
  };
  f.put('articleMedia', imageId, activeImage);
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
  const formalRedirect = await fetch(`${origin}/blog/manufacturing-guide?utm_source=review`, {
    redirect: 'manual',
  });
  assert.equal(formalRedirect.status, 308);
  assert.equal(
    formalRedirect.headers.get('location'),
    '/blog/manufacturing-guide/?utm_source=review',
  );
  await formalRedirect.arrayBuffer();
  assert.equal(response.status, 200, output);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('server-timing') ?? '', /article-read;dur=\d+(?:\.\d+)?/);
  assert.match(response.headers.get('server-timing') ?? '', /blog-handler;dur=\d+(?:\.\d+)?/);
  const previewOnly = process.env.BLOG_PREVIEW_ONLY !== '0';
  assert.equal(response.headers.get('x-robots-tag'), previewOnly ? 'noindex,nofollow' : null);
  const health = await (await get('/blog/health.json')).json();
  const siteOrigin = process.env.SITE_URL || 'http://localhost:4321';
  assert(health !== null && typeof health === 'object');
  assert.equal(Reflect.get(health, 'siteOrigin'), siteOrigin);
  assert.equal(Reflect.get(health, 'previewOnly'), previewOnly);
  const mediaDelivery = process.env.BLOG_MEDIA_DELIVERY ?? 'proxy';
  assert.equal(Reflect.get(health, 'mediaDelivery'), mediaDelivery);
  assert.deepEqual(Reflect.get(health, 'indexing'), {
    enabled: !previewOnly,
    canonicalHost: true,
    allowed: !previewOnly,
  });
  assert.match(String(Reflect.get(health, 'releaseId')), /^(?:[a-f0-9]{40}|local)$/);
  assert.equal(response.headers.get('x-channel-blog-version'), Reflect.get(health, 'releaseId'));
  const html = await response.text();
  const originalImagePath = renderedArticleImagePath(html);
  const originalProxyBefore = mediaProxyRequests;
  const imageResponse = await get(originalImagePath);
  assert.equal(
    imageResponse.status,
    200,
    `The original image URL emitted by HTML must work: ${originalImagePath}`,
  );
  assert.equal(imageResponse.headers.get('content-type'), 'image/webp');
  assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), imageBytes);
  assert.equal(mediaProxyRequests - originalProxyBefore, mediaDelivery === 'api' ? 0 : 1);
  assert.equal(
    (await get(`/blog/media/articles/${imageId}/${imageHash}.webp`)).status,
    200,
    'Previously emitted original proxy URLs stay readable in both modes',
  );
  assertArticleSchemaImage(html, originalImagePath);
  t.diagnostic(JSON.stringify({ mode: 'original', renderedSrc: originalImagePath, status: 200 }));
  assert.equal(
    (await get(`/media/articles/${imageId}/${imageHash}.webp`)).status,
    404,
    'Root media paths belong to static hosting, not the article API',
  );
  const header = /<header\b[^>]*data-site-header[\s\S]*?<\/header>/.exec(html)?.[0];
  assert(header?.includes('href="/blog/"'), 'SSR header must expose the public Blog navigation');
  assert.match(html, /A clear manufacturing brief helps suppliers/);
  assert.match(html, /<h1[^>]*>Manufacturing guide<\/h1>/);
  assert(html.includes(`rel="canonical" href="${siteOrigin}/blog/manufacturing-guide/"`));
  assert.match(html, /"@type":"Article"/);
  assert.match(html, /datePublished/);
  assert.match(html, /index,follow/);
  const acceptedBeforePreparation = structuredClone(f.rows.get(`articleAccepted/${draft.id}`));
  const checkpoints: StoredMediaObject[] = [];
  const prepare: Parameters<typeof prepareArticleWebMedia>[0] = {
    active: activeImage,
    storage: {
      async getObjectAsBase64(id) {
        const bytes = imageObjects.get(id);
        assert(bytes);
        return { body: bytes.toString('base64') };
      },
      async putObject(input, options) {
        assert(input.content instanceof Uint8Array);
        assert(options?.beforeWrite);
        const storagePath = objectStoragePath(input);
        const target: StoredMediaObject = {
          storageProvider: 'cloudbase-storage',
          storageMode: 'classic-nosql-storage',
          storagePath,
          storageFileId: `cloud://offline/${storagePath}`,
          byteSize: input.content.length,
        };
        await options.beforeWrite(target);
        imageObjects.set(target.storageFileId, Buffer.from(input.content));
        return target;
      },
    },
    checkpoint: async (target) => {
      checkpoints.push({ ...target });
    },
    register: (entry) => registerArticleWebMedia(articleTransaction(f.db), entry),
  };
  const prepared = await prepareArticleWebMedia(prepare);
  assert.equal(checkpoints.length, 1);
  assert.deepEqual(f.rows.get(`articleAccepted/${draft.id}`), acceptedBeforePreparation);
  const rendered = await get('/blog/manufacturing-guide/');
  assert.equal(rendered.status, 200);
  assert.equal(rendered.headers.get('x-article-presentation'), 'render-web-v1');
  const renderedHtml = await rendered.text();
  const webPath = renderedArticleImagePath(renderedHtml);
  assert.match(renderedHtml, /alt="Factory HTTP image"/);
  assert(!renderedHtml.includes('storageFileId'));
  const webProxyBefore = mediaProxyRequests;
  const webResponse = await get(webPath);
  assert.equal(webResponse.status, 200, `The web image URL emitted by HTML must work: ${webPath}`);
  assert.equal(webResponse.headers.get('content-type'), 'image/webp');
  assert.equal(
    createHash('sha256')
      .update(Buffer.from(await webResponse.arrayBuffer()))
      .digest('hex'),
    prepared.entry.web.checksumSha256,
  );
  assert.equal(mediaProxyRequests - webProxyBefore, mediaDelivery === 'api' ? 0 : 1);
  const compatibleProxy = `/blog/media/articles/${imageId}/web-v1-${prepared.entry.web.checksumSha256}.webp`;
  const proxyImage = await get(compatibleProxy);
  assert.equal(proxyImage.status, 200, 'Old web image proxy URLs stay compatible');
  const proxyTiming = proxyImage.headers.get('server-timing') ?? '';
  for (const metric of [
    'am-ref1',
    'am-storage',
    'am-ref2',
    'blog-image-headers',
    'blog-image-body',
  ]) {
    assert.match(proxyTiming, new RegExp(`\\b${metric};dur=\\d+\\.\\d`));
  }
  assertArticleSchemaImage(renderedHtml, webPath);
  t.diagnostic(JSON.stringify({ mode: 'web-v1', renderedSrc: webPath, status: 200 }));
  assert.equal(
    (await get(`/media/articles/${imageId}/web-v1-${prepared.entry.web.checksumSha256}.webp`))
      .status,
    404,
    'A logical backend media path must not be mistaken for a website image URL',
  );
  const prepareMobile = {
    ...prepare,
    mobileWithStandard: prepared.entry,
    register: (entry: typeof prepared.entry) =>
      registerArticleResponsiveMedia(articleTransaction(f.db), entry),
  };
  const mobile = await prepareArticleWebMedia(prepareMobile);
  assert.equal(mobile.entry.web.width, 768);
  assert(mobile.entry.web.byteSize < prepared.entry.web.byteSize);
  assert.equal(checkpoints.length, 2);
  assert.equal(
    (await prepareArticleWebMedia({ ...prepareMobile, existing: mobile.entry })).objectWrites,
    0,
  );
  assert.equal(checkpoints.length, 2);
  assert.deepEqual(f.rows.get(`articleAccepted/${draft.id}`), acceptedBeforePreparation);
  const responsive = await get('/blog/manufacturing-guide/');
  assert.equal(responsive.headers.get('x-article-presentation'), 'render-web-v2');
  const responsiveHtml = await responsive.text();
  const mobilePath = webPath.replace(
    /web-v1-[a-f0-9]+\.webp$/,
    `web-v2-${mobile.entry.web.checksumSha256}.webp`,
  );
  assert.match(responsiveHtml, /alt="Factory HTTP image"/);
  assert.equal(renderedArticleImagePath(responsiveHtml), webPath);
  assert(responsiveHtml.includes(`srcset="${mobilePath} 768w, ${webPath} 1228w"`));
  assertArticleSchemaImage(responsiveHtml, webPath);
  const mobileResponse = await get(mobilePath);
  assert.equal(mobileResponse.status, 200);
  assert.equal(mobileResponse.headers.get('content-type'), 'image/webp');
  assert.equal(
    createHash('sha256')
      .update(Buffer.from(await mobileResponse.arrayBuffer()))
      .digest('hex'),
    mobile.entry.web.checksumSha256,
  );
  oldApi = true;
  const fallback = await get('/blog/manufacturing-guide/');
  assert.equal(fallback.headers.get('x-article-presentation'), 'render-web-v1');
  assert(!(await fallback.text()).includes('web-v2-'));
  oldApi = false;
  if (process.env.BLOG_SSR_BROWSER === '1') {
    const { chromium } = await import('@playwright/test');
    const browser = await chromium.launch({
      headless: true,
      ignoreDefaultArgs: ['--disable-back-forward-cache'],
    });
    try {
      const evidence = new URL('../../output/blog-server-http/', import.meta.url);
      await mkdir(evidence, { recursive: true });
      for (const [width, expectedPath] of [
        [390, mobilePath],
        [1440, webPath],
      ] as const) {
        const check = await browser.newPage({
          viewport: { width, height: 844 },
          deviceScaleFactor: 2,
        });
        try {
          const requests: string[] = [];
          check.on('request', (req) => {
            const path = new URL(req.url()).pathname;
            if (path === webPath || path === mobilePath) requests.push(path);
          });
          await check.goto(`${origin}/blog/manufacturing-guide/`);
          const hero = check.locator('[data-blog-article] img[fetchpriority=high]');
          assert.equal(
            await hero.evaluate(async (img) => {
              if (!(img instanceof HTMLImageElement)) throw Error('No first article image');
              await img.decode();
              return new URL(img.currentSrc).pathname;
            }),
            expectedPath,
          );
          assert.deepEqual(requests, [expectedPath]);
          await hero.screenshot({
            path: new URL(`article-responsive-${width}.png`, evidence).pathname,
          });
        } finally {
          await check.close();
        }
      }
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
  assert.equal(
    (await get(webPath)).status,
    404,
    'Removing the published image must revoke its web copy',
  );
  assert.equal(
    (await get(mobilePath)).status,
    404,
    'Removing the published image also revokes its 768px URL',
  );
  const revokedProxy = await get(compatibleProxy);
  assert.equal(revokedProxy.status, 404, 'Old URLs retain the same withdrawal gate');
  assert.doesNotMatch(revokedProxy.headers.get('server-timing') ?? '', /am-|blog-image-/);
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
  const failedImage = await get(compatibleProxy);
  assert.equal(failedImage.status, 503);
  assert.equal(failedImage.headers.get('retry-after'), '30');
  assert.doesNotMatch(failedImage.headers.get('server-timing') ?? '', /am-|blog-image-/);
  assert.equal((await get('/blog/sitemap.xml')).status, 503);
});

function renderedArticleImagePath(html: string): string {
  const article = /<article\b[^>]*data-blog-article[\s\S]*?<\/article>/.exec(html)?.[0];
  assert(article, 'The article body must exist before checking its real image URL');
  const source = /<img\b[^>]*\ssrc="([^"]+)"/.exec(article)?.[1];
  assert(source, 'An actual article image src must be present in the rendered HTML');
  const origin = process.env.SITE_URL || 'http://localhost:4321';
  const url = new URL(source, origin);
  assert.equal(url.origin, new URL(origin).origin);
  assert(
    url.pathname.startsWith(
      process.env.BLOG_MEDIA_DELIVERY === 'api' ? '/api/articles/media/' : '/blog/media/articles/',
    ),
    'HTML must use the explicitly selected public media route',
  );
  return `${url.pathname}${url.search}`;
}

function assertArticleSchemaImage(html: string, imagePath: string) {
  const script = /<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/.exec(
    html,
  )?.[1];
  assert(script, 'The rendered article must include structured data');
  const schema: unknown = JSON.parse(script);
  assert(schema && typeof schema === 'object');
  const graph: unknown = Reflect.get(schema, '@graph');
  assert(Array.isArray(graph));
  const article: unknown = graph.find(
    (node) => node && typeof node === 'object' && Reflect.get(node, '@type') === 'Article',
  );
  assert(article && typeof article === 'object');
  assert.deepEqual(Reflect.get(article, 'image'), [
    new URL(imagePath, process.env.SITE_URL || 'http://localhost:4321').href,
  ]);
}
