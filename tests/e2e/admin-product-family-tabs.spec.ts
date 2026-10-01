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
      if (body.data?.pageSize !== 1) listBodies.push(body.data ?? {});
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
  await expect(tabs.getByRole('button')).toHaveCount(6);
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

  await tabs.getByRole('button', { name: /Needs classification/ }).click();
  await expect(page).toHaveURL(/productFamily=unclassified/);
  await expect.poll(() => listBodies.at(-1)?.needsClassification).toBe(true);
  expect(listBodies.at(-1)?.productFamily).toBeUndefined();
  await expect(page.getByText(/Source-wide rules are managed/)).toBeVisible();
  await page.getByRole('button', { name: 'New Product' }).click();
  await expect(page.locator('select#productFamily')).not.toHaveValue('unclassified');
  await page.getByRole('button', { name: 'Cancel' }).click();

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
  const section = page.getByRole('combobox', { name: 'Section' }).and(page.locator('button'));
  await section.click();
  await page
    .getByRole('listbox', { name: 'Section' })
    .getByRole('option', { name: 'Products', exact: true })
    .click();
  const select = page.locator('button[role="combobox"][aria-label="Product family"]');
  await expect(select).toBeVisible();
  await select.click();
  await page
    .getByRole('listbox', { name: 'Product family' })
    .getByRole('option', { name: 'Misc' })
    .click();
  await expect(select).toContainText('Misc');
  await expect(page).toHaveURL(/productFamily=misc/);
  await select.click();
  await page
    .getByRole('listbox', { name: 'Product family' })
    .getByRole('option', { name: /Needs classification/ })
    .click();
  await expect(page).toHaveURL(/productFamily=unclassified/);
  await expect(page.getByText(/Source-wide rules are managed/)).toBeVisible();
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
  for (const width of [375, 390, 734, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const geometry = await page.evaluate(() => ({
      viewport: window.innerWidth,
      documentClient: document.documentElement.clientWidth,
      documentScroll: document.documentElement.scrollWidth,
      navClient: document.querySelector('aside nav')?.clientWidth ?? 0,
      navScroll: document.querySelector('aside nav')?.scrollWidth ?? 0,
      tableClient: document.querySelector('table')?.parentElement?.clientWidth ?? 0,
      tableScroll: document.querySelector('table')?.parentElement?.scrollWidth ?? 0,
    }));
    expect(geometry.viewport).toBe(width);
    expect(geometry.documentScroll, `document overflow at ${width}px`).toBeLessThanOrEqual(
      geometry.documentClient,
    );
    expect(geometry.navScroll, `nav overflow at ${width}px`).toBeLessThanOrEqual(
      geometry.navClient,
    );
    expect(geometry.tableScroll, `table must scroll locally at ${width}px`).toBeGreaterThan(
      geometry.tableClient,
    );
  }
});

test('narrow section picker supports keyboard navigation without writes', async ({ page }) => {
  await seedAdminSession(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const writes: string[] = [];
  await page.route('**/api/admin', async (route) => {
    const body = route.request().postDataJSON() as { action?: string; data?: { kind?: string } };
    if (body.action === 'update' || body.action === 'create' || body.data?.kind === 'assignment')
      writes.push(body.action ?? 'unknown');
    await route.fulfill({
      status: 200,
      json:
        body.action === 'me'
          ? { ok: true, data: { user: adminUser } }
          : { ok: true, data: { items: [], total: 0, page: 1, pageSize: 20 } },
    });
  });
  await page.goto('/admin');
  const section = page.getByRole('combobox', { name: 'Section' }).and(page.locator('button'));
  await expect(section).toContainText('Users');
  await section.press('Enter');
  await section.press('ArrowDown');
  await section.press('Enter');
  await expect(page.getByRole('heading', { name: 'Products' })).toBeVisible();
  await expect(section).toContainText('Products');
  await section.press('Home');
  await section.press('Enter');
  await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible();
  expect(writes).toEqual([]);
});

test('narrow section picker excludes admin-only sections for contributors', async ({ page }) => {
  const contributor = { ...adminUser, role: 'contributor' as const };
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript((user) => {
    localStorage.setItem('channel.token', 'valid-token');
    localStorage.setItem('channel.user', JSON.stringify(user));
  }, contributor);
  await page.route('**/api/admin', async (route) => {
    const body = route.request().postDataJSON() as { action?: string };
    await route.fulfill({
      status: 200,
      json:
        body.action === 'me'
          ? { ok: true, data: { user: contributor } }
          : { ok: true, data: { items: [], total: 0, page: 1, pageSize: 20 } },
    });
  });
  await page.goto('/admin');
  const section = page.getByRole('combobox', { name: 'Section' }).and(page.locator('button'));
  await expect(section).toContainText('Products');
  await section.click();
  const options = page.getByRole('listbox', { name: 'Section' });
  await expect(options.getByRole('option', { name: 'Users' })).toHaveCount(0);
  await expect(options.getByRole('option', { name: 'Alibaba Sync' })).toHaveCount(0);
  await expect(options.getByRole('option', { name: 'Products' })).toBeVisible();
});

test('auth presentation is VIP-free on login and registration pages', async ({ page }) => {
  for (const path of ['/login', '/register']) {
    await page.goto(path);
    expect(await page.locator('body').innerText()).not.toMatch(
      /\bVIP\b|unlock\s+(?:VIP\s+)?pricing/i,
    );
  }
});
