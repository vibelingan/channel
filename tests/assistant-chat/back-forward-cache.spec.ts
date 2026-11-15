import { expect, test } from '@playwright/test';

// Ordinary browsers may show a page again from their back-forward cache, with
// its old memory, after the visitor asked something on the page in between.
// Neither Playwright nor the Vite test server lets Chromium cache these pages
// (an open dev-server socket makes them ineligible), so this test advances the
// conversation behind the page's back and fires the event the browser fires.
test('a page restored from the back-forward cache catches up with the conversation', async ({
  page,
}) => {
  await page.goto('/assistant-chat.html');
  await page.getByRole('textbox', { name: 'Your question' }).fill('Asked on this page');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByLabel('Answer status')).toContainText('Answer ready');

  // What another page in this tab would have done: ask with the tab's credential.
  await page.evaluate(async () => {
    const key = Object.keys(sessionStorage).find((k) => k.startsWith('channel.ai.v2.'));
    const saved = JSON.parse(sessionStorage.getItem(key ?? '') ?? '{}');
    const response = await fetch(`/api/ai/v2/conversations/${saved.conversationId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${saved.credential}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: 'Asked on the next page',
        idempotencyKey: crypto.randomUUID(),
      }),
    });
    if (!response.ok) throw new Error(`append failed: ${response.status}`);
  });
  await expect(page.locator('[data-message-role="visitor"]')).toHaveCount(1);

  await expect
    .poll(async () => {
      await page.evaluate(() =>
        dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })),
      );
      return page.locator('[data-message-role="assistant"]').count();
    })
    .toBe(2);
  await expect(page.locator('[data-message-role="visitor"]')).toHaveText([
    'Asked on this page',
    'Asked on the next page',
  ]);
  await expect(page.locator('[data-message-role="assistant"]').last()).toContainText(
    'database and worker',
  );
});
