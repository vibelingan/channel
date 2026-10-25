import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { parseArticleDraft } from '../../packages/articles/src/draft-repository.ts';
import { ArticleReleaseViewSchema } from '../../packages/articles/src/release.ts';
import { signInAdminThroughUi } from './helpers/ui-admin-login.ts';

const operation = process.env.E2E_BLOG_PUBLICATION_OPERATION;
const serverDelivery = process.env.E2E_BLOG_DELIVERY_MODE === 'server';
const title = 'Preparing an OEM headphone project brief';
const body =
  'Before requesting a quotation, describe the intended use, target quantity, preferred connection type, packaging requirements and delivery destination. Include any reference samples and the certifications required by your market. Confirm which details are essential and which can change after a sample review.';
test.skip(!operation, 'Explicit owned-article live acceptance only.');
test.use({ viewport: { width: 1440, height: 1100 } });
test.beforeAll(() => {
  if (
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.E2E_SITE_URL !== 'https://supplychainsai.com' ||
    process.env.E2E_API_URL !== 'https://diversity-123-d9grnqfux221323bb.service.tcloudbase.com' ||
    !['create', 'retry', 'update', 'withdraw', 'check'].includes(operation ?? '') ||
    !/^\d+$/.test(process.env.GITHUB_RUN_ID ?? '')
  )
    throw Error('Unapproved publication acceptance');
});
test('the real public admin requests publication only for its owned acceptance article', async ({
  page,
}) => {
  test.setTimeout(180000);
  await signInAdminThroughUi(
    page,
    process.env.E2E_ADMIN_EMAIL ?? '',
    process.env.E2E_ADMIN_PASSWORD ?? '',
  );
  await expect(page.getByRole('button', { name: 'Products', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Alibaba Sync', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Articles', exact: true }).click();
  let articleId = process.env.E2E_BLOG_ARTICLE_ID ?? '';
  if (operation === 'create') {
    expect(articleId).toBe('');
    await page.getByRole('button', { name: 'New article', exact: true }).click();
    await page.getByLabel('Title', { exact: true }).fill(title);
    await page.getByRole('textbox', { name: 'Article body' }).fill(body);
    await page.getByText('Article details and search settings', { exact: true }).click();
    await page.getByLabel('authorName', { exact: true }).fill('Diversity Technology Limited');
    await page
      .getByLabel('slug', { exact: true })
      .fill(`oem-project-brief-acceptance-${process.env.GITHUB_RUN_ID}`);
    await page
      .getByLabel('excerpt', { exact: true })
      .fill(
        'A short checklist to prepare product requirements before requesting an OEM headphone quotation.',
      );
    await page.getByLabel('seoTitle', { exact: true }).fill(title);
    await page
      .getByLabel('seoDescription', { exact: true })
      .fill(
        'Prepare your intended use, quantities, connection type, packaging and destination before requesting an OEM headphone quotation.',
      );
    const createReply = page.waitForResponse(
      (r) =>
        r.url().endsWith('/api/admin') &&
        r.request().postDataJSON()?.action === 'articleDrafts' &&
        r.request().postDataJSON()?.data?.operation === 'create',
    );
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    const draft = parseArticleDraft((await (await createReply).json()).data);
    articleId = draft.id;
    await mkdir('output/blog-publication', { recursive: true });
    await writeFile(
      'output/blog-publication/started.json',
      JSON.stringify({ articleId, title, slug: draft.content.slug }, null, 2),
      { flag: 'wx' },
    );
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Image', exact: true }).click();
    await (await chooser).setFiles({
      name: 'factory-exterior.webp',
      mimeType: 'image/webp',
      buffer: await readFile('apps/site/public/media/factory-oem.webp'),
    });
    const image = page.locator('[data-article-image]');
    await expect(image.getByRole('img')).toHaveAttribute('src', /^blob:/, { timeout: 60000 });
    await image.getByLabel('Image description').fill('Factory exterior');
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await expect(page.getByText('Saved · revision 2', { exact: true })).toBeVisible();
  } else {
    expect(articleId).toMatch(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/);
    await page.getByLabel('Search titles', { exact: true }).fill(title);
    await page
      .locator(`tr[data-article-id="${articleId}"]`)
      .getByRole('button', { name: 'Edit', exact: true })
      .click();
    await page.getByText('Article details and search settings', { exact: true }).click();
  }
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue(title);
  await expect(page.getByLabel('slug', { exact: true })).toHaveValue(
    /^oem-project-brief-acceptance-\d+$/,
  );
  await expect(page.getByLabel('authorName', { exact: true })).toHaveValue(
    'Diversity Technology Limited',
  );
  const slug = await page.getByLabel('slug', { exact: true }).inputValue();
  if (operation === 'update')
    await page
      .getByRole('textbox', { name: 'Article body' })
      .locator('p')
      .first()
      .fill(
        `${body} Keep the final approved specification with your quotation so later revisions can be compared clearly.`,
      );
  let task = null;
  if (operation === 'create' || operation === 'update') {
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    const preview = page.getByRole('region', { name: 'Draft preview', exact: true });
    await expect(preview).toContainText(title);
    await expect(preview).toContainText('Before requesting a quotation');
    const privateImage = preview.getByRole('img', { name: 'Factory exterior', exact: true });
    await expect(privateImage).toHaveAttribute('src', /^blob:/);
    await expect
      .poll(() =>
        privateImage.evaluate(
          (image: HTMLImageElement) => image.complete && image.naturalWidth > 0,
        ),
      )
      .toBe(true);
    await page.screenshot({ path: 'output/blog-publication/admin-preview.png', fullPage: true });
    await page.getByRole('button', { name: 'Close preview', exact: true }).click();
  }
  if (operation !== 'check') {
    const command =
      operation === 'withdraw' ? 'withdraw' : operation === 'retry' ? 'retry' : 'publish';
    const reply = page.waitForResponse(
      (r) =>
        r.url().endsWith('/api/admin') &&
        r.request().postDataJSON()?.action === 'articleReleases' &&
        r.request().postDataJSON()?.data?.operation === command,
    );
    if (operation === 'withdraw') {
      page.once('dialog', (dialog) => dialog.accept());
      await page.getByRole('button', { name: 'Withdraw article', exact: true }).click();
    } else if (operation === 'retry')
      await page.getByRole('button', { name: /^Retry revision \d+$/ }).click();
    else
      await page
        .getByRole('button', {
          name: operation === 'update' ? 'Save and publish update' : 'Save and publish',
          exact: true,
        })
        .click();
    const response = await reply;
    expect(response.status()).toBe(200);
    const result = await response.json();
    expect(result.ok).toBe(true);
    task = ArticleReleaseViewSchema.parse(result.data.task);
    expect(task.articleId).toBe(articleId);
    expect(task.state).toBe(serverDelivery ? 'SUCCEEDED' : 'QUEUED');
    await expect(page.getByRole('region', { name: 'Publication', exact: true })).toContainText(
      serverDelivery
        ? operation === 'withdraw'
          ? 'Article withdrawn'
          : `Published · revision ${task.revision}`
        : 'Waiting to publish',
    );
  }
  await mkdir('output/blog-publication', { recursive: true });
  if (serverDelivery) {
    const publicPage = await page.context().newPage();
    try {
      const reply = await publicPage.goto(`/blog/${slug}/`);
      expect(reply?.status()).toBe(operation === 'withdraw' ? 404 : 200);
      if (operation !== 'withdraw') {
        await expect(publicPage.getByRole('heading', { name: title, exact: true })).toBeVisible();
        const image = publicPage.getByRole('img', { name: 'Factory exterior', exact: true });
        await expect(image).toBeVisible();
        expect(
          await image.evaluate(
            (element: HTMLImageElement) => element.complete && element.naturalWidth > 0,
          ),
        ).toBe(true);
        if (operation === 'update')
          await expect(publicPage.locator('main')).toContainText(
            'Keep the final approved specification',
          );
      }
      await publicPage.screenshot({
        path: 'output/blog-publication/public-desktop.png',
        fullPage: true,
      });
      await publicPage.setViewportSize({ width: 390, height: 844 });
      expect(
        await publicPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      ).toBe(true);
      await publicPage.screenshot({
        path: 'output/blog-publication/public-mobile.png',
        fullPage: true,
      });
      await publicPage.goto('/blog/');
      const link = publicPage.locator(`main a[href="/blog/${slug}/"]`);
      if (operation === 'withdraw') await expect(link).toHaveCount(0);
      else await expect(link.first()).toBeVisible();
    } finally {
      await publicPage.close();
    }
  }
  await page.screenshot({ path: 'output/blog-publication/admin-desktop.png', fullPage: true });
  await writeFile(
    'output/blog-publication/request.json',
    JSON.stringify(
      {
        operation,
        articleId,
        slug,
        title,
        task,
        imageSha256: createHash('sha256')
          .update(await readFile('apps/site/public/media/factory-oem.webp'))
          .digest('hex'),
      },
      null,
      2,
    ),
    { flag: 'wx' },
  );
});
