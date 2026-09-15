import { expect, test } from '@playwright/test';

test.describe('mobile account navigation', { tag: '@mobile-regression' }, () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
  for (const state of ['admin', 'expired', 'guest', 'member'] as const) {
    test(`${state} account follows a real destination from the mobile menu`, async ({
      page,
    }, testInfo) => {
      const user = {
        id: 'nav-test',
        username: 'admin',
        email: 'nav@example.test',
        role: state === 'member' ? 'member' : 'admin',
      };
      if (state !== 'guest')
        await page.addInitScript(
          ({ user }) => {
            if (location.pathname !== '/headphones/') return;
            localStorage.setItem('channel.token', 'navigation-fixture-only');
            localStorage.setItem('channel.user', JSON.stringify(user));
          },
          { user },
        );
      await page.route('**/api/admin', async (route) => {
        const action = route.request().postDataJSON().action;
        return route.fulfill({
          status: state === 'expired' ? 401 : 200,
          contentType: 'application/json',
          body: JSON.stringify(
            state === 'expired'
              ? { ok: false, error: { code: 'UNAUTHORIZED', message: 'Session expired' } }
              : {
                  ok: true,
                  data: action === 'me' ? { user } : { items: [], total: 0, page: 1, pageSize: 10 },
                },
          ),
        });
      });
      await page.goto('/headphones/');
      const mobile = page.getByRole('navigation', { name: 'Mobile', exact: true });
      await page.getByLabel('Toggle menu', { exact: true }).tap();
      const entry =
        state === 'guest'
          ? mobile.getByRole('link', { name: 'Admin portal', exact: true })
          : mobile.locator('[data-account-trigger]');
      await expect(entry).toHaveAttribute('href', state === 'member' ? '/account' : '/admin');
      if (process.env.E2E_RECORD_ARTIFACTS === '1')
        await page.screenshot({ path: testInfo.outputPath(`mobile-${state}-navigation.png`) });
      await entry.tap();
      if (state === 'expired' || state === 'guest') {
        await expect(page).toHaveURL(/\/login\/?\?returnTo=(?:\/|%2F)admin/);
        await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
      } else {
        await expect(page).toHaveURL(state === 'member' ? /\/account\/?$/ : /\/admin\/?$/);
        if (state === 'admin') await expect(page.getByText('Channel Admin')).toBeVisible();
      }
    });
  }

  test('account settings and sign out stay reachable; desktop dropdown remains available', async ({
    page,
  }) => {
    await page.goto('/headphones/');
    await page.evaluate(() => {
      localStorage.setItem('channel.token', 'navigation-fixture-only');
      localStorage.setItem(
        'channel.user',
        JSON.stringify({
          id: 'nav-test',
          username: 'LongAdminNameForLayoutTest',
          email: 'nav@example.test',
          role: 'admin',
        }),
      );
      dispatchEvent(new Event('channel:auth'));
    });
    const outer = page.locator('[data-mobile-disclosure]');
    await page.getByLabel('Toggle menu', { exact: true }).tap();
    const mobile = page.getByRole('navigation', { name: 'Mobile', exact: true });
    await expect(
      mobile.getByRole('link', { name: 'Account settings', exact: true }),
    ).toHaveAttribute('href', '/account');
    await expect(mobile.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator('[data-site-header]')).toHaveAttribute('data-header-mode', 'desktop');
    await expect(outer).not.toHaveAttribute('open', '');
    const desktop = page.locator('.header-desktop-account');
    await desktop.locator('[data-account-trigger]').click();
    await expect(desktop.getByRole('link', { name: 'Admin dashboard', exact: true })).toBeVisible();
    await expect(
      desktop.getByRole('link', { name: 'Account settings', exact: true }),
    ).toBeVisible();
    await page.setViewportSize({ width: 320, height: 568 });
    await expect(page.locator('[data-site-header]')).toHaveAttribute('data-header-mode', 'mobile');
    // Resize may open the mobile menu to preserve focus, so reconcile before toggling.
    if (!(await outer.evaluate((el: HTMLDetailsElement) => el.open)))
      await page.getByLabel('Toggle menu', { exact: true }).tap();
    const box = await mobile.locator('[data-account-menu]').boundingBox();
    expect(box?.x).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(320);
    await mobile.getByRole('button', { name: 'Sign out', exact: true }).tap();
    await expect(page).toHaveURL(/\/$/);
    expect(await page.evaluate(() => localStorage.getItem('channel.token'))).toBeNull();
    await page.getByLabel('Toggle menu', { exact: true }).tap();
    await expect(
      page
        .getByRole('navigation', { name: 'Mobile', exact: true })
        .getByRole('link', { name: 'Sign in', exact: true }),
    ).toBeVisible();
  });
});

const expectedCatalogLinks = [
  '/electronics-toys/',
  '/headphones/',
  '/ai-gadgets/',
  '/toys/',
  '/misc/',
];

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
  const active = disclosure.locator('a[href="/headphones/"]');
  const inactive = disclosure.locator('a[href="/toys/"]');
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
