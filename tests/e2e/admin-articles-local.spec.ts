import { readFile } from 'node:fs/promises';
import { type Page, expect, test } from '@playwright/test';

test.describe.configure({ mode: 'serial' });
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
async function login(page: Page) {
  await page.goto('/login?returnTo=/admin');
  await page.getByLabel('Email', { exact: true }).fill('admin@channel.local');
  await page.getByLabel('Password', { exact: true }).fill('admin');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL('**/admin');
  await page.getByRole('button', { name: 'Articles', exact: true }).click();
}
async function create(page: Page, title: string) {
  await page.getByRole('button', { name: 'New article', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill(title);
  await page.getByRole('textbox', { name: 'Article body' }).fill('Acceptance body');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByText('Saved · revision 1', { exact: true })).toBeVisible();
}
async function open(page: Page, title: string) {
  await page
    .getByRole('row')
    .filter({ hasText: title })
    .getByRole('button', { name: 'Edit', exact: true })
    .click();
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue(title);
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
        row.draft.content.title === 'Blog local persistence',
    ).draft.revision,
  ).toBe(2);
  await page.getByRole('button', { name: '← Articles', exact: true }).click();
  await open(page, 'Blog local persistence');
  await expect(page.getByRole('textbox', { name: 'Article body' }).locator('strong')).toHaveText(
    ' strong text',
  );
  await page.reload();
  await page.getByRole('button', { name: 'Articles', exact: true }).click();
  await open(page, 'Blog local persistence');
  await expect(page.getByRole('textbox', { name: 'Article body' })).toContainText('strong text');
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
  await page.getByLabel('Title', { exact: true }).fill('Blog offline retry');
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
        row.draft.content.title === 'Blog offline retry',
    ),
  ).toHaveLength(1);
});

test('discard protection covers sidebar changes and narrow screens have no overflow', async ({
  page,
}) => {
  await login(page);
  await page.getByRole('button', { name: 'New article', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill('Do not discard');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: 'Products', exact: true }).click();
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
  await page.getByLabel('Title', { exact: true }).fill('Blog lost acknowledgement');
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
      row.draft.content.title === 'Blog lost acknowledgement',
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
        requestId: 'editor-schema-roundtrip',
        content: { title: 'Editor schema contract', slug: '', body: editorContractDocument },
      },
    },
  });
  expect(created.ok()).toBe(true);
  const record = await created.json();
  expect(record.ok).toBe(true);
  await page.reload();
  await page.getByRole('button', { name: 'Articles', exact: true }).click();
  await open(page, 'Editor schema contract');
  const body = page.getByRole('textbox', { name: 'Article body' });
  const before = await body.evaluate((element) => Reflect.get(element, 'editor').getJSON());
  expect(fromTiptapJSON(before)).toEqual(editorContractDocument);
  await body.press('ControlOrMeta+End');
  await body.pressSequentially(' revised');
  const expected = fromTiptapJSON(
    await body.evaluate((element) => Reflect.get(element, 'editor').getJSON()),
  );
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByText('Saved · revision 2', { exact: true })).toBeVisible();
  const store = JSON.parse(await readFile(database ?? '', 'utf8'));
  const row = store.articleDrafts.find(
    (row: { draft: { id: string } }) => row.draft.id === record.data.id,
  );
  expect(row.draft.content.body).toEqual(expected);
  expect(JSON.stringify(row.draft.content.body)).toContain('saved-image');
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('image references are preserved');
});

test('common formatting controls, private preview and desktop/mobile layout remain usable', async ({
  page,
}) => {
  await login(page);
  await page.getByRole('button', { name: 'New article', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill('Editorial workspace');
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
  await body.press('Enter');
  await expect(body).toContainText('A clear place');
  expect(
    await body.evaluate((element) => Reflect.get(element, 'editor').state.selection.empty),
  ).toBe(true);
  await page.getByRole('button', { name: 'Table', exact: true }).click();
  await expect(body.locator('table')).toBeVisible();
  await page.getByRole('button', { name: 'Add row', exact: true }).click();
  await expect(body.locator('tr')).toHaveCount(4);
  await page.getByRole('button', { name: 'Add column', exact: true }).click();
  await expect(body.locator('tr').first().locator('th,td')).toHaveCount(4);
  await page.getByRole('button', { name: 'Delete table', exact: true }).click();
  await expect(body.locator('table')).toHaveCount(0);
  await expect(body).toContainText('A clear place');
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
