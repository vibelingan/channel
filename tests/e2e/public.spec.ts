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

  test('public catalog payloads never ship role-gated pricing or raw internal fields', async ({
    request,
  }) => {
    // The unauthenticated API projects an explicit allowlist: vipPrice is
    // role-gated in the UI and must not ride along in the network payload for
    // anonymous callers (the client-side gate is cosmetic).
    for (const path of ['/api/products?pageSize=48', '/api/overstock?pageSize=48']) {
      const response = await request.get(`${e2e.apiUrl}${path}`, {
        headers: { Origin: e2e.siteUrl },
      });
      expect(response.status()).toBe(200);
      const body = (await response.json()) as {
        ok: boolean;
        data?: { items?: Record<string, unknown>[] };
      };
      const items = body.data?.items ?? [];
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) {
        expect(item, `vipPrice leaked in ${path}`).not.toHaveProperty('vipPrice');
        expect(item, `imageIds leaked in ${path}`).not.toHaveProperty('imageIds');
        expect(item, `createdAt leaked in ${path}`).not.toHaveProperty('createdAt');
      }
      // Detail route runs the same projection.
      const first = items[0];
      const firstId = first?._id;
      if (typeof firstId !== 'string') throw new Error(`no _id on first ${path} item`);
      const detail = await request.get(
        `${e2e.apiUrl}${path.split('?')[0]}/${encodeURIComponent(firstId)}`,
        { headers: { Origin: e2e.siteUrl } },
      );
      expect(detail.status()).toBe(200);
      const detailBody = (await detail.json()) as { data?: Record<string, unknown> };
      expect(detailBody.data).not.toHaveProperty('vipPrice');
      expect(detailBody.data).not.toHaveProperty('imageIds');
    }
  });

  test('public image delivery sends nosniff and an allowlisted Content-Type', async ({
    request,
  }) => {
    // Find a real image URL from the published catalog rather than hardcoding
    // a seed id, so the test survives seed-data changes.
    const list = await request.get(`${e2e.apiUrl}/api/products?pageSize=48`, {
      headers: { Origin: e2e.siteUrl },
    });
    const body = (await list.json()) as { data?: { items?: { images?: string[] }[] } };
    const imagePath = body.data?.items?.flatMap((item) => item.images ?? [])[0];
    if (!imagePath) throw new Error('expected at least one published product image');

    const image = await request.get(
      imagePath.startsWith('http') ? imagePath : `${e2e.apiUrl}${imagePath}`,
      { headers: { Origin: e2e.siteUrl } },
    );
    expect(image.status()).toBe(200);
    expect(image.headers()['x-content-type-options']).toBe('nosniff');
    expect(image.headers()['content-security-policy']).toBe("default-src 'none'; sandbox");
    const contentType = image.headers()['content-type'] ?? '';
    expect(
      ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'].some((allowed) =>
        contentType.startsWith(allowed),
      ),
      `Content-Type ${contentType} must come from the image allowlist`,
    ).toBe(true);
  });

  test('signed-in member gets VIP pricing from the catalog; anonymous does not', async ({
    request,
  }) => {
    // The public catalog is unauthenticated, but a valid session token unlocks
    // the role-gated VIP tier server-side. Uses the local seed's member account;
    // on a deployed env without that sample account, skip rather than fail.
    const loginRes = await request.post(`${e2e.apiUrl}/api/admin`, {
      data: { action: 'login', data: { email: 'member@channel.local', password: 'password' } },
    });
    const loginBody = (await loginRes.json()) as { ok: boolean; data?: { token?: string } };
    const token = loginBody.data?.token;
    test.skip(!loginBody.ok || !token, 'seeded member account unavailable in this environment');

    const anon = await request.get(`${e2e.apiUrl}/api/products?pageSize=1`, {
      headers: { Origin: e2e.siteUrl },
    });
    const anonItem = ((await anon.json()) as { data: { items: Record<string, unknown>[] } }).data
      .items[0];
    expect(anonItem, 'anonymous callers must not receive vipPrice').not.toHaveProperty('vipPrice');

    const authed = await request.get(`${e2e.apiUrl}/api/products?pageSize=1`, {
      headers: { Origin: e2e.siteUrl, Authorization: `Bearer ${token}` },
    });
    const authedItem = ((await authed.json()) as { data: { items: Record<string, unknown>[] } })
      .data.items[0];
    expect(typeof authedItem?.vipPrice, 'entitled member must receive vipPrice').toBe('number');
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
