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

test('admin inspects one Alibaba detail through the authenticated app boundary', async ({
  page,
}) => {
  await seedAdminSession(page);
  const inspectedIds: string[] = [];

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

  await page.route('**/api/alibaba-catalog-sync', async (route) => {
    const body = route.request().postDataJSON() as {
      action?: string;
      token?: string;
      data?: { sourceProductId?: string };
    };
    expect(body.token).toBe('valid-token');
    if (body.action === 'connectionStatus') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          data: { status: 'active', accountLabel: 'channeltec', notConfigured: false },
        }),
      });
      return;
    }
    if (body.action === 'inspectProductDetail' && body.data?.sourceProductId) {
      inspectedIds.push(body.data.sourceProductId);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          data: {
            sourceProductId: body.data.sourceProductId,
            payloadId: '1'.repeat(64),
            deduplicated: false,
            rawByteLength: 23_050,
            hasSubject: true,
            hasCategory: true,
            hasMoq: true,
            description: { kind: 'html', characterCount: 12_345 },
            imageCount: 6,
            skuCount: 3,
            skusWithAttributes: 3,
            attributeNameCount: 2,
            attributeNames: ['Color', 'Connectors'],
            productTierCount: 0,
            skuTieredPriceCount: 3,
            normalizedOfferCount: 3,
            normalizedPriceModes: ['tiered'],
            currency: 'USD',
            sourceStatus: 'published',
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

  await page.goto('/admin');
  await page.getByRole('button', { name: 'Alibaba Sync', exact: true }).click();
  const input = page.getByLabel('Alibaba product ID');
  await expect(input).toBeVisible();
  await input.fill('AAGmBBhgAOVTpOOZBg7MoZq_');
  await page.getByRole('button', { name: 'Inspect detail' }).click();

  await expect.poll(() => inspectedIds).toEqual(['AAGmBBhgAOVTpOOZBg7MoZq_']);
  const result = page.locator('[data-detail-inspection-result]');
  await expect(result).toContainText('23,050 bytes');
  await expect(result).toContainText('3 / 3');
  await expect(result).toContainText('tiered · USD');
  await expect(result).toContainText('Color, Connectors');
  await expect(result).not.toContainText('access-token');
});

test('Alibaba detail inspection remains usable without horizontal overflow on mobile', async ({
  page,
}) => {
  await seedAdminSession(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.route('**/api/admin', async (route) => {
    const body = route.request().postDataJSON() as { action?: string };
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
  await page.route('**/api/alibaba-catalog-sync', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        data: { status: 'active', accountLabel: 'channeltec', notConfigured: false },
      }),
    });
  });

  await page.goto('/admin');
  await page.getByRole('button', { name: 'Alibaba Sync', exact: true }).click();
  await expect(page.getByLabel('Alibaba product ID')).toBeVisible();
  const dimensions = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client);
});
