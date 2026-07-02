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
    for (const path of ['/', '/admin', '/login', '/oem', '/portfolio']) {
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

  test('Success Stories certificates open in an accessible lightbox', async ({ page }) => {
    await page.goto('/portfolio', { waitUntil: 'domcontentloaded' });

    // Both certificate groups render (company + product).
    await expect(page.getByRole('heading', { name: 'Company & compliance' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Product test reports' })).toBeVisible();

    // Every certificate exposes an enlargement control.
    const triggers = page.getByRole('button', { name: /Enlarge certificate/i });
    expect(await triggers.count()).toBeGreaterThan(0);

    // Opening a certificate shows a modal <dialog>; Escape closes it.
    const dialog = page.locator('dialog.cert-dialog').first();
    await expect(dialog).toBeHidden();
    await triggers.first().click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('OEM factory block renders the facility video', async ({ page }) => {
    await page.goto('/oem', { waitUntil: 'domcontentloaded' });
    // The client-provided factory video is wired: /oem emits a muted autoplay
    // <video> with an mp4 source. See docs/oem-refresh/DESIGN.md.
    await expect(page.locator('video')).toHaveCount(1);
    await expect(page.locator('video source[src*="oem-factory"]')).toHaveCount(1);
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
