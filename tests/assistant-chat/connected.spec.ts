import { type Page, expect, test } from '@playwright/test';
const errors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const seen: string[] = [];
  errors.set(page, seen);
  page.on('pageerror', (e) => seen.push(e.message));
  await page.goto('/assistant-chat.html');
  await expect(page.getByRole('textbox', { name: 'Your question' })).toBeVisible();
});
test.afterEach(async ({ page }) => {
  expect(errors.get(page)).toEqual([]);
});
async function send(page: Page, text: string) {
  await page.getByRole('textbox', { name: 'Your question' }).fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}
test('actual components communicate with BFF, database and worker across two turns', async ({
  page,
}) => {
  await expect(page.getByRole('button', { name: 'Restore conversation' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Prepare inquiry', exact: true })).toHaveCount(0);
  await send(page, 'A product question');
  await expect(page.getByLabel('Answer status')).toContainText('Answer ready');
  await expect(page.locator('[data-message-role="assistant"]')).toContainText(
    'database and worker',
  );
  await send(page, 'Another question');
  await expect(page.getByLabel('Answer status')).toContainText('Answer ready');
  await expect(page.locator('[data-message-role="visitor"]')).toHaveCount(2);
  await expect(page.locator('[data-message-role="assistant"]')).toHaveCount(2);
  const { mkdir } = await import('node:fs/promises');
  await mkdir('output/assistant-chat', { recursive: true });
  await page
    .getByRole('dialog')
    .screenshot({ path: `output/assistant-chat/${test.info().project.name}.png` });
});
test('stop interrupts a quiet provider and a subsequent turn can complete', async ({ page }) => {
  await send(page, 'slow response');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByLabel('Answer status')).toContainText('has stopped', { timeout: 2000 });
  await send(page, 'A new question after stop');
  await expect(page.getByLabel('Answer status')).toContainText('Answer ready');
  await expect(page.locator('[data-message-role="assistant"]').last()).toContainText(
    'database and worker',
  );
});
test('one failed answer does not disable the whole assistant', async ({ page }) => {
  await send(page, 'fail this answer');
  await expect(page.getByLabel('Answer status')).toContainText('could not verify');
  await send(page, 'A fresh product question');
  await expect(page.getByLabel('Answer status')).toContainText('Answer ready');
});

test('lost acceptance reply retries the original submission through the real API', async ({
  page,
}) => {
  const bodies: string[] = [];
  await page.route('**/api/ai/v2/conversations/*/messages', async (route) => {
    bodies.push(route.request().postData() ?? '');
    const response = await route.fetch();
    if (bodies.length === 1) {
      await response.dispose();
      await route.abort('connectionreset');
    } else await route.fulfill({ response });
  });
  await send(page, 'Recover one question');
  await expect(page.getByLabel('Answer status')).toContainText('interrupted');
  await page.getByRole('button', { name: 'Resume this answer' }).click();
  await expect(page.getByLabel('Answer status')).toContainText('Answer ready');
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toBe(bodies[1]);
  await expect(page.locator('[data-message-role="visitor"]')).toHaveCount(1);
  await expect(page.locator('[data-message-role="assistant"]')).toHaveCount(1);
});
