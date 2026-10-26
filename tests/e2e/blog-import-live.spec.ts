import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { appendArticleParagraph } from './helpers/article-editor-input.ts';
import { signInAdminThroughUi } from './helpers/ui-admin-login.ts';
const operation = process.env.E2E_IMPORT_OPERATION;
test.skip(!operation, 'Explicit owned Hermes draft acceptance only.');
test.use({ viewport: { width: 1440, height: 1100 } });
test('the exact imported draft supports human editing, preview and manual publication', async ({
  page,
}) => {
  test.setTimeout(180000);
  expect(process.env.GITHUB_ACTIONS).toBe('true');
  expect(process.env.E2E_SITE_URL).toBe('https://supplychainsai.com');
  expect(['review', 'publish', 'withdraw']).toContain(operation);
  const fixture = JSON.parse(await readFile('output/blog-import/fixture.json', 'utf8')) as {
    articleId: string;
    revision: number;
    title: string;
    slug: string;
    editUrl: string;
    marker: string;
    operation: string;
    originalHeading: string;
    repairHeading: string | null;
    resetHtml: string | null;
  };
  expect(fixture.operation).toBe(operation);
  expect(fixture.articleId).toMatch(/^article-[a-f0-9]{64}$/);
  expect(fixture.editUrl).toBe(
    `https://supplychainsai.com/admin/?section=articles&article=${fixture.articleId}`,
  );
  await page.goto(fixture.editUrl);
  await signInAdminThroughUi(
    page,
    process.env.E2E_ADMIN_EMAIL ?? '',
    process.env.E2E_ADMIN_PASSWORD ?? '',
  );
  await page.goto(fixture.editUrl);
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue(fixture.title);
  if (operation === 'review') {
    const editor = page.getByRole('textbox', { name: 'Article body' });
    if (fixture.resetHtml) {
      await editor.press('ControlOrMeta+A');
      await editor.evaluate((element, html) => {
        const clipboard = new DataTransfer();
        clipboard.setData('text/html', html);
        element.dispatchEvent(
          new ClipboardEvent('paste', {
            clipboardData: clipboard,
            bubbles: true,
            cancelable: true,
          }),
        );
      }, fixture.resetHtml);
    }
    await expect(editor.locator('h2').first()).toHaveText(fixture.originalHeading);
    await appendArticleParagraph(editor, fixture.marker);
    await expect(editor.locator('h2').first()).toHaveText(fixture.originalHeading);
    const saved = page.waitForResponse(
      (r) =>
        r.url().endsWith('/api/admin') &&
        r.request().postDataJSON()?.action === 'articleDrafts' &&
        r.request().postDataJSON()?.data?.operation === 'save',
    );
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    const response = await saved;
    expect(response.status()).toBe(200);
    expect((await response.json()).data.revision).toBe(fixture.revision + 1);
    await page.reload();
    await expect(page.getByRole('textbox', { name: 'Article body' })).toContainText(fixture.marker);
  }
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  const preview = page.getByRole('region', { name: 'Draft preview', exact: true });
  await expect(preview).toContainText(fixture.title);
  await expect(preview.locator('p').last()).toHaveText(fixture.marker);
  await expect(
    preview.getByRole('heading', { level: 2, name: fixture.originalHeading, exact: true }),
  ).toBeVisible();
  await mkdir('output/blog-import', { recursive: true });
  await page.screenshot({ path: 'output/blog-import/admin-preview.png', fullPage: true });
  await page.getByRole('button', { name: 'Close preview', exact: true }).click();
  if (operation !== 'review') {
    const response = page.waitForResponse(
      (r) =>
        r.url().endsWith('/api/admin') &&
        r.request().postDataJSON()?.action === 'articleReleases' &&
        r.request().postDataJSON()?.data?.operation ===
          (operation === 'publish' ? 'publish' : 'withdraw'),
    );
    if (operation === 'withdraw') {
      page.once('dialog', (d) => d.accept());
      await page.getByRole('button', { name: 'Withdraw article', exact: true }).click();
    } else await page.getByRole('button', { name: /^Save and publish(?: update)?$/ }).click();
    const result = await response;
    expect(result.status()).toBe(200);
    const value = await result.json();
    expect(value.ok).toBe(true);
    expect(value.data.task.state).toBe('SUCCEEDED');
    await writeFile(
      'output/blog-import/request.json',
      JSON.stringify({ articleId: fixture.articleId, operation, task: value.data.task }, null, 2),
      { flag: 'wx' },
    );
    if (operation === 'publish') {
      await page.goto(`https://supplychainsai.com/blog/${fixture.slug}/`);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(fixture.title);
      await expect(page.locator('article')).toContainText(fixture.marker);
      await page.screenshot({ path: 'output/blog-import/public-desktop.png', fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({ path: 'output/blog-import/public-mobile.png', fullPage: true });
    }
  }
});
