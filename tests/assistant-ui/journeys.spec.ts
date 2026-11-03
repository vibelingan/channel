import { readFileSync } from 'node:fs';
import { type Page, expect, test } from '@playwright/test';
const screenData: { screens: Array<{ id: string; number: number }> } = JSON.parse(
  readFileSync(
    new URL('../../docs/ai-platform/assistant-ui/screens.json', import.meta.url),
    'utf8',
  ),
);
const observations = new WeakMap<Page, { errors: string[]; forbidden: string[] }>();

interface Ledger {
  runs: Array<{ turnKey: string; idempotencyKey: string; cursor: number }>;
  stops: string[];
  submissions: Array<{ key: string; fingerprint: string }>;
  records: number;
}
async function ledger(page: Page): Promise<Ledger> {
  return JSON.parse((await page.getByTestId('preview-ledger').textContent()) ?? '{}');
}
async function select(page: Page, scenario: string, journey = false) {
  if (await page.getByRole('dialog').isVisible())
    await page.getByRole('button', { name: 'Close assistant' }).click();
  await page.getByLabel('查看设计状态').selectOption(scenario);
  if (scenario !== 'closed' && !(await page.getByRole('dialog').isVisible()))
    await page.getByRole('button', { name: 'Ask our AI' }).click();
  if (journey) {
    if (await page.getByRole('dialog').isVisible())
      await page.getByRole('button', { name: 'Close assistant' }).click();
    await page.getByRole('button', { name: 'Start this journey' }).click();
  }
}
async function send(page: Page, message = 'Please help me choose 500 headphones.') {
  await page.getByRole('textbox', { name: 'Your question' }).fill(message);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}
async function fillInquiry(page: Page) {
  await page.getByRole('button', { name: 'Prepare inquiry', exact: true }).last().click();
  const form = page.getByRole('form', { name: 'Review your inquiry' });
  await form
    .getByLabel('Your requirement')
    .fill('500 gifts; model not decided. Please suggest options.');
  await form.getByRole('textbox', { name: /^Email/ }).fill('buyer@example.invalid');
  await form.getByRole('checkbox').check();
  return form;
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  const forbidden: string[] = [];
  observations.set(page, { errors, forbidden });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:62058' || url.pathname.startsWith('/api/')) {
      forbidden.push(url.origin + url.pathname);
      return route.abort();
    }
    return route.continue();
  });
  await page.goto('/assistant-preview.html');
  await expect(page.getByRole('dialog')).toBeVisible();
  test.info().annotations.push({
    type: 'scope',
    description: 'Real React components with simulated IO; no backend/model claim.',
  });
  await page.evaluate(() => {
    document.documentElement.style.scrollBehavior = 'auto';
  });
});
test.afterEach(async ({ page }) => {
  expect(observations.get(page)?.errors).toEqual([]);
  expect(observations.get(page)?.forbidden).toEqual([]);
});

for (const screen of screenData.screens) {
  test(`state ${screen.number}: ${screen.id} fits the viewport`, async ({ page }) => {
    await select(page, screen.id);
    if (screen.id !== 'closed') {
      const panel = page.getByRole('dialog');
      await expect(panel).toBeVisible();
      const bounds = await panel.boundingBox();
      const viewport = page.viewportSize();
      if (!bounds || !viewport) throw new Error('Panel or viewport is missing');
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.y).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
      await expect(panel).toContainText('sample data');
    } else await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}

test('real components mount, follow branding and restore keyboard focus', async ({ page }) => {
  const question = page.getByRole('textbox', { name: 'Your question' });
  await expect(question).toBeFocused();
  expect(
    await page
      .getByRole('dialog')
      .locator('header')
      .evaluate((element) => getComputedStyle(element).backgroundColor),
  ).not.toBe('rgba(0, 0, 0, 0)');
  await question.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Ask our AI' })).toBeFocused();
  await page.getByRole('button', { name: 'Ask our AI' }).click();
  await expect(question).toBeFocused();
  // Opening and typing without sending is not a conversation to continue.
  await question.fill('A draft I did not send');
  await question.press('Escape');
  await expect(page.getByRole('button', { name: 'Ask our AI' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Continue conversation/ })).toHaveCount(0);
});

test('IME and Shift+Enter preserve input; Enter creates one turn and cards browse side by side', async ({
  page,
}) => {
  const question = page.getByRole('textbox', { name: 'Your question' });
  await question.fill('耳机采购');
  await question.dispatchEvent('compositionstart');
  await question.press('Enter');
  expect((await ledger(page)).runs).toHaveLength(0);
  await question.dispatchEvent('compositionend');
  await question.fill('耳机采购');
  await question.press('Shift+Enter');
  await expect(question).toHaveValue('耳机采购\n');
  await question.press('Enter');
  await expect(page.getByLabel('Answer status')).toContainText('Answer ready');
  expect((await ledger(page)).runs).toHaveLength(1);
  // Cards sit side by side; browsing them never asks the service again.
  const carousel = page.getByRole('region', { name: 'Product options' });
  await expect(carousel.locator('[data-product-id]')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Compare', exact: true })).toHaveCount(0);
  const first = carousel.getByRole('button', { name: 'Show product 1 of 2' });
  const second = carousel.getByRole('button', { name: 'Show product 2 of 2' });
  await expect(first).toHaveAttribute('aria-current', 'true');
  await second.click();
  await expect(second).toHaveAttribute('aria-current', 'true');
  await second.press('ArrowLeft');
  await expect(first).toHaveAttribute('aria-current', 'true');
  if (await carousel.getByRole('button', { name: 'Previous product' }).isVisible()) {
    await expect(carousel.getByRole('button', { name: 'Previous product' })).toBeDisabled();
    await carousel.getByRole('button', { name: 'Next product' }).click();
    await expect(carousel.getByRole('button', { name: 'Next product' })).toBeDisabled();
  }
  // With reduced motion the jump is immediate rather than an animated slide.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await second.click();
  expect(
    await carousel
      .locator('ul')
      .evaluate(
        (track) =>
          Math.abs(
            track.scrollLeft -
              Math.min(
                (track.children[1] as HTMLElement).offsetLeft,
                track.scrollWidth - track.clientWidth,
              ),
          ) <= 1,
      ),
  ).toBe(true);
  expect((await ledger(page)).runs).toHaveLength(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('closing during a turn preserves its answer without issuing stop', async ({ page }) => {
  await select(page, 'queued', true);
  await send(page);
  await page.getByRole('button', { name: 'Close assistant' }).click();
  await expect.poll(async () => (await ledger(page)).runs.length).toBe(1);
  // The closed launcher offers the conversation back and marks the finished answer.
  await expect(
    page.getByRole('button', { name: 'Continue conversation · New answer' }),
  ).toBeVisible();
  await page.getByRole('button', { name: /^Continue conversation/ }).click();
  await expect(page.locator('[data-launcher-notice]')).toHaveCount(0);
  await expect(page.getByLabel('Answer status')).toContainText('Answer ready');
  expect((await ledger(page)).stops).toEqual([]);
  await expect(page.locator('[data-message-role="visitor"]')).toHaveCount(1);
});

test('unknown stop stays uncertain, confirmed stop fences late text and reanswer uses a new identity', async ({
  page,
}) => {
  await select(page, 'stop_unconfirmed', true);
  await send(page);
  await expect(page.locator('[data-message-role="assistant"]')).toContainText(
    'checking the options',
  );
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByLabel('Answer status')).toContainText('not confirmed');
  await page.getByRole('button', { name: 'Check stop status' }).click();
  await expect(page.getByLabel('Answer status')).toContainText('has stopped');
  await expect(page.getByRole('dialog')).not.toContainText('LATE RESPONSE');
  await page.getByRole('button', { name: 'Answer again', exact: true }).click();
  expect((await ledger(page)).runs).toHaveLength(1);
  await page.getByRole('button', { name: 'Start new answer' }).click();
  await expect.poll(async () => (await ledger(page)).runs.length).toBe(2);
  const runs = (await ledger(page)).runs;
  expect(runs[0]?.turnKey).not.toBe(runs[1]?.turnKey);
  await expect(page.locator('[data-message-role="visitor"]')).toHaveCount(1);
  await expect(page.locator('[data-message-role="assistant"]')).toHaveCount(2);
});

test('interrupted answer resumes the same operation and cursor without repeated words', async ({
  page,
}) => {
  await select(page, 'network_failure', true);
  await send(page);
  await expect(page.getByLabel('Answer status')).toContainText('interrupted');
  await page.getByRole('button', { name: 'Resume this answer' }).click();
  await expect(page.getByLabel('Answer status')).toContainText('Answer ready');
  const runs = (await ledger(page)).runs;
  expect(runs).toHaveLength(2);
  expect(runs[1]).toEqual({ ...runs[0], cursor: 2 });
  await expect(page.locator('[data-message-role="assistant"]')).toHaveText(
    'Here is your answer from approved sources.',
  );
  await expect(page.locator('[data-message-role="visitor"]')).toHaveCount(1);
});

test('unsupported question produces an answer and still permits the next question', async ({
  page,
}) => {
  await select(page, 'out_of_scope', true);
  await send(page, 'Explain an unrelated topic.');
  await expect(page.getByLabel('Answer status')).toContainText('Answer ready');
  await expect(page.locator('[data-message-role="assistant"]')).toContainText('cannot verify');
  await send(page, 'Which products can you help with?');
  await expect.poll(async () => (await ledger(page)).runs.length).toBe(2);
});

test('completed answer permits the next question even if the old reader lingers', async ({
  page,
}) => {
  await select(page, 'streaming', true);
  await send(page);
  await expect(page.getByLabel('Answer status')).toContainText('Answer ready');
  await send(page, 'Please compare the two options.');
  await expect.poll(async () => (await ledger(page)).runs.length, { timeout: 1000 }).toBe(2);
});

test('server cooldown disables retry only until its supplied time', async ({ page }) => {
  await select(page, 'rate_limit', true);
  await send(page);
  await expect(page.getByRole('button', { name: 'Resume this answer' })).toBeDisabled();
  // While waiting, the visitor is told the way to the team that is still open.
  await expect(page.getByLabel('Answer status')).toContainText(
    'You can still send your requirement to our team with Prepare inquiry.',
  );
  await expect(page.getByRole('button', { name: 'Resume this answer' })).toBeEnabled();
  await page.getByRole('button', { name: 'Resume this answer' }).click();
  await expect(page.getByLabel('Answer status')).toContainText('Answer ready');
});

test('inquiry requires explicit consent and keeps values after validation errors', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Prepare inquiry', exact: true }).click();
  const form = page.getByRole('form', { name: 'Review your inquiry' });
  await expect(form.getByRole('checkbox')).not.toBeChecked();
  await form.getByLabel('Company').fill('Keep my company');
  await form.getByRole('button', { name: 'Confirm & submit' }).click();
  await expect(form.getByLabel('Your requirement')).toBeFocused();
  await expect(form.getByLabel('Company')).toHaveValue('Keep my company');
  expect((await ledger(page)).submissions).toHaveLength(0);
  await form.getByLabel('Your requirement').fill('500 gifts without a chosen model.');
  await form.getByRole('textbox', { name: /^Email/ }).fill('buyer@example.invalid');
  await form.getByRole('checkbox').check();
  await form.getByRole('button', { name: 'Hide inquiry' }).click();
  await expect(page.getByLabel('Your inquiry', { exact: true })).toContainText('not submitted');
  await page.getByRole('button', { name: 'Review your inquiry' }).click();
  await expect(form.getByLabel('Company')).toHaveValue('Keep my company');
  await form.getByRole('button', { name: 'Confirm & submit' }).click();
  await expect(page.getByLabel('Inquiry receipt')).toContainText('PREVIEW-001');
  expect((await ledger(page)).records).toBe(1);
});

test('unknown inquiry retries the frozen original key and body and creates only one record', async ({
  page,
}) => {
  await select(page, 'inquiry_unknown', true);
  const form = await fillInquiry(page);
  await form.getByRole('button', { name: 'Confirm & submit' }).click();
  await expect(form).toContainText('could not confirm the result yet');
  await expect(form.getByRole('textbox', { name: /^Email/ })).toBeDisabled();
  await form.getByRole('button', { name: 'Check again now' }).click();
  await expect(page.getByLabel('Inquiry receipt')).toContainText('PREVIEW-001');
  const result = await ledger(page);
  expect(result.submissions).toHaveLength(2);
  expect(result.submissions[0]).toEqual(result.submissions[1]);
  expect(result.records).toBe(1);
});

test('answering a new question cannot discard an in-flight inquiry receipt', async ({ page }) => {
  await select(page, 'inquiry_submitting', true);
  const form = await fillInquiry(page);
  await form.getByRole('button', { name: 'Confirm & submit' }).click();
  await expect(form.getByRole('button', { name: 'Saving…' })).toBeDisabled();
  await send(page, 'Can I change the color?');
  await expect(page.getByLabel('Your inquiry', { exact: true })).toContainText(
    'Saving your inquiry',
  );
  await expect(page.getByLabel('Answer status')).toContainText('Answer ready');
  await expect(page.getByLabel('Inquiry receipt')).toContainText('PREVIEW-001');
  await expect(page.getByLabel('Your inquiry', { exact: true })).toHaveCount(0);
  expect((await ledger(page)).records).toBe(1);
});

test('inquiry_is_inside_transcript and chat_remains_visible_during_edit', async ({ page }) => {
  await send(page);
  await expect(page.getByLabel('Answer status')).toContainText('Answer ready');
  const transcript = page.getByTestId('assistant-transcript');
  await transcript.getByRole('button', { name: 'Prepare inquiry', exact: true }).first().click();
  const form = transcript.getByRole('form', { name: 'Review your inquiry' });
  await expect(form).toBeVisible();
  await expect(form.getByLabel('Your requirement')).toBeFocused();
  await expect(page.locator('[data-message-role="visitor"]')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Back to chat' })).toHaveCount(0);
  await form.getByLabel('Company').fill('Keep my company');
  await send(page, 'Can the earbuds be engraved?');
  await expect(page.getByLabel('Answer status')).toContainText('Answer ready');
  await expect(page.locator('[data-message-role="visitor"]')).toHaveCount(2);
  await expect(form).toHaveCount(0);
  await expect(page.getByLabel('Your inquiry', { exact: true })).toBeInViewport();
  await page.getByRole('button', { name: 'Show inquiry' }).click();
  await expect(form.getByLabel('Company')).toHaveValue('Keep my company');
  expect((await ledger(page)).submissions).toHaveLength(0);
});

test('two_products_do_not_silently_swap_draft', async ({ page }) => {
  await send(page);
  await expect(page.getByLabel('Answer status')).toContainText('Answer ready');
  const transcript = page.getByTestId('assistant-transcript');
  const cards = transcript.getByRole('button', { name: 'Prepare inquiry', exact: true });
  await cards.nth(0).click();
  const form = transcript.getByRole('form', { name: 'Review your inquiry' });
  const first = (await form.locator('p', { hasText: 'Product:' }).textContent()) ?? '';
  await cards.nth(1).click();
  const update = form.getByLabel('Suggested update');
  await expect(update).toContainText('Update this inquiry?');
  await expect(update).toContainText('Product');
  await expect(form.locator('p', { hasText: 'Product:' })).toHaveText(first);
  await update.getByRole('button', { name: 'Keep current' }).click();
  await expect(update).toHaveCount(0);
  await expect(form.locator('p', { hasText: 'Product:' })).toHaveText(first);
});

test('model_update_shows_change_summary, manual_edit_not_overwritten_silently and changed_need_preserves_contact_and_clears_consent', async ({
  page,
}, info) => {
  await select(page, 'handoff', true);
  await send(page, '500 headphones for company gifts');
  await expect(page.getByLabel('Answer status')).toContainText('Answer ready');
  await page.getByRole('button', { name: 'Prepare inquiry', exact: true }).click();
  const form = page.getByRole('form', { name: 'Review your inquiry' });
  await expect(form.getByLabel('Your requirement')).toHaveValue('500 headphones for company gifts');
  await form.getByLabel('Your requirement').fill('500 headphones, my wording');
  await form.getByRole('textbox', { name: /^Email/ }).fill('buyer@example.invalid');
  await form.getByRole('checkbox').check();

  await send(page, 'Add custom packaging too');
  await expect(page.getByLabel('Your inquiry', { exact: true })).toContainText('Update suggested');
  await page.getByRole('button', { name: 'Show inquiry' }).click();
  const update = form.getByLabel('Suggested update');
  await expect(update).toContainText('Suggested update from the conversation');
  await expect(update).toContainText('500 headphones, my wording');
  await expect(update).toContainText('Add custom packaging too');
  await update.scrollIntoViewIfNeeded();
  await page.getByRole('dialog').screenshot({
    path: `output/assistant-ui/screens/${info.project.name}-inquiry_update.png`,
  });
  await expect(form.getByLabel('Your requirement')).toHaveValue('500 headphones, my wording');
  await update.getByRole('button', { name: 'Keep current' }).click();
  await expect(form.getByLabel('Your requirement')).toHaveValue('500 headphones, my wording');
  await expect(form.getByRole('checkbox')).toBeChecked();

  await send(page, '700 headphones with custom packaging');
  await page.getByRole('button', { name: 'Show inquiry' }).click();
  await form.getByLabel('Suggested update').getByRole('button', { name: 'Use update' }).click();
  await expect(form.getByLabel('Your requirement')).toHaveValue(
    '700 headphones with custom packaging',
  );
  await expect(form.getByRole('textbox', { name: /^Email/ })).toHaveValue('buyer@example.invalid');
  await expect(form.getByRole('checkbox')).not.toBeChecked();
  expect((await ledger(page)).submissions).toHaveLength(0);
});

test('saved_receipt_does_not_resubmit', async ({ page }) => {
  await select(page, 'handoff', true);
  await send(page, '500 headphones for company gifts');
  await expect(page.getByLabel('Answer status')).toContainText('Answer ready');
  const form = await fillInquiry(page);
  await form.getByRole('button', { name: 'Confirm & submit' }).click();
  const receipt = page.getByLabel('Inquiry receipt');
  await expect(receipt).toContainText('PREVIEW-001');
  await expect(receipt).toContainText('500 gifts; model not decided');
  await send(page, 'OK, thanks');
  await expect(page.getByLabel('Answer status')).toContainText('Answer ready');
  await expect(page.getByLabel('Your inquiry', { exact: true })).toHaveCount(0);
  await expect(form).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Start another inquiry' })).toBeVisible();
  const result = await ledger(page);
  expect(result.submissions).toHaveLength(1);
  expect(result.records).toBe(1);
});

test('restored long history keeps reader position when new messages arrive', async ({ page }) => {
  await page.getByRole('button', { name: 'Restore conversation' }).click();
  await expect(page.locator('[data-message-role]')).toHaveCount(40);
  const transcript = page.getByTestId('assistant-transcript');
  await expect.poll(() => transcript.evaluate((element) => element.scrollTop)).toBeGreaterThan(300);
  await transcript.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event('scroll'));
  });
  await send(page, 'A new question while reading.');
  await expect(page.getByLabel('Answer status')).toContainText('Answer ready');
  expect(await transcript.evaluate((element) => element.scrollTop)).toBeLessThan(20);
  await page.getByRole('button', { name: 'New messages · Jump to latest' }).click();
  await expect
    .poll(() =>
      transcript.evaluate(
        (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
      ),
    )
    .toBeLessThan(64);
});

test('expired conversation starts fresh without bringing back contact details', async ({
  page,
}) => {
  await select(page, 'history_expired');
  await page.getByRole('button', { name: 'Start new conversation' }).click();
  await expect(page.locator('[data-message-role]')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Your question' })).toBeEnabled();
  expect((await ledger(page)).submissions).toHaveLength(0);
});

test('short mobile screen remains usable', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await select(page, 'inquiry_review');
  await expect(page.getByLabel('Your requirement')).toBeInViewport();
  const panel = await page.getByRole('dialog').boundingBox();
  if (!panel) throw new Error('Panel is missing');
  expect(panel.width).toBeLessThanOrEqual(288);
  expect(panel.y).toBeGreaterThanOrEqual(0);
  await expect(page.getByRole('textbox', { name: 'Your question' })).toBeVisible();
  await page.getByRole('button', { name: 'Hide inquiry' }).click();
  await expect(page.getByLabel('Your inquiry', { exact: true })).toBeInViewport();
});

test('temporary history failure keeps the current discussion and retry can restore it', async ({
  page,
}) => {
  await select(page, 'history_restoring', true);
  await send(page, 'Keep this current conversation.');
  await expect(page.getByLabel('Answer status')).toContainText('Answer ready');
  await page.getByRole('button', { name: 'Restore conversation' }).click();
  await expect(page.getByRole('dialog')).toContainText('Your current conversation is kept');
  await expect(page.locator('[data-message-role="visitor"]')).toContainText(
    'Keep this current conversation.',
  );
  await expect(page.getByRole('textbox', { name: 'Your question' })).toBeEnabled();
  await page.getByRole('button', { name: 'Restore conversation' }).click();
  await expect(page.locator('[data-message-role]')).toHaveCount(40);
});

test('capture actual component screens for visual review', async ({ page }, info) => {
  const { mkdir } = await import('node:fs/promises');
  const directory = 'output/assistant-ui/screens';
  await mkdir(directory, { recursive: true });
  for (const scenario of ['welcome', 'product_results', 'inquiry_review']) {
    await select(page, scenario);
    await expect(page.getByRole('dialog')).toBeVisible();
    await page
      .getByRole('dialog')
      .screenshot({ path: `${directory}/${info.project.name}-${scenario}.png` });
  }
});
