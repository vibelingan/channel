import { readFile } from 'node:fs/promises';
import { type Page, expect, test } from '@playwright/test';
import { appendArticleParagraph } from './helpers/article-editor-input.ts';
import { signInAdminThroughUi } from './helpers/ui-admin-login.ts';

const database = process.env.E2E_CATALOG_LOCAL_DB;
const site = process.env.E2E_SITE_URL;
// @skip-when No disposable local runner was requested; production mutation suites must not run this fixture lane.
test.skip(
  process.env.E2E_CATALOG_LOCAL_SEED !== '1',
  'Run with the disposable local articles runner.',
);
test.beforeAll(() => {
  if (!database) throw new Error('The opted-in local runner must provide its owned database.');
  if (!site || !['127.0.0.1', 'localhost'].includes(new URL(site).hostname))
    throw new Error('Local-only article acceptance requires an owned localhost site.');
});
// The disk-backed runner survives browser retries; each attempt owns distinct records.
function ownedLabel(value: string) {
  const { retry, repeatEachIndex } = test.info();
  return retry || repeatEachIndex ? `${value}--retry${retry}-repeat${repeatEachIndex}` : value;
}
async function login(page: Page) {
  await signInAdminThroughUi(page, 'admin@channel.local', 'admin');
  await page.getByRole('button', { name: 'Articles', exact: true }).click();
}
async function create(page: Page, title: string) {
  await page.getByRole('button', { name: 'New article', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill(ownedLabel(title));
  await page.getByRole('textbox', { name: 'Article body' }).fill('Acceptance body');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByText('Saved · revision 1', { exact: true })).toBeVisible();
}
async function open(page: Page, title: string) {
  await page
    .getByRole('row')
    .filter({ has: page.getByRole('cell', { name: ownedLabel(title), exact: true }) })
    .getByRole('button', { name: 'Edit', exact: true })
    .click();
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue(ownedLabel(title));
}

test('real editor saves formatted content to disk, previews, reopens and survives refresh', async ({
  page,
}) => {
  await login(page);
  await create(page, 'Blog local persistence');
  await page.getByRole('textbox', { name: 'Article body' }).press('ControlOrMeta+End');
  await page.getByRole('button', { name: 'Bold', exact: true }).click();
  await page.getByRole('textbox', { name: 'Article body' }).pressSequentially(' strong text');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByText('Saved · revision 2', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Draft preview' }).locator('strong')).toHaveText(
    ' strong text',
  );
  const store = JSON.parse(await readFile(database ?? '', 'utf8'));
  expect(JSON.stringify(store.articleDrafts)).toContain('strong text');
  expect(
    store.articleDrafts.find(
      (row: { draft: { content: { title: string } } }) =>
        row.draft.content.title === ownedLabel('Blog local persistence'),
    ).draft.revision,
  ).toBe(2);
  await page.getByRole('button', { name: '← Articles', exact: true }).click();
  await open(page, 'Blog local persistence');
  await expect(page.getByRole('textbox', { name: 'Article body' }).locator('strong')).toHaveText(
    ' strong text',
  );
  await page.reload();
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue(
    ownedLabel('Blog local persistence'),
  );
  await expect(page.getByRole('textbox', { name: 'Article body' })).toContainText('strong text');
  const editor = page.getByRole('textbox', { name: 'Article body' });
  await editor.focus();
  await editor.press('ControlOrMeta+A');
  await editor.evaluate((element) => {
    const data = new DataTransfer();
    data.setData(
      'text/html',
      '<h2>Original heading</h2><p>First paragraph.</p><h2>Last section</h2><p>Final paragraph.</p>',
    );
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  });
  await expect(editor.locator('h2').first()).toHaveText('Original heading');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByText('Saved · revision 3', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '← Articles', exact: true }).click();
  await open(page, 'Blog local persistence');
  await page.reload();
  await expect(editor.locator('h2').first()).toHaveText('Original heading');
  await appendArticleParagraph(editor, 'Reviewed final paragraph.');
  await expect(editor.locator('h2').first()).toHaveText('Original heading');
  await expect(editor.locator('p').last()).toHaveText('Reviewed final paragraph.');
  await expect(editor.locator('p')).toHaveText([
    'First paragraph.',
    'Final paragraph.',
    'Reviewed final paragraph.',
  ]);
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByText('Saved · revision 4', { exact: true })).toBeVisible();
  await page.reload();
  await expect(editor.locator('h2').first()).toHaveText('Original heading');
  await expect(editor.locator('p').last()).toHaveText('Reviewed final paragraph.');
});

test('two real tabs conflict without overwriting either author input', async ({
  page,
  context,
}) => {
  await login(page);
  await create(page, 'Blog revision collision');
  const other = await context.newPage();
  await other.goto('/admin');
  await other.getByRole('button', { name: 'Articles', exact: true }).click();
  await open(other, 'Blog revision collision');
  await page.getByRole('textbox', { name: 'Article body' }).fill('First writer wins');
  await other.getByRole('textbox', { name: 'Article body' }).fill('Second writer keeps local text');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByText('Saved · revision 2', { exact: true })).toBeVisible();
  await other.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(other.getByRole('alert')).toContainText('revision 2');
  await expect(other.getByRole('textbox', { name: 'Article body' })).toHaveText(
    'Second writer keeps local text',
  );
  const store = JSON.parse(await readFile(database ?? '', 'utf8'));
  expect(JSON.stringify(store.articleDrafts)).not.toContain('Second writer keeps local text');
  other.on('dialog', (dialog) => dialog.accept());
  await other.close();
});

test('failed connection preserves the draft and retries the same creation without duplicates', async ({
  page,
  context,
}) => {
  await login(page);
  await page.getByRole('button', { name: 'New article', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill(ownedLabel('Blog offline retry'));
  await page.getByRole('textbox', { name: 'Article body' }).fill('Kept offline');
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry save', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Article body' })).toHaveText('Kept offline');
  await context.setOffline(false);
  await page.getByRole('button', { name: 'Retry save', exact: true }).click();
  await expect(page.getByText('Saved · revision 1', { exact: true })).toBeVisible();
  const store = JSON.parse(await readFile(database ?? '', 'utf8'));
  expect(
    store.articleDrafts.filter(
      (row: { draft: { content: { title: string } } }) =>
        row.draft.content.title === ownedLabel('Blog offline retry'),
    ),
  ).toHaveLength(1);
});

test('discard protection covers available navigation and narrow screens have no overflow', async ({
  page,
}) => {
  await login(page);
  await page.getByRole('button', { name: 'New article', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill('Do not discard');
  page.once('dialog', (dialog) => dialog.dismiss());
  if (process.env.PUBLIC_BLOG_WORKSPACE === '1') {
    await expect(page.getByRole('button', { name: 'Products', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '← Articles', exact: true }).click();
  } else {
    await page.getByRole('button', { name: 'Products', exact: true }).click();
  }
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Do not discard');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByRole('button', { name: 'Save draft', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByText('Saved · revision 1', { exact: true })).toBeVisible();
});

test('a lost acknowledgement retries real create and save without duplicate revisions', async ({
  page,
}) => {
  await login(page);
  await page.getByRole('button', { name: 'New article', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill(ownedLabel('Blog lost acknowledgement'));
  await page.getByRole('textbox', { name: 'Article body' }).fill('Stored even if reply is lost');
  let dropped = false;
  await page.route('**/api/admin', async (route) => {
    const input = route.request().postDataJSON();
    if (!dropped && input.action === 'articleDrafts' && input.data.operation === 'create') {
      dropped = true;
      const actual = await route.fetch();
      expect(actual.ok()).toBe(true);
      await route.abort('failed');
    } else await route.continue();
  });
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry save', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Retry save', exact: true }).click();
  await expect(page.getByText('Saved · revision 1', { exact: true })).toBeVisible();
  await page.unroute('**/api/admin');
  await page.getByRole('textbox', { name: 'Article body' }).fill('Stored revision two');
  dropped = false;
  await page.route('**/api/admin', async (route) => {
    const input = route.request().postDataJSON();
    if (!dropped && input.action === 'articleDrafts' && input.data.operation === 'save') {
      dropped = true;
      const actual = await route.fetch();
      expect(actual.ok()).toBe(true);
      await route.abort('failed');
    } else await route.continue();
  });
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry save', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Retry save', exact: true }).click();
  await expect(page.getByText('Saved · revision 2', { exact: true })).toBeVisible();
  const store = JSON.parse(await readFile(database ?? '', 'utf8'));
  const rows = store.articleDrafts.filter(
    (row: { draft: { content: { title: string } } }) =>
      row.draft.content.title === ownedLabel('Blog lost acknowledgement'),
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].draft.revision).toBe(2);
});

test('the real Tiptap schema round-trips every enabled node without losing saved image references', async ({
  page,
}) => {
  const { editorContractDocument } = await import('../fixtures/article-document.ts');
  const { fromTiptapJSON } = await import('../../packages/articles/src/index.ts');
  await login(page);
  const token = await page.evaluate(() => localStorage.getItem('channel.token'));
  const api = process.env.E2E_API_URL || site;
  if (!api || !['localhost', '127.0.0.1'].includes(new URL(api).hostname))
    throw new Error('Local API required');
  const created = await page.request.post(`${api}/api/admin`, {
    data: {
      action: 'articleDrafts',
      token,
      data: {
        operation: 'create',
        requestId: ownedLabel('editor-schema-roundtrip'),
        content: {
          title: ownedLabel('Editor schema contract'),
          slug: '',
          body: {
            ...editorContractDocument,
            document: {
              type: 'doc',
              content: editorContractDocument.document.content.filter(
                (node) => node.type !== 'articleImage',
              ),
            },
          },
        },
      },
    },
  });
  expect(created.ok()).toBe(true);
  const record = await created.json();
  expect(record.ok).toBe(true);
  if (!token) throw new Error('Local token required');
  const mediaId = await apiUpload(page, token, record.data.id);
  const document = structuredClone(editorContractDocument);
  for (const node of document.document.content)
    if (node.type === 'articleImage') node.attrs.mediaId = mediaId;
  const saved = await page.request.post(`${api}/api/admin`, {
    data: {
      action: 'articleDrafts',
      token,
      data: {
        operation: 'save',
        articleId: record.data.id,
        expectedRevision: 1,
        content: { title: ownedLabel('Editor schema contract'), slug: '', body: document },
      },
    },
  });
  expect(saved.ok()).toBe(true);

  await page.reload();
  await page.getByRole('button', { name: 'Articles', exact: true }).click();
  await open(page, 'Editor schema contract');
  const body = page.getByRole('textbox', { name: 'Article body' });
  const before = await body.evaluate((element) => Reflect.get(element, 'editor').getJSON());
  expect(fromTiptapJSON(before)).toEqual(document);
  await body.press('ControlOrMeta+End');
  await body.pressSequentially(' revised');
  const expected = fromTiptapJSON(
    await body.evaluate((element) => Reflect.get(element, 'editor').getJSON()),
  );
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByText('Saved · revision 3', { exact: true })).toBeVisible();
  const store = JSON.parse(await readFile(database ?? '', 'utf8'));
  const row = store.articleDrafts.find(
    (row: { draft: { id: string } }) => row.draft.id === record.data.id,
  );
  expect(row.draft.content.body).toEqual(expected);
  expect(JSON.stringify(row.draft.content.body)).toContain(mediaId);
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Draft preview' }).locator('img')).toBeVisible();
});

test('common formatting controls, private preview and desktop/mobile layout remain usable', async ({
  page,
}) => {
  await login(page);
  await page.getByRole('button', { name: 'New article', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill(ownedLabel('Editorial workspace'));
  const body = page.getByRole('textbox', { name: 'Article body' });
  await body.fill('A clear place to write, revise, and save private drafts.');
  await body.press('ControlOrMeta+A');
  for (const label of ['Bold', 'Italic', 'Underline']) {
    await page.getByRole('button', { name: label, exact: true }).click();
    await expect(page.getByRole('button', { name: label, exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.getByRole('button', { name: label, exact: true }).click();
  }
  await page.getByRole('combobox', { name: 'Paragraph style', exact: true }).click();
  await page.getByRole('option', { name: 'Heading 2', exact: true }).click();
  await expect(body.locator('h2')).toContainText('A clear place');
  await page.getByRole('combobox', { name: 'Paragraph style', exact: true }).click();
  await expect(page.getByRole('option', { name: 'Heading 1', exact: true })).toHaveCount(0);
  await page.getByRole('option', { name: 'Paragraph', exact: true }).click();
  for (const label of ['Bullets', 'Numbered']) {
    await page.getByRole('button', { name: label, exact: true }).click();
    await expect(body.locator(label === 'Bullets' ? 'ul' : 'ol')).toBeVisible();
    await page.getByRole('button', { name: label, exact: true }).click();
  }
  await body.press('ControlOrMeta+A');
  await page.getByRole('button', { name: 'Link', exact: true }).click();
  await page.getByLabel('Link URL', { exact: true }).fill('javascript:alert(1)');
  await page.getByRole('button', { name: 'Apply link', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('HTTPS');
  await page.getByLabel('Link URL', { exact: true }).fill('https://example.com/');
  await page.getByRole('button', { name: 'Apply link', exact: true }).click();
  await expect(body.locator('a')).toHaveAttribute('href', 'https://example.com/');
  await page.getByRole('button', { name: 'Link', exact: true }).click();
  await page.getByLabel('Link URL', { exact: true }).fill('');
  await page.getByRole('button', { name: 'Apply link', exact: true }).click();
  await expect(body).toContainText('A clear place');
  await body.locator('p').last().click();
  await body.press('End');
  await expect
    .poll(() => body.evaluate((element) => Reflect.get(element, 'editor').state.selection.empty))
    .toBe(true);
  const paragraphs = await body.locator('p').count();
  await body.press('Enter');
  await expect(body.locator('p')).toHaveCount(paragraphs + 1);
  await expect(body).toContainText('A clear place to write, revise, and save private drafts.');
  await expect
    .poll(() => body.evaluate((element) => Reflect.get(element, 'editor').state.selection.empty))
    .toBe(true);
  await page.getByRole('button', { name: 'Table', exact: true }).click();
  await expect(body.locator('table')).toBeVisible();
  await page.getByRole('button', { name: 'Add row', exact: true }).click();
  await expect(body.locator('tr')).toHaveCount(4);
  await page.getByRole('button', { name: 'Add column', exact: true }).click();
  await expect(body.locator('tr').first().locator('th,td')).toHaveCount(4);
  await page.getByRole('button', { name: 'Delete table', exact: true }).click();
  await expect(body.locator('table')).toHaveCount(0);
  await expect(body).toContainText('A clear place to write, revise, and save private drafts.');
  await page.getByText('More formatting', { exact: true }).click();
  await page.getByRole('button', { name: 'Center', exact: true }).click();
  await page.getByRole('button', { name: 'Left', exact: true }).click();
  await page.getByText('More formatting', { exact: true }).click();
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByText('Saved · revision 1', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Draft preview' })).toContainText('A clear place');
  if (process.env.E2E_BLOG_SCREENSHOTS === '1') {
    await page.screenshot({
      path: 'output/blog-editor-2026-10-23/editor-desktop.png',
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: 'output/blog-editor-2026-10-23/editor-mobile.png',
      fullPage: true,
    });
  }
});

const articlePixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV1sAAAAASUVORK5CYII=',
  'base64',
);
async function apiUpload(page: Page, token: string, articleId: string) {
  const { createHash } = await import('node:crypto');
  const api = process.env.E2E_API_URL;
  if (!api || new URL(api).hostname !== '127.0.0.1') throw new Error('Owned loopback API required');
  const intentResponse = await page.request.post(`${api}/api/admin`, {
    data: {
      action: 'articleMedia',
      token,
      data: {
        operation: 'intent',
        articleId,
        requestId: crypto.randomUUID(),
        file: {
          fileName: 'pixel.png',
          mimeType: 'image/png',
          byteSize: articlePixel.length,
          checksumSha256: createHash('sha256').update(articlePixel).digest('hex'),
        },
      },
    },
  });
  expect(intentResponse.ok()).toBe(true);
  const { data: intent } = await intentResponse.json();
  expect(
    (
      await page.request.put(intent.upload.url, {
        headers: intent.upload.headers,
        data: articlePixel,
      })
    ).ok(),
  ).toBe(true);
  const complete = await page.request.post(`${api}/api/admin`, {
    data: {
      action: 'articleMedia',
      token,
      data: { operation: 'complete', articleId, mediaId: intent.mediaId },
    },
  });
  expect(complete.ok()).toBe(true);
  return intent.mediaId as string;
}

test('real private image upload locks save, preserves bytes, previews and reopens without storage URLs', async ({
  page,
}) => {
  await login(page);
  await page.getByRole('button', { name: 'New article', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill(ownedLabel('Private image acceptance'));
  await page.getByRole('textbox', { name: 'Article body' }).fill('Image acceptance body');
  let release = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/__local-test/article-uploads/**', async (route) => {
    await pending;
    await route.continue();
  });
  const photo = await readFile('apps/site/public/media/factory-oem.webp');
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Image', exact: true }).click();
  await (await chooserPromise).setFiles({
    name: 'factory.webp',
    mimeType: 'image/webp',
    buffer: photo,
  });
  await expect(page.getByText('Uploading and verifying image…', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save draft', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Preview', exact: true })).toBeDisabled();
  release();
  const figure = page.locator('[data-article-image]');
  await expect(figure.getByRole('img')).toBeVisible();
  await expect
    .poll(() =>
      figure
        .getByRole('img')
        .evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth),
    )
    .toBe(1228);
  await figure.getByLabel('Image description').fill('Factory building');
  await figure.getByLabel('Image caption').fill('Factory photo in a private draft');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByText('Saved · revision 2', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  const preview = page.getByRole('region', { name: 'Draft preview' });
  const image = preview.getByRole('img', { name: 'Factory building' });
  await expect(image).toBeVisible();
  await expect(image).toHaveAttribute('src', /^blob:/);
  await expect(preview.locator('figcaption')).toHaveText('Factory photo in a private draft');
  const store = JSON.parse(await readFile(database ?? '', 'utf8'));
  const draft = store.articleDrafts.find(
    (row: { draft: { content: { title: string } } }) =>
      row.draft.content.title === ownedLabel('Private image acceptance'),
  );
  const media = store.articleMedia.find(
    (row: { articleId: string }) => row.articleId === draft._id,
  );
  expect(media.status).toBe('active');
  expect(media.width).toBe(1228);
  expect(media.height).toBe(718);
  const { join, dirname } = await import('node:path');
  expect(await readFile(join(dirname(database ?? ''), 'media', media.storage.storagePath))).toEqual(
    photo,
  );
  expect(media.purpose).toBe('article-image');
  expect(JSON.stringify(draft)).not.toMatch(/blob:|storageFileId|http.*article-uploads/);
  const api = process.env.E2E_API_URL;
  const anonymous = await page.request.post(`${api}/api/admin`, {
    data: {
      action: 'articleMedia',
      data: { operation: 'preview', articleId: draft._id, mediaId: media.id },
    },
  });
  expect(anonymous.status()).toBe(401);
  expect(anonymous.headers()['cache-control']).toBe('no-store');
  expect((await page.request.get(`${api}/api/images/${media.id}`)).status()).toBe(404);
  expect(
    await page
      .locator('img')
      .evaluateAll((images) => images.map((img) => img.getAttribute('src')).filter(Boolean)),
  ).not.toContain(media.storage.storageFileId);
  await page.reload();
  await page.getByRole('button', { name: 'Articles', exact: true }).click();
  await open(page, 'Private image acceptance');
  await expect(page.locator('[data-article-image] img')).toBeVisible();
  await expect(page.getByLabel('Image description')).toHaveValue('Factory building');
  if (process.env.E2E_BLOG_MEDIA_SCREENSHOTS === '1') {
    const { mkdir } = await import('node:fs/promises');
    await mkdir('output/blog-media-2026-10-23', { recursive: true });
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.screenshot({
      path: 'output/blog-media-2026-10-23/media-desktop.png',
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await page.screenshot({
      path: 'output/blog-media-2026-10-23/media-mobile.png',
      fullPage: true,
    });
  }
});

test('image response loss retries the same upload and replacement/removal release private object URLs', async ({
  page,
}) => {
  const urls = new Set<string>();
  await page.exposeFunction('articleObjectCreated', (url: string) => urls.add(url));
  await page.exposeFunction('articleObjectRevoked', (url: string) => urls.delete(url));
  await page.addInitScript(() => {
    const originalCreate = URL.createObjectURL.bind(URL);
    const originalRevoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      const url = originalCreate(blob);
      Reflect.get(window, 'articleObjectCreated')(url);
      return url;
    };
    URL.revokeObjectURL = (url) => {
      Reflect.get(window, 'articleObjectRevoked')(url);
      return originalRevoke(url);
    };
  });
  await login(page);
  await create(page, 'Image retry and replacement');
  let loseOnce = true;
  await page.route('**/api/admin', async (route) => {
    const req = route.request().postDataJSON();
    if (loseOnce && req?.action === 'articleMedia' && req.data?.operation === 'complete') {
      loseOnce = false;
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      await route.abort('failed');
      return;
    }
    await route.continue();
  });
  await page
    .getByLabel('Upload article image')
    .setInputFiles({ name: 'retry.png', mimeType: 'image/png', buffer: articlePixel });
  await expect(page.getByRole('button', { name: 'Retry upload', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Article body' })).toContainText(
    'Acceptance body',
  );
  await page.getByRole('button', { name: 'Retry upload', exact: true }).click();
  await expect(page.locator('[data-article-image] img')).toBeVisible();
  let store = JSON.parse(await readFile(database ?? '', 'utf8'));
  const draft = store.articleDrafts.find(
    (row: { draft: { content: { title: string } } }) =>
      row.draft.content.title === ownedLabel('Image retry and replacement'),
  );
  expect(
    store.articleMedia.filter((row: { articleId: string }) => row.articleId === draft._id),
  ).toHaveLength(1);
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByText('Saved · revision 2', { exact: true })).toBeVisible();
  await expect.poll(() => urls.size).toBe(1);
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Draft preview' }).locator('img')).toBeVisible();
  await expect.poll(() => urls.size).toBe(2);
  await page.getByRole('button', { name: 'Close preview', exact: true }).click();
  await expect.poll(() => urls.size).toBe(1);
  const replacementPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Replace image', exact: true }).click();
  await (await replacementPromise).setFiles({
    name: 'replacement.png',
    mimeType: 'image/png',
    buffer: articlePixel,
  });
  await expect
    .poll(async () => {
      const db = JSON.parse(await readFile(database ?? '', 'utf8'));
      return db.articleMedia.filter((row: { articleId: string }) => row.articleId === draft._id)
        .length;
    })
    .toBe(2);
  await expect(page.getByRole('button', { name: 'Remove image', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Remove image', exact: true }).click();
  await expect(page.locator('[data-article-image]')).toHaveCount(0);
  await expect.poll(() => urls.size).toBe(0);
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await page.getByRole('button', { name: '← Articles', exact: true }).click();
  store = JSON.parse(await readFile(database ?? '', 'utf8'));
  expect(
    store.articleMedia.filter((row: { articleId: string }) => row.articleId === draft._id),
  ).toHaveLength(2);
});

test('a private draft link survives sign-in and opens the same editor after refresh', async ({
  page,
  browser,
}) => {
  test.setTimeout(120000);
  await login(page);
  await create(page, 'Assistant draft link');
  await page.getByRole('button', { name: '← Articles', exact: true }).click();
  const row = page.getByRole('row').filter({
    has: page.getByRole('cell', { name: ownedLabel('Assistant draft link'), exact: true }),
  });
  const id = await row.getAttribute('data-article-id');
  if (!id || !site) throw Error('Owned draft was not found');
  const path = `/admin/?${new URLSearchParams({ section: 'articles', article: id })}`;
  const fresh = await browser.newContext({ baseURL: site });
  try {
    const editor = await fresh.newPage();
    await editor.goto(path);
    await expect(editor).toHaveURL(/\/login\?returnTo=/);
    await editor.getByLabel('Email', { exact: true }).fill('admin@channel.local');
    await editor.getByLabel('Password', { exact: true }).fill('admin');
    const loginReply = editor.waitForResponse(
      (response) =>
        response.url().endsWith('/api/admin') &&
        response.request().postDataJSON()?.action === 'login',
    );
    await editor.getByRole('button', { name: 'Sign in', exact: true }).click();
    const firstLogin = await loginReply;
    // A successful login immediately replaces the document and its response body.
    await expect
      .poll(async () =>
        new URL(editor.url()).pathname.replace(/\/$/, '') === '/admin'
          ? 'opened'
          : (await editor.locator('form p.text-red-700').isVisible())
            ? 'rejected'
            : 'waiting',
      )
      .not.toBe('waiting');
    if (new URL(editor.url()).pathname === '/login') {
      const firstBody = await firstLogin.json();
      expect(firstLogin.status() === 429 || firstBody.error?.code === 'RATE_LIMITED').toBe(true);
      const seconds = Number(
        firstLogin.headers()['retry-after'] ?? firstBody.error.retryAfterSeconds,
      );
      expect(Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 60).toBe(true);
      // Respect the actual server cooldown; this suite deliberately performs eleven sign-ins.
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000 + 100));
      await editor.getByRole('button', { name: 'Sign in', exact: true }).click();
    }

    await expect(editor).toHaveURL(new URL(path, site).href);
    await expect(editor.getByLabel('Title', { exact: true })).toHaveValue(
      ownedLabel('Assistant draft link'),
    );
    await editor.reload();
    await expect(editor.getByLabel('Title', { exact: true })).toHaveValue(
      ownedLabel('Assistant draft link'),
    );
    await editor.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(editor.getByRole('region', { name: 'Draft preview' })).toContainText(
      'Acceptance body',
    );
    if (process.env.E2E_BLOG_EDITOR_SCREENSHOTS === '1') {
      const { mkdir } = await import('node:fs/promises');
      await mkdir('output/blog-agent', { recursive: true });
      await editor.screenshot({ path: 'output/blog-agent/draft-link-desktop.png', fullPage: true });
      await editor.setViewportSize({ width: 390, height: 844 });
      expect(await editor.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await editor.screenshot({ path: 'output/blog-agent/draft-link-mobile.png', fullPage: true });
    }
  } finally {
    await fresh.close();
  }
});
