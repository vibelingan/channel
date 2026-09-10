import { type Page, expect } from '@playwright/test';

/** Wait for the saved server revision, never an option label or explanatory copy. */
export async function expectInquirySaved(page: Page, version: number, status: string) {
  const panel = page.getByRole('region', { name: 'Process inquiry' });
  await expect(panel).toHaveAttribute('data-inquiry-version', String(version));
  await expect(panel.locator('p').filter({ hasText: 'Current status:' })).toHaveText(
    `Current status: ${status}`,
  );
  // The editor remounts on version changes, so a transient success message is
  // not an acknowledgement contract. The refreshed version/status are.
  await expect(panel.getByRole('button', { name: 'Save follow-up', exact: true })).toBeDisabled();
}
