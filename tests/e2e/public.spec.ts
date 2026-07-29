import { type Page, expect, test } from '@playwright/test';
import { teardownBomSource } from '../fixtures/teardown-bom-source.ts';
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

  test('Slide 2 header keeps the company name without restoring MOQ', async ({ page }) => {
    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await expect(page.locator('[data-company-name]')).toHaveText('Diversity Technology Limited');
      await expect(page.locator('[data-company-name]')).toBeVisible();
      await expect(page.getByText('Minimum Order Amount: $500', { exact: true })).toHaveCount(0);
      await expect(page.locator('[data-primary-nav]')).toBeVisible();
      await expect(page.locator('[data-account-controls]')).toBeVisible();
      const regions = await page.evaluate(() => {
        const box = (selector: string) => {
          const rect = document.querySelector(selector)?.getBoundingClientRect();
          return rect ? { left: rect.left, right: rect.right } : undefined;
        };
        return {
          brand: box('[data-brand-link]'),
          nav: box('[data-primary-nav]'),
          account: box('[data-account-controls]'),
        };
      });
      expect(regions.brand?.right).toBeLessThanOrEqual(regions.nav?.left ?? 0);
      expect(regions.nav?.right).toBeLessThanOrEqual(regions.account?.left ?? 0);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-company-name]')).toBeVisible();
    await expect(page.locator('[data-company-name]')).toHaveText('Diversity Technology Limited');
    await expect(page.locator('[data-site-header] img')).toBeVisible();
    const toggle = page.getByRole('button', { name: 'Toggle menu' });
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const mobileMenu = page.getByRole('navigation', { name: 'Mobile' });
    await expect(mobileMenu).toBeHidden();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(mobileMenu).toBeVisible();
    for (const label of [
      'OEM Development',
      'Headphones',
      'Success Stories',
      'Teardown Lab',
      'Blue Ocean',
    ]) {
      await expect(mobileMenu.getByRole('link', { name: label, exact: true })).toBeVisible();
    }
    await expect(mobileMenu.getByRole('link', { name: 'Headphones', exact: true })).toHaveAttribute(
      'href',
      '/headphones',
    );
    await expect(mobileMenu.getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
    await expect(mobileMenu.getByRole('link', { name: 'Register', exact: true })).toBeVisible();
    await expect(page.getByText('Minimum Order Amount: $500', { exact: true })).toHaveCount(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);

    await page.setViewportSize({ width: 767, height: 768 });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-menu-toggle]')).toBeVisible();
    await expect(page.locator('[data-primary-nav]')).toBeHidden();

    for (const viewport of [
      { width: 768, height: 768 },
      { width: 1024, height: 768 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await expect(page.locator('[data-company-name]')).toBeVisible();
      await expect(page.locator('[data-company-name]')).toHaveText('Diversity Technology Limited');
      await expect(page.locator('[data-site-header] img')).toBeVisible();
      await expect(page.locator('[data-menu-toggle]')).toBeHidden();
      await expect(page.locator('[data-primary-nav]')).toBeVisible();
      await expect(page.locator('[data-account-controls]')).toBeVisible();
      const headphonesLink = page
        .locator('[data-primary-nav]')
        .getByRole('link', { name: 'Headphones', exact: true });
      await expect(headphonesLink).toBeVisible();
      await expect(headphonesLink).toHaveAttribute('href', '/headphones');
      await expect(page.getByText('Minimum Order Amount: $500', { exact: true })).toHaveCount(0);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    }
  });

  test('Headphones products remain visibly rendered after client catalog load', async ({
    page,
  }) => {
    if (new URL(e2e.siteUrl).hostname === 'localhost') {
      await page.route('**/api/products?**', async (route) => {
        const response = await route.fetch();
        await route.fulfill({
          response,
          headers: {
            ...response.headers(),
            'access-control-allow-origin': e2e.siteUrl,
          },
        });
      });
    }

    for (const viewport of [
      { width: 390, height: 844 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto('/headphones', { waitUntil: 'domcontentloaded' });
      const cloudBaseNotice = page.getByRole('button', { name: '确定访问', exact: true });
      if (await cloudBaseNotice.isVisible()) await cloudBaseNotice.click();

      const productCards = page.locator('[data-product-card]');
      await expect.poll(() => productCards.count()).toBeGreaterThan(0);

      for (const productCard of await productCards.all()) {
        const rendered = await productCard.evaluate((element) => {
          if (!(element instanceof HTMLElement)) throw new Error('Product card is not HTML');
          const hiddenAncestors: string[] = [];
          let current: HTMLElement | null = element;
          while (current && current !== document.body) {
            const style = getComputedStyle(current);
            if (
              Number(style.opacity) < 1 ||
              style.visibility === 'hidden' ||
              style.display === 'none'
            ) {
              hiddenAncestors.push(`${current.tagName.toLowerCase()}.${current.className}`);
            }
            current = current.parentElement;
          }
          const rect = element.getBoundingClientRect();
          return { hiddenAncestors, width: rect.width, height: rect.height };
        });

        expect(rendered.hiddenAncestors, `hidden product ancestors at ${viewport.width}px`).toEqual(
          [],
        );
        expect(rendered.width).toBeGreaterThan(0);
        expect(rendered.height).toBeGreaterThan(0);
      }

      await productCards.first().click();
      await expect(page.locator('[data-product-detail]')).toBeVisible();
      await page.getByRole('button', { name: 'Back to all models', exact: true }).click();
      await expect(page.locator('[data-product-detail]')).toHaveCount(0);
      await expect(productCards.first()).toBeVisible();
    }
  });

  test('Slide 4 factory gallery moves from exteriors to production and making details', async ({
    page,
  }) => {
    await page.goto('/#factory', { waitUntil: 'domcontentloaded' });
    const gallery = page.getByRole('region', {
      name: 'Factory development and production gallery',
    });
    await gallery.evaluate((element) => element.scrollIntoView({ block: 'center' }));
    await expect(gallery.locator('img')).toHaveCount(10);
    for (const image of await gallery.locator('img').all()) {
      await expect(image).toHaveAttribute('loading', 'lazy');
    }
    expect(
      await gallery
        .locator('img')
        .evaluateAll((images) => images.map((image) => image.getAttribute('src'))),
    ).toEqual([
      '/media/oem/factory/f03.jpg',
      '/media/oem/factory/f10.jpg',
      '/media/oem/factory/f07.jpg',
      '/media/oem/factory/f08.jpg',
      '/media/oem/factory/f04.jpg',
      '/media/oem/factory/f09.jpg',
      '/media/oem/factory/f05.jpg',
      '/media/oem/factory/f01.jpg',
      '/media/oem/factory/f02.jpg',
      '/media/oem/factory/f06.jpg',
    ]);
    for (const image of await gallery.locator('img').all()) {
      await image.scrollIntoViewIfNeeded();
      await expect
        .poll(() =>
          image.evaluate((element) => {
            const img = element as HTMLImageElement;
            return img.complete && img.naturalWidth > 0;
          }),
        )
        .toBe(true);
    }
  });

  test('public site footer links the ICP filing number to the MIIT homepage', async ({ page }) => {
    for (const path of ['/', '/oem', '/portfolio']) {
      await page.goto(path, { waitUntil: 'domcontentloaded' });
      const filing = page.getByRole('link', { name: '粤ICP备2026092477号-1', exact: true });
      await expect(filing, `ICP filing link on ${path}`).toHaveCount(1);
      await expect(filing).toHaveAttribute('href', 'https://beian.miit.gov.cn/');
      await expect(filing).toHaveAttribute('target', '_blank');
      await expect(filing).toHaveAttribute('rel', 'noopener noreferrer');
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
    // Guard against an empty catalog: `not.toHaveProperty` passes vacuously on
    // `undefined`, so only assert when we actually have a real item to inspect.
    if (anonItem) {
      expect(anonItem, 'anonymous callers must not receive vipPrice').not.toHaveProperty(
        'vipPrice',
      );
    }

    const authed = await request.get(`${e2e.apiUrl}/api/products?pageSize=1`, {
      headers: { Origin: e2e.siteUrl, Authorization: `Bearer ${token}` },
    });
    const authedItem = ((await authed.json()) as { data: { items: Record<string, unknown>[] } })
      .data.items[0];
    expect(typeof authedItem?.vipPrice, 'entitled member must receive vipPrice').toBe('number');
  });

  test('Success Stories galleries expose carousel controls on mobile and tablet', async ({
    page,
  }) => {
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 768, height: 1024 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto('/portfolio', { waitUntil: 'domcontentloaded' });

      const logoCarousel = page.locator('#customers [data-carousel]');
      await logoCarousel.scrollIntoViewIfNeeded();
      await expect(logoCarousel.locator('[data-carousel-slide]')).toHaveCount(13);
      await expect(logoCarousel.locator('[data-carousel-controls]')).toBeVisible();
      await expect(
        logoCarousel.getByRole('button', { name: 'Previous slide', exact: true }),
      ).toBeVisible();
      await expect(
        logoCarousel.getByRole('button', { name: 'Next slide', exact: true }),
      ).toBeVisible();
      await expect(page.locator('#certificates [data-carousel]').first()).toBeVisible();
      await expect(page.locator('#certificates [data-carousel-controls]').first()).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    }
  });

  test('Success Stories carousel auto-advances and pauses after keyboard input', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/portfolio', { waitUntil: 'domcontentloaded' });

    const logoCarousel = page.locator('#customers [data-carousel]');
    await logoCarousel.scrollIntoViewIfNeeded();
    const position = logoCarousel.locator('[data-carousel-position]');
    await expect(position).toHaveText('1 / 13');
    await expect.poll(() => position.textContent(), { timeout: 7_000 }).not.toBe('1 / 13');

    const track = logoCarousel.locator('[data-carousel-track]');
    await track.focus();
    const positionBeforeInput = await position.textContent();
    await page.keyboard.press('ArrowRight');
    await expect(position).not.toHaveText(positionBeforeInput ?? '');
    await expect(
      logoCarousel.getByRole('button', { name: 'Resume automatic rotation', exact: true }),
    ).toBeVisible();
    await page.waitForTimeout(750);
    const pausedPosition = await position.textContent();
    await page.waitForTimeout(5_250);
    await expect(position).toHaveText(pausedPosition ?? '');
  });

  test('Success Stories carousel disables autoplay for reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/portfolio', { waitUntil: 'domcontentloaded' });

    const logoCarousel = page.locator('#customers [data-carousel]');
    await logoCarousel.scrollIntoViewIfNeeded();
    await expect(logoCarousel.locator('[data-carousel-position]')).toHaveText('1 / 13');
    await expect(
      logoCarousel.getByRole('button', {
        name: 'Automatic rotation disabled by reduced motion preference',
        exact: true,
      }),
    ).toBeDisabled();
  });

  test('Success Stories keeps desktop logo grids and certificate lightboxes', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/portfolio', { waitUntil: 'domcontentloaded' });

    const logoCarousel = page.locator('#customers [data-carousel]');
    await expect(logoCarousel.locator('[data-carousel-slide]')).toHaveCount(13);
    await expect(logoCarousel.locator('img')).toHaveCount(13);
    await expect(logoCarousel.locator('[data-carousel-controls]')).toBeHidden();
    expect(
      await logoCarousel.locator('[data-carousel-track]').evaluate((track) => {
        const rows = new Set(
          Array.from(track.children, (child) => (child as HTMLElement).offsetTop),
        );
        return rows.size;
      }),
    ).toBeGreaterThanOrEqual(2);

    await expect(page.getByRole('heading', { name: 'Compliance & Testing' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Design Patents' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Patent Record' })).toBeVisible();

    const triggers = page.getByRole('button', { name: /Enlarge certificate/i });
    await expect(triggers).toHaveCount(8);

    const dialog = page.locator('dialog.cert-dialog').first();
    await expect(dialog).toBeHidden();
    await triggers.first().click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('OEM Phase 8 removes Teardown listing stats and retains reports', async ({
    page,
    request,
  }) => {
    const viewports = [
      { width: 390, height: 844, columns: 1 },
      { width: 768, height: 1024, columns: 2 },
      { width: 1024, height: 900, columns: 3 },
      { width: 1440, height: 1000, columns: 3 },
    ];

    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await page.goto(`/teardown-lab?phase8=${e2e.runId}`, {
        waitUntil: 'domcontentloaded',
      });

      await expect(page.getByText('Teardown Reports', { exact: true })).toHaveCount(0);
      await expect(page.getByText('Avg. Hardware Margin', { exact: true })).toHaveCount(0);
      await expect(page.getByText('Years Supply Chain Data', { exact: true })).toHaveCount(0);

      const cardsHeading = page.getByRole('heading', { name: "What's inside the lab" });
      const cardsSection = page.locator('main > section').filter({ has: cardsHeading });
      await cardsSection.scrollIntoViewIfNeeded();
      await expect(cardsHeading).toBeVisible();
      expect(
        await cardsSection.evaluate((section) =>
          section.previousElementSibling?.querySelector('h1')?.textContent?.trim(),
        ),
      ).toBe('Teardown Lab');

      const cards = cardsSection.locator('a[href^="/teardown-lab/"]');
      await expect(cards).toHaveCount(3);
      expect(
        await cards.evaluateAll(
          (elements) =>
            new Set(elements.map((element) => Math.round(element.getBoundingClientRect().left)))
              .size,
        ),
      ).toBe(viewport.columns);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    }

    const detailPaths = await page
      .locator('a[href^="/teardown-lab/"]')
      .evaluateAll((links) => links.map((link) => (link as HTMLAnchorElement).pathname));
    expect([...detailPaths].sort()).toEqual([
      '/teardown-lab/clicbot-modular-robot',
      '/teardown-lab/lofree-flow-2-keyboard',
      '/teardown-lab/oladance-ows-pro',
    ]);
    await expect(page.getByText('Our Methodology', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Start an OEM project' })).toHaveAttribute(
      'href',
      '/#oem-inquiry',
    );

    for (const detailPath of detailPaths) {
      const response = await request.get(detailPath);
      expect(response.status(), detailPath).toBe(200);
      const html = await response.text();
      for (const retained of ['BOM Cost Breakdown', 'Est. Margin', 'MOQ', 'Start an OEM project']) {
        expect(html, `${detailPath} retains ${retained}`).toContain(retained);
      }
      expect(html).toContain('href="/teardown-lab"');
      expect(html).toContain('href="/#oem-inquiry"');

      await page.goto(`${detailPath}?phase8=${e2e.runId}`, { waitUntil: 'domcontentloaded' });
      const source = teardownBomSource.find(({ slug }) => detailPath.endsWith(`/${slug}`));
      expect(source, `${detailPath} has a reviewed source fixture`).toBeDefined();
      const expectedRows = source?.rows
        .slice(0, -1)
        .map(({ category, description, cost }) => [category, description, `$${cost.toFixed(2)}`]);
      const renderedRows = await page
        .locator('#bom tbody tr')
        .evaluateAll((rows) =>
          rows.map((row) =>
            Array.from(row.querySelectorAll('th, td'), (cell) => cell.textContent?.trim() ?? ''),
          ),
        );
      expect(renderedRows, `${detailPath} renders every reviewed BOM row`).toEqual(expectedRows);
      const expectedTotal = source?.rows.at(-1);
      await expect(page.locator('#bom tfoot tr')).toHaveText(
        `${expectedTotal?.category} ${expectedTotal?.description} $${expectedTotal?.cost.toFixed(2)}`,
      );
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/teardown-lab/clicbot-modular-robot?phase8=${e2e.runId}`, {
      waitUntil: 'domcontentloaded',
    });
    const bomTableScroller = page.locator('#bom .overflow-x-auto');
    await expect(
      page.getByRole('rowheader', { name: 'Electromechanical Drive & Distributed Control' }),
    ).toBeAttached();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    expect(
      await bomTableScroller.evaluate((element) => element.scrollWidth > element.clientWidth),
    ).toBe(true);
  });

  test('OEM Phase 8 removes Blue Ocean listing stats and retains concepts', async ({
    page,
    request,
  }) => {
    const viewports = [
      { width: 390, height: 844, columns: 1 },
      { width: 768, height: 1024, columns: 2 },
      { width: 1024, height: 900, columns: 3 },
      { width: 1440, height: 1000, columns: 3 },
    ];

    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await page.goto(`/blue-ocean?phase8=${e2e.runId}`, {
        waitUntil: 'domcontentloaded',
      });

      await expect(page.getByText('Concept Products', { exact: true })).toHaveCount(0);
      await expect(page.getByText('Avg. Gross Margin', { exact: true })).toHaveCount(0);
      await expect(page.getByText('Starting MOQ', { exact: true })).toHaveCount(0);

      const cardsHeading = page.getByRole('heading', {
        name: "Products the market hasn't built yet",
      });
      const cardsSection = page.locator('main > section').filter({ has: cardsHeading });
      await cardsSection.scrollIntoViewIfNeeded();
      await expect(cardsHeading).toBeVisible();
      expect(
        await cardsSection.evaluate((section) =>
          section.previousElementSibling?.querySelector('h1')?.textContent?.trim(),
        ),
      ).toBe('Blue Ocean Products');

      const cards = cardsSection.locator('a[href^="/blue-ocean/"]');
      await expect(cards).toHaveCount(3);
      expect(
        await cards.evaluateAll(
          (elements) =>
            new Set(elements.map((element) => Math.round(element.getBoundingClientRect().left)))
              .size,
        ),
      ).toBe(viewport.columns);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    }

    const cardsHeading = page.getByRole('heading', {
      name: "Products the market hasn't built yet",
    });
    const cardsSection = page.locator('main > section').filter({ has: cardsHeading });
    const detailPaths = await cardsSection
      .locator('a[href^="/blue-ocean/"]')
      .evaluateAll((links) => links.map((link) => (link as HTMLAnchorElement).pathname));
    expect([...detailPaths].sort()).toEqual([
      '/blue-ocean/aerosense-ai-sports-headband',
      '/blue-ocean/lumicogni-desktop-ai-hologram',
      '/blue-ocean/somniflow-ai-sleep-pods',
    ]);
    for (const detailPath of detailPaths) {
      const response = await request.get(detailPath);
      expect(response.status(), detailPath).toBe(200);
      const html = await response.text();
      for (const retained of [
        'BOM Cost Breakdown',
        'Est. Margin',
        'MOQ',
        'White-label',
        'Exclusive Buyout',
        'Co-Development (JDM)',
        'Start an OEM project',
      ]) {
        expect(html, `${detailPath} retains ${retained}`).toContain(retained);
      }
      expect(html).toContain('href="/blue-ocean"');
      expect(html).toContain('href="/#oem-inquiry"');
    }

    await expect(page.getByText('Three Ways to Partner', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Start an OEM project' })).toHaveAttribute(
      'href',
      '/#oem-inquiry',
    );
  });

  test('OEM Phase 8 renders approved active OEM claims without submitting', async ({ page }) => {
    const adminPosts: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes('/api/admin')) {
        adminPosts.push(request.url());
      }
    });

    await page.goto(`/oem?phase8=${e2e.runId}`, { waitUntil: 'domcontentloaded' });
    const whyUs = page.locator('#why-us');
    await expect(whyUs.getByText('20+', { exact: true })).toBeVisible();
    await expect(whyUs.getByText('15+', { exact: true })).toHaveCount(0);

    const oemForm = page.locator('#submit');
    await expect(oemForm.locator('[data-success]')).toContainText(
      'Our engineering team will review your details and get back to you within 24 hours.',
    );
    await expect(oemForm.locator('[data-success]')).not.toContainText(/business day/i);

    await page.goto(`/?phase8=${e2e.runId}#oem-inquiry`, { waitUntil: 'domcontentloaded' });
    const homepageForm = page.locator('#oem-inquiry');
    await expect(homepageForm.locator('[data-success]')).toContainText(
      'Our engineering team will review your details and get back to you within 24 hours.',
    );
    await expect(homepageForm.locator('[data-success]')).not.toContainText(/business day/i);
    expect(adminPosts).toEqual([]);
  });

  test('OEM Phase 8 renders the approved submission result claim', async ({ page }) => {
    const adminPosts: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes('/api/admin')) {
        adminPosts.push(request.url());
      }
    });

    await page.goto(`/oem_submit_result?id=phase8-check&phase8=${e2e.runId}`, {
      waitUntil: 'domcontentloaded',
    });
    const result = page.locator('main');
    await expect(result).toContainText(
      'Thank you — we have logged your project enquiry. Our engineering team will review the details and get back to you within 24 hours. We’ll also attempt to send a confirmation email to the address you provided.',
    );
    await expect(result).not.toContainText(/business day/i);
    await expect(result).not.toContainText('A confirmation email is on its way');
    const referenceCard = result.locator('[data-ref-card]');
    await expect(referenceCard).toBeVisible();
    await expect(referenceCard.locator('[data-ref-id]')).toHaveText('#phase8-check');

    const submitAgain = page.getByRole('link', { name: 'Submit another request' });
    await expect(submitAgain).toHaveAttribute('href', '/#oem-inquiry');
    await submitAgain.click();
    await expect(page).toHaveURL(/\/#oem-inquiry$/);
    await expect(page.locator('#oem-inquiry form[data-project-form]')).toBeVisible();
    expect(adminPosts).toEqual([]);
  });

  test('OEM factory block renders the facility video', async ({ page }) => {
    await page.goto('/oem', { waitUntil: 'domcontentloaded' });
    // The client-provided factory video is wired: /oem emits a muted autoplay
    // <video> with an mp4 source. See docs/oem-refresh/DESIGN.md.
    await expect(page.locator('video')).toHaveCount(1);
    await expect(page.locator('video source[src*="oem-factory"]')).toHaveCount(1);
  });

  test('homepage and OEM page expose separate full project forms at their approved anchors', async ({
    page,
  }) => {
    await page.goto('/#oem-inquiry', { waitUntil: 'domcontentloaded' });
    const homepageSection = page.locator('#oem-inquiry');
    await expect(homepageSection).toHaveCount(1);
    await expect(
      homepageSection.getByRole('heading', { name: 'Ready to develop your next product?' }),
    ).toBeVisible();
    const homepageForm = homepageSection.locator('form[data-project-form]');
    await expect(homepageForm).toHaveAttribute('data-endpoint', '/api/admin');
    await expect(homepageForm).toHaveAttribute('data-result', '/oem_submit_result');
    for (const fieldName of [
      'company',
      'contact',
      'email',
      'whatsapp',
      'category',
      'quantity',
      'drawing',
    ]) {
      await expect(homepageForm.locator(`[name="${fieldName}"]`)).toHaveCount(1);
    }
    await expect(homepageSection.getByRole('button', { name: 'Submit project' })).toBeVisible();
    await expect(homepageSection.getByRole('link', { name: 'Start OEM Inquiry' })).toHaveCount(0);
    await expect(
      homepageSection.getByRole('link', { name: 'Explore Success Stories' }),
    ).toHaveCount(0);

    await page.goto('/oem#submit', { waitUntil: 'domcontentloaded' });
    const oemForm = page.locator('#submit form[data-project-form]');
    await expect(oemForm).toHaveCount(1);
    await expect(oemForm).toHaveAttribute('data-endpoint', '/api/admin');
    await expect(oemForm).toHaveAttribute('data-result', '/oem_submit_result');
  });

  test('legacy Success Stories redirects to canonical portfolio and keeps its inquiry CTA', async ({
    page,
    request,
  }) => {
    await page.goto('/success-stories', { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/portfolio\/?$/);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      'href',
      `${e2e.siteUrl}/portfolio/`,
    );

    const sitemap = await request.get('/sitemap-0.xml');
    await expect(sitemap).toBeOK();
    const sitemapXml = await sitemap.text();
    expect(sitemapXml).toContain(`<loc>${e2e.siteUrl}/portfolio/</loc>`);
    expect(sitemapXml).not.toContain('/success-stories');

    const stats = page.locator('[data-portfolio-stats]');
    await expect(stats.getByText('50+', { exact: true })).toBeVisible();
    await expect(stats.getByText('Case Studies', { exact: true })).toBeVisible();
    await expect(stats.getByText('30+', { exact: true })).toBeVisible();
    await expect(stats.getByText('Trusted Clients', { exact: true })).toBeVisible();
    await expect(stats.getByText('100+', { exact: true })).toBeVisible();
    await expect(stats.getByText('Certifications', { exact: true })).toBeVisible();

    const cases = page.locator('#cases article');
    await expect(cases).toHaveCount(2);
    await expect(
      cases.nth(0).getByRole('heading', { name: "Children's Sleep Training Clock" }),
    ).toBeVisible();
    await expect(cases.nth(0).locator('img')).toHaveAttribute(
      'src',
      '/media/portfolio/cases/sleep-clock.webp',
    );
    await expect(cases.nth(1).getByRole('heading', { name: 'Disc Repair System' })).toBeVisible();
    await expect(cases.nth(1).locator('img')).toHaveAttribute(
      'src',
      '/media/portfolio/cases/disc-repair.jpg',
    );
    await expect(page.getByText('Character TWS Bluetooth Speaker')).toHaveCount(0);

    const cta = page.getByRole('link', { name: 'Start your project', exact: true });
    await expect(cta).toHaveAttribute('href', '/#oem-inquiry');
    await cta.click();
    await expect(page).toHaveURL(/\/#oem-inquiry$/);
    await expect(page.locator('#oem-inquiry form[data-project-form]')).toBeVisible();
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
