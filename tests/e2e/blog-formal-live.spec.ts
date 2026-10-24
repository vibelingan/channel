import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { parseArticleDraft } from '../../packages/articles/src/draft-repository.ts';
import { signInAdminThroughUi } from './helpers/ui-admin-login.ts';

test.describe.configure({ mode: 'serial' });
test.use({
  viewport: { width: 1440, height: 1100 },
  ignoreHTTPSErrors: process.env.E2E_BLOG_FORMAL_PREVIEW === '1',
  launchOptions: {
    args:
      process.env.E2E_BLOG_FORMAL_PREVIEW === '1'
        ? ['--host-resolver-rules=MAP supplychainsai.com 127.0.0.1']
        : [],
  },
});
test.skip(process.env.E2E_BLOG_FORMAL_LIVE !== '1', 'Explicit formal CloudBase acceptance only.');
test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus) {
    await mkdir('output/blog-bootstrap', { recursive: true });
    await writeFile(
      'output/blog-bootstrap/browser-failure.json',
      JSON.stringify(
        {
          path: new URL(page.url()).pathname,
          role: await page.evaluate(() => {
            try {
              return JSON.parse(localStorage.getItem('channel.user') ?? 'null')?.role ?? null;
            } catch {
              return null;
            }
          }),
          viewport: page.viewportSize(),
          headings: await page.getByRole('heading').allTextContents(),
        },
        null,
        2,
      ),
    );
    await page.screenshot({ path: 'output/blog-bootstrap/browser-failure.png', fullPage: true });
  }
});
test.beforeAll(() => {
  if (
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.E2E_SITE_URL !== 'https://supplychainsai.com' ||
    process.env.E2E_API_URL !== 'https://diversity-123-d9grnqfux221323bb.service.tcloudbase.com'
  )
    throw Error('Unapproved live target');
});

test('real administrator saves, uploads, previews, reopens and resolves a concurrent edit against formal CloudBase', async ({
  page,
  context,
}) => {
  test.setTimeout(180000);
  const title = `Private Blog acceptance ${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`;
  const body = 'Private acceptance text saved by the real article editor.';
  const finalBody = 'Updated private article after a real concurrent-edit check.';
  await signInAdminThroughUi(
    page,
    process.env.E2E_ADMIN_EMAIL ?? '',
    process.env.E2E_ADMIN_PASSWORD ?? '',
  );
  if (process.env.PUBLIC_BLOG_WORKSPACE !== '1')
    await page.getByRole('button', { name: 'Articles', exact: true }).click();
  await expect(page.getByRole('button', { name: 'New article', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'New article', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill(title);
  await page.getByRole('textbox', { name: 'Article body' }).fill(body);
  const response = page.waitForResponse(
    (r) =>
      r.url().endsWith('/api/admin') &&
      r.request().postDataJSON()?.action === 'articleDrafts' &&
      r.request().postDataJSON()?.data?.operation === 'create',
  );
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  const created = parseArticleDraft((await (await response).json()).data);
  await expect(page.getByText('Saved · revision 1', { exact: true })).toBeVisible();
  const photo = await readFile('apps/site/public/media/factory-oem.webp');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Image', exact: true }).click();
  await (await chooser).setFiles({
    name: 'acceptance-factory.webp',
    mimeType: 'image/webp',
    buffer: photo,
  });
  const figure = page.locator('[data-article-image]');
  await expect(figure.getByRole('img')).toBeVisible({ timeout: 60000 });
  await expect(figure.getByRole('img')).toHaveAttribute('src', /^blob:/);
  await figure.getByLabel('Image description').fill('Factory building');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByText('Saved · revision 2', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(
    page
      .getByRole('region', { name: 'Draft preview' })
      .getByRole('img', { name: 'Factory building' }),
  ).toHaveAttribute('src', /^blob:/);
  await page.getByRole('button', { name: 'Close preview', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Articles', exact: true }).click();
  await page
    .getByRole('row')
    .filter({ hasText: title })
    .getByRole('button', { name: 'Edit', exact: true })
    .click();
  await expect(figure.getByRole('img')).toBeVisible();
  const other = await context.newPage();
  await other.goto('/admin');
  await other.getByRole('button', { name: 'Articles', exact: true }).click();
  await other
    .getByRole('row')
    .filter({ hasText: title })
    .getByRole('button', { name: 'Edit', exact: true })
    .click();
  await page.getByRole('textbox', { name: 'Article body' }).click();
  // Change the paragraph without removing the saved image.
  await page.getByRole('textbox', { name: 'Article body' }).locator('p').first().fill(finalBody);
  await other
    .getByRole('textbox', { name: 'Article body' })
    .locator('p')
    .first()
    .fill('Concurrent unsaved private text');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByText('Saved · revision 3', { exact: true })).toBeVisible();
  await other.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(other.getByRole('alert')).toContainText('revision 3');
  await expect(other.getByRole('textbox', { name: 'Article body' })).toContainText(
    'Concurrent unsaved private text',
  );
  other.on('dialog', (d) => d.accept());
  await other.close();
  const anonymous = await page.request.post(`${process.env.E2E_API_URL}/api/admin`, {
    data: { action: 'articleDrafts', data: { operation: 'get', articleId: created.id } },
  });
  expect(anonymous.status()).toBe(401);
  await mkdir('output/blog-bootstrap', { recursive: true });
  await writeFile(
    'output/blog-bootstrap/ui-proof.json',
    JSON.stringify(
      {
        articleId: created.id,
        title,
        revision: 3,
        text: finalBody,
        imageSha256: createHash('sha256').update(photo).digest('hex'),
      },
      null,
      2,
    ),
    { flag: 'wx' },
  );
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.screenshot({ path: 'output/blog-bootstrap/editor-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'output/blog-bootstrap/editor-mobile.png', fullPage: true });
});
