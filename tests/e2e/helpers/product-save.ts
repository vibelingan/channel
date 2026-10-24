import { type Page, expect } from '@playwright/test';

/** Stop on a visible save rejection, rather than obscuring it as a dialog timeout. */
export async function expectProductSaved(page: Page, timeout = 30000) {
  const editor = page.getByRole('dialog', { name: 'Edit Product', exact: true });
  let outcome = 'saving';
  await expect
    .poll(
      async () => {
        if ((await editor.count()) === 0) outcome = 'saved';
        else if (await editor.locator('[data-record-form-error]').isVisible()) {
          // Only known categories may enter live CI output. Never echo arbitrary
          // backend payloads, private product content or credentials.
          const message = await editor.locator('[data-record-form-error]').innerText();
          outcome = /description images/i.test(message) ? 'description-media-error' : 'save-error';
        }
        return outcome !== 'saving';
      },
      { timeout },
    )
    .toBe(true);
  expect(outcome, 'Product save must finish successfully, not just stop loading').toBe('saved');
}
