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
});

test('IME and Shift+Enter preserve input; Enter creates one turn and cards can compare', async ({
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
  await page.getByRole('button', { name: 'Compare', exact: true }).first().click();
  await page.getByRole('button', { name: 'Compare', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Compare options' })).toContainText(
    'Compact wireless earbuds',
  );
  await page.getByRole('button', { name: 'Close comparison' }).click();
  await expect(page.getByRole('region', { name: 'Compare options' })).toHaveCount(0);
});

test('closing during a turn preserves its answer without issuing stop', async ({ page }) => {
  await select(page, 'queued', true);
  await send(page);
  await page.getByRole('button', { name: 'Close assistant' }).click();
  await expect.poll(async () => (await ledger(page)).runs.length).toBe(1);
  await page.getByRole('button', { name: 'Ask our AI' }).click();
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
  await form.getByRole('button', { name: 'Back to chat' }).click();
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
  await expect(form).toContainText('not confirmed the result');
  await expect(form.getByRole('textbox', { name: /^Email/ })).toBeDisabled();
  await form.getByRole('button', { name: 'Check original submission' }).click();
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
  await form.getByRole('button', { name: 'Back to chat' }).click();
  await send(page, 'Can I change the color?');
  await expect(page.getByLabel('Answer status')).toContainText('Answer ready');
  await page.getByRole('button', { name: 'Review your inquiry', exact: true }).click();
  await expect(page.getByLabel('Inquiry receipt')).toContainText('PREVIEW-001');
  expect((await ledger(page)).records).toBe(1);
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
  await expect(page.getByLabel('Your requirement')).toBeVisible();
  const panel = await page.getByRole('dialog').boundingBox();
  if (!panel) throw new Error('Panel is missing');
  expect(panel.width).toBeLessThanOrEqual(288);
  expect(panel.y).toBeGreaterThanOrEqual(0);
  await page.getByRole('button', { name: 'Back to chat' }).click();
  await expect(page.getByRole('textbox', { name: 'Your question' })).toBeVisible();
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
