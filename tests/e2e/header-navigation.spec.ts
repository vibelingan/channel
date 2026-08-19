import { expect, test } from '@playwright/test';

const expectedCatalogLinks = ['/electronics-toys', '/headphones', '/ai-gadgets', '/toys', '/misc'];

test('desktop catalog disclosure exposes five links and returns focus on Escape', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const header = page.locator('[data-site-header]');
  await expect(header).toHaveAttribute('data-header-mode', 'desktop');
  const disclosure = page.locator('[data-catalog-disclosure="desktop"]');
  const summary = disclosure.locator(':scope > summary');
  await summary.click();
  await expect(disclosure).toHaveAttribute('open', '');
  const links = disclosure.locator('[data-catalog-menu] a');
  await expect(links).toHaveCount(5);
  expect(
    await links.evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute('href'))),
  ).toEqual(expectedCatalogLinks);

  await links.first().focus();
  await page.keyboard.press('Escape');
  await expect(disclosure).not.toHaveAttribute('open', '');
  await expect(summary).toBeFocused();
});

test('mobile outer and nested disclosures dismiss independently with 44px controls', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/');
  const header = page.locator('[data-site-header]');
  await expect(header).toHaveAttribute('data-header-mode', 'mobile');
  const outer = page.locator('[data-mobile-disclosure]');
  const toggle = outer.locator(':scope > summary');
  const bounds = await toggle.boundingBox();
  expect(bounds?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(bounds?.height ?? 0).toBeGreaterThanOrEqual(44);

  await toggle.click();
  const nested = page.locator('[data-catalog-disclosure="mobile"]');
  const nestedSummary = nested.locator(':scope > summary');
  await nestedSummary.click();
  await nested.locator('[data-catalog-menu] a').first().focus();
  await page.keyboard.press('Escape');
  await expect(nested).not.toHaveAttribute('open', '');
  await expect(nestedSummary).toBeFocused();
  await expect(outer).toHaveAttribute('open', '');

  await page.keyboard.press('Escape');
  await expect(outer).not.toHaveAttribute('open', '');
  await expect(toggle).toBeFocused();

  await toggle.click();
  await nestedSummary.click();
  await page.locator('[data-brand-link]').click();
  await expect(outer).not.toHaveAttribute('open', '');
  await expect(nested).not.toHaveAttribute('open', '');
});

test('current family is indicated semantically and visually', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/headphones/');
  await expect(page.locator('[data-site-header]')).toHaveAttribute('data-header-mode', 'desktop');
  const disclosure = page.locator('[data-catalog-disclosure="desktop"]');
  await disclosure.locator(':scope > summary').click();
  const active = disclosure.locator('a[href="/headphones"]');
  const inactive = disclosure.locator('a[href="/toys"]');
  await expect(active).toHaveAttribute('aria-current', 'page');
  const styles = await Promise.all(
    [active, inactive].map((link) =>
      link.evaluate((element) => {
        const style = getComputedStyle(element);
        return { backgroundColor: style.backgroundColor, color: style.color };
      }),
    ),
  );
  expect(styles[0]).not.toEqual(styles[1]);
});
