import { type Browser, type Page, expect, test } from '@playwright/test';
import type { CatalogPage } from '../../apps/site/src/islands/shop/catalog-types.ts';
import type { SessionUser } from '../../packages/shared/src/auth.ts';
import { teardownBomSource } from '../fixtures/teardown-bom-source.ts';
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

async function readHeaderGeometry(page: Page) {
  return page.evaluate(() => {
    const bounds = (selector: string) => {
      const rect = document.querySelector(selector)?.getBoundingClientRect();
      return rect
        ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
        : null;
    };
    const visibleLinks = Array.from(
      document.querySelectorAll<HTMLElement>('[data-primary-nav] > a'),
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
  expect(geometry.visibleLinks).toHaveLength(5);
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
    await page.goto('/oem#capabilities', { waitUntil: 'domcontentloaded' });
    const reveal = page.locator('#capabilities .reveal').first();
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
    await page.goto('/oem#capabilities', { waitUntil: 'domcontentloaded' });
    const reveal = page.locator('#capabilities .reveal').first();
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
    const reveal = page.locator('#capabilities .reveal').first();
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
        await page.goto(`${e2e.siteUrl}/oem#capabilities`, { waitUntil: 'domcontentloaded' });
        const reveal = page.locator('#capabilities .reveal').first();
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

  test('below-fold reveal animates once and releases transform resources', async ({ page }) => {
    await page.goto('/oem', { waitUntil: 'domcontentloaded' });
    const reveal = page.locator('#capabilities .reveal').first();
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
    const reveal = page.locator('#capabilities .reveal').first();
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

  test('Headphones Gallery bounds media, falls back, and resets across products', async ({
    page,
  }) => {
    const imageIdsA = Array.from({ length: 6 }, (_, index) => `miu8-a${index + 1}`);
    const imageIdsB = Array.from({ length: 6 }, (_, index) => `miu8-b${index + 1}`);
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
                images: imageIdsB.map(imagePath),
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
      expect(requestedImageIds).not.toContain('miu8-a5');
      expect(requestedImageIds).not.toContain('miu8-a6');

      await frame.scrollIntoViewIfNeeded();
      await page.mouse.move(1, 1);
      await page.waitForTimeout(50);
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
          objectPosition: style.objectPosition,
          backgroundImage: style.backgroundImage,
          scrollX: window.scrollX,
          scrollY: window.scrollY,
        };
      });
      await frame.hover({ position: { x: 5, y: 5 } });
      const frameBox = await frame.boundingBox();
      if (!frameBox) throw new Error('Gallery frame has no bounding box');
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

      await productB.click();
      await expect(thumbnails).toHaveCount(4);
      await expect(viewAll).toHaveAttribute('aria-expanded', 'false');
      await expect(thumbnails.first()).toHaveAttribute('aria-pressed', 'true');
      await expect(frame.locator('img')).toHaveAttribute('src', /\/api\/images\/miu8-b1$/);
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
    await page
      .getByRole('navigation', { name: 'Mobile' })
      .getByRole('link', { name: 'Headphones', exact: true })
      .focus();
    await page.setViewportSize({ width: 1360, height: 800 });
    await expect(page.locator('[data-site-header]')).toHaveAttribute('data-header-mode', 'desktop');
    await expect(page.locator('[data-mobile-disclosure]')).not.toHaveAttribute('open', '');
    await expect(
      page.locator('[data-primary-nav]').getByRole('link', { name: 'Headphones', exact: true }),
    ).toBeFocused();
    await page.setViewportSize({ width: 1359, height: 800 });
    await expect(page.locator('[data-mobile-disclosure]')).toHaveAttribute('open', '');
    await expect(page.getByRole('navigation', { name: 'Mobile' })).toBeVisible();
    await expect(
      page
        .getByRole('navigation', { name: 'Mobile' })
        .getByRole('link', { name: 'Headphones', exact: true }),
    ).toBeFocused();

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
        document.documentElement.style.fontSize = '125%';
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
    const context = await browser.newContext({
      javaScriptEnabled: false,
      storageState: trustedStorage,
      viewport: { width: 1440, height: 900 },
    });
    try {
      const page = await context.newPage();
      await page.goto(`${e2e.siteUrl}/headphones`, { waitUntil: 'domcontentloaded' });
      const disclosure = page.locator('[data-mobile-disclosure]');
      await expect(disclosure).toBeVisible();
      await disclosure.locator('summary').click();
      const mobileMenu = page.getByRole('navigation', { name: 'Mobile' });
      await expect(mobileMenu).toBeVisible();
      await expect(
        mobileMenu.getByRole('link', { name: 'Headphones', exact: true }),
      ).toHaveAttribute('href', '/headphones');
    } finally {
      await context.close();
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
