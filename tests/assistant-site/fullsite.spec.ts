import { type Page, expect, test } from '@playwright/test';

/**
 * MIU 20 acceptance on the real Astro pages (ROUND2-DESIGN §9): homepage →
 * small talk → at most five cards → browse → a follow-up → same-tab product
 * page with the conversation → inquiry in the chat → the saved record and the
 * Sales hand-off read back from the local Channel intake.
 */
const errors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const seen: string[] = [];
  errors.set(page, seen);
  page.on('pageerror', (e) => seen.push(e.message));
});
test.afterEach(async ({ page }) => {
  expect(errors.get(page)).toEqual([]);
});

const assistant = (page: Page) => page.locator('[data-message-role="assistant"]');
async function send(page: Page, text: string) {
  await page.getByRole('textbox', { name: 'Your question' }).fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}
async function answered(page: Page, count: number) {
  await expect(assistant(page)).toHaveCount(count);
  await expect(page.getByLabel('Answer status')).toContainText('Answer ready');
}

test('real_site_path: hello, products, follow-up, product page, inquiry and Sales hand-off', async ({
  page,
  request,
}, info) => {
  const mobile = info.project.name === 'mobile';
  await page.goto('/');
  await page.getByRole('button', { name: 'Ask our AI' }).click();
  // A visitor who opens with "hi" gets a real answer and ways to start.
  await send(page, 'hi');
  await answered(page, 1);
  await expect(assistant(page).last()).toContainText('Hello! I can find products');
  await expect(assistant(page).last().getByRole('listitem')).toHaveCount(3);

  await send(page, 'We want headphones for our team');
  await answered(page, 2);
  const cards = assistant(page).last().locator('[data-product-id]');
  const count = await cards.count();
  expect(count).toBeGreaterThan(0);
  expect(count).toBeLessThanOrEqual(5);
  if (count > 1) {
    const dots = assistant(page)
      .last()
      .getByRole('button', { name: /Show product \d of/ });
    await expect(dots).toHaveCount(count);
    if (mobile) await dots.nth(1).click();
    else await assistant(page).last().getByRole('button', { name: 'Next product' }).click();
    await expect(dots.nth(1)).toHaveAttribute('aria-current', 'true');
  }

  await page.getByRole('button', { name: 'Add our logo' }).click();
  await answered(page, 3);
  await expect(page.locator('[data-message-role="visitor"]').last()).toHaveText(
    'Can you print our logo on them?',
  );

  // Same tab to the full product page; the conversation comes along.
  const first = assistant(page).nth(1).locator('[data-product-id]').first();
  const name = (await first.getByRole('heading').textContent())?.trim() ?? '';
  await first.getByRole('link', { name: 'View product' }).click();
  await expect(page).toHaveURL(/\/products\/item\/\?id=/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(name);
  // The product stays readable; the launcher offers to continue, at every width.
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Continue conversation' }).click();
  await expect(assistant(page)).toHaveCount(3);
  await expect(page.locator('[data-message-role="visitor"]')).toHaveCount(3);

  await send(page, 'Please send me a quote');
  await answered(page, 4);
  await assistant(page).last().getByRole('button', { name: 'Review inquiry' }).click();
  const before = (await (
    await request.get('http://127.0.0.1:62384/__fixture/state')
  ).json()) as Record<string, unknown>;
  await page.getByRole('textbox', { name: 'Email *', exact: true }).fill('buyer@example.invalid');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Mia Weber');
  // An ordinary company name, with no "test" in it, must save in the test scope.
  await page.getByRole('textbox', { name: 'Company', exact: true }).fill('Weber Audio GmbH');
  await page.getByRole('button', { name: 'Confirm & submit' }).click();
  await expect(page.getByLabel('Inquiry receipt')).toContainText('Your inquiry is recorded');

  const after = (await (
    await request.get('http://127.0.0.1:62384/__fixture/state')
  ).json()) as Record<string, Record<string, unknown>>;
  const added = Object.keys(after).filter((key) => !Object.hasOwn(before, key));
  const projects = added.filter((key) => key.startsWith('oemProjects/'));
  expect(projects).toHaveLength(1);
  expect(added.filter((key) => key.startsWith('channelSalesSourceRegistrations/'))).toHaveLength(1);
  expect(added.filter((key) => key.startsWith('channelSalesSourceDeliveries/'))).toHaveLength(1);
  expect(JSON.stringify(after[projects[0] ?? ''])).toContain('Weber Audio GmbH');
  await page.screenshot({ path: `output/assistant-site/path-${info.project.name}.png` });
});

for (const width of [320, 768]) {
  test(`narrow_${width}: the widget fits, nothing scrolls sideways, and the composer stays visible with a keyboard-sized viewport`, async ({
    page,
  }, info) => {
    test.skip(info.project.name !== 'mobile', 'one run per width is enough');
    await page.setViewportSize({ width, height: 700 });
    await page.goto('/');
    await page.getByRole('button', { name: 'Ask our AI' }).click();
    await send(page, 'We want headphones for our team');
    await answered(page, 1);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    const panel = await page.getByRole('dialog').boundingBox();
    expect(panel && panel.x >= 0 && panel.x + panel.width <= width).toBe(true);
    await page.screenshot({ path: `output/assistant-site/narrow-${width}.png` });
    // An on-screen keyboard leaves about half the height; the composer must stay usable.
    await page.setViewportSize({ width, height: 360 });
    const box = page.getByRole('textbox', { name: 'Your question' });
    await box.focus();
    const field = await box.boundingBox();
    expect(field && field.y >= 0 && field.y + field.height <= 360).toBe(true);
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeInViewport();
    await page.screenshot({ path: `output/assistant-site/keyboard-${width}.png` });
  });
}
