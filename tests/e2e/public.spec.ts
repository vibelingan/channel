import { Buffer } from 'node:buffer';
import { type Browser, type Page, expect, test } from '@playwright/test';
import type { CatalogPage } from '../../apps/site/src/islands/shop/catalog-types.ts';
import type { SessionUser } from '../../packages/shared/src/auth.ts';
import { e2e } from './helpers/env';

const cardTypographyCatalog = {
  items: [
    {
      _id: 'e2e-card-typography',
      name: 'E2E Headphone',
      category: 'bluetooth',
      modName: 'E2E-100',
      description: 'Stable fixture for card hierarchy checks.',
      moq: 500,
      unitPrice: 12.5,
      images: ['/api/images/_placeholder'],
    },
  ],
  total: 1,
  page: 1,
  pageSize: 48,
} satisfies CatalogPage;
const longNameMember = {
  id: 'e2e-long-header-user',
  email: 'long-header-member@example.test',
  username: 'Authenticated Header Identity With Long Name',
  role: 'member',
} satisfies SessionUser;

function captureConsoleProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
  page.on('pageerror', (error) => problems.push(error.message));
  return problems;
}

async function ensureApplicationPage(page: Page): Promise<void> {
  const appHeader = page.locator('[data-site-header]');
  const cloudBaseNotice = page.getByRole('button', { name: '确定访问', exact: true });
  const firstSurface = await Promise.race([
    appHeader.waitFor({ state: 'visible' }).then(() => 'app' as const),
    cloudBaseNotice.waitFor({ state: 'visible' }).then(() => 'notice' as const),
  ]);
  if (firstSurface === 'notice') {
    await cloudBaseNotice.click();
    await appHeader.waitFor({ state: 'visible' });
  }
}

async function trustedSiteStorage(browser: Browser) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(e2e.siteUrl, { waitUntil: 'domcontentloaded' });
    await ensureApplicationPage(page);
    return await context.storageState();
  } finally {
    await context.close();
  }
}

async function waitForApplicationStyles(page: Page, timeoutMs = 30_000): Promise<void> {
  // In no-JS mode DOMContentLoaded can fire before Astro's app stylesheet is
  // applied. Poll a required global.css token instead of <link> elements:
  // Astro may inline CSS locally, while third-party font CSS can hang in CI/CN.
  // `page.waitForFunction` is unusable here because its polling does not run
  // when JavaScript is disabled in the browser context.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await page.evaluate(
      () =>
        getComputedStyle(document.documentElement).getPropertyValue('--spacing-header').trim() !==
        '',
    );
    if (ready) return;
    await page.waitForTimeout(100);
  }
  throw new Error('Timed out waiting for application styles to apply');
}

async function readHeaderGeometry(page: Page) {
  return page.evaluate(() => {
    const bounds = (selector: string) => {
      const rect = document.querySelector(selector)?.getBoundingClientRect();
      return rect
        ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
        : null;
    };
    const visibleLinks = Array.from(
      // The catalog expansion replaced the flat Headphones link with an
      // Electronics & Toys disclosure, so a top-level nav item is now either an
      // anchor or that disclosure's summary.
      document.querySelectorAll<HTMLElement>(
        '[data-primary-nav] > a, [data-primary-nav] > details > summary',
      ),
    )
      .filter((link) => getComputedStyle(link).display !== 'none')
      .map((link) => ({
        whiteSpace: getComputedStyle(link).whiteSpace,
        height: link.getBoundingClientRect().height,
      }));
    const layout = document.querySelector<HTMLElement>('[data-site-header] > div');
    const layoutStyle = layout ? getComputedStyle(layout) : null;
    return {
      brand: bounds('[data-brand-link]'),
      nav: bounds('[data-primary-nav]'),
      account: bounds('[data-account-controls]'),
      header: bounds('[data-site-header]'),
      layout: bounds('[data-site-header] > div'),
      layoutPadding: layoutStyle
        ? {
            left: Number.parseFloat(layoutStyle.paddingLeft),
            right: Number.parseFloat(layoutStyle.paddingRight),
          }
        : null,
      visibleLinks,
      noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth,
    };
  });
}

function expectDesktopHeaderContained(
  geometry: Awaited<ReturnType<typeof readHeaderGeometry>>,
): void {
  expect(geometry.brand?.right).toBeLessThanOrEqual(geometry.nav?.left ?? 0);
  expect(geometry.nav?.right).toBeLessThanOrEqual(geometry.account?.left ?? 0);
  expect(geometry.noHorizontalOverflow).toBe(true);
  // Primary nav currently has 3 visible top-level items (OEM Development,
  // Electronics & Toys disclosure, Success Stories) — Teardown Lab and Blue
  // Ocean are temporarily hidden.
  expect(geometry.visibleLinks).toHaveLength(3);
  const contentLeft = (geometry.layout?.left ?? 0) + (geometry.layoutPadding?.left ?? 0);
  const contentRight = (geometry.layout?.right ?? 0) - (geometry.layoutPadding?.right ?? 0);
  for (const region of [geometry.brand, geometry.nav, geometry.account]) {
    expect(region?.left).toBeGreaterThanOrEqual(contentLeft);
    expect(region?.right).toBeLessThanOrEqual(contentRight);
    expect(region?.top).toBeGreaterThanOrEqual(geometry.layout?.top ?? 0);
    expect(region?.bottom).toBeLessThanOrEqual(geometry.layout?.bottom ?? 0);
  }
  for (const link of geometry.visibleLinks) {
    expect(link.whiteSpace).toBe('nowrap');
    expect(link.height).toBeLessThanOrEqual(
      (geometry.header?.bottom ?? 0) - (geometry.header?.top ?? 0),
    );
  }
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

  test('shared Product Category control is native, required, and serialized once', async ({
    page,
  }) => {
    const submissions: Array<{ action?: string; data?: Record<string, unknown> }> = [];
    await page.route('**/api/admin', async (route) => {
      const payload = route.request().postDataJSON() as {
        action?: string;
        data?: Record<string, unknown>;
      };
      if (payload.action === 'submitProject') submissions.push(payload);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, data: {} }),
      });
    });

    for (const path of ['/', '/oem#submit']) {
      submissions.length = 0;
      await page.goto(path, { waitUntil: 'domcontentloaded' });
      await ensureApplicationPage(page);

      const form = page.locator('form[data-project-form]');
      const category = form.getByRole('combobox', { name: 'Product Category', exact: true });
      await expect(form.locator('[data-public-select]')).toHaveCount(1);
      await expect(form.locator('[name="category"]')).toHaveCount(1);
      await expect(category).toBeVisible();
      await expect(category).toHaveAttribute('name', 'category');
      await expect(category).toHaveAttribute('required', '');
      await expect(category).not.toHaveAttribute('aria-describedby', /category-error/);
      await expect(category).not.toHaveAttribute('aria-invalid', 'true');
      await expect(form.locator('#category-error')).not.toHaveAttribute('data-visible', '');
      await expect(form.locator('#category-error')).toHaveText('');
      await expect(category.locator('option[value=""]')).toHaveText('Select a product category…');
      await expect(category.locator('option[value="Other"]')).toHaveCount(1);

      await form.locator('[name="company"]').fill('E2E Category Control');
      await form.locator('[name="contact"]').fill('E2E Contact');
      await form.locator('[name="email"]').fill('category-control@example.test');
      await form.getByRole('button', { name: /Submit project/i }).click();
      await expect(category).toBeFocused();
      await expect(category).toHaveAttribute('aria-describedby', 'category-error');
      await expect(category).toHaveAttribute('aria-invalid', 'true');
      await expect(form.locator('#category-error')).toHaveAttribute('data-visible', '');
      await expect(form.locator('#category-error')).toHaveText('Select product category.');

      await category.selectOption('Other');
      await expect(category).toHaveValue('Other');
      await expect(category).not.toHaveAttribute('aria-describedby', /category-error/);
      await expect(category).not.toHaveAttribute('aria-invalid', 'true');
      await expect(form.locator('#category-error')).not.toHaveAttribute('data-visible', '');
      await expect(form.locator('#category-error')).toHaveText('');
      await form.getByRole('button', { name: /Submit project/i }).click();
      await expect.poll(() => submissions.length).toBe(1);
      expect(submissions[0]?.data?.category).toBe('Other');
      expect(Object.keys(submissions[0]?.data ?? {}).filter((key) => key === 'category')).toEqual([
        'category',
      ]);
    }
  });

  test('Product Category stays usable as one native select without JavaScript', async ({
    browser,
  }) => {
    const trustedStorage = await trustedSiteStorage(browser);
    const context = await browser.newContext({
      javaScriptEnabled: false,
      storageState: trustedStorage,
      viewport: { width: 390, height: 844 },
    });
    try {
      const page = await context.newPage();
      for (const path of ['/', '/oem#submit']) {
        await page.goto(`${e2e.siteUrl}${path}`, { waitUntil: 'domcontentloaded' });
        const form = page.locator('form[data-project-form]');
        const category = form.getByRole('combobox', { name: 'Product Category', exact: true });
        await expect(form.locator('[data-public-select]')).toHaveCount(1);
        await expect(form.locator('select[name="category"]')).toHaveCount(1);
        await expect(category).toBeVisible();
        const opacity = await category.evaluate((element) => {
          if (!(element instanceof HTMLElement)) throw new Error('Category is not HTML');
          let current: HTMLElement | null = element;
          let effectiveOpacity = 1;
          while (current) {
            effectiveOpacity *= Number(getComputedStyle(current).opacity);
            current = current.parentElement;
          }
          return effectiveOpacity;
        });
        expect(opacity).toBe(1);
        await category.selectOption('Other');
        await expect(category).toHaveValue('Other');
      }
    } finally {
      await context.close();
    }
  });

  test('static reveal content is visible before observer class mutation', async ({ page }) => {
    await page.goto('/oem#process', { waitUntil: 'domcontentloaded' });
    const reveal = page.locator('#process .reveal').first();
    await expect(reveal).toHaveCount(1);
    await reveal.evaluate((element) => element.classList.remove('reveal-pending', 'is-visible'));

    const state = await reveal.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        opacity: style.opacity,
        transform: style.transform,
        noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth,
      };
    });
    expect(state.opacity).toBe('1');
    expect(state.transform).toBe('none');
    expect(state.noHorizontalOverflow).toBe(true);
  });

  test('static reveal content stays visible when IntersectionObserver is unavailable', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      Reflect.deleteProperty(window, 'IntersectionObserver');
    });
    await page.goto('/oem#process', { waitUntil: 'domcontentloaded' });
    const reveal = page.locator('#process .reveal').first();
    await expect(reveal).toBeVisible();
    await expect(reveal).not.toHaveClass(/reveal-pending|is-visible/);
    await expect(reveal).toHaveCSS('opacity', '1');
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });

  test('static reveal content stays visible when observer registration fails', async ({ page }) => {
    await page.addInitScript(() => {
      class ThrowingIntersectionObserver {
        observe() {
          throw new Error('observer registration unavailable');
        }

        unobserve() {}
      }
      Object.defineProperty(window, 'IntersectionObserver', {
        configurable: true,
        value: ThrowingIntersectionObserver,
      });
    });
    await page.goto('/oem', { waitUntil: 'domcontentloaded' });
    const reveal = page.locator('#process .reveal').first();
    await expect(reveal).not.toHaveClass(/reveal-pending|is-visible/);
    await expect(reveal).toHaveCSS('opacity', '1');
    await expect(reveal).toHaveCSS('transform', 'none');
  });

  test('static reveal content stays visible without JavaScript and under reduced motion', async ({
    browser,
  }) => {
    const trustedStorage = await trustedSiteStorage(browser);
    for (const mode of ['no-js', 'reduced-motion'] as const) {
      const context = await browser.newContext({
        javaScriptEnabled: mode !== 'no-js',
        reducedMotion: mode === 'reduced-motion' ? 'reduce' : 'no-preference',
        storageState: trustedStorage,
        viewport: { width: 390, height: 844 },
      });
      try {
        const page = await context.newPage();
        await page.goto(`${e2e.siteUrl}/oem#process`, { waitUntil: 'domcontentloaded' });
        if (mode === 'no-js') await waitForApplicationStyles(page);
        const reveal = page.locator('#process .reveal').first();
        await expect(reveal).not.toHaveClass(/reveal-pending|is-visible/);
        const state = await reveal.evaluate((element) => {
          const style = getComputedStyle(element);
          const desktopNav = document.querySelector<HTMLElement>('.header-desktop-nav');
          return {
            opacity: style.opacity,
            transform: style.transform,
            transitionDuration: style.transitionDuration,
            animationName: style.animationName,
            desktopNavPosition: desktopNav ? getComputedStyle(desktopNav).position : null,
            noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth,
          };
        });
        expect(state.opacity, mode).toBe('1');
        expect(state.transform, mode).toBe('none');
        expect(state.noHorizontalOverflow, mode).toBe(true);
        if (mode === 'no-js') expect(state.desktopNavPosition).toBe('fixed');
        if (mode === 'reduced-motion') {
          expect(state.transitionDuration).toBe('0s');
          expect(state.animationName).toBe('none');
        }
      } finally {
        await context.close();
      }
    }
  });

  test('public pages never overflow horizontally across breakpoints without JavaScript', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const trustedStorage = await trustedSiteStorage(browser);
    // Independent public pages (no redirect aliases — /success-stories 301s to
    // /portfolio and is asserted separately by the redirect contract).
    const publicPaths = ['/', '/oem', '/headphones', '/portfolio'];
    const breakpoints = [
      { width: 320, height: 568 },
      { width: 390, height: 844 },
      { width: 768, height: 1024 },
      { width: 1024, height: 768 },
      { width: 1280, height: 800 },
      { width: 1440, height: 900 },
    ];

    for (const path of publicPaths) {
      for (const viewport of breakpoints) {
        const context = await browser.newContext({
          javaScriptEnabled: false,
          storageState: trustedStorage,
          viewport,
        });
        try {
          const page = await context.newPage();
          await page.goto(`${e2e.siteUrl}${path}`, { waitUntil: 'domcontentloaded' });
          await waitForApplicationStyles(page);
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - window.innerWidth,
          );
          expect(
            overflow,
            `${path} @ ${viewport.width}px (no-js) horizontal overflow`,
          ).toBeLessThanOrEqual(0);
        } finally {
          await context.close();
        }
      }
    }
  });

  test('no-JS layout readiness fails closed when application CSS is unavailable', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      javaScriptEnabled: false,
      viewport: { width: 390, height: 844 },
    });
    try {
      const page = await context.newPage();
      await page.goto(`${e2e.siteUrl}/portfolio`, { waitUntil: 'domcontentloaded' });
      await waitForApplicationStyles(page);
      const removedStyleNodes = await page.evaluate(() => {
        const styles = Array.from(document.querySelectorAll('style, link[rel="stylesheet"]'));
        for (const style of styles) style.remove();
        return styles.length;
      });
      expect(removedStyleNodes).toBeGreaterThan(0);
      await expect(waitForApplicationStyles(page, 250)).rejects.toThrow(
        'Timed out waiting for application styles to apply',
      );
    } finally {
      await context.close();
    }
  });

  test('below-fold reveal animates once and releases transform resources', async ({ page }) => {
    await page.goto('/oem', { waitUntil: 'domcontentloaded' });
    const reveal = page.locator('#process .reveal').first();
    await expect(reveal).toHaveClass(/reveal-pending/);
    await expect(reveal).not.toHaveClass(/is-visible/);
    await expect(reveal).toHaveCSS('will-change', 'auto');

    await reveal.scrollIntoViewIfNeeded();
    await expect(reveal).toHaveClass(/reveal-pending.*is-visible|is-visible.*reveal-pending/);
    await reveal.locator('*').first().dispatchEvent('transitionend', {
      propertyName: 'opacity',
    });
    await expect(reveal).toHaveClass(/reveal-pending/);
    await reveal.dispatchEvent('transitionend', {
      propertyName: 'background-color',
    });
    await expect(reveal).toHaveClass(/reveal-pending/);
    await expect(reveal).toHaveCSS('opacity', '1');
    await expect(reveal).not.toHaveClass(/reveal-pending|is-visible/, { timeout: 2_000 });
    const final = await reveal.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        opacity: style.opacity,
        transform: style.transform,
        willChange: style.willChange,
      };
    });
    expect(final).toEqual({ opacity: '1', transform: 'none', willChange: 'auto' });
  });

  test('below-fold reveal timeout releases classes when transitionend is delayed', async ({
    page,
  }) => {
    await page.goto('/oem', { waitUntil: 'domcontentloaded' });
    const reveal = page.locator('#process .reveal').first();
    await expect(reveal).toHaveClass(/reveal-pending/);
    await reveal.evaluate((element) => {
      if (!(element instanceof HTMLElement)) throw new Error('Reveal is not HTML');
      element.style.setProperty('transition-duration', '10s', 'important');
    });

    await reveal.scrollIntoViewIfNeeded();
    await expect(reveal).toHaveClass(/reveal-pending.*is-visible|is-visible.*reveal-pending/);
    await expect(reveal).not.toHaveClass(/reveal-pending|is-visible/, { timeout: 2_000 });
    await expect(reveal).toHaveCSS('will-change', 'auto');
  });

  test('OEM page keeps its independent service structure with current facts and deep links', async ({
    page,
  }) => {
    await page.goto('/oem', { waitUntil: 'domcontentloaded' });
    await ensureApplicationPage(page);

    // OEM-specific hero and local deep links.
    const hero = page.locator('main > section').first();
    await expect(
      hero.getByRole('heading', {
        level: 1,
        name: 'One-stop OEM development, from idea to shipment',
      }),
    ).toBeVisible();
    await expect(hero.locator('a[href="#submit"]')).toHaveCount(1);
    await expect(hero.locator('a[href="#process"]')).toHaveCount(1);

    // Shared What We Do keeps the Traditional-versus-AI comparison.
    await expect(page.locator('#what-we-do')).toHaveCount(1);
    await expect(page.getByText('Traditional Drawing-Based OEM Workflow')).toBeAttached();
    await expect(page.getByText('AI Big Data Smart OEM Workflow')).toBeAttached();

    // Independent capability and six-stage process remain distinct from home.
    await expect(page.locator('#capabilities')).toHaveCount(1);
    await expect(page.locator('#capabilities ul > li')).toHaveCount(6);
    await expect(page.locator('#process')).toHaveCount(1);
    await expect(page.locator('#process ol > li')).toHaveCount(6);
    await expect(page.locator('#why-us')).toHaveCount(1);

    // Capability section carries the OEM-specific video/poster pair, exactly once.
    await expect(page.locator('#capabilities video')).toHaveCount(1);
    await expect(page.locator('#capabilities video source')).toHaveAttribute(
      'src',
      '/media/oem-factory.mp4',
    );
    await expect(page.locator('#capabilities video')).toHaveAttribute(
      'poster',
      '/media/factory-oem.webp',
    );
    await expect(page.locator('#why-us')).toContainText('40+');
    await expect(page.locator('#why-us')).toContainText('5000+');
    const qualityCapability = page
      .locator('#capabilities ul > li')
      .filter({ has: page.getByRole('heading', { name: 'Quality & Global Delivery' }) });
    await expect(qualityCapability).toContainText(
      'coordinate available CE, EMC, FCC, and JD compliance and test reports',
    );
    const iterationReason = page
      .locator('#why-us li')
      .filter({ hasText: 'Long-Term Product Iteration' });
    await expect(iterationReason).toContainText('market feedback and cost optimization');

    // The inquiry form stays intact at #submit.
    await expect(page.locator('#submit')).toHaveCount(1);
    await expect(page.locator('#submit form[data-project-form]')).toHaveCount(1);
    await expect(page.locator('#submit input[type="file"]')).toHaveCount(1);

    // Unsupported legacy claims remain gone from the restored page.
    const bodyText = await page.locator('body').innerText();
    for (const claim of [
      '100+ Supply Chain Partners',
      'Flexible MOQ',
      'Dedicated Project Manager',
      'agreed AQL',
      'RoHS',
      'six primary product families',
    ]) {
      expect(bodyText, claim).not.toContain(claim);
    }

    // The homepage remains separate and unchanged.
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await ensureApplicationPage(page);
    await expect(page.locator('#oem-inquiry')).toHaveCount(1);
    await expect(page.locator('#factory video source')).toHaveAttribute(
      'src',
      '/media/oem/factory-video.mp4',
    );
    await expect(page.locator('a[href="/#oem-inquiry"]').first()).toBeVisible();
    await expect(page.locator('a[href="#submit"]')).toHaveCount(0);
  });

  test('OEM page stays responsive without horizontal overflow across breakpoints', async ({
    page,
  }) => {
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 768, height: 1024 },
      { width: 1024, height: 768 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto('/oem', { waitUntil: 'domcontentloaded' });
      await ensureApplicationPage(page);
      await expect(page.locator('#process')).toBeAttached();
      await expect(page.locator('#submit input[type="file"]')).toBeAttached();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        `no horizontal overflow at ${viewport.width}px`,
      ).toBe(true);
    }
  });

  test('Slide 2 header keeps the company name without restoring MOQ', async ({ page }) => {
    for (const viewport of [
      { width: 1360, height: 800 },
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
    const toggle = page.locator('[data-menu-toggle]');
    await expect(toggle).toBeVisible();
    const disclosure = page.locator('[data-mobile-disclosure]');
    await expect(disclosure).not.toHaveAttribute('open', '');
    const mobileMenu = page.getByRole('navigation', { name: 'Mobile' });
    await expect(mobileMenu).toBeHidden();
    await toggle.click();
    await expect(disclosure).toHaveAttribute('open', '');
    await expect(mobileMenu).toBeVisible();
    for (const label of ['OEM Development', 'Success Stories']) {
      await expect(mobileMenu.getByRole('link', { name: label, exact: true })).toBeVisible();
    }
    // Teardown Lab and Blue Ocean are temporarily hidden (un-routed, 2026-08):
    // they must not appear in any nav.
    for (const label of ['Teardown Lab', 'Blue Ocean']) {
      await expect(mobileMenu.getByRole('link', { name: label, exact: true })).toHaveCount(0);
    }
    // The catalog expansion groups every family under an Electronics & Toys disclosure,
    // so Headphones is reachable one level in rather than as a top-level nav link.
    const mobileCatalog = mobileMenu.locator('[data-catalog-disclosure="mobile"]');
    await mobileCatalog.locator(':scope > summary').click();
    await expect(
      mobileCatalog.getByRole('link', { name: 'Headphones', exact: true }),
    ).toBeVisible();
    await expect(
      mobileCatalog.getByRole('link', { name: 'Headphones', exact: true }),
    ).toHaveAttribute('href', '/headphones/');
    await expect(mobileMenu.getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
    await expect(mobileMenu.getByRole('link', { name: 'Register', exact: true })).toBeVisible();
    await expect(page.getByText('Minimum Order Amount: $500', { exact: true })).toHaveCount(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);

    for (const viewport of [
      { width: 767, height: 768 },
      { width: 768, height: 768 },
      { width: 1023, height: 768 },
      { width: 1024, height: 768 },
      { width: 1279, height: 800 },
      { width: 1280, height: 800 },
      { width: 1319, height: 800 },
      { width: 1320, height: 800 },
      { width: 1359, height: 800 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await expect(page.locator('[data-menu-toggle]')).toBeVisible();
      await expect(page.locator('[data-primary-nav]')).toBeHidden();
    }

    for (const viewport of [
      { width: 1360, height: 800 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await expect(page.locator('[data-company-name]')).toBeVisible();
      await expect(page.locator('[data-company-name]')).toHaveText('Diversity Technology Limited');
      await expect(page.locator('[data-site-header] img')).toBeVisible();
      await expect(page.locator('[data-menu-toggle]')).toBeHidden();
      await expect(page.locator('[data-primary-nav]')).toBeVisible();
      await expect(page.locator('[data-account-controls]')).toBeVisible();
      const catalogDisclosure = page.locator('[data-catalog-disclosure="desktop"]');
      await expect(catalogDisclosure).toBeVisible();
      await catalogDisclosure.locator(':scope > summary').click();
      // Desktop catalog links carry a description, so their accessible name is not
      // just the family label; address them by destination instead.
      const headphonesLink = catalogDisclosure.locator('a[href="/headphones/"]');
      await expect(headphonesLink).toBeVisible();
      await expect(headphonesLink).toHaveText(/Headphones/);
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
      await page.getByRole('button', { name: 'Back to all products', exact: true }).click();
      await expect(page.locator('[data-product-detail]')).toHaveCount(0);
      await expect(productCards.first()).toBeVisible();
    }
  });

  test('Headphones Gallery bounds media, falls back, and resets across products', async ({
    page,
  }) => {
    const imageIdsA = Array.from({ length: 6 }, (_, index) => `miu8-a${index + 1}`);
    const imagePath = (id: string) => `/api/images/${id}`;
    const requestedImageIds: string[] = [];
    let catalogMode: 'gallery' | 'fallback' = 'gallery';
    let releaseDetailFallback: (() => void) | undefined;

    await page.route('**/api/products?**', (route) => {
      const items =
        catalogMode === 'gallery'
          ? [
              {
                _id: 'miu8-product-a',
                name: 'MIU 8 Product A',
                category: 'bluetooth',
                images: imageIdsA.map(imagePath),
              },
              {
                _id: 'miu8-product-b',
                name: 'MIU 8 Product B',
                category: 'bluetooth',
                images: imageIdsA.map(imagePath),
              },
            ]
          : [
              {
                _id: 'miu8-product-missing',
                name: 'MIU 8 Missing Product',
                category: 'bluetooth',
                images: [imagePath('miu8-missing')],
              },
            ];
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          data: {
            items,
            total: items.length,
            page: 1,
            pageSize: 48,
          },
        }),
      });
    });
    await page.route('**/api/images/miu8-*', async (route) => {
      const id = new URL(route.request().url()).pathname.split('/').at(-1) ?? '';
      requestedImageIds.push(id);
      if (id === 'miu8-missing') {
        if (requestedImageIds.filter((candidate) => candidate === id).length === 2) {
          await new Promise<void>((resolve) => {
            releaseDetailFallback = resolve;
          });
        }
        return route.fulfill({ status: 404, headers: { 'Cache-Control': 'no-store' }, body: '' });
      }
      return route.fulfill({
        status: 200,
        contentType: 'image/svg+xml',
        headers: { 'Cache-Control': 'no-store' },
        body: `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800"><rect width="800" height="800" fill="#315d78"/><text x="400" y="420" text-anchor="middle" font-size="56" fill="white">${id}</text></svg>`,
      });
    });

    for (const viewport of [
      { width: 390, height: 844 },
      { width: 768, height: 1024 },
      { width: 1024, height: 768 },
      { width: 1440, height: 900 },
    ]) {
      catalogMode = 'gallery';
      requestedImageIds.length = 0;
      await page.setViewportSize(viewport);
      await page.emulateMedia({
        reducedMotion: viewport.width === 390 ? 'reduce' : 'no-preference',
      });
      await page.goto(`/headphones?miu8=${viewport.width}`, { waitUntil: 'domcontentloaded' });
      await ensureApplicationPage(page);
      await page.evaluate(() => {
        const host = window as typeof window & {
          __miu8ScrollOptions?: boolean | ScrollIntoViewOptions | undefined;
        };
        Element.prototype.scrollIntoView = function scrollIntoView(options) {
          host.__miu8ScrollOptions = options;
        };
      });

      const productA = page.locator('[data-product-card="miu8-product-a"]');
      const productB = page.locator('[data-product-card="miu8-product-b"]');
      await productA.click();

      const gallery = page.locator('[data-gallery]');
      const frame = gallery.locator('[data-gallery-frame]');
      const thumbnails = gallery.locator('[data-gallery-thumbnail]');
      const viewAll = gallery.locator('[data-gallery-view-all]');
      await expect(gallery).toBeVisible();
      await expect(thumbnails).toHaveCount(4);
      await expect(gallery.locator('img')).toHaveCount(5);
      await expect(viewAll).toHaveAttribute('aria-expanded', 'false');
      await expect(frame.locator('img')).toHaveCSS('object-fit', 'contain');
      const initialGeometry = await frame.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
          width: rect.width,
          height: rect.height,
          noHorizontalOverflow:
            document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        };
      });
      expect(initialGeometry.width).toBeLessThanOrEqual(520.5);
      expect(Math.abs(initialGeometry.width - initialGeometry.height)).toBeLessThanOrEqual(1);
      expect(initialGeometry.noHorizontalOverflow).toBe(true);
      await expect
        .poll(() => [...new Set(requestedImageIds)].sort())
        .toEqual(imageIdsA.slice(0, 4).sort());
      expect(requestedImageIds.length).toBeGreaterThanOrEqual(4);
      expect(requestedImageIds.length).toBeLessThanOrEqual(5);
      for (const id of imageIdsA.slice(0, 4)) {
        const count = requestedImageIds.filter((requestedId) => requestedId === id).length;
        expect(count, `${id} request multiplicity`).toBeGreaterThanOrEqual(1);
        expect(count, `${id} request multiplicity`).toBeLessThanOrEqual(id === 'miu8-a1' ? 2 : 1);
      }

      await frame.scrollIntoViewIfNeeded();
      await page.mouse.move(1, 1);
      // The detail expansion smooth-scrolls into view; sample only after the
      // scroll settles or the before/after comparison races the animation.
      let lastScrollY = -1;
      await expect
        .poll(async () => {
          const scrollY = await page.evaluate(() => window.scrollY);
          const stable = scrollY === lastScrollY;
          lastScrollY = scrollY;
          return stable;
        })
        .toBe(true);
      // Sample BEFORE the pointer ever enters the frame — otherwise :hover is
      // active in both snapshots and a real hover-zoom cancels itself out.
      // Read the box first (it can scroll), then move with RAW COORDINATES:
      // page.mouse.move performs no actionability scroll, unlike locator.hover.
      const frameBox = await frame.boundingBox();
      if (!frameBox) throw new Error('Gallery frame has no bounding box');
      const beforePointer = await frame.locator('img').evaluate((image) => {
        const style = getComputedStyle(image);
        const rect = image.getBoundingClientRect();
        return {
          x: rect.x + window.scrollX,
          y: rect.y + window.scrollY,
          width: rect.width,
          height: rect.height,
          opacity: style.opacity,
          transform: style.transform,
          // Tailwind v4 `scale-*` sets the CSS `scale` property, NOT
          // `transform`, so a transform-only snapshot misses hover zoom.
          scale: style.scale,
          objectPosition: style.objectPosition,
          backgroundImage: style.backgroundImage,
          scrollX: window.scrollX,
          scrollY: window.scrollY,
        };
      });
      await page.mouse.move(frameBox.x + 5, frameBox.y + 5);
      await page.mouse.move(frameBox.x + frameBox.width - 5, frameBox.y + frameBox.height - 5);
      await page.waitForTimeout(250);
      const afterPointer = await frame.locator('img').evaluate((image) => {
        const style = getComputedStyle(image);
        const rect = image.getBoundingClientRect();
        return {
          x: rect.x + window.scrollX,
          y: rect.y + window.scrollY,
          width: rect.width,
          height: rect.height,
          opacity: style.opacity,
          transform: style.transform,
          scale: style.scale,
          objectPosition: style.objectPosition,
          backgroundImage: style.backgroundImage,
          scrollX: window.scrollX,
          scrollY: window.scrollY,
        };
      });
      expect(afterPointer).toEqual(beforePointer);

      await thumbnails.nth(3).focus();
      await page.keyboard.press('Tab');
      await expect(viewAll).toBeFocused();
      const focusVisual = await viewAll.evaluate((element) => ({
        focusVisible: element.matches(':focus-visible'),
        boxShadow: getComputedStyle(element).boxShadow,
      }));
      expect(focusVisual.focusVisible).toBe(true);
      expect(focusVisual.boxShadow).not.toBe('none');
      await page.keyboard.press('Enter');
      await expect(thumbnails).toHaveCount(6);
      await expect(viewAll).toHaveAttribute('aria-expanded', 'true');
      await expect(viewAll).toHaveText('Show Less');
      await expect(viewAll).toBeFocused();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      ).toBe(true);

      const selectedBorder = await thumbnails
        .first()
        .evaluate((element) => getComputedStyle(element).borderTopColor);
      const unselectedBorder = await thumbnails
        .nth(1)
        .evaluate((element) => getComputedStyle(element).borderTopColor);
      expect(selectedBorder).not.toBe(unselectedBorder);
      await thumbnails.nth(4).click();
      await expect(thumbnails.nth(4)).toHaveAttribute('aria-pressed', 'true');
      await expect
        .poll(() =>
          thumbnails.nth(4).evaluate((element) => getComputedStyle(element).borderTopColor),
        )
        .toBe(selectedBorder);
      await expect
        .poll(() =>
          thumbnails.first().evaluate((element) => getComputedStyle(element).borderTopColor),
        )
        .toBe(unselectedBorder);

      await viewAll.focus();
      await page.keyboard.press('Enter');
      await expect(thumbnails).toHaveCount(4);
      await expect(viewAll).toHaveAttribute('aria-expanded', 'false');
      await expect(viewAll).toHaveText('View All');
      await expect(viewAll).toBeFocused();
      const collapsedPressed = await thumbnails.evaluateAll((nodes) =>
        nodes
          .filter((node) => node.getAttribute('aria-pressed') === 'true')
          .map((node) => ({
            label: node.getAttribute('aria-label'),
            pathname: new URL(node.querySelector('img')?.src ?? '', window.location.href).pathname,
          })),
      );
      expect(collapsedPressed).toEqual([
        { label: 'View image 5', pathname: '/api/images/miu8-a5' },
      ]);
      await page.keyboard.press('Enter');
      await expect(thumbnails).toHaveCount(6);
      await expect(viewAll).toHaveText('Show Less');
      await expect(viewAll).toBeFocused();

      await productB.click();
      await expect(thumbnails).toHaveCount(4);
      await expect(viewAll).toHaveAttribute('aria-expanded', 'false');
      await expect(thumbnails.first()).toHaveAttribute('aria-pressed', 'true');
      await expect(frame.locator('img')).toHaveAttribute('src', /\/api\/images\/miu8-a1$/);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      ).toBe(true);

      const scrollBehavior = await page.evaluate(() => {
        const host = window as typeof window & {
          __miu8ScrollOptions?: boolean | ScrollIntoViewOptions;
        };
        const options = host.__miu8ScrollOptions;
        return typeof options === 'object' ? options.behavior : undefined;
      });
      expect(scrollBehavior).toBe(viewport.width === 390 ? 'auto' : 'smooth');

      catalogMode = 'fallback';
      requestedImageIds.length = 0;
      await page.goto(`/headphones?miu8-fallback=${viewport.width}`, {
        waitUntil: 'domcontentloaded',
      });
      await ensureApplicationPage(page);
      const missingProduct = page.locator('[data-product-card="miu8-product-missing"]');
      await expect(missingProduct).toBeVisible();
      await expect
        .poll(() => requestedImageIds.filter((id) => id === 'miu8-missing').length)
        .toBe(1);
      await missingProduct.click();
      const missingFrame = page.locator('[data-gallery-frame]');
      const missingAnnouncement = page.locator('[data-gallery] output');
      await expect(missingAnnouncement).toBeAttached();
      await expect(missingAnnouncement).toHaveText('');
      if (!releaseDetailFallback) throw new Error('Detail fallback request was not intercepted');
      releaseDetailFallback();
      releaseDetailFallback = undefined;
      await expect(missingFrame.locator('[data-product-media="fallback"]')).toContainText(
        'Product image unavailable',
      );
      await expect(missingAnnouncement).toHaveText(
        'MIU 8 Missing Product. Product image unavailable',
      );
      await expect
        .poll(() => requestedImageIds.filter((id) => id === 'miu8-missing').length)
        .toBe(2);
      await page.waitForTimeout(150);
      expect(requestedImageIds.filter((id) => id === 'miu8-missing')).toHaveLength(2);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      ).toBe(true);
    }
  });

  test('admin ImageManager enforces catalog capacity before upload', async ({ page }) => {
    const adminUser = {
      id: 'miu8-admin',
      email: 'miu8-admin@example.test',
      username: 'MIU 8 Admin',
      role: 'admin',
    } satisfies SessionUser;
    const intentCounts = new Map<string, number>();
    const previewCounts = new Map<string, number>();
    let imageSequence = 0;
    const existingImageIds = Array.from(
      { length: 19 },
      (_, index) => `existing-image-${index + 1}`,
    );

    await page.addInitScript((user) => {
      localStorage.setItem('channel.token', 'miu8-admin-token');
      localStorage.setItem('channel.user', JSON.stringify(user));
    }, adminUser);
    await page.route('**/api/admin', async (route) => {
      const payload = route.request().postDataJSON() as {
        action?: string;
        data?: Record<string, unknown>;
      };
      let data: unknown;
      switch (payload.action) {
        case 'me':
          data = { user: adminUser };
          break;
        case 'list':
          data =
            payload.data?.collection === 'products'
              ? {
                  items: [
                    {
                      _id: 'existing-over-limit-product',
                      name: 'Existing Over-Limit Product',
                      category: 'wired',
                      imageIds: existingImageIds,
                    },
                  ],
                  total: 1,
                  page: 1,
                  pageSize: 20,
                }
              : { items: [], total: 0, page: 1, pageSize: 20 };
          break;
        case 'getImagePreview':
          {
            const previewId = String(payload.data?.id ?? '');
            previewCounts.set(previewId, (previewCounts.get(previewId) ?? 0) + 1);
            const index = Number(previewId.split('-').at(-1) ?? '0');
            await new Promise((resolve) => setTimeout(resolve, Math.max(1, index) * 5));
          }
          data = {
            id: String(payload.data?.id ?? ''),
            mimeType: 'image/png',
            dataBase64:
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
          };
          break;
        case 'createUploadIntent': {
          const fileName = String(payload.data?.fileName ?? 'unknown.png');
          const attempt = (intentCounts.get(fileName) ?? 0) + 1;
          intentCounts.set(fileName, attempt);
          imageSequence += 1;
          data = {
            imageId: `miu8-upload-${imageSequence}`,
            uploadIntentId: `intent-${imageSequence}`,
            storageFileId: `cloud://miu8/${imageSequence}`,
            upload: {
              method: 'POST',
              url: `${e2e.siteUrl}/__miu8-upload?fileName=${encodeURIComponent(fileName)}&attempt=${attempt}`,
              fields: {},
            },
          };
          break;
        }
        case 'completeUpload':
          data = {};
          break;
        default:
          throw new Error(`Unexpected admin action: ${payload.action}`);
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, data }),
      });
    });
    await page.route('**/__miu8-upload?**', (route) => {
      const url = new URL(route.request().url());
      const fileName = url.searchParams.get('fileName') ?? '';
      const attempt = Number(url.searchParams.get('attempt') ?? '1');
      const failsFirstAttempt = /miu8-cap-(?:0|1)\.png$/.test(fileName) && attempt === 1;
      return route.fulfill({ status: failsFirstAttempt ? 500 : 204, body: '' });
    });

    await page.goto('/admin?miu8-capacity=1', { waitUntil: 'domcontentloaded' });
    await expect(page.getByText('Channel Admin', { exact: true })).toBeVisible();
    // The catalog now spans four families, so the admin section that used to be
    // "Headphones" is the broader "Products".
    await page.getByRole('button', { name: 'Products', exact: true }).click();
    await expect(page.getByText('Existing Over-Limit Product', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();

    const existingInput = page.locator('#imageIds');
    const existingManager = page.locator('#imageIds-capacity').locator('..');
    await expect
      .poll(() => [...previewCounts.values()].reduce((sum, count) => sum + count, 0))
      .toBe(19);
    await expect(existingManager.locator('img[alt=""]')).toHaveCount(19);
    expect(previewCounts.size).toBe(19);
    expect([...previewCounts.values()].every((count) => count === 1)).toBe(true);
    await expect(existingManager.locator('#imageIds-capacity')).toContainText('19 of 9 images');
    await expect(existingInput).toBeDisabled();
    const existingRemove = existingManager
      .getByRole('button', { name: 'Remove image', exact: true })
      .first();
    await existingRemove.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(existingRemove).toBeFocused();
    const existingActionBar = existingRemove.locator('..');
    await expect(existingActionBar).toHaveCSS('opacity', '1');
    expect(await existingRemove.evaluate((element) => element.matches(':focus-visible'))).toBe(
      true,
    );
    const firstRemovalFocus = await existingRemove.evaluate((button) => {
      if (!(button instanceof HTMLButtonElement)) throw new Error('Remove is not a button');
      const manager = button.closest('[data-image-manager]');
      button.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
      const active = document.activeElement;
      return {
        activeTag: active?.tagName,
        activeLabel: active?.getAttribute('aria-label'),
        activeImageId: active?.closest('[data-image-id]')?.getAttribute('data-image-id'),
        survivingImageIds: Array.from(manager?.querySelectorAll('[data-image-id]') ?? []).map(
          (item) => item.getAttribute('data-image-id'),
        ),
      };
    });
    expect(firstRemovalFocus).toEqual({
      activeTag: 'BUTTON',
      activeLabel: 'Remove image',
      activeImageId: 'existing-image-2',
      survivingImageIds: existingImageIds.slice(1),
    });
    const nextExistingRemove = existingManager
      .getByRole('button', { name: 'Remove image', exact: true })
      .first();
    await expect(nextExistingRemove).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(
      existingManager.getByRole('button', { name: 'Remove image', exact: true }).first(),
    ).toBeFocused();
    await expect(existingManager.locator('#imageIds-capacity')).toContainText('17 of 9 images');
    await expect(existingManager.locator('output')).toContainText('17 of 9 images');
    await expect(existingManager.locator('output')).toContainText('Image removed');
    await expect(existingInput).toBeEnabled();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();

    await page.getByRole('button', { name: /^New / }).click();

    const fileInput = page.locator('#imageIds');
    const imageManager = page.locator('#imageIds-capacity').locator('..');
    await expect(fileInput).toBeAttached();
    await expect(fileInput).toHaveAccessibleName('Add product images');
    await expect(fileInput).toHaveAttribute('aria-describedby', 'imageIds-capacity');
    expect(await fileInput.evaluate((element) => element.getAttribute('id'))).toBe('imageIds');
    await fileInput.focus();
    await expect(fileInput).toBeFocused();
    expect(
      await fileInput.locator('..').evaluate((element) => getComputedStyle(element).boxShadow),
    ).not.toBe('none');
    // V1.1 caps a PRODUCT at nine images (Overstock keeps eighteen), so twenty
    // selected files fill the nine slots and the rest are refused before upload.
    await expect(imageManager.locator('#imageIds-capacity')).toContainText('0 of 9 images');

    const payloads = Array.from({ length: 20 }, (_, index) => ({
      name: `miu8-cap-${index}.png`,
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
        'base64',
      ),
    }));
    await fileInput.setInputFiles(payloads);
    await expect
      .poll(() => [...intentCounts.values()].reduce((sum, count) => sum + count, 0))
      .toBe(9);
    await expect(imageManager.getByText('Uploading…')).toHaveCount(0);
    await expect(imageManager.getByText('Upload failed', { exact: true })).toHaveCount(2);
    await expect(imageManager.locator('output')).toContainText(
      '2 uploads failed. Retry or remove them.',
    );
    await expect(imageManager.locator('img[alt=""]')).toHaveCount(7);
    await expect(imageManager.locator('#imageIds-capacity')).toContainText('9 of 9 images');
    await expect(imageManager.locator('output')).toContainText('11 files not selected');
    await expect(fileInput).toBeDisabled();

    const firstRetry = imageManager.getByRole('button', { name: 'Retry', exact: true }).first();
    await firstRetry.evaluate((button) => {
      if (!(button instanceof HTMLButtonElement)) throw new Error('Retry is not a button');
      button.click();
      button.click();
    });
    await expect.poll(() => intentCounts.get('miu8-cap-0.png') ?? 0).toBe(2);
    await page.waitForTimeout(100);
    expect(intentCounts.get('miu8-cap-0.png')).toBe(2);
    await expect(imageManager.getByText('Upload failed', { exact: true })).toHaveCount(1);
    await expect(imageManager.locator('img[alt=""]')).toHaveCount(8);

    await imageManager.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(imageManager.locator('#imageIds-capacity')).toContainText('8 of 9 images');
    await expect(imageManager.locator('output')).toContainText('Failed upload removed');
    await expect(fileInput).toBeEnabled();

    await fileInput.setInputFiles({
      name: 'miu8-cap-replacement.png',
      mimeType: 'image/png',
      buffer: payloads[0]?.buffer ?? Buffer.alloc(0),
    });
    await expect(imageManager.locator('img[alt=""]')).toHaveCount(9);
    await expect(imageManager.locator('#imageIds-capacity')).toContainText('9 of 9 images');
    await expect(fileInput).toBeDisabled();
    expect(intentCounts.get('miu8-cap-replacement.png')).toBe(1);
  });

  test('Headphones hero serves gated product media SSR-first with ordered fallback', async ({
    page,
  }) => {
    // The reviewed hero provenance (i18n/content/headphones/en-US.md
    // hero.sources): three gated 800x800 images, tried in order.
    const heroSourceIds = [
      '0e0afdc26a68209e00523aa031e56460',
      '7b76ee416a68209d0110670520562928',
      '0e0afdc26a68209c00523a7b50cb8647',
    ] as const;

    // client:load SSR. Assert ONLY on markup that client:load emits: the
    // wrapper div and the island's serialized props exist under client:only
    // too, so asserting those would pin nothing.
    const ssrResponse = await page.request.get(`${e2e.siteUrl}/headphones`);
    expect(ssrResponse.ok()).toBe(true);
    const ssrHtml = await ssrResponse.text();
    expect(ssrHtml).toContain('client="load"');
    expect(ssrHtml).toContain('data-product-media="image"');
    expect(ssrHtml).toContain(heroSourceIds[0]);
    // The focused shell omits the standalone client-logo band; canonical
    // proof stays on /oem and /portfolio.
    expect(ssrHtml).not.toContain('Global Clients');

    // Hero mobile order at 390x844: real media sits before the proof/CTA row,
    // the Product Line hint is visible, and nothing overflows.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/headphones', { waitUntil: 'domcontentloaded' });
    await ensureApplicationPage(page);
    const heroMedia = page.locator('[data-hero-media]');
    await expect(heroMedia).toBeVisible();
    const heroImage = heroMedia.locator('[data-product-media="image"]');
    await expect(heroImage).toBeVisible();
    // Unrouted load: the FIRST reviewed source is the one actually served.
    await expect(heroImage).toHaveAttribute('src', new RegExp(heroSourceIds[0]));
    const mediaBox = await heroMedia.boundingBox();
    const proofBox = await page.locator('[data-hero-proof]').boundingBox();
    if (!mediaBox || !proofBox) throw new Error('hero media/proof geometry unavailable');
    expect(mediaBox.y).toBeLessThan(proofBox.y);
    // ui-design responsive matrix: 160-180px real media at 375/390.
    const mediaHeight = mediaBox.height;
    expect(mediaHeight).toBeGreaterThanOrEqual(160);
    expect(mediaHeight).toBeLessThanOrEqual(180);
    await expect(page.getByText('Factory-Direct Headphones', { exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);

    // Force ONLY the first reviewed source to 404: the second must render.
    await page.route('**/api/images/**', (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname.endsWith(heroSourceIds[0])) {
        return route.fulfill({ status: 404, headers: { 'Cache-Control': 'no-store' }, body: '' });
      }
      return route.fulfill({
        status: 200,
        contentType: 'image/svg+xml',
        headers: { 'Cache-Control': 'no-store' },
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800"><rect width="800" height="800" fill="#315d78"/></svg>',
      });
    });
    await page.goto('/headphones', { waitUntil: 'domcontentloaded' });
    await ensureApplicationPage(page);
    const advancedImage = heroMedia.locator('[data-product-media="image"]');
    await expect(advancedImage).toBeVisible();
    await expect(advancedImage).toHaveAttribute('src', new RegExp(heroSourceIds[1]));
    await page.unroute('**/api/images/**');

    // Force ALL sources to 404: the terminal fallback must appear WITHOUT a
    // request loop (each source tried at most once).
    const heroRequestCounts = new Map<string, number>();
    await page.route('**/api/images/**', (route) => {
      const url = new URL(route.request().url());
      heroRequestCounts.set(url.pathname, (heroRequestCounts.get(url.pathname) ?? 0) + 1);
      return route.fulfill({ status: 404, contentType: 'text/plain', body: 'gone' });
    });
    await page.goto('/headphones', { waitUntil: 'domcontentloaded' });
    await ensureApplicationPage(page);
    await expect(heroMedia.locator('[data-product-media="fallback"]')).toBeVisible();
    await expect(heroMedia.locator('[data-product-media="image"]')).toHaveCount(0);
    for (const [pathname, count] of heroRequestCounts) {
      expect(count, `no request loop for ${pathname}`).toBeLessThanOrEqual(1);
    }
    await page.unroute('**/api/images/**');
  });

  test('Headphones Load More paginates, dedupes, and recovers without losing cards', async ({
    page,
  }) => {
    // Server pages overlap by one id (concurrent inserts shift offset windows)
    // so the dedup contract is exercised, not just assumed.
    const pageFor = (n: number) => {
      const start = (n - 1) * 12 - (n - 1);
      return Array.from({ length: 12 }, (_, i) => ({
        _id: `miu13-p${start + i + 1}`,
        name: `MIU13 Model ${start + i + 1}`,
        category: 'bluetooth',
        unitPrice: 10 + n,
        moq: 500,
        images: [],
      }));
    };
    const catalogRequests: string[] = [];
    let failNextLoadMore = false;

    await page.route('**/api/products?**', (route) => {
      const url = new URL(route.request().url());
      catalogRequests.push(url.search);
      const pageNumber = Number(url.searchParams.get('page') ?? '1');
      if (pageNumber > 1 && failNextLoadMore) {
        failNextLoadMore = false;
        return route.fulfill({ status: 500, contentType: 'text/plain', body: 'boom' });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          data: { items: pageFor(pageNumber), total: 30, page: pageNumber, pageSize: 12 },
        }),
      });
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/headphones', { waitUntil: 'domcontentloaded' });
    await ensureApplicationPage(page);

    const cards = page.locator('[data-product-card]');
    const loadMore = page.locator('[data-load-more]');
    await expect(cards).toHaveCount(12);
    // Exactly one initial catalog call, and it asks for 12 items.
    expect(catalogRequests).toHaveLength(1);
    expect(catalogRequests[0]).toContain('pageSize=12');
    expect(catalogRequests[0]).toContain('page=1');
    await expect(page.locator('[data-result-progress]')).toContainText('12');

    // A recoverable load-more failure keeps the loaded cards usable.
    failNextLoadMore = true;
    await loadMore.click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(cards).toHaveCount(12);
    await expect(loadMore).toBeEnabled();

    // Retry: page 2 overlaps page 1 by one id, so 12 + 11 unique = 23.
    await loadMore.click();
    await expect(cards).toHaveCount(23);
    expect(catalogRequests.at(-1)).toContain('page=2');
    // Every rendered card id is unique.
    const ids = await cards.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-product-card')),
    );
    expect(new Set(ids).size).toBe(ids.length);

    await page.unroute('**/api/products?**');
  });

  test('Headphones keyboard flow moves focus card -> detail -> back to origin card', async ({
    page,
  }) => {
    const items = Array.from({ length: 3 }, (_, i) => ({
      _id: `miu13-focus-${i + 1}`,
      name: `MIU13 Focus Model ${i + 1}`,
      category: 'bluetooth',
      description:
        'A deliberately long product description used to prove that detail copy wraps inside its bounded column track instead of widening the document at medium widths.',
      series: 'SERIES-WITH-A-VERY-LONG-UNBROKEN-IDENTIFIER-0123456789',
      modType: 'TWS',
      moq: 500,
      unitPrice: 12.5,
      images: Array.from({ length: 6 }, (_, n) => `/api/images/miu13-focus-${i + 1}-${n + 1}`),
    }));
    const imageRequests: string[] = [];

    await page.route('**/api/products?**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          data: { items, total: items.length, page: 1, pageSize: 12 },
        }),
      }),
    );
    await page.route('**/api/images/**', (route) => {
      imageRequests.push(new URL(route.request().url()).pathname);
      return route.fulfill({
        status: 200,
        contentType: 'image/svg+xml',
        headers: { 'Cache-Control': 'no-store' },
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800"><rect width="800" height="800" fill="#315d78"/></svg>',
      });
    });

    for (const viewport of [
      { width: 768, height: 1024 },
      { width: 1024, height: 768 },
    ]) {
      await page.setViewportSize(viewport);
      imageRequests.length = 0;
      await page.goto('/headphones', { waitUntil: 'domcontentloaded' });
      await ensureApplicationPage(page);

      const originCard = page.locator('[data-product-card="miu13-focus-2"]');
      await expect(originCard).toBeVisible();
      // Interaction-gated gallery: a card may lazily request its OWN primary
      // image (suffix -1), but no gallery thumbnail (-2..-6) may be fetched
      // before a product is selected.
      expect(
        imageRequests.filter((path) => /miu13-focus-\d+-(?!1$)\d+$/.test(path)),
        `no gallery thumbnail request before selection at ${viewport.width}px`,
      ).toEqual([]);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      ).toBe(true);

      // Keyboard: focus the card and activate it.
      await originCard.focus();
      await expect(originCard).toBeFocused();
      await page.keyboard.press('Enter');

      // Focus lands on the detail heading of the expanded band.
      const heading = page.locator('[data-detail-heading]');
      await expect(heading).toBeVisible();
      await expect(heading).toBeFocused();
      await expect(page.locator('[data-product-detail="miu13-focus-2"]')).toBeVisible();

      // Request budget after selection: the active image plus at most four
      // lazy thumbnail previews — never all six references.
      const galleryRequests = imageRequests.filter((path) => path.includes('miu13-focus-2'));
      expect(
        new Set(galleryRequests).size,
        `bounded gallery requests at ${viewport.width}px`,
      ).toBeLessThanOrEqual(5);
      // No HIGH-PRIORITY image other than the hero. (The gallery's active
      // image is `eager` — the user explicitly asked for it — but must not
      // compete with the hero for bandwidth priority; thumbnails are `low`.)
      const highPriorityOutsideHero = await page.evaluate(() =>
        Array.from(document.querySelectorAll('img'))
          .filter((img) => !img.closest('[data-hero-media]'))
          .filter((img) => img.getAttribute('fetchpriority') === 'high')
          .map((img) => img.getAttribute('src')),
      );
      expect(
        highPriorityOutsideHero,
        `no high-priority media outside the hero at ${viewport.width}px`,
      ).toEqual([]);

      // Long copy and long spec values wrap instead of widening the document.
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
        `no overflow with detail open at ${viewport.width}px`,
      ).toBe(true);

      // View All expands the bounded thumbnail track without overflow.
      const viewAll = page.locator('[data-gallery-view-all]');
      await expect(viewAll).toBeVisible();
      await viewAll.click();
      await expect(page.locator('[data-gallery-thumbnail]')).toHaveCount(6);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
        `no overflow after View All at ${viewport.width}px`,
      ).toBe(true);

      // Every enquiry command resolves to the OEM enquiry section, and the
      // retired advantages band is gone.
      const enquiryHrefs = await page
        .locator('[data-product-detail] a')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href')));
      expect(enquiryHrefs.length).toBeGreaterThan(0);
      for (const href of enquiryHrefs) {
        expect(href).toBe('/#oem-inquiry');
      }
      await expect(page.getByText('Factory Strength & Quality Assurance')).toHaveCount(0);

      // Back returns focus to the originating card.
      await page.locator('[data-detail-back]').click();
      await expect(page.locator('[data-product-detail]')).toHaveCount(0);
      await expect(originCard).toBeFocused();

      // Re-activating the SAME card must move focus again, not dead-end: the
      // open handler cannot rely on the active product changing identity.
      await page.keyboard.press('Enter');
      await expect(heading).toBeFocused();
      await originCard.focus();
      await page.keyboard.press('Enter');
      await expect(
        heading,
        `re-activating the open card refocuses its heading at ${viewport.width}px`,
      ).toBeFocused();
      await page.locator('[data-detail-back]').click();
      await expect(page.locator('[data-product-detail]')).toHaveCount(0);
    }

    await page.unroute('**/api/images/**');
    await page.unroute('**/api/products?**');
  });

  test('Headphones header stays responsive and card pricing hierarchy is restrained', async ({
    browser,
    page,
  }) => {
    for (const viewport of [
      { width: 1360, height: 800 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto('/headphones', { waitUntil: 'domcontentloaded' });
      await ensureApplicationPage(page);
      await page.evaluate(() => document.fonts?.ready);
      await expect(page.locator('[data-primary-nav]')).toBeVisible();
      await expect(page.locator('[data-account-controls]')).toBeVisible();
      await expect(
        page.locator('[data-account-controls]').getByRole('link', { name: 'Sign in', exact: true }),
      ).toBeVisible();

      expectDesktopHeaderContained(await readHeaderGeometry(page));
    }

    await page.route('**/api/products?**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          data: cardTypographyCatalog,
        }),
      }),
    );

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/headphones', { waitUntil: 'domcontentloaded' });
    await ensureApplicationPage(page);
    const productCards = page.locator('[data-product-card]');
    await expect(productCards).toHaveCount(1);
    await expect(page.locator('[data-product-card="e2e-card-typography"]')).toBeVisible();
    await expect(page.locator('[data-product-card-price]').first()).toHaveCSS('font-weight', '600');
    await expect(page.locator('[data-product-card-price]').first()).toHaveCSS(
      'font-family',
      /^Inter(?:,|$)/,
    );
    await expect(page.locator('[data-product-card-action]').first()).toHaveCSS(
      'font-weight',
      '500',
    );
    await page.unrouteAll({ behavior: 'wait' });

    for (const viewport of [
      { width: 390, height: 844 },
      { width: 768, height: 768 },
      { width: 1023, height: 768 },
      { width: 1024, height: 768 },
      { width: 1279, height: 800 },
      { width: 1280, height: 800 },
      { width: 1319, height: 800 },
      { width: 1320, height: 800 },
      { width: 1359, height: 800 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto('/headphones', { waitUntil: 'domcontentloaded' });
      await ensureApplicationPage(page);
      await expect(page.locator('[data-primary-nav]')).toBeHidden();
      await expect(page.locator('.header-desktop-account')).toBeHidden();
      const menuToggle = page.locator('[data-menu-toggle]');
      await expect(menuToggle).toBeVisible();
      await menuToggle.click();
      await expect(page.locator('[data-mobile-disclosure]')).toHaveAttribute('open', '');
      await expect(page.getByRole('navigation', { name: 'Mobile' })).toBeVisible();
      const mobileGeometry = await page.evaluate(() => {
        const brand = document.querySelector('[data-brand-link]')?.getBoundingClientRect();
        const toggle = document.querySelector('[data-menu-toggle]')?.getBoundingClientRect();
        return brand && toggle ? { brandRight: brand.right, toggleLeft: toggle.left } : null;
      });
      expect(mobileGeometry?.brandRight).toBeLessThanOrEqual(mobileGeometry?.toggleLeft ?? 0);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    }

    await page.setViewportSize({ width: 1359, height: 800 });
    await page.goto('/headphones', { waitUntil: 'domcontentloaded' });
    const transitionToggle = page.locator('[data-menu-toggle]');
    await expect(transitionToggle).toBeVisible();
    await transitionToggle.click();
    await expect(page.locator('[data-mobile-disclosure]')).toHaveAttribute('open', '');
    await expect(page.getByRole('navigation', { name: 'Mobile' })).toBeVisible();
    // Under the catalog IA the family link lives inside the Electronics & Toys
    // disclosure in both lanes, so the lane transition must carry focus between
    // the two nested copies of the same destination.
    const mobileCatalogLink = page
      .locator('[data-catalog-disclosure="mobile"]')
      .locator('a[href="/headphones/"]');
    await page.locator('[data-catalog-disclosure="mobile"]').locator(':scope > summary').click();
    await mobileCatalogLink.focus();
    await page.setViewportSize({ width: 1360, height: 800 });
    await expect(page.locator('[data-site-header]')).toHaveAttribute('data-header-mode', 'desktop');
    await expect(page.locator('[data-mobile-disclosure]')).not.toHaveAttribute('open', '');
    await expect(
      page.locator('[data-catalog-disclosure="desktop"]').locator('a[href="/headphones/"]'),
    ).toBeFocused();
    await page.setViewportSize({ width: 1359, height: 800 });
    await expect(page.locator('[data-mobile-disclosure]')).toHaveAttribute('open', '');
    await expect(page.getByRole('navigation', { name: 'Mobile' })).toBeVisible();
    await expect(mobileCatalogLink).toBeFocused();

    await page.setViewportSize({ width: 568, height: 320 });
    await page.goto('/headphones', { waitUntil: 'domcontentloaded' });
    await page.locator('[data-menu-toggle]').click();
    const shortMenu = page.getByRole('navigation', { name: 'Mobile' });
    await expect(shortMenu).toBeVisible();
    await expect(shortMenu).toHaveCSS('overflow-y', 'auto');
    const shortSignIn = shortMenu.getByRole('link', { name: 'Sign in', exact: true });
    await shortSignIn.click();
    await expect(page).toHaveURL(/\/login\/?$/);

    const trustedStorage = await trustedSiteStorage(browser);
    const signedInContext = await browser.newContext({
      storageState: trustedStorage,
      viewport: { width: 1440, height: 900 },
    });
    try {
      await signedInContext.addInitScript((user) => {
        localStorage.setItem('channel.token', 'e2e-header-token');
        localStorage.setItem('channel.user', JSON.stringify(user));
      }, longNameMember);
      const signedInPage = await signedInContext.newPage();
      await signedInPage.goto(e2e.siteUrl, { waitUntil: 'domcontentloaded' });
      await ensureApplicationPage(signedInPage);
      await signedInPage.evaluate(() => document.fonts?.ready);
      const desktopAccountTrigger = signedInPage
        .locator('.header-desktop-account')
        .getByRole('button', {
          name: new RegExp(longNameMember.username),
        });
      await expect(desktopAccountTrigger).toBeVisible();
      await expect(signedInPage.locator('[data-site-header]')).toHaveAttribute(
        'data-header-mode',
        'desktop',
      );
      expectDesktopHeaderContained(await readHeaderGeometry(signedInPage));
      await desktopAccountTrigger.focus();
      await signedInPage.evaluate(() => {
        // 3 nav links (Teardown/Blue Ocean hidden) leave more headroom than the
        // original 5-link header did — 150% font is what reliably overflows the
        // measured desktop lane now.
        document.documentElement.style.fontSize = '150%';
        window.dispatchEvent(new Event('resize'));
      });
      await expect(signedInPage.locator('[data-site-header]')).toHaveAttribute(
        'data-header-mode',
        'mobile',
      );
      await expect(signedInPage.locator('[data-menu-toggle]')).toBeVisible();
      const mobileAccountTrigger = signedInPage
        .locator('[data-mobile-menu]')
        .getByRole('button', { name: new RegExp(longNameMember.username) });
      await expect(mobileAccountTrigger).toBeFocused();
      expect(
        await signedInPage.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);

      await signedInPage.evaluate(() => {
        document.documentElement.style.fontSize = '';
        window.dispatchEvent(new Event('resize'));
      });
      await expect(signedInPage.locator('[data-site-header]')).toHaveAttribute(
        'data-header-mode',
        'desktop',
      );
      expectDesktopHeaderContained(await readHeaderGeometry(signedInPage));
      await expect(desktopAccountTrigger).toBeFocused();

      await desktopAccountTrigger.click();
      const desktopAccountSettings = signedInPage
        .locator('.header-desktop-account')
        .getByRole('link', { name: 'Account settings', exact: true });
      await desktopAccountSettings.focus();
      await signedInPage.setViewportSize({ width: 1359, height: 800 });
      await expect(signedInPage.locator('[data-site-header]')).toHaveAttribute(
        'data-header-mode',
        'mobile',
      );
      await expect(
        signedInPage
          .locator('[data-mobile-menu]')
          .getByRole('button', { name: new RegExp(longNameMember.username) }),
      ).toBeFocused();
    } finally {
      await signedInContext.close();
    }

    await page.setViewportSize({ width: 1359, height: 800 });
    await page.goto('/headphones', { waitUntil: 'domcontentloaded' });
    await page.locator('[data-menu-toggle]').click();
    const mobileSignIn = page
      .getByRole('navigation', { name: 'Mobile' })
      .getByRole('link', { name: 'Sign in', exact: true });
    await mobileSignIn.focus();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(
      page.locator('.header-desktop-account').getByRole('link', { name: 'Sign in', exact: true }),
    ).toBeFocused();
  });

  test('public navigation remains available without JavaScript', async ({ browser }) => {
    const trustedStorage = await trustedSiteStorage(browser);
    // The header now picks its lane in CSS at the same 1360px threshold the script
    // measures, so navigation is present without JavaScript at BOTH widths: the
    // desktop lane above the threshold, the native disclosure below it.
    const context = await browser.newContext({
      javaScriptEnabled: false,
      storageState: trustedStorage,
      viewport: { width: 1440, height: 900 },
    });
    try {
      const page = await context.newPage();
      await page.goto(`${e2e.siteUrl}/headphones`, { waitUntil: 'domcontentloaded' });
      const desktopNav = page.locator('[data-primary-nav]');
      await expect(desktopNav).toBeVisible();
      const desktopCatalog = page.locator('[data-catalog-disclosure="desktop"]');
      await desktopCatalog.locator(':scope > summary').click();
      await expect(desktopCatalog.locator('a[href="/headphones/"]')).toBeVisible();
    } finally {
      await context.close();
    }

    const mobileContext = await browser.newContext({
      javaScriptEnabled: false,
      storageState: trustedStorage,
      viewport: { width: 390, height: 844 },
    });
    try {
      const page = await mobileContext.newPage();
      await page.goto(`${e2e.siteUrl}/headphones`, { waitUntil: 'domcontentloaded' });
      const disclosure = page.locator('[data-mobile-disclosure]');
      await expect(disclosure).toBeVisible();
      await disclosure.locator(':scope > summary').click();
      const mobileMenu = page.getByRole('navigation', { name: 'Mobile' });
      await expect(mobileMenu).toBeVisible();
      const mobileCatalog = mobileMenu.locator('[data-catalog-disclosure="mobile"]');
      await mobileCatalog.locator(':scope > summary').click();
      await expect(
        mobileCatalog.getByRole('link', { name: 'Headphones', exact: true }),
      ).toHaveAttribute('href', '/headphones/');
    } finally {
      await mobileContext.close();
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

  test('OEM Phase 8 renders approved active OEM claims without submitting', async ({ page }) => {
    const adminPosts: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes('/api/admin')) {
        adminPosts.push(request.url());
      }
    });

    await page.goto(`/oem?phase8=${e2e.runId}`, { waitUntil: 'domcontentloaded' });
    // The independent OEM page keeps the approved experience stat in its own
    // restored Why Us section.
    await expect(page.locator('#why-us').getByText('20+', { exact: true })).toBeVisible();
    await expect(page.getByText('15+', { exact: true })).toHaveCount(0);

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

  // Was permanently skipped with a stale justification ("headphones is
  // un-routed on the OEM-only site") and assertions written against a retired
  // UI. Headphones is live, so this now runs against the shipped catalog: the
  // island hydrates against the REAL API, resolves out of its skeleton, and
  // does so without console errors or unhandled rejections.
  test('headphones page hydrates and resolves catalog loading state', async ({ page }) => {
    const problems = captureConsoleProblems(page);
    const productsResponse = page.waitForResponse(
      (response) => response.url().includes('/api/products') && response.status() === 200,
    );

    await page.goto('/headphones', { waitUntil: 'domcontentloaded' });
    await ensureApplicationPage(page);
    await productsResponse;

    // The catalog heading is server-rendered; the skeleton must clear once the
    // island hydrates and commits its first page.
    await expect(page.locator('[data-catalog-heading]')).toBeVisible();
    await expect(page.locator('.animate-pulse')).toHaveCount(0, { timeout: 15_000 });

    // Terminal state is either real cards or the authored empty state — never
    // an indefinite skeleton and never a blocking error.
    await expect
      .poll(async () => {
        const cards = await page.locator('[data-product-card]').count();
        const empty = await page.getByText('No published headphone models are available').count();
        return cards + empty;
      })
      .toBeGreaterThan(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(problems).toEqual([]);
  });
});
