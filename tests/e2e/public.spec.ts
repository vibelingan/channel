import { type Page, expect, test } from '@playwright/test';
import { e2e } from './helpers/env';

function captureConsoleProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
  page.on('pageerror', (error) => problems.push(error.message));
  return problems;
}

test.describe('public browser smoke', () => {
  test('core pages render from the configured site origin', async ({ context }) => {
    for (const path of ['/', '/admin', '/login', '/oem']) {
      const page = await context.newPage();
      const problems = captureConsoleProblems(page);
      await page.goto(path, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('body')).toBeVisible();
      expect(problems, `console/page errors while rendering ${path}`).toEqual([]);
      await page.close();
    }
  });

  test('public API is reachable, CORS-enabled, and files stay private', async ({ request }) => {
    const health = await request.get(`${e2e.apiUrl}/api/health`, {
      headers: { Origin: e2e.siteUrl },
    });
    expect(health.status()).toBe(200);
    expect([e2e.siteUrl, '*']).toContain(health.headers()['access-control-allow-origin']);
    await expect(health).toBeOK();
    await expect(await health.json()).toMatchObject({
      ok: true,
      data: { status: 'ok', service: 'public-api' },
    });

    for (const path of ['/api/products?pageSize=1', '/api/overstock?pageSize=1']) {
      const response = await request.get(`${e2e.apiUrl}${path}`, {
        headers: { Origin: e2e.siteUrl },
      });
      expect(response.status()).toBe(200);
      const body = (await response.json()) as {
        ok: boolean;
        data?: { items?: unknown[]; total?: number };
      };
      expect(body.ok).toBe(true);
      expect(Array.isArray(body.data?.items)).toBe(true);
      expect(typeof body.data?.total).toBe('number');
    }

    const files = await request.get(`${e2e.apiUrl}/api/files/e2e-missing`, {
      headers: { Origin: e2e.siteUrl },
    });
    expect(files.status()).toBe(404);
  });

  // Headphones storefront is hidden (un-routed) on the OEM-only site; this page
  // test moves to the future standalone headphones site. See docs/oem-refresh/DESIGN.md.
  test.skip('headphones page hydrates and resolves catalog loading state', async ({ page }) => {
    const problems = captureConsoleProblems(page);
    const productsResponse = page.waitForResponse(
      (response) => response.url().includes('/api/products') && response.status() === 200,
    );

    await page.goto('/headphones', { waitUntil: 'domcontentloaded' });
    await productsResponse;

    await expect(page.getByRole('heading', { name: 'Headphones' })).toBeVisible();
    await expect(page.locator('.animate-pulse')).toHaveCount(0, { timeout: 15_000 });
    await expect
      .poll(async () => {
        const emptyStates = await page.getByText(/No products match/i).count();
        const cards = await page.locator('a[href^="/headphone-item"]').count();
        return emptyStates + cards;
      })
      .toBeGreaterThan(0);
    expect(problems).toEqual([]);
  });
});
