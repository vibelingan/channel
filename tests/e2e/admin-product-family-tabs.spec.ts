import { type Page, expect, test } from '@playwright/test';

const adminUser = {
  id: 'user-1',
  email: 'admin@example.test',
  username: 'Admin',
  role: 'admin',
} as const;

async function seedAdminSession(page: Page) {
  await page.addInitScript((user) => {
    if (!window.location.pathname.startsWith('/admin')) return;
    localStorage.setItem('channel.token', 'valid-token');
    localStorage.setItem('channel.user', JSON.stringify(user));
  }, adminUser);
}

test('Products family tabs compose list queries, recover URL state, and prefill New', async ({
  page,
}) => {
  await seedAdminSession(page);
  const listBodies: Array<Record<string, unknown>> = [];
  await page.route('**/api/admin', async (route) => {
    const body = route.request().postDataJSON() as {
      action?: string;
      data?: Record<string, unknown>;
    };
    if (body.action === 'me') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, data: { user: adminUser } }),
      });
      return;
    }
    if (body.action === 'list') {
      listBodies.push(body.data ?? {});
      const productsPage = body.data?.collection === 'products';
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          data: {
            items: productsPage
              ? [{ _id: 'product-1', name: 'Product One', productFamily: 'toys' }]
              : [],
            total: productsPage ? 40 : 0,
            page: body.data?.page ?? 1,
            pageSize: 20,
          },
        }),
      });
      return;
    }
    await route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: false,
        error: { code: 'BAD_REQUEST', message: 'Unexpected action' },
      }),
    });
  });

  await page.goto('/admin?productFamily=toys');
  await page.getByRole('button', { name: 'Products', exact: true }).click();
  const tabs = page.getByRole('group', { name: 'Product family', exact: true });
  await expect(tabs.getByRole('button')).toHaveCount(5);
  await expect(tabs.getByRole('button', { name: 'Toys', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect.poll(() => listBodies.at(-1)?.productFamily).toBe('toys');

  await page.getByRole('button', { name: 'Next' }).click();
  await expect.poll(() => listBodies.at(-1)?.page).toBe(2);
  await page.getByRole('checkbox', { name: 'Select row' }).check();
  await expect(page.getByText('1 selected')).toBeVisible();

  await tabs.getByRole('button', { name: 'AI Gadgets' }).click();
  await expect(page).toHaveURL(/productFamily=ai-gadgets/);
  await expect.poll(() => listBodies.at(-1)?.productFamily).toBe('ai-gadgets');
  expect(listBodies.at(-1)?.page).toBe(1);
  await expect(page.getByText('1 selected')).toHaveCount(0);

  await page.getByRole('button', { name: 'New Product' }).click();
  await expect(page.locator('select#productFamily')).toHaveValue('ai-gadgets');
  await page.getByRole('button', { name: 'Cancel' }).click();

  await page.goBack();
  await expect(tabs.getByRole('button', { name: 'Toys', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect.poll(() => listBodies.at(-1)?.productFamily).toBe('toys');

  await tabs.getByRole('button', { name: 'All products' }).click();
  await expect(page).not.toHaveURL(/productFamily=/);
  await expect.poll(() => listBodies.at(-1)?.productFamily).toBeUndefined();

  await page.getByRole('button', { name: 'Users', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Product family', exact: true })).toHaveCount(0);
});

test('mobile Products view exposes a full-width family select', async ({ page }) => {
  await seedAdminSession(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.route('**/api/admin', async (route) => {
    const body = route.request().postDataJSON() as {
      action?: string;
      data?: Record<string, unknown>;
    };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        body.action === 'me'
          ? { ok: true, data: { user: adminUser } }
          : { ok: true, data: { items: [], total: 0, page: 1, pageSize: 20 } },
      ),
    });
  });

  await page.goto('/admin');
  await page.getByRole('button', { name: 'Products', exact: true }).click();
  const select = page.locator('button[role="combobox"][aria-label="Product family"]');
  await expect(select).toBeVisible();
  await select.click();
  await page
    .getByRole('listbox', { name: 'Product family' })
    .getByRole('option', { name: 'Other Electronics & Toys' })
    .click();
  await expect(select).toContainText('Other Electronics & Toys');
  await expect(page).toHaveURL(/productFamily=misc/);
  await select.click();
  await page
    .getByRole('listbox', { name: 'Product family' })
    .getByRole('option', { name: 'All products' })
    .click();
  await expect(select).toContainText('All products');
  await expect(page).not.toHaveURL(/productFamily=/);
  await expect(page.getByRole('link', { name: 'Back to site' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  const dimensions = await page.evaluate(() => ({
    body: document.body.clientWidth,
    bodyScroll: document.body.scrollWidth,
    tableClient: document.querySelector('table')?.parentElement?.clientWidth ?? 0,
    tableScroll: document.querySelector('table')?.parentElement?.scrollWidth ?? 0,
  }));
  expect(dimensions.bodyScroll).toBeLessThanOrEqual(dimensions.body);
  expect(dimensions.tableScroll).toBeGreaterThan(dimensions.tableClient);
});

test('auth presentation is VIP-free on login and registration pages', async ({ page }) => {
  for (const path of ['/login', '/register']) {
    await page.goto(path);
    expect(await page.locator('body').innerText()).not.toMatch(
      /\bVIP\b|unlock\s+(?:VIP\s+)?pricing/i,
    );
  }
});
