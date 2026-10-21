import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { build } from 'vite';

const root = fileURLToPath(new URL('../../../../../../', import.meta.url));
const origin = 'https://supplychainsai.com';
const api = 'https://diversity-123-d9grnqfux221323bb.service.tcloudbase.com';
test(
  'operator sees exact failed photo, retries only its source product, retains failure remedy and opens that product',
  { timeout: 30000 },
  async (t) => {
    const cache = join(root, 'apps/site/node_modules/.cache');
    await mkdir(cache, { recursive: true });
    const dir = await mkdtemp(join(cache, 'photo-issues-browser-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    await writeFile(
      join(dir, 'entry.tsx'),
      `import{createElement}from'react';import{createRoot}from'react-dom/client';import{AlibabaPhotoIssues}from'${root}/apps/site/src/islands/admin/alibaba-catalog-sync/AlibabaPhotoIssues.tsx';createRoot(document.getElementById('root')).render(createElement(AlibabaPhotoIssues,{onOpenProduct:id=>{document.getElementById('opened').textContent=id;}}));`,
    );
    await build({
      configFile: false,
      root: dir,
      logLevel: 'silent',
      esbuild: { jsx: 'automatic' },
      define: {
        'import.meta.env.PUBLIC_API_BASE_URL': JSON.stringify(api),
        'process.env.NODE_ENV': JSON.stringify('production'),
      },
      build: {
        outDir: join(dir, 'dist'),
        lib: { entry: join(dir, 'entry.tsx'), formats: ['es'], fileName: () => 'app.js' },
      },
    });
    const script = await readFile(join(dir, 'dist/app.js'), 'utf8');
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext();
    t.after(() => context.close());
    await context.addInitScript(() => {
      localStorage.setItem('channel.token', 'local-ui-test-token');
      localStorage.setItem(
        'channel.user',
        JSON.stringify({ id: 'admin', role: 'admin', status: 'active', username: 'Admin' }),
      );
    });
    const actions: { action: string; data: Record<string, unknown> }[] = [];
    const issue = {
      productId: 'p1',
      name: 'Actual operator photo example',
      sourceProductId: 'Source-1',
      photos: [
        {
          part: 'configurations',
          position: 205,
          sourceUrl: 'https://sc04.alicdn.com/kf/example.jpg',
          reason: 'not-found',
        },
      ],
      truncated: false,
    };
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === origin)
        return route.fulfill({
          body: url.pathname.endsWith('.js')
            ? script
            : '<html><div id="root"></div><p id="opened"></p><script type="module" src="/app.js"></script></html>',
          contentType: url.pathname.endsWith('.js') ? 'text/javascript' : 'text/html',
        });
      assert.equal(url.origin, api);
      const body = route.request().postDataJSON();
      actions.push(body);
      let data: unknown;
      if (body.action === 'photoPreparationStatus') {
        assert.equal(body.data.includeIssues, true);
        data = { hiddenDrafts: 0, draftsToFill: 0, draftsMissingPhotos: 1, issues: [issue] };
      } else if (body.action === 'syncProduct') {
        assert.equal(body.data.sourceProductId, 'Source-1');
        data = {
          ok: true,
          sourceProductId: 'Source-1',
          sourceKey: 'a'.repeat(64),
          productId: 'p1',
          draftCreated: false,
          offerCount: 1,
        };
      } else if (body.action === 'prepareAlibabaPhotos') {
        assert.equal(body.data.productId, 'p1');
        assert.equal(body.data.retryUnavailable, true);
        data = {
          afterProductId: '',
          nextProductId: 'p1',
          done: true,
          visited: 1,
          prepared: 1,
          photosCopied: 0,
          photosReused: 0,
          photosFailed: 1,
          busy: 0,
          waiting: 0,
          failures: [],
          retryFailedBefore: new Date().toISOString(),
        };
      } else throw Error(`Unexpected action ${body.action}`);
      return route.fulfill({
        json: { ok: true, data },
        headers: { 'access-control-allow-origin': origin },
      });
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(origin);
    await expect(page.getByText('Actual operator photo example', { exact: true })).toBeVisible();
    await expect(page.getByText(/Variant image 205:/)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open source image' })).toHaveAttribute(
      'href',
      issue.photos[0]?.sourceUrl ?? '',
    );
    await page.getByRole('button', { name: 'Retry this product', exact: true }).click();
    await expect(page.getByText(/Some images are still unavailable/)).toBeVisible();
    assert.equal(actions.filter((x) => x.action === 'syncProduct').length, 1);
    assert.equal(actions.filter((x) => x.action === 'prepareAlibabaPhotos').length, 1);
    await page.getByRole('button', { name: 'Open product', exact: true }).click();
    await expect(page.locator('#opened')).toHaveText('p1');
    assert.deepEqual(errors, []);
  },
);
