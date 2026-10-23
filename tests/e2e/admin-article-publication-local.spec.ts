import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
const file = process.env.E2E_BLOG_PUBLICATION_LOCAL_DB;
test.skip(!file, 'Run with the owned isolated publication UI runner');
test('page saves, queues, reloads and cancels real persistent backend work without fabricating a delivery', async ({
  page,
}) => {
  await page.goto('/login?returnTo=/admin');
  await page.getByLabel('Email', { exact: true }).fill('admin@channel.local');
  await page.getByLabel('Password', { exact: true }).fill('admin');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL('**/admin');
  await page.getByRole('button', { name: 'Articles', exact: true }).click();
  await page.getByRole('button', { name: 'New article', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill('Publishing from the existing editor');
  await page
    .getByRole('textbox', { name: 'Article body' })
    .fill('This body is saved to the real local backend.');
  await page.getByText('Article details and search settings', { exact: true }).click();
  await page.getByLabel('authorName', { exact: true }).fill('Example editor');
  await page.getByLabel('slug', { exact: true }).fill('publication-check');
  await page.getByRole('button', { name: 'Save and publish', exact: true }).click();
  const region = page.getByRole('region', { name: 'Publication' });
  await expect(region).toContainText('Publication requested.');
  const data = JSON.parse(await readFile(file ?? '', 'utf8'));
  expect(data.articleReleaseTasks).toHaveLength(1);
  expect(data.articlePublications).toHaveLength(1);
  expect(data.articleReleaseTasks[0].state).toBe('QUEUED');
  expect(data.articleAccepted ?? []).toHaveLength(0);
  await page
    .getByRole('textbox', { name: 'Article body' })
    .fill('A newer unsent draft stays editable.');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByText('Saved · revision 2', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'output/playwright/blog-publication-queued.png', fullPage: true });
  await page.reload();
  await page.getByRole('button', { name: 'Articles', exact: true }).click();
  await page
    .getByRole('row')
    .filter({ hasText: 'Publishing from the existing editor' })
    .getByRole('button', { name: 'Edit', exact: true })
    .click();
  await expect(region).toContainText('saved revision 1');
  await page.getByRole('button', { name: 'Cancel request', exact: true }).click();
  await expect(region).toContainText('Request cancelled.');
  await page.getByRole('button', { name: 'Retry revision 1', exact: true }).click();
  await expect(region).toContainText('Publication requested.');
  const after = JSON.parse(await readFile(file ?? '', 'utf8'));
  expect(after.articleReleaseTasks).toHaveLength(2);
  expect(
    after.articleReleaseTasks.find((task: { state: string }) => task.state === 'QUEUED')?.revision,
  ).toBe(1);
  expect(after.articlePublications).toHaveLength(1);
});
