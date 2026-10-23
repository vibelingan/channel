import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Page, expect, test } from '@playwright/test';
const privateDirectory = process.env.BLOG_DUMMY_PRIVATE_DIR;
test.skip(
  process.env.E2E_BLOG_DUMMY_LIVE !== '1',
  'Explicit isolated real-cloud test window required',
);
test.describe.configure({ retries: 0 });
const pixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV1sAAAAASUVORK5CYII=',
  'base64',
);
const gh = (args: string[]) =>
  execFileSync('gh', args, { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
async function launch(task: { id: string }, permission: string, sha: string, fault = 'none') {
  const since = Date.now();
  gh([
    'workflow',
    'run',
    'seo-blog-dummy.yml',
    '--repo',
    'vibelingan/channel',
    '--ref',
    'feat/seo-foundation',
    '-f',
    `task_id=${task.id}`,
    '-f',
    `permission_hash=${permission}`,
    '-f',
    'confirm=ISOLATED_BLOG_ONLY',
    '-f',
    `fault=${fault}`,
  ]);
  let run:
    | {
        databaseId: number;
        headSha: string;
        status: string;
        conclusion: string;
        displayTitle: string;
      }
    | undefined;
  const deadline = Date.now() + 12 * 60_000;
  while (Date.now() < deadline) {
    const runs = JSON.parse(
      gh([
        'run',
        'list',
        '--repo',
        'vibelingan/channel',
        '--workflow',
        'seo-blog-dummy.yml',
        '--event',
        'workflow_dispatch',
        '--limit',
        '30',
        '--json',
        'databaseId,headSha,status,conclusion,displayTitle,createdAt',
      ]),
    );
    run = runs.find(
      (value: { headSha: string; displayTitle: string; createdAt: string }) =>
        value.headSha === sha &&
        value.displayTitle === `Blog dummy ${task.id}` &&
        Date.parse(value.createdAt) >= since - 5000,
    );
    if (run?.status === 'completed') {
      expect(run.conclusion, `Actual dummy delivery run ${run.databaseId}`).toBe('success');
      return run.databaseId;
    }
    await new Promise((done) => setTimeout(done, 5000));
  }
  throw new Error(`Actual dummy workflow did not finish: ${run?.databaseId ?? 'not found'}`);
}
async function publication(page: Page, operation: string, button: string) {
  const response = page.waitForResponse((response) => {
    try {
      const input = response.request().postDataJSON();
      return input?.action === 'articleReleases' && input.data?.operation === operation;
    } catch {
      return false;
    }
  });
  await page.getByRole('button', { name: button, exact: true }).click();
  const result = await (await response).json();
  expect(result.ok).toBe(true);
  return result.data.task;
}
test('real editor, cloud function, private storage and Actions publish A, recover A after B, retry B and withdraw', async ({
  page,
  context,
  request,
}) => {
  test.setTimeout(30 * 60_000);
  page.on('requestfailed', (request) => {
    const url = new URL(request.url());
    console.log(
      'Live request failed:',
      request.method(),
      url.origin,
      url.pathname,
      request.failure()?.errorText,
    );
  });
  page.on('console', (message) => {
    if (message.type() === 'error')
      console.log(
        'Live browser error:',
        message.text().replace(/https?:\/\/[^\s]+/g, '[request URL]'),
      );
  });
  if (!privateDirectory) throw new Error('Private prepared session file required');
  if (!['127.0.0.1', 'localhost'].includes(new URL(process.env.E2E_SITE_URL ?? '').hostname))
    throw new Error('This test uses an isolated local admin UI only');
  const prepared = JSON.parse(await readFile(join(privateDirectory, 'sessions.json'), 'utf8'));
  const admin = prepared.sessions.find((session: { role: string }) => session.role === 'admin');
  await page.addInitScript((session) => {
    localStorage.setItem('channel.token', session.token);
    localStorage.setItem('channel.user', JSON.stringify(session.user));
  }, admin);
  await page.goto('/admin');
  await page.getByRole('button', { name: 'Articles', exact: true }).click();
  await page.getByRole('button', { name: 'New article', exact: true }).click();
  const slug = `dummy-live-${Date.now()}`;
  await page.getByLabel('Title', { exact: true }).fill('Dummy article A');
  await page.getByRole('textbox', { name: 'Article body' }).fill('Real cloud acceptance body A.');
  await page.getByText('Article details and search settings', { exact: true }).click();
  await page.getByLabel('authorName', { exact: true }).fill('Dummy editor');
  await page.getByLabel('slug', { exact: true }).fill(slug);
  await page
    .getByLabel('Upload article image')
    .setInputFiles({ name: 'dummy.png', mimeType: 'image/png', buffer: pixel });
  const figure = page.locator('[data-article-image]');
  await expect(figure.getByRole('img')).toBeVisible({ timeout: 60000 });
  await figure.getByLabel('Image description').fill('Isolated test image');
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  const preview = page.getByRole('region', { name: 'Draft preview' });
  await expect(preview.getByRole('img')).toBeVisible();
  expect(await preview.getByRole('img').getAttribute('src')).toMatch(/^blob:/);
  await page.getByRole('button', { name: 'Close preview', exact: true }).click();
  const a = await publication(page, 'publish', 'Save and publish');
  const results = [];
  results.push({
    stage: 'A',
    taskId: a.id,
    runId: await launch(a, prepared.permissionHash, prepared.codeSha),
  });
  const region = page.getByRole('region', { name: 'Publication' });
  await expect(region).toContainText('Published · revision', { timeout: 30000 });
  const url = `https://supplychainsai.com/__blog-dummy/${slug}/`;
  const publicA = await request.get(url);
  expect(publicA.status()).toBe(200);
  const htmlA = await publicA.text();
  expect(htmlA).toContain('Real cloud acceptance body A.');
  expect(htmlA).toContain('noindex,nofollow');
  expect(htmlA).not.toMatch(/cloud:\/\/|pending-upload/);
  await page.screenshot({
    path: 'output/playwright/blog-dummy-live-published.png',
    fullPage: true,
  });
  await page.getByLabel('Title', { exact: true }).fill('Dummy article B');
  const b = await publication(page, 'publish', 'Save and publish update');
  results.push({
    stage: 'B-failure-A-recovery',
    taskId: b.id,
    runId: await launch(b, prepared.permissionHash, prepared.codeSha, 'after-upload'),
  });
  await expect(region).toContainText('previous website was restored and checked', {
    timeout: 30000,
  });
  expect(await (await request.get(url)).text()).toBe(htmlA);
  await page.screenshot({ path: 'output/playwright/blog-dummy-live-restored.png', fullPage: true });
  const retry = await publication(page, 'retry', `Retry revision ${b.revision}`);
  results.push({
    stage: 'retry-B',
    taskId: retry.id,
    runId: await launch(retry, prepared.permissionHash, prepared.codeSha),
  });
  await expect(region).toContainText(`Published · revision ${b.revision}`, { timeout: 30000 });
  expect(await (await request.get(url)).text()).toContain('Dummy article B');
  page.once('dialog', (dialog) => dialog.accept());
  const withdraw = await publication(page, 'withdraw', 'Withdraw article');
  results.push({
    stage: 'withdraw',
    taskId: withdraw.id,
    runId: await launch(withdraw, prepared.permissionHash, prepared.codeSha),
  });
  await expect(region).toContainText('Article withdrawn', { timeout: 30000 });
  const missing = await request.get(url);
  expect(missing.status()).toBe(404);
  expect(await missing.text()).toContain('data-not-found-page');
  await page.reload();
  await page.getByRole('button', { name: 'Articles', exact: true }).click();
  await page
    .getByRole('row')
    .filter({ hasText: 'Dummy article B' })
    .getByRole('button', { name: 'Edit', exact: true })
    .click();
  await expect(region).toContainText('Article withdrawn');
  await writeFile(
    join(privateDirectory, 'live-results.json'),
    JSON.stringify({ codeSha: prepared.codeSha, url, results }, null, 2),
    { mode: 0o600 },
  );
});
