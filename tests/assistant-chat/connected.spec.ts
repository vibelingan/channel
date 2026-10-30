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

test('public HTTP products render images, compare, refresh and withdraw consistently', async ({
  page,
  request,
}) => {
  await request.post('http://127.0.0.1:62383/__fixture/control?state=normal');
  await send(page, 'Show headphones for company gifts');
  await expect(page.getByLabel('Answer status')).toContainText('Answer ready');
  const cards = page.locator('[data-message-role="assistant"]').last();
  await expect(cards.getByRole('heading', { name: 'Everyday wireless headphones' })).toBeVisible();
  await expect(cards.locator('img')).toHaveCount(2);
  await expect
    .poll(() =>
      cards
        .locator('img')
        .first()
        .evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
    )
    .toBe(true);
  await expect(cards.getByRole('link', { name: 'View product' }).first()).toHaveAttribute(
    'href',
    '/products/item/?id=demo-1',
  );
  await expect(cards.getByRole('button', { name: 'Prepare inquiry' })).toHaveCount(0);
  await cards.getByRole('button', { name: 'Compare', exact: true }).first().click();
  await cards.getByRole('button', { name: 'Compare', exact: true }).click();
  const comparison = page.getByRole('region', { name: 'Compare options' });
  await expect(comparison.getByRole('heading', { level: 4 })).toHaveCount(2);
  await request.post('http://127.0.0.1:62383/__fixture/control?state=updated');
  await comparison.getByRole('button', { name: 'Check current details' }).click();
  await expect(comparison).toContainText('Updated published details');
  await expect(page.getByText('Earlier details. See the updated card below.')).toBeVisible();
  await request.post('http://127.0.0.1:62383/__fixture/control?state=withdrawn');
  await comparison.getByRole('button', { name: 'Check current details' }).click();
  await expect(comparison.getByRole('heading', { level: 4 })).toHaveCount(1);
  await expect(comparison).not.toContainText('Office wireless headphones');
  await expect(
    page.getByText('This product is no longer available in the public catalog.').first(),
  ).toBeVisible();
  await request.post('http://127.0.0.1:62383/__fixture/control?state=normal');
  await page
    .getByRole('dialog')
    .screenshot({ path: `output/assistant-chat/products-${test.info().project.name}.png` });
});

test('clarification, no match, catalog failure and a fresh request all have usable responses', async ({
  page,
}) => {
  await send(page, 'I am not sure what product I want');
  await expect(page.locator('[data-message-role="assistant"]').last()).toContainText(
    'What type of product',
  );
  await send(page, 'Find no matching product');
  await expect(page.locator('[data-message-role="assistant"]').last()).toContainText(
    'could not find a published product',
  );
  await send(page, 'catalog failure');
  await expect(page.getByLabel('Answer status')).toContainText('could not verify');
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
  await send(page, 'Show headphones');
  await expect(page.getByRole('heading', { name: 'Everyday wireless headphones' })).toBeVisible();
});

test('stopping a pending catalog read prevents its late product cards', async ({ page }) => {
  await send(page, 'catalog slow');
  await page.waitForTimeout(900);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByLabel('Answer status')).toContainText('has stopped');
  await page.waitForTimeout(1000);
  await expect(page.locator('[data-message-role="assistant"] section')).toHaveCount(0);
  await send(page, 'Show headphones');
  await expect(page.getByRole('heading', { name: 'Everyday wireless headphones' })).toBeVisible();
});

test('missing product images fall back without breaking the product actions', async ({ page }) => {
  await page.route('**/api/images/**', (route) => route.abort());
  await send(page, 'Show headphones');
  await expect(page.getByRole('heading', { name: 'Everyday wireless headphones' })).toBeVisible();
  await expect(page.locator('[data-message-role="assistant"] img')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'View product' })).toHaveCount(2);
  await page
    .getByRole('dialog')
    .screenshot({ path: `output/assistant-chat/product-cards-${test.info().project.name}.png` });
});

test('a follow-up uses prior public cards as context and rechecks current catalog details', async ({
  page,
  request,
}) => {
  await request.post('http://127.0.0.1:62383/__fixture/control?state=normal');
  await send(page, 'Show headphones');
  await expect(page.getByRole('heading', { name: 'Everyday wireless headphones' })).toBeVisible();
  await request.post('http://127.0.0.1:62383/__fixture/control?state=updated');
  await send(page, 'Check those again');
  await expect(page.locator('[data-message-role="assistant"]').last()).toContainText(
    'Updated published details',
  );
  await expect(page.getByLabel('Answer status')).toContainText('Answer ready');
  await request.post('http://127.0.0.1:62383/__fixture/control?state=normal');
});
