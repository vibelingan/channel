import { type Locator, type Page, expect, test } from '@playwright/test';
import { detailFixture } from '../../apps/site/src/catalog/testing/detail-fixture.ts';
import type { CatalogQuoteSubmission } from '../../packages/shared/src/catalog/quote-draft.ts';
import { mockCatalogTaxonomy } from './helpers/admin-api';

async function focusCountry(country: Locator) {
  await country.click();
  // Playwright can type before the scroll event from bringing the input into
  // view is delivered. Let that scroll finish before opening the popup; React
  // Aria correctly dismisses an open popup when its parent is scrolled.
  await country.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function expectContainedQuote(dialog: Locator) {
  const measured = await dialog.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const form = element.querySelector('form');
    const formBounds = form?.getBoundingClientRect();
    const controls = Array.from(
      element.querySelectorAll(
        'input:not([type=hidden]), textarea, button, h2, [data-rfq-context], [data-rfq-review]',
      ),
    )
      .filter((item) => item.getClientRects().length > 0)
      .map((item) => ({
        tag: item.tagName,
        type: item.getAttribute('type'),
        left: item.getBoundingClientRect().left,
        right: item.getBoundingClientRect().right,
      }));
    return {
      width: innerWidth,
      left: bounds.left,
      right: bounds.right,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      formWidth: form?.scrollWidth,
      formClient: form?.clientWidth,
      formLeft: formBounds?.left ?? -1,
      formRight: formBounds?.right ?? -1,
      controls,
      overflowX: getComputedStyle(element).overflowX,
      touchAction: getComputedStyle(element).touchAction,
    };
  });
  expect(measured.left).toBeGreaterThanOrEqual(-1);
  expect(measured.right).toBeLessThanOrEqual(measured.width + 1);
  expect(measured.scrollWidth).toBeLessThanOrEqual(measured.clientWidth + 1);
  expect(measured.formWidth).toBeLessThanOrEqual((measured.formClient ?? 0) + 1);
  for (const control of measured.controls) {
    expect(control.left, JSON.stringify(control)).toBeGreaterThanOrEqual(measured.left - 1);
    expect(control.right, JSON.stringify(control)).toBeLessThanOrEqual(measured.right + 1);
  }
  expect(measured.overflowX).toBe('hidden');
  expect(measured.touchAction).toContain('pan-y');
  expect(measured.touchAction).toContain('pinch-zoom');
}

test.describe('country Escape layering', { tag: '@mobile-regression' }, () => {
  test.use({ hasTouch: true });
  test.beforeEach(async ({ page }, testInfo) => {
    testInfo.annotations.push({
      type: 'browser',
      description: page.context().browser()?.version() ?? 'unknown',
    });
  });
  for (const viewport of [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
  ]) {
    for (const escapeTarget of ['input', 'popup', 'native cancel'] as const) {
      test(`preserves the quote at ${viewport.width}px from ${escapeTarget}`, async ({
        page,
      }, testInfo) => {
        await page.setViewportSize(viewport);
        const detail = detailFixture();
        detail.name = `Product-${'X'.repeat(180)}`;
        const first = detail.variants.items[0];
        if (!first) throw new Error('Missing fixture variant');
        first.options = [{ name: 'Configuration', value: `Option-${'Y'.repeat(150)}` }];
        await page.route('**/api/products/canonical-product/detail*', (route) =>
          route.fulfill({ contentType: 'application/json', body: envelope(detail) }),
        );
        await page.route('**/api/images/**', (route) =>
          route.fulfill({ contentType: 'image/png', body: imageBytes }),
        );
        await page.goto('/products/item/?id=canonical-product');
        const originalAnchor = await page.evaluate(
          () => document.documentElement.style.overflowAnchor,
        );
        const opener = page.getByRole('button', { name: 'Request a quote', exact: true });
        await opener.tap();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        await dialog.getByRole('textbox', { name: 'Requested quantity', exact: true }).fill('20');
        const date = new Date();
        date.setDate(date.getDate() + 14);
        await dialog.locator('input[type=date]').fill(date.toISOString().slice(0, 10));
        await dialog.getByRole('button', { name: 'Continue to contact' }).tap();
        const contact = dialog.getByRole('textbox', { name: 'Contact name', exact: true });
        const email = dialog.getByRole('textbox', { name: 'Email', exact: true });
        const company = dialog.getByRole('textbox', { name: 'Company', exact: true });
        await contact.fill('Escape Buyer');
        await email.fill('escape@example.test');
        await company.fill('Escape Company');
        const country = dialog.getByRole('combobox', { name: 'Company country / region' });
        await focusCountry(country);
        await country.fill('HK');
        const option = dialog.getByRole('option', { name: /Hong Kong/ });
        await expect(option).toBeVisible();
        const hit = await option.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          const center = { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
          return {
            ...center,
            reachable: element.contains(document.elementFromPoint(center.x, center.y)),
          };
        });
        expect(hit.reachable).toBe(true);
        await page.touchscreen.tap(hit.x, hit.y);
        const countryLabel = await page.evaluate(() =>
          new Intl.DisplayNames(['en'], { type: 'region' }).of('HK'),
        );
        if (!countryLabel) throw new Error('Missing HK display name');
        await expect(country).toHaveValue(countryLabel);
        await expect(country).toBeFocused();
        const fields = {
          contactName: 'Escape Buyer',
          email: 'escape@example.test',
          company: 'Escape Company',
          country: 'HK',
        };
        const contactState = () =>
          dialog.evaluate((element) => {
            const form = element.querySelector('form');
            const input = element.querySelector<HTMLInputElement>('[role="combobox"]');
            if (!form || !input) throw new Error('Quote contact controls are missing');
            const fields: Record<string, FormDataEntryValue> = {};
            new FormData(form).forEach((value, key) => {
              fields[key] = value;
            });
            return {
              fields,
              method: form.method,
              countryLabel: input.value,
              expanded: input.getAttribute('aria-expanded'),
              focused: document.activeElement === input,
              listboxes: element.querySelectorAll('[role="listbox"]').length,
            };
          });
        for (let cycle = 0; cycle < 3; cycle++) {
          await country.press('ArrowDown');
          await expect(country).toHaveAttribute('aria-expanded', 'true');
          const listbox = dialog.getByRole('listbox');
          await expect(listbox).toBeVisible();
          if (escapeTarget === 'popup') {
            const dismissButton = dialog
              .locator('[data-trigger="ComboBox"]')
              .getByRole('button', { name: 'Dismiss', exact: true });
            await dismissButton.evaluate((element) => element.focus({ preventScroll: true }));
            await expect(dismissButton).toBeFocused();
          }
          if (escapeTarget === 'native cancel') {
            if (cycle === 0) {
              await dialog.dispatchEvent('cancel', { bubbles: false, cancelable: true });
            } else {
              await page.keyboard.down('Escape');
              await expect(country).toHaveAttribute('aria-expanded', 'false');
              await dialog.dispatchEvent('cancel', { bubbles: false, cancelable: true });
              await page.keyboard.up('Escape');
            }
          } else {
            await page.keyboard.press('Escape');
          }
          await expect(dialog).toBeVisible();
          await expect.poll(contactState).toMatchObject({
            fields,
            method: 'post',
            countryLabel,
            expanded: 'false',
            focused: true,
            listboxes: 0,
          });
        }
        await expectContainedQuote(dialog);
        if (process.env.E2E_RECORD_ARTIFACTS === '1')
          await page.screenshot({ path: testInfo.outputPath('escape-dismissed.png') });
        await page.keyboard.press('Escape');
        await expect(dialog).not.toBeVisible();
        await expect
          .poll(() => page.evaluate(() => document.documentElement.style.overflowAnchor))
          .toBe(originalAnchor);
        await expect(opener).toBeFocused();
        await opener.tap();
        await expect(
          dialog.getByRole('textbox', { name: 'Requested quantity', exact: true }),
        ).toHaveValue('20');
        await dialog.getByRole('button', { name: 'Continue to contact' }).tap();
        await expect.poll(contactState).toMatchObject({ fields, countryLabel });
      });
    }
  }
});

test.describe('responsive quote sheet', { tag: '@mobile-regression' }, () => {
  test.use({ hasTouch: true });
  for (const viewport of [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
    { width: 568, height: 320 },
    { width: 768, height: 1024 },
    { width: 1024, height: 768 },
    { width: 1440, height: 900 },
  ])
    test(`quote/customization stays contained through all steps at ${viewport.width}x${viewport.height}`, async ({
      page,
      browserName,
    }, testInfo) => {
      test.setTimeout(90000);
      await page.setViewportSize(viewport);
      const detail = detailFixture();
      detail.name = `Product-${'X'.repeat(180)}`;
      const first = detail.variants.items[0];
      if (!first) throw new Error('Missing fixture variant');
      first.options = [{ name: 'Configuration', value: `Option-${'Y'.repeat(150)}` }];
      await page.route('**/api/products/canonical-product/detail*', (route) =>
        route.fulfill({ contentType: 'application/json', body: envelope(detail) }),
      );
      await page.route('**/api/images/**', (route) =>
        route.fulfill({ contentType: 'image/png', body: imageBytes }),
      );
      let sends = 0;
      await page.route('**/api/catalog-quote-requests', (route) => {
        sends++;
        return route.abort();
      });
      await page.goto('/products/item/?id=canonical-product');
      // Intl region labels depend on the browser's ICU data (macOS/Linux may
      // use Hong Kong / Hong Kong SAR China). HK is the stable stored identity.
      const hongKongLabel = await page.evaluate(() =>
        new Intl.DisplayNames(['en'], { type: 'region' }).of('HK'),
      );
      if (!hongKongLabel) throw new Error('Missing HK display name');
      for (const customization of [false, true]) {
        const action = customization ? 'customization' : 'quote';
        const opener = page.getByRole('button', { name: 'Request a quote', exact: true });
        await opener.click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        const customizationToggle = dialog.getByRole('checkbox', {
          name: 'Ask about customization',
          exact: true,
        });
        await customizationToggle.setChecked(customization);
        await expect(customizationToggle).toBeChecked({ checked: customization });
        await expectContainedQuote(dialog);
        if (process.env.E2E_RECORD_ARTIFACTS === '1' && [390, 1440].includes(viewport.width))
          await page.screenshot({ path: testInfo.outputPath(`${action}-requirements.png`) });
        await dialog.getByRole('button', { name: 'Continue to contact' }).click();
        await expect(dialog.getByRole('alert').first()).toBeVisible();
        await expectContainedQuote(dialog);
        await dialog.getByRole('textbox', { name: 'Requested quantity', exact: true }).fill('20');
        const date = new Date();
        date.setDate(date.getDate() + 14);
        await dialog.locator('input[type=date]').fill(date.toISOString().slice(0, 10));
        if (customization) {
          await dialog.getByRole('checkbox', { name: 'Packaging', exact: true }).check();
          await dialog
            .locator('textarea')
            .fill('Use recyclable packaging and print our company logo.');
        }
        await expectContainedQuote(dialog);
        await dialog.getByRole('button', { name: 'Continue to contact' }).click();
        await dialog
          .getByRole('textbox', { name: 'Contact name', exact: true })
          .fill('Mobile Test Buyer');
        await dialog
          .getByRole('textbox', { name: 'Email', exact: true })
          .fill(`${'a'.repeat(60)}@example.test`);
        await dialog.getByRole('textbox', { name: 'Company', exact: true }).fill('C'.repeat(180));
        const country = dialog.getByRole('combobox', { name: 'Company country / region' });
        await focusCountry(country);
        await country.fill('HK');
        const option = dialog.getByRole('option', { name: /Hong Kong/ });
        await expect(option).toBeVisible();
        await option.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            }),
        );
        // Filtering changes popup height; assert its settled bounds, not the
        // intermediate placement from the previous result list.
        await expect
          .poll(async () => {
            const rect = await option.boundingBox();
            return rect
              ? Math.min(
                  rect.x,
                  rect.y,
                  viewport.width - rect.x - rect.width,
                  viewport.height - rect.y - rect.height,
                )
              : -1;
          })
          .toBeGreaterThanOrEqual(0);
        // Tap the visible option like a touch user. Locator.click's automatic
        // scrollIntoView can scroll the dialog around an already-visible fixed
        // portal and dismiss it. Verify hit-testing rather than force-clicking.
        const hit = await option.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          return { x, y, reachable: element.contains(document.elementFromPoint(x, y)) };
        });
        expect(hit.reachable).toBe(true);
        await page.touchscreen.tap(hit.x, hit.y);
        await expect(country).toHaveValue(hongKongLabel);
        await expect(dialog.locator('input[type=hidden][name=country]')).toHaveValue('HK');
        await expect(country).toBeFocused();
        await country.press('ArrowDown');
        await expect(country).toHaveAttribute('aria-expanded', 'true');
        await country.press('Escape');
        await expect(country).toHaveAttribute('aria-expanded', 'false');
        await expect(dialog).toBeVisible();
        await expectContainedQuote(dialog);
        await dialog.getByRole('button', { name: 'Review request' }).click();
        await expect(dialog.locator('[data-rfq-review]')).toContainText('Hong Kong');
        await expectContainedQuote(dialog);
        await page.evaluate(async () => {
          await document.fonts.ready;
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          });
        });
        const backgroundY = await page.evaluate(() => scrollY);
        await dialog.evaluate((element) => {
          element.scrollLeft = 120;
          element.scrollTop = element.scrollHeight;
        });
        expect(await dialog.evaluate((element) => element.scrollLeft)).toBe(0);
        expect(await dialog.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
        expect(await page.evaluate(() => scrollY)).toBe(backgroundY);
        if (browserName === 'chromium' && viewport.width === 390) {
          await dialog.evaluate((element) => {
            element.scrollTop = 0;
          });
          const session = await page.context().newCDPSession(page);
          const rect = await dialog.boundingBox();
          if (!rect) throw new Error('Quote sheet is missing');
          const start = { x: viewport.width / 2, y: rect.y + rect.height / 2 };
          expect(
            await dialog.evaluate(
              (element, point) => element.contains(document.elementFromPoint(point.x, point.y)),
              start,
            ),
          ).toBe(true);
          // Emit a real touch sequence rather than the platform-dependent
          // synthetic scroll shortcut. Wait for presented frames and assert the
          // resulting scroll offset; never mutate it to simulate a gesture.
          const swipe = async (dx: number, dy: number) => {
            const point = (x: number, y: number) => ({ x, y, id: 1, radiusX: 5, radiusY: 5 });
            await session.send('Input.dispatchTouchEvent', {
              type: 'touchStart',
              touchPoints: [point(start.x, start.y)],
            });
            for (let step = 1; step <= 12; step++) {
              await session.send('Input.dispatchTouchEvent', {
                type: 'touchMove',
                touchPoints: [point(start.x + (dx * step) / 12, start.y + (dy * step) / 12)],
              });
              await page.evaluate(
                () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
              );
            }
            await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          };
          await swipe(-120, 0);
          expect(await dialog.evaluate((element) => element.scrollLeft)).toBe(0);
          await expectContainedQuote(dialog);
          await swipe(0, -200);
          await expect
            .poll(() => dialog.evaluate((element) => element.scrollTop))
            .toBeGreaterThan(0);
          expect(await page.evaluate(() => scrollY)).toBe(backgroundY);
          await session.detach();
        }
        await dialog.getByRole('button', { name: 'Back', exact: true }).click();
        await expect(country).toHaveValue(hongKongLabel);
        await expect(dialog.locator('input[type=hidden][name=country]')).toHaveValue('HK');
        await page.keyboard.press('Escape');
        await expect(dialog).not.toBeVisible();
        await expect(opener).toBeFocused();
        await opener.click();
        await expect(
          dialog.getByRole('textbox', { name: 'Requested quantity', exact: true }),
        ).toHaveValue('20');
        await expectContainedQuote(dialog);
        await dialog.getByRole('button', { name: 'Close', exact: true }).click();
        await expect(dialog).not.toBeVisible();
      }
      if (viewport.width === 390) {
        await page.getByRole('button', { name: 'Request a quote', exact: true }).click();
        await page.evaluate(() => {
          document.documentElement.style.fontSize = '24px';
        });
        await expectContainedQuote(page.getByRole('dialog'));
        await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
        await page.evaluate(() => {
          document.documentElement.style.fontSize = '';
        });
      }
      expect(sends).toBe(0);
    });
});

function colorDetail() {
  const detail = detailFixture();
  detail.name = 'Color-bound source headphones';
  detail.images = Array.from({ length: 6 }, (_, i) => `/api/images/general-${i}`);
  detail.variants.items.forEach((variant, i) => {
    const color = ['Black', 'White', 'Pink'][i];
    if (!color) throw new Error('Color fixture mismatch');
    variant.options = [{ name: 'Color', value: color }];
    variant.images = [`/api/images/sku-${color.toLowerCase()}`];
  });
  return detail;
}
const imageBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1sAAAAASUVORK5CYII=',
  'base64',
);

test('mobile selected photos use explicit SKU bindings; general photos never change the selected color', async ({
  page,
}) => {
  const detail = colorDetail();
  let reads = 0;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/products/canonical-product/detail*', (route) => {
    reads++;
    return route.fulfill({ contentType: 'application/json', body: envelope(detail) });
  });
  await page.route('**/api/images/**', (route) =>
    route.fulfill({ contentType: 'image/png', body: imageBytes }),
  );
  await page.goto('/products/item/?id=canonical-product');
  const hero = page.locator('[data-gallery-frame] img');
  await expect(hero).toHaveAttribute('src', /\/sku-black$/);
  await expect(hero).toHaveAttribute('alt', /Black \(selected configuration\)$/);
  await expect(page.getByRole('radio', { name: /Black/ })).toBeChecked();
  await expect(page.locator('[data-gallery-count]')).toHaveText('1 / 7');
  await expect(page.getByRole('button', { name: /^View product gallery/ })).toHaveCount(0);
  await expect(page.locator('[data-gallery-mode], [data-gallery-view-all]')).toHaveCount(0);
  const thumbnails = page.locator('[data-gallery-thumbnail]');
  await expect(thumbnails).toHaveCount(7);
  for (const thumbnail of await thumbnails.all())
    await expect(thumbnail).toHaveAttribute('aria-label', /^View image /);
  const selectedUrl = page.url();
  await thumbnails.nth(3).click();
  await expect(hero).toHaveAttribute('src', /\/general-2$/);
  await expect(hero).toHaveAttribute('alt', /General product photo$/);
  await expect(page.locator('[data-gallery-count]')).toHaveText('4 / 7');
  await expect(page.getByRole('radio', { name: /Black/ })).toBeChecked();
  await expect(page).toHaveURL(selectedUrl);
  const strip = page.locator('#gallery-thumbnails');
  expect(await strip.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  expect(await strip.evaluate((element) => getComputedStyle(element).overflowX)).toBe('auto');
  await thumbnails.last().click();
  await expect(hero).toHaveAttribute('src', /\/general-5$/);
  await expect(page.locator('[data-gallery-count]')).toHaveText('7 / 7');
  expect(await strip.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  await expect(page.getByRole('radio', { name: /Black/ })).toBeChecked();
  await expect(page).toHaveURL(selectedUrl);
  for (const color of ['Pink', 'White', 'Black', 'Pink']) {
    await page.getByRole('radio', { name: new RegExp(color) }).check();
    await expect(hero).toHaveAttribute('src', new RegExp(`/sku-${color.toLowerCase()}$`));
    await expect(hero).toHaveAttribute('alt', new RegExp(`${color} \\(selected configuration\\)$`));
    await expect(page.locator('[data-gallery-count]')).toHaveText('1 / 7');
    await expect(page.getByRole('radio', { name: new RegExp(color) })).toBeChecked();
  }
  expect(reads).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('unequal image/spec counts, unmapped and broken SKU images never fall back to a different color', async ({
  page,
}) => {
  const detail = colorDetail();
  const [black, , pink] = detail.variants.items;
  if (!black || !pink) throw new Error('Missing color fixtures');
  black.images.push('/api/images/sku-black-side');
  detail.images.push('/api/images/sku-black', '/api/images/general-0');
  pink.images = [];
  await page.route('**/api/products/canonical-product/detail*', (route) =>
    route.fulfill({ contentType: 'application/json', body: envelope(detail) }),
  );
  await page.route('**/api/images/**', (route) =>
    route.request().url().endsWith('/sku-white')
      ? route.fulfill({ status: 404 })
      : route.fulfill({ contentType: 'image/png', body: imageBytes }),
  );
  await page.goto('/products/item/?id=canonical-product');
  await expect(page.locator('[data-gallery-count]')).toHaveText('1 / 8');
  await expect(page.locator('[data-gallery-thumbnail]')).toHaveCount(8);
  await expect
    .poll(() =>
      page
        .locator('[data-gallery-thumbnail] img')
        .evaluateAll((images) =>
          images.map((image) => new URL((image as HTMLImageElement).src).pathname),
        ),
    )
    .toEqual([
      '/api/images/sku-black',
      '/api/images/sku-black-side',
      ...Array.from({ length: 6 }, (_, index) => `/api/images/general-${index}`),
    ]);
  await page.locator('[data-gallery-thumbnail="1"]').click();
  await expect(page.locator('[data-gallery-frame] img')).toHaveAttribute(
    'src',
    /\/sku-black-side$/,
  );
  await expect(page.getByRole('radio', { name: /Black/ })).toBeChecked();
  await page.getByRole('radio', { name: /Pink/ }).check();
  await expect(page.locator('[data-gallery-frame] img')).toHaveAttribute('src', /\/general-0$/);
  await expect(page.locator('[data-gallery-frame] img')).toHaveAttribute(
    'alt',
    /General product photo$/,
  );
  await expect(page.locator('[data-gallery-count]')).toHaveText('1 / 7');
  await expect(
    page.getByText('No photo is assigned to this configuration.', { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole('radio', { name: /Pink/ })).toBeChecked();
  await page.getByRole('radio', { name: /White/ }).check();
  await expect(page.locator('[data-gallery-frame] [data-product-media="fallback"]')).toBeVisible();
  await expect(page.locator('[data-gallery-frame] img')).toHaveCount(0);
  await expect(page.locator('[data-gallery-count]')).toHaveText('1 / 8');
  await expect(page.locator('[data-gallery-thumbnail="0"]')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const whiteUrl = page.url();
  await page.locator('[data-gallery-thumbnail="1"]').click();
  await expect(page.locator('[data-gallery-frame] img')).toHaveAttribute('src', /\/general-0$/);
  await expect(page.locator('[data-gallery-frame] img')).toHaveAttribute(
    'alt',
    /General product photo$/,
  );
  await expect(page.getByRole('radio', { name: /White/ })).toBeChecked();
  await expect(page).toHaveURL(whiteUrl);
  await page.locator('[data-gallery-thumbnail="0"]').click();
  await expect(page.locator('[data-gallery-frame] [data-product-media="fallback"]')).toBeVisible();
  await expect(page.locator('[data-gallery-frame] img')).toHaveCount(0);
  await expect(page.getByRole('radio', { name: /White/ })).toBeChecked();
  await expect(page).toHaveURL(whiteUrl);
});

async function trackCatalogPrefetch(
  page: Page,
  connection: { saveData: boolean; effectiveType: string },
) {
  await page.addInitScript((value) => {
    Object.defineProperty(navigator, 'connection', { value, configurable: true });
    const images: HTMLImageElement[] = [];
    Reflect.set(window, '__catalogPrefetchImages', images);
    window.Image = new Proxy(window.Image, {
      construct(target, args, newTarget) {
        const image: HTMLImageElement = Reflect.construct(target, args, newTarget);
        images.push(image);
        return image;
      },
    });
  }, connection);
  return () =>
    page.evaluate(() => {
      const images: HTMLImageElement[] = Reflect.get(window, '__catalogPrefetchImages');
      return images
        .map((image) => new URL(image.src).pathname)
        .filter((source) => source.includes('/sku-'));
    });
}

test('visible hero loads first; fast selection joins in-flight prefetch and late completion cannot change selection', async ({
  page,
}) => {
  const prefetchSources = await trackCatalogPrefetch(page, {
    saveData: false,
    effectiveType: '4g',
  });
  const requests: string[] = [];
  let releaseBlack: () => void = () => {};
  let releaseWhite: () => void = () => {};
  const blackGate = new Promise<void>((resolve) => {
    releaseBlack = resolve;
  });
  const whiteGate = new Promise<void>((resolve) => {
    releaseWhite = resolve;
  });
  await page.route('**/api/products/canonical-product/detail*', (route) =>
    route.fulfill({ contentType: 'application/json', body: envelope(colorDetail()) }),
  );
  await page.route('**/api/images/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    requests.push(path);
    if (path.endsWith('/sku-black')) await blackGate;
    if (path.endsWith('/sku-white')) await whiteGate;
    await route.fulfill({ contentType: 'image/png', body: imageBytes });
  });
  await page.goto('/products/item/?id=canonical-product', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-gallery-frame] img')).toHaveAttribute('src', /\/sku-black$/);
  await expect(page.locator('[data-gallery-frame] img')).toHaveAttribute('fetchpriority', 'high');
  expect(requests.filter((source) => source.includes('/sku-'))).toEqual(['/api/images/sku-black']);
  releaseBlack();
  await expect.poll(prefetchSources).toContain('/api/images/sku-white');
  await expect.poll(() => requests.includes('/api/images/sku-white')).toBe(true);
  await page.getByRole('radio', { name: /White/ }).check();
  await expect(page.locator('[data-gallery-frame] img')).toHaveAttribute('src', /\/sku-white$/);
  await page.getByRole('radio', { name: /Pink/ }).check();
  releaseWhite();
  await expect(page.locator('[data-gallery-frame] img')).toHaveAttribute('src', /\/sku-pink$/);
  await expect
    .poll(() =>
      page
        .locator('[data-gallery-frame] img')
        .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
    )
    .toBe(true);
  expect(requests.filter((path) => path.endsWith('/sku-white'))).toHaveLength(1);
  await expect(page.getByRole('radio', { name: /Pink/ })).toBeChecked();
  const visibleSources = await page
    .locator('[data-gallery-thumbnail] img')
    .evaluateAll((images) =>
      images.map((image) => new URL((image as HTMLImageElement).src).pathname),
    );
  expect(
    requests
      .filter((source) => source.includes('/general-'))
      .every((source) => visibleSources.includes(source)),
  ).toBe(true);
});

for (const connection of [
  { saveData: true, effectiveType: '4g' },
  { saveData: false, effectiveType: '2g' },
]) {
  test(`data-saving connection (${connection.saveData ? 'Save-Data' : '2g'}) disables speculation, not selected images`, async ({
    page,
  }) => {
    const requests: string[] = [];
    const prefetchSources = await trackCatalogPrefetch(page, connection);
    await page.clock.install();
    await page.route('**/api/products/canonical-product/detail*', (route) =>
      route.fulfill({ contentType: 'application/json', body: envelope(colorDetail()) }),
    );
    await page.route('**/api/images/**', (route) => {
      requests.push(new URL(route.request().url()).pathname);
      return route.fulfill({ contentType: 'image/png', body: imageBytes });
    });
    await page.goto('/products/item/?id=canonical-product');
    const hero = page.locator('[data-gallery-frame] img');
    await expect
      .poll(() => hero.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
      .toBe(true);
    await page.clock.runFor(2000);
    expect(await prefetchSources()).toEqual([]);
    expect([...new Set(requests.filter((source) => source.includes('/sku-')))]).toEqual([
      '/api/images/sku-black',
    ]);
    await page.getByRole('radio', { name: /Pink/ }).check();
    await expect(hero).toHaveAttribute('src', /\/sku-pink$/);
    await expect
      .poll(() => hero.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
      .toBe(true);
    await page.clock.runFor(2000);
    expect(await prefetchSources()).toEqual([]);
    expect([...new Set(requests.filter((source) => source.includes('/sku-')))]).toEqual([
      '/api/images/sku-black',
      '/api/images/sku-pink',
    ]);
    await expect(page.getByRole('radio', { name: /Pink/ })).toBeChecked();
  });
}

for (const width of [320, 390, 1440]) {
  for (const websiteAuthority of [false, true]) {
    test(`primary detail order and ${websiteAuthority ? 'website' : 'product/SKU'} reference prices at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      const detail = colorDetail();
      const variant = detail.variants.items[0];
      if (!variant) throw new Error('Missing priced variant');
      variant.sku = 'INTERNAL-SKU-REFERENCE';
      detail.offers = [
        {
          kind: 'supplier',
          basis: 'source-quote',
          pricing: { mode: 'fixed', currency: 'EUR', amountMinor: 1200 },
        },
      ];
      variant.offers = [
        {
          kind: 'regular',
          basis: 'source-quote',
          pricing: {
            mode: 'range',
            currency: 'CNY',
            minimumAmountMinor: 570,
            maximumAmountMinor: 880,
          },
        },
      ];
      if (websiteAuthority)
        detail.websitePricing = {
          basis: 'website-manual',
          pricing: {
            mode: 'tiered',
            currency: 'USD',
            tiers: [
              { minimumQuantity: 2, maximumQuantity: 999, unitAmountMinor: 570 },
              { minimumQuantity: 1000, unitAmountMinor: 380 },
            ],
          },
        };
      detail.descriptionText = 'Supplier notes remain visible without expansion.';
      detail.descriptionImages = ['/api/images/description-1', '/api/images/description-2'];
      await page.route('**/api/products/canonical-product/detail*', (route) =>
        route.fulfill({ contentType: 'application/json', body: envelope(detail) }),
      );
      await page.route('**/api/images/**', (route) =>
        route.fulfill({ contentType: 'image/png', body: imageBytes }),
      );
      let sends = 0;
      await page.route('**/api/catalog-quote-requests', (route) => {
        sends++;
        return route.abort();
      });
      await page.goto('/products/item/?id=canonical-product');
      const article = page.locator('[data-shared-catalog-detail]');
      const price = article.locator('[data-catalog-compact-price]');
      await expect(price).toBeVisible();
      const primary = article.locator('header').locator('..');
      await expect(
        primary.locator('[data-catalog-key-facts], [data-catalog-quote-conditions], table'),
      ).toHaveCount(0);
      await expect(
        primary.getByRole('heading', { name: 'Selected configuration', exact: true }),
      ).toHaveCount(0);
      const primaryText = await primary.evaluate((element) => {
        const copy = element.cloneNode(true) as HTMLElement;
        for (const dialog of Array.from(copy.querySelectorAll('dialog'))) dialog.remove();
        return copy.textContent;
      });
      expect(primaryText).not.toMatch(/INTERNAL-SKU-REFERENCE|SKU:|Configuration reference/);
      await expect(primary.getByText('Configuration reference', { exact: true })).toHaveCount(0);
      await expect(primary.locator('input[name="quantity"]:not(dialog input)')).toHaveCount(0);
      await expect(
        primary.getByRole('button', { name: 'Request a quote', exact: true }),
      ).toHaveCount(1);
      await expect(primary.getByRole('button', { name: /customization/i })).toHaveCount(0);
      for (const selector of [
        '[data-variant-gallery]',
        '[data-shared-detail-heading]',
        '[data-catalog-compact-price]',
        '[data-catalog-variant-selector]',
        '[data-quote-open]',
      ]) {
        await expect(primary.locator(selector)).toBeVisible();
      }
      const geometry = await primary.evaluate((element) => {
        const selectors = [
          '[data-variant-gallery]',
          '[data-shared-detail-heading]',
          '[data-catalog-compact-price]',
          '[data-catalog-variant-selector]',
          '[data-quote-open]',
        ];
        const nodes = selectors.map((selector) => {
          const node = element.querySelector(selector);
          if (!node) throw new Error(`Missing primary region: ${selector}`);
          return node;
        });
        return {
          viewport: innerWidth,
          ordered: nodes.every((node, index) => {
            const previous = nodes[index - 1];
            return (
              index === 0 ||
              Boolean(
                previous &&
                  previous.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING,
              )
            );
          }),
          boxes: nodes.map((node) => {
            const bounds = node.getBoundingClientRect();
            return {
              top: bounds.top,
              bottom: bounds.bottom,
              left: bounds.left,
              right: bounds.right,
            };
          }),
        };
      });
      expect(geometry.viewport).toBe(width);
      expect(geometry.ordered).toBe(true);
      for (let index = width < 1024 ? 1 : 2; index < geometry.boxes.length; index++) {
        const current = geometry.boxes[index];
        const previous = geometry.boxes[index - 1];
        if (!current || !previous) throw new Error('Missing primary region bounds');
        expect(current.top).toBeGreaterThanOrEqual(previous.bottom - 1);
      }
      const [galleryBounds, headingBounds] = geometry.boxes;
      if (!galleryBounds || !headingBounds) throw new Error('Missing gallery or heading bounds');
      if (width >= 1024) {
        expect(galleryBounds.right).toBeLessThanOrEqual(headingBounds.left);
        const galleryWidth = galleryBounds.right - galleryBounds.left;
        const headingWidth = headingBounds.right - headingBounds.left;
        expect(galleryWidth / (galleryWidth + headingWidth)).toBeCloseTo(0.46, 2);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false,
      );
      if (websiteAuthority) {
        await expect(price).toContainText('Website price / Reference');
        await expect(price).toContainText('USD 3.80 - USD 5.70 per unit');
        await expect(price).not.toContainText(/EUR|CNY/);
        await expect(price.locator('[data-quote-scope]')).toHaveCount(0);
      } else {
        await expect(price.locator('[data-quote-scope="product"]')).toContainText('EUR 12.00');
        await expect(price.locator('[data-quote-scope="product"]')).not.toContainText('CNY');
        await expect(price.locator('[data-quote-scope="variant"]')).toContainText(
          'CNY 5.70 - CNY 8.80 per unit',
        );
        await expect(price.locator('[data-quote-scope="variant"]')).not.toContainText('EUR');
      }
      const reference = await price.textContent();
      if (!reference) throw new Error('Missing compact price text');
      await article.locator('[data-quote-open]').click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.locator('[data-rfq-context]')).toHaveAttribute(
        'data-configuration-id',
        variant.id,
      );
      await dialog.getByRole('textbox', { name: 'Requested quantity', exact: true }).fill('1000');
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(price).toHaveText(reference);
      await article.getByRole('radio', { name: /White/ }).check();
      if (websiteAuthority) await expect(price).toHaveText(reference);
      else {
        await expect(price.locator('[data-quote-scope="variant"]')).toContainText(
          'Request a quote',
        );
        await expect(price.locator('[data-quote-scope="variant"]')).not.toContainText(
          /EUR|CNY|12\.00|0\.00/,
        );
      }
      const notes = article.locator('section[data-catalog-notes]');
      await expect(notes.locator('summary')).toHaveCount(0);
      await notes.scrollIntoViewIfNeeded();
      await expect(notes.getByText(detail.descriptionText, { exact: true })).toBeVisible();
      const description = article.locator('section[data-description-images]');
      await expect(description.locator('summary')).toHaveCount(0);
      await expect(description.locator('img')).toHaveCount(2);
      for (const image of await description.locator('img').all()) {
        await image.scrollIntoViewIfNeeded();
        await expect(image).toBeVisible();
        await expect
          .poll(() =>
            image.evaluate(
              (element: HTMLImageElement) => element.complete && element.naturalWidth > 0,
            ),
          )
          .toBe(true);
      }
      if (process.env.E2E_RECORD_ARTIFACTS === '1') {
        await page.screenshot({
          path: `output/playwright/client-detail-${width}-${websiteAuthority ? 'website' : 'supplier'}.png`,
          fullPage: true,
        });
      }
      expect(sends).toBe(0);
    });
  }
}

test('no-SKU detail directly shows every general photo in a horizontally scrolling gallery', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const detail = detailFixture(0);
  const generalImages = Array.from({ length: 9 }, (_, index) => `/api/images/general-${index}`);
  detail.images = generalImages;
  await page.route('**/api/products/canonical-product/detail*', (route) =>
    route.fulfill({ contentType: 'application/json', body: envelope(detail) }),
  );
  await page.route('**/api/images/**', (route) =>
    route.fulfill({ contentType: 'image/png', body: imageBytes }),
  );
  await page.goto('/products/item/?id=canonical-product');
  const hero = page.locator('[data-gallery-frame] img');
  await expect(hero).toHaveAttribute('src', /\/general-0$/);
  await expect(hero).toHaveAttribute('alt', /General product photo$/);
  await expect(page.getByRole('radio')).toHaveCount(0);
  await expect(page.locator('[data-gallery-count]')).toHaveText('1 / 9');
  await expect(page.locator('[data-gallery-view-all], [data-gallery-mode]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^View product gallery/ })).toHaveCount(0);
  const thumbnails = page.locator('[data-gallery-thumbnail]');
  await expect(thumbnails).toHaveCount(9);
  const strip = page.locator('#gallery-thumbnails');
  expect(await strip.evaluate((element) => getComputedStyle(element).overflowX)).toBe('auto');
  expect(await strip.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  const canonicalUrl = page.url();
  for (const [index, source] of generalImages.entries()) {
    await thumbnails.nth(index).click();
    await expect(hero).toHaveAttribute('src', new RegExp(`${source}$`));
    await expect(hero).toHaveAttribute('alt', /General product photo$/);
    await expect(thumbnails.nth(index)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-gallery-count]')).toHaveText(`${index + 1} / 9`);
    await expect(page).toHaveURL(canonicalUrl);
  }
  expect(await strip.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

test('no-SKU product completes a customization inquiry without inventing a variant', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const detail = detailFixture(0);
  const requestId = '391b7edf-35f3-42c9-af2a-7d2a988107dd';
  const requests: CatalogQuoteSubmission[] = [];
  await page.route('**/api/products/canonical-product/detail*', (route) =>
    route.fulfill({ contentType: 'application/json', body: envelope(detail) }),
  );
  await page.route('**/api/images/**', (route) =>
    route.fulfill({ contentType: 'image/png', body: imageBytes }),
  );
  await page.route('**/api/catalog-quote-requests', (route) => {
    expect(route.request().method()).toBe('POST');
    requests.push(route.request().postDataJSON());
    return route.fulfill({ json: { ok: true, requestId } });
  });
  await page.goto('/products/item/?id=canonical-product');
  await page.getByRole('button', { name: 'Request a quote', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const customization = dialog.getByRole('checkbox', {
    name: 'Ask about customization',
    exact: true,
  });
  await expect(customization).toBeChecked();
  await expect(customization).toBeDisabled();
  await dialog.getByRole('textbox', { name: 'Requested quantity', exact: true }).fill('20');
  await dialog.getByRole('checkbox', { name: 'Packaging', exact: true }).check();
  await dialog
    .locator('textarea')
    .fill('Recyclable packaging for the product without configurations.');
  await dialog.getByRole('button', { name: 'Continue to contact' }).click();
  await dialog.getByRole('textbox', { name: 'Contact name', exact: true }).fill('No SKU Buyer');
  await dialog.getByRole('textbox', { name: 'Email', exact: true }).fill('no-sku@example.test');
  await dialog.getByRole('textbox', { name: 'Company', exact: true }).fill('Local UI Test');
  const country = dialog.getByRole('combobox', { name: 'Company country / region' });
  await focusCountry(country);
  await country.fill('HK');
  await expect(dialog.getByRole('option', { name: /Hong Kong/ })).toBeVisible();
  await country.press('ArrowDown');
  await country.press('Enter');
  await expect(dialog.locator('input[name="country"]')).toHaveValue('HK');
  await dialog.getByRole('button', { name: 'Review request' }).click();
  await expect(dialog.locator('[data-rfq-review]')).toContainText('Packaging');
  expect(requests).toHaveLength(0);
  const submit = dialog.locator('form > div').getByRole('button').last();
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(dialog.locator('[data-rfq-receipt]')).toContainText(requestId);
  await expect(submit).toBeDisabled();
  expect(requests).toHaveLength(1);
  expect(requests[0]?.target).toEqual({
    productId: detail._id,
    revision: detail.revision,
    intent: 'customization',
  });
  expect(requests[0]?.fields).toMatchObject({
    intent: 'customization',
    quantity: '20',
    country: 'HK',
  });
});

test('combined gallery retains all twelve assigned and general photos without truncating or changing SKU', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const detail = colorDetail();
  const first = detail.variants.items[0];
  if (!first) throw new Error('Missing assigned-photo variant');
  first.images = [
    '/api/images/sku-black',
    '/api/images/sku-black-side',
    '/api/images/sku-black-back',
  ];
  detail.images = Array.from({ length: 9 }, (_, index) => `/api/images/general-${index}`);
  const photos = [...first.images, ...detail.images];
  await page.route('**/api/products/canonical-product/detail*', (route) =>
    route.fulfill({ contentType: 'application/json', body: envelope(detail) }),
  );
  await page.route('**/api/images/**', (route) =>
    route.fulfill({ contentType: 'image/png', body: imageBytes }),
  );
  await page.goto('/products/item/?id=canonical-product');
  const thumbnails = page.locator('[data-gallery-thumbnail]');
  await expect(thumbnails).toHaveCount(12);
  await expect(page.locator('[data-gallery-count]')).toHaveText('1 / 12');
  const canonicalUrl = page.url();
  for (const [index, source] of photos.entries()) {
    await thumbnails.nth(index).click();
    await expect(page.locator('[data-gallery-frame] img')).toHaveAttribute(
      'src',
      new RegExp(`${source}$`),
    );
    await expect(page.locator('[data-gallery-frame] img')).toHaveAttribute(
      'alt',
      index < 3 ? /\(selected configuration\)$/ : /General product photo$/,
    );
    await expect(page.locator('[data-gallery-count]')).toHaveText(`${index + 1} / 12`);
    await expect(page.getByRole('radio', { name: /Black/ })).toBeChecked();
    await expect(page).toHaveURL(canonicalUrl);
  }
  expect(
    await page.locator('#gallery-thumbnails').evaluate((element) => element.scrollLeft),
  ).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

const product = {
  _id: 'current',
  name: 'VisionClip AI Camera',
  productFamily: 'ai-gadgets',
  slug: 'visionclip-ai-camera',
  skuCode: 'AI-VC-100',
  description: 'Compact smart camera for OEM programs.',
  moq: 100,
  wholesalePrice: 15.5,
  vipPrice: 13.2,
  images: Array.from({ length: 10 }, (_, index) => `/media/test-${index + 1}.jpg`),
};

const related = {
  _id: 'related',
  name: 'Pocket Translator',
  productFamily: 'ai-gadgets',
  slug: 'pocket-translator',
  images: [],
};

const tieredToy = {
  _id: 'tiered-toy',
  name: 'Interactive Tiered Toy',
  productFamily: 'toys',
  slug: 'interactive-tiered-toy',
  description: 'Interactive toy for quantity-based OEM orders.',
  moq: 1,
  unitPrice: 134.18,
  wholesalePrice: 118.31,
  manualCatalogPricing: {
    schemaVersion: 'manual-catalog-pricing-v1',
    currency: 'USD',
    tiers: [
      { minQuantity: 1, maxQuantity: 12, unitAmountMinor: 13_418 },
      { minQuantity: 13, unitAmountMinor: 11_831 },
    ],
  },
  images: ['/media/section-capabilities.png'],
};

const envelope = (data: unknown) => JSON.stringify({ ok: true, data });

test.beforeEach(async ({ page }) => {
  await mockCatalogTaxonomy(page);
  // These fixtures deliberately predate shared approval. Never let a mocked
  // legacy product depend on a real remote /detail response.
  await page.route('**/api/products/*/detail*', (route) =>
    route.fulfill({ status: 404, body: '' }),
  );
});

test('forbidden approved detail never falls back to legacy product data', async ({ page }) => {
  let legacyReads = 0;
  await page.route('**/api/products/forbidden**', (route) => {
    if (new URL(route.request().url()).pathname.endsWith('/detail'))
      return route.fulfill({ status: 403, body: '' });
    legacyReads++;
    return route.fulfill({ status: 200, contentType: 'application/json', body: envelope(product) });
  });
  await page.goto('/products/item/?id=forbidden');
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.locator('[data-product-detail]')).toHaveCount(0);
  expect(legacyReads).toBe(0);
});

test('ambiguous slug and id never load a different product or remain stuck loading', async ({
  page,
}) => {
  const requests: string[] = [];
  await page.route('**/api/products/**', (route) => {
    requests.push(route.request().url());
    return route.fulfill({ status: 500 });
  });
  await page.goto('/products/item/?slug=visionclip-ai-camera&id=different');
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.locator('[data-product-detail]')).toHaveCount(0);
  expect(requests).toEqual([]);
});

test('direct SKU journey renders nine images, facts, related links, and preserves browser Back', async ({
  page,
}) => {
  await page.route('**/api/products/slug/visionclip-ai-camera', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: envelope(product) }),
  );
  await page.route('**/api/products?*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: envelope({ items: [product, related], total: 2, page: 1, pageSize: 5 }),
    }),
  );

  await page.goto('/ai-gadgets/');
  await page.goto('/products/item/?slug=visionclip-ai-camera');
  await expect(page.getByRole('heading', { level: 1, name: product.name })).toBeVisible();
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex,follow');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    /\/products\/item\/\?slug=visionclip-ai-camera$/,
  );
  await expect(page.getByText('AI-VC-100', { exact: true })).toBeVisible();
  await expect(page.locator('dl > div', { hasText: 'MOQ' })).toContainText('100');
  await expect(page.getByText('$15.50', { exact: true })).toBeVisible();
  await expect(page.getByText('$13.20', { exact: true })).toHaveCount(0);
  await expect(page.locator('[data-gallery-thumbnail]')).toHaveCount(4);
  await expect(page.getByRole('button', { name: 'View All' })).toBeVisible();
  await page.getByRole('button', { name: 'View All' }).click();
  await expect(page.locator('[data-gallery-thumbnail]')).toHaveCount(9);
  await expect(page.locator('img[src*="test-10"]')).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Pocket Translator/ })).toHaveAttribute(
    'href',
    '/products/item/?slug=pocket-translator',
  );
  await expect(page.getByText(/VIP|video/i)).toHaveCount(0);
  const schemas = await page
    .locator('script[type="application/ld+json"]')
    .evaluateAll((scripts) =>
      scripts
        .map((script) => JSON.parse(script.textContent ?? '{}'))
        .flatMap((schema) => schema['@graph'] ?? []),
    );
  const breadcrumbSchema = schemas.find((node) => node['@type'] === 'BreadcrumbList');
  const productSchema = schemas.find((node) => node['@type'] === 'Product');
  const visibleBreadcrumbs = await page
    .getByRole('navigation', { name: 'Breadcrumb' })
    .locator('a, [aria-current="page"]')
    .allTextContents();
  expect(
    breadcrumbSchema.itemListElement.map(
      (item: { name: string; position: number; item: string }) => ({
        name: item.name,
        position: item.position,
        item: new URL(item.item).pathname + new URL(item.item).search,
      }),
    ),
  ).toEqual(
    visibleBreadcrumbs.map((name, index) => ({
      name: name.trim(),
      position: index + 1,
      item:
        index === 0
          ? '/'
          : index === 1
            ? '/electronics-toys/'
            : index === 2
              ? '/ai-gadgets/'
              : '/products/item/?slug=visionclip-ai-camera',
    })),
  );
  expect(productSchema).toMatchObject({
    '@type': 'Product',
    name: product.name,
    sku: product.skuCode,
    offers: { '@type': 'Offer', priceCurrency: 'USD', price: '15.50' },
  });
  for (const forbidden of [
    'aggregateRating',
    'review',
    'inventoryLevel',
    'warranty',
    'availability',
  ]) {
    expect(productSchema).not.toHaveProperty(forbidden);
  }
  expect(page.url()).toContain('?slug=visionclip-ai-camera');
  await page.goBack();
  await expect(page).toHaveURL(/\/ai-gadgets\/$/);
});

test('missing and unknown slugs render not-found without detail', async ({ page }) => {
  await page.route('**/api/products/slug/unknown', (route) => route.fulfill({ status: 404 }));

  await page.goto('/products/item/');
  await expect(page.getByRole('heading', { level: 1, name: 'Product not found.' })).toBeVisible();
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    /\/products\/item\/$/,
  );
  await expect(page.locator('[data-sku-detail]')).toHaveCount(0);

  await page.goto('/products/item/?slug=unknown');
  await expect(page.getByRole('heading', { level: 1, name: 'Product not found.' })).toBeVisible();
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    /\/products\/item\/$/,
  );
  await expect(page.locator('[data-sku-detail]')).toHaveCount(0);
});

test('manual tiers drive card, in-page detail, slug detail, and AggregateOffer without SKU', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const productRequests: string[] = [];
  await page.route('**/api/products/tiered-toy*', (route) => {
    const detail = new URL(route.request().url()).pathname.endsWith('/detail');
    return route.fulfill({
      status: detail ? 404 : 200,
      contentType: 'application/json',
      body: detail ? '' : envelope(tieredToy),
    });
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/products/slug/interactive-tiered-toy', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: envelope(tieredToy) }),
  );
  await page.route('**/api/products?*', (route) => {
    productRequests.push(route.request().url());
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: envelope({ items: [tieredToy], total: 1, page: 1, pageSize: 12 }),
    });
  });

  await page.goto('/toys/');
  await expect.poll(() => productRequests.length + pageErrors.length).toBeGreaterThan(0);
  expect(pageErrors, pageErrors.join('\n')).toEqual([]);
  expect(consoleErrors, consoleErrors.join('\n')).toEqual([]);
  const familyRequest = new URL(productRequests[0] ?? 'http://invalid');
  expect(familyRequest.searchParams.get('productFamily')).toBe('toys');
  expect(familyRequest.searchParams.get('page')).toBe('1');
  expect(familyRequest.searchParams.get('pageSize')).toBe('12');
  await expect(page.locator('[data-product-card-price]')).toHaveText('From $118.31');
  await page.getByRole('button', { name: /Interactive Tiered Toy/ }).click();
  await expect(page.locator('[data-manual-tier-pricing]')).toContainText('1–12');
  await expect(page.locator('[data-manual-tier-pricing]')).toContainText('13+');
  await expect(page.locator('[data-manual-tier-pricing]')).toContainText('$134.18');
  await expect(page.getByText('$118.31', { exact: true })).toBeVisible();
  await expect(page.getByText('$134.18', { exact: true })).toBeVisible();

  await page.goto('/products/item/?slug=interactive-tiered-toy');
  await expect(page.getByRole('heading', { level: 1, name: tieredToy.name })).toBeVisible();
  await expect(page.getByText('SKU', { exact: true })).toHaveCount(0);
  await expect(page.locator('[data-manual-tier-pricing]')).toContainText('1–12');
  const productSchema = await page
    .locator('script[type="application/ld+json"]')
    .evaluateAll((scripts) =>
      scripts
        .map((script) => JSON.parse(script.textContent ?? '{}'))
        .flatMap((schema) => schema['@graph'] ?? [])
        .find((node) => node['@type'] === 'Product'),
    );
  expect(productSchema).not.toHaveProperty('sku');
  expect(productSchema.offers).toMatchObject({
    '@type': 'AggregateOffer',
    priceCurrency: 'USD',
    lowPrice: '118.31',
    highPrice: '134.18',
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
  if (process.env.E2E_RECORD_ARTIFACTS) {
    await page.screenshot({
      path: 'output/playwright/miu28-tiered-product-mobile.png',
      fullPage: true,
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({
      path: 'output/playwright/miu28-tiered-product-desktop.png',
      fullPage: true,
    });
  }
});

test('retry recovers from a detail transport error', async ({ page }) => {
  let attempts = 0;
  await page.route('**/api/products/slug/visionclip-ai-camera', (route) => {
    attempts += 1;
    return attempts === 1
      ? route.fulfill({ status: 500 })
      : route.fulfill({ status: 200, contentType: 'application/json', body: envelope(product) });
  });
  await page.route('**/api/products?*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: envelope({ items: [], total: 0, page: 1, pageSize: 5 }),
    }),
  );

  await page.goto('/products/item/?slug=visionclip-ai-camera');
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    /\/products\/item\/$/,
  );
  await page.getByRole('button', { name: 'Reload details', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: product.name })).toBeVisible();
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    /\/products\/item\/\?slug=visionclip-ai-camera$/,
  );
  expect(attempts).toBe(2);
});

test('related-product failure leaves the loaded detail usable', async ({ page }) => {
  let releaseRelated: (() => void) | undefined;
  const relatedReleased = new Promise<void>((resolve) => {
    releaseRelated = resolve;
  });
  await page.route('**/api/products/slug/visionclip-ai-camera', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: envelope(product) }),
  );
  await page.route('**/api/products?*', async (route) => {
    await relatedReleased;
    await route.fulfill({ status: 500 });
  });

  await page.goto('/products/item/?slug=visionclip-ai-camera');
  await expect(page.getByRole('heading', { level: 1, name: product.name })).toBeVisible();
  await expect(page.locator('[data-sku-detail="current"]')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Build This Product for Your Market' }),
  ).toBeVisible();
  releaseRelated?.();
  await expect(page.getByRole('heading', { name: 'Related Products' })).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
});
