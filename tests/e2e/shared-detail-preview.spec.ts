import { expect, test } from '@playwright/test';
import { detailFixture } from '../../apps/site/src/catalog/testing/detail-fixture.ts';

// Explicit opt-in: this suite tests the development-only CUI-04 entry, not production routes.
test.skip(process.env.E2E_SHARED_DETAIL_PREVIEW !== '1', 'Requires the isolated local preview');
const preview = (id: string, variant?: string) =>
  `/products/item/?preview=shared&id=${encodeURIComponent(id)}${variant ? `&variant=${encodeURIComponent(variant)}` : ''}`;
const samples = [
  ['24ee8f21-1cac-49f0-93a2-30ba1746289f', 3],
  ['c1cdd2d8-4141-4a5a-8c90-7dc11a163df0', 6],
  ['227c01eb-b155-4e4a-b78a-8be6d12e3823', 4],
  ['4595df66-8f29-489a-9b49-3cc71764b41a', 8],
] as const;

test.beforeEach(async ({ baseURL, page }) => {
  expect(baseURL && ['localhost', '127.0.0.1'].includes(new URL(baseURL).hostname)).toBe(true);
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const local = ['localhost', '127.0.0.1'].includes(url.hostname);
    const read = ['GET', 'HEAD', 'OPTIONS'].includes(route.request().method());
    const explicitWrite =
      process.env.E2E_LOCAL_QUOTE_WRITE === '1' &&
      url.port === '3013' &&
      url.pathname === '/api/catalog-quote-requests';
    if (local && (read || explicitWrite)) return route.fallback();
    await route.abort();
    throw new Error('Unexpected non-local/read-only preview request blocked');
  });
});

test('country picker searches codes, clears selection, rejects free text and keeps popup inside mobile dialog', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 650 });
  await page.goto(preview(samples[0][0]));
  await page.getByRole('button', { name: 'Request a quote', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Requested quantity', exact: true }).fill('2');
  await dialog.getByRole('button', { name: 'Continue to contact' }).click();
  await dialog.getByRole('textbox', { name: 'Contact name', exact: true }).fill('Test Buyer');
  await dialog.getByRole('textbox', { name: 'Email', exact: true }).fill('buyer@example.test');
  await dialog.getByRole('textbox', { name: 'Company', exact: true }).fill('Local Test Co');
  const country = dialog.getByRole('combobox', { name: 'Company country / region' });
  await country.click();
  await country.fill('not-a-country');
  await expect(dialog.getByText('No matching country / region.', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Review request' }).click();
  await expect(country).toBeFocused();
  await expect(country).toHaveAttribute('aria-invalid', 'true');
  await country.fill('HK');
  await expect(dialog.getByRole('option', { name: /Hong Kong/ })).toBeVisible();
  await page.screenshot({ path: 'output/playwright/cui06b-country-picker-mobile.png' });
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await dialog.getByRole('button', { name: 'Review request' }).click();
  await expect(dialog.locator('[data-rfq-review]')).toContainText('Hong Kong');
  await dialog.getByRole('button', { name: 'Back', exact: true }).click();
  await dialog.getByRole('button', { name: 'Clear country / region' }).click();
  await expect(country).toHaveValue('');
  await dialog.getByRole('button', { name: 'Review request' }).click();
  await expect(country).toBeFocused();
  expect(await dialog.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(false);
});

test('local inquiry explicitly saves with canonical context and only shows a verified receipt', async ({
  page,
}) => {
  test.skip(process.env.E2E_LOCAL_QUOTE_WRITE !== '1', 'Opt in to one local sample inquiry write');
  await page.goto(preview(samples[0][0]));
  await page.getByRole('button', { name: 'Request a quote', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Requested quantity', exact: true }).fill('500');
  await dialog.getByRole('button', { name: 'Continue to contact' }).click();
  await dialog
    .getByRole('textbox', { name: 'Contact name', exact: true })
    .fill('CUI Local Acceptance');
  await dialog
    .getByRole('textbox', { name: 'Email', exact: true })
    .fill('cui-local-acceptance@example.test');
  await dialog.getByRole('textbox', { name: 'Company', exact: true }).fill('Local Test Only');
  const country = dialog.getByRole('combobox', { name: 'Company country / region' });
  await country.click();
  await country.fill('Hong');
  await dialog.getByRole('option', { name: /Hong Kong/ }).click();
  await dialog.getByRole('button', { name: 'Review request' }).click();
  await expect(dialog.locator('[data-rfq-receipt]')).toHaveCount(0);
  const responsePromise = page.waitForResponse(
    (r) => r.url().endsWith('/api/catalog-quote-requests') && r.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: 'Save inquiry locally' }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  const receipt = await response.json();
  expect(receipt.ok).toBe(true);
  await expect(dialog.locator('[data-rfq-receipt]')).toContainText(receipt.requestId);
  await expect(dialog.getByRole('button', { name: 'Save inquiry locally' })).toBeDisabled();
  const sent = response.request().postDataJSON();
  expect(sent.fields.country).toBe('HK');
  expect(sent.target.productId).toBe(samples[0][0]);
  expect(Object.keys(sent).sort()).toEqual(['fields', 'idempotencyKey', 'target']);
  expect(JSON.stringify(sent)).not.toContain('unitPrice');
  // This explicitly opted-in sample is retained for operator DB/readback evidence.
  await page.screenshot({ path: 'output/playwright/cui07-local-inquiry-receipt.png' });
});

test('local RFQ validates fields, keeps configuration and quantity, and never sends before explicit submit', async ({
  page,
}) => {
  const mutations: string[] = [];
  const errors: string[] = [];
  page.on('request', (request) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) mutations.push(request.url());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(preview(samples[0][0]));
  const quantity = page.getByRole('textbox', { name: 'Requested quantity', exact: true });
  await quantity.fill('500');
  await page.getByRole('radio').nth(1).check();
  const chosen = await page.getByRole('radio').nth(1).getAttribute('value');
  const open = page.getByRole('button', { name: 'Request a quote', exact: true });
  await open.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-rfq-context]')).toHaveAttribute(
    'data-configuration-id',
    chosen ?? 'missing',
  );
  await expect(
    dialog.getByRole('textbox', { name: 'Requested quantity', exact: true }),
  ).toHaveValue('500');
  await dialog.getByRole('textbox', { name: 'Requested quantity', exact: true }).fill('0');
  await dialog.getByRole('button', { name: 'Continue to contact' }).click();
  await expect(
    dialog.getByRole('textbox', { name: 'Requested quantity', exact: true }),
  ).toBeFocused();
  await expect(dialog.getByRole('alert')).toContainText('positive whole number');
  // Below source MOQ is still a valid inquiry, not an order.
  await dialog.getByRole('textbox', { name: 'Requested quantity', exact: true }).fill('1');
  await dialog.getByRole('button', { name: 'Continue to contact' }).click();
  await dialog.getByRole('button', { name: 'Review request' }).click();
  await expect(dialog.getByRole('textbox', { name: 'Contact name', exact: true })).toBeFocused();
  for (const [name, value] of [
    ['Contact name', 'Test Buyer'],
    ['Email', 'buyer@example.test'],
    ['Company', 'Local Test Co'],
  ] as const)
    await dialog.getByRole('textbox', { name, exact: true }).fill(value);
  await dialog.getByRole('combobox', { name: 'Company country / region' }).click();
  await dialog.getByRole('combobox', { name: 'Company country / region' }).fill('Hong');
  await dialog.getByRole('option', { name: /Hong Kong/ }).click();
  await dialog.getByRole('button', { name: 'Review request' }).click();
  await expect(dialog.locator('[data-rfq-review]')).toContainText('buyer@example.test');
  await expect(dialog.locator('[data-rfq-review]')).toContainText('Requested quantity1');
  await expect(dialog.getByRole('button', { name: 'Save inquiry locally' })).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(open).toBeFocused();
  await expect(quantity).toHaveValue('1');
  await page.getByRole('radio').first().check();
  await open.click();
  await expect(dialog.locator('[data-rfq-context]')).toHaveAttribute(
    'data-configuration-id',
    (await page.getByRole('radio', { includeHidden: true }).first().getAttribute('value')) ??
      'missing',
  );
  await expect(dialog.locator('[data-rfq-review]')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Continue to contact' }).click();
  await expect(dialog.getByRole('textbox', { name: 'Email', exact: true })).toHaveValue(
    'buyer@example.test',
  );
  expect(mutations).toEqual([]);
  expect(errors).toEqual([]);
  expect(
    await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })),
  ).not.toContain('buyer@example.test');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.evaluate((url) => {
    history.pushState({}, '', url);
    dispatchEvent(new PopStateEvent('popstate'));
  }, preview(samples[1][0]));
  await page.getByRole('button', { name: 'Request a quote', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Requested quantity', exact: true }).fill('2');
  await dialog.getByRole('button', { name: 'Continue to contact' }).click();
  await expect(dialog.getByRole('textbox', { name: 'Email', exact: true })).toHaveValue('');
});

test('customization requires type and brief, dialog contains focus and remains usable at 320px', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto(preview(samples[0][0]));
  await page.getByRole('button', { name: 'Ask about customization' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Requested quantity', exact: true }).fill('20');
  await dialog.getByRole('button', { name: 'Continue to contact' }).click();
  await expect(dialog.getByRole('alert')).toHaveCount(2);
  await dialog.getByRole('checkbox', { name: 'Logo', exact: true }).check();
  await dialog
    .getByRole('textbox', {
      name: 'Describe the customization (at least 10 characters)',
      exact: true,
    })
    .fill('Print our company logo on both sides.');
  await dialog.getByRole('button', { name: 'Continue to contact' }).click();
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press('Tab');
    // Chromium may temporarily focus browser chrome (document.body in headless).
    // It must never focus an interactive background element; the next Tab returns.
    const focus = await dialog.evaluate((element) => ({
      inside: element.contains(document.activeElement),
      chrome: document.activeElement === document.body,
    }));
    expect(focus.inside || focus.chrome).toBe(true);
    if (focus.chrome) {
      await page.keyboard.press('Tab');
      expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(
        true,
      );
    }
  }
  await page.locator('[data-quote-open]').evaluate((element: HTMLButtonElement) => element.focus());
  await expect(page.locator('[data-quote-open]')).not.toBeFocused();
  await page.setViewportSize({ width: 320, height: 360 });
  const review = dialog.getByRole('button', { name: 'Review request' });
  await review.scrollIntoViewIfNeeded();
  await expect(review).toBeInViewport();
  expect(await dialog.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(false);
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Ask about customization' })).toBeFocused();
});

test('a delivery date that expires while the form is open invalidates review', async ({ page }) => {
  await page.clock.setFixedTime(new Date(2026, 8, 6, 12));
  await page.goto(preview(samples[0][0]));
  await page.getByRole('button', { name: 'Request a quote', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Requested quantity', exact: true }).fill('2');
  await dialog.getByLabel('Requested delivery date (optional)', { exact: true }).fill('2026-09-07');
  await dialog.getByRole('button', { name: 'Continue to contact' }).click();
  for (const [name, value] of [
    ['Contact name', 'Test Buyer'],
    ['Email', 'buyer@example.test'],
    ['Company', 'Local Test Co'],
  ] as const)
    await dialog.getByRole('textbox', { name, exact: true }).fill(value);
  await dialog.getByRole('combobox', { name: 'Company country / region' }).click();
  await dialog.getByRole('combobox', { name: 'Company country / region' }).fill('Hong');
  await dialog.getByRole('option', { name: /Hong Kong/ }).click();
  await page.clock.setFixedTime(new Date(2026, 8, 8, 12));
  await dialog.getByRole('button', { name: 'Review request' }).click();
  await expect(dialog.locator('[data-rfq-review]')).toHaveCount(0);
  await expect(dialog.getByRole('alert')).toContainText('today or later');
  await expect(
    dialog.getByLabel('Requested delivery date (optional)', { exact: true }),
  ).toBeFocused();
});

test('revised real description uses grouped rows and keeps supplier copy secondary', async ({
  page,
}) => {
  await page.goto(preview(samples[0][0]));
  await expect(page.locator('[data-catalog-key-facts]')).toContainText('ABS');
  await expect(page.locator('[data-catalog-packaging]')).toContainText('Aux cable');
  const notes = page.locator('[data-catalog-notes]');
  await expect(notes).not.toHaveAttribute('open', '');
  await notes.locator('summary').click();
  await expect(notes).toContainText('60,000');
  await expect(notes.locator('h3')).toHaveText([
    'Experienced Headphones Manufacturer',
    'Product Description',
  ]);
  expect(
    await notes.locator('div').evaluate((el) => el.getBoundingClientRect().width),
  ).toBeLessThanOrEqual(850);
});

test('source tiers follow exact quantity boundaries, retain SKU quantity and reset on product navigation', async ({
  page,
}) => {
  await page.goto(preview(samples[0][0]));
  const quantity = page.getByRole('textbox', { name: 'Requested quantity', exact: true });
  const result = page.locator('[data-quote-result]');
  await expect(quantity).toHaveValue('');
  for (const [value, price] of [
    ['2', '5.70'],
    ['499', '5.70'],
    ['500', '5.00'],
    ['999', '5.00'],
    ['1000', '3.80'],
  ] as const) {
    await quantity.fill(value);
    await expect(result).toHaveText(`USD ${price} per unit`);
    await expect(page.locator('[data-active-tier="true"]')).toHaveCount(1);
  }
  await page.getByRole('radio').nth(1).check();
  await expect(quantity).toHaveValue('1000');
  await expect(result).toHaveText('USD 3.80 per unit');
  await quantity.fill('1');
  await expect(result).toContainText('Minimum order quantity: 2');
  await expect(page.locator('[data-active-tier="true"]')).toHaveCount(0);
  for (const value of ['', '0', '1e3', '1.5', '9007199254740992']) {
    await quantity.fill(value);
    await expect(page.locator('[data-active-tier="true"]')).toHaveCount(0);
    await expect(result).not.toContainText('USD');
    await expect(quantity).toHaveAttribute('aria-invalid', value ? 'true' : 'false');
  }
  await quantity.fill('500');
  await page.evaluate((url) => {
    history.pushState({}, '', url);
    dispatchEvent(new PopStateEvent('popstate'));
  }, preview(samples[1][0]));
  await expect(page.locator(`[data-shared-catalog-detail="${samples[1][0]}"]`)).toBeVisible();
  await expect(quantity).toHaveValue('');
  await quantity.fill('500');
  await expect(result).not.toContainText('USD');
  await expect(page.getByRole('button', { name: 'Request a quote' })).toBeEnabled();
});

test('gallery geometry stays bounded across mobile tablet and desktop without a fixed disabled CTA', async ({
  page,
}) => {
  await page.goto(preview(samples[0][0]));
  await expect(page.locator('[data-catalog-key-facts]')).toBeVisible();
  for (const width of [390, 640, 700, 768, 900, 1023, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const frame = await page.locator('[data-gallery-frame]').boundingBox();
    expect(frame).not.toBeNull();
    if (!frame) throw new Error('Gallery frame missing');
    expect(frame.height).toBeLessThanOrEqual(width < 640 ? 340 : width < 1024 ? 360 : 420);
    if (width < 1024) expect(frame.width).toBeLessThanOrEqual(560);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    const button = page.getByRole('button', { name: 'Request a quote' });
    expect(
      await button.evaluate((el) =>
        el.parentElement ? getComputedStyle(el.parentElement).position : 'missing',
      ),
    ).not.toBe('fixed');
    await page.getByRole('button', { name: 'View image 6', exact: true }).click();
    await expect(page.locator('[data-gallery-count]')).toHaveText('6 / 6');
  }
});
for (const [id, variants] of samples)
  test(`real local HTTP sample ${id} renders and selects canonical rows`, async ({ page }) => {
    const errors: string[] = [];
    const apiRequests: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      if (request.url().includes('/api/products')) apiRequests.push(request.url());
    });
    await page.goto(preview(id));
    const article = page.locator(`[data-shared-catalog-detail="${id}"]`);
    await expect(article).toBeVisible();
    await expect(article.getByRole('radio')).toHaveCount(variants);
    const last = article.getByRole('radio').last();
    await last.check();
    await expect(last).toBeChecked();
    await article.getByText('Configuration reference', { exact: true }).click();
    await expect(
      article.getByText((await last.getAttribute('value')) ?? '', { exact: true }),
    ).toBeVisible();
    await expect(article.getByRole('button', { name: 'Request a quote' })).toBeEnabled();
    await article.getByRole('button', { name: 'Request a quote' }).click();
    await expect(page.getByRole('dialog').locator('[data-rfq-context]')).toHaveAttribute(
      'data-configuration-id',
      (await last.getAttribute('value')) ?? 'missing',
    );
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
    const image = article.locator('[data-gallery-frame] img');
    await expect(image).toBeVisible();
    await expect
      .poll(() =>
        image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0),
      )
      .toBe(true);
    expect(apiRequests.length).toBeGreaterThan(0);
    expect(apiRequests.every((url) => url.includes(`/api/products/${id}/detail?`))).toBe(true);
    expect(errors).toEqual([]);
  });

test('720px reflow with failed images keeps the long-title product and configuration usable', async ({
  page,
}) => {
  // CSS viewport equivalent to a 1440px window at 200%; not a claim that native browser zoom was driven.
  await page.setViewportSize({ width: 720, height: 450 });
  await page.route('**/api/images/*', (route) => route.abort());
  await page.goto(preview(samples[0][0]));
  await expect(page.locator('[data-shared-catalog-detail] h1')).toContainText('Wireless');
  await expect(page.locator('[data-gallery-frame]')).toContainText('unavailable');
  await page.getByRole('radio').nth(1).check();
  await expect(page.getByRole('radio').nth(1)).toBeChecked();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

test('mobile has visible SKU choices, independent image navigation, and no horizontal overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(preview(samples[0][0]));
  const radios = page.getByRole('radio');
  await expect(radios).toHaveCount(3);
  await radios.nth(1).check();
  await expect(radios.nth(1)).toBeChecked();
  await radios.nth(1).focus();
  await page.keyboard.press('ArrowRight');
  await expect(radios.nth(2)).toBeChecked();
  await radios.nth(1).check();
  const image = page.locator('[data-gallery-frame] img');
  await expect(image).toBeVisible();
  const oldSource = await image.getAttribute('src');
  await page.getByRole('button', { name: 'View image 2', exact: true }).click();
  await expect(image).not.toHaveAttribute('src', oldSource ?? '');
  await expect(radios.nth(1)).toBeChecked();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

test('navigation to B aborts delayed A and cannot resurrect its selection', async ({ page }) => {
  let release = () => {};
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let signalStarted = () => {};
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  await page.route('**/api/products/canonical-product/detail?*', async (route) => {
    signalStarted();
    await waiting;
    await route.fulfill({ json: { ok: true, data: detailFixture() } });
  });
  await page.goto(preview('canonical-product', 'variant-2'));
  await started;
  await page.evaluate((url) => {
    history.pushState({}, '', url);
    dispatchEvent(new PopStateEvent('popstate'));
  }, preview(samples[1][0]));
  await expect(page.locator(`[data-shared-catalog-detail="${samples[1][0]}"]`)).toBeVisible();
  release();
  await page.unrouteAll({ behavior: 'wait' });
  await expect(page.locator('[data-shared-catalog-detail="canonical-product"]')).toHaveCount(0);
  await expect(page.getByRole('radio')).toHaveCount(6);
});

test('51st URL variant waits for revision-pinned page 2; 409 discards the entire snapshot', async ({
  page,
}) => {
  let conflict = false;
  let pinned = false;
  await page.route('**/api/products/canonical-product/detail?*', async (route) => {
    const url = new URL(route.request().url());
    const number = Number(url.searchParams.get('page'));
    if (number === 2) {
      pinned = url.searchParams.get('revision') === 'approved-r1';
      if (conflict) return route.fulfill({ status: 409, json: { ok: false } });
    }
    return route.fulfill({ json: { ok: true, data: detailFixture(51, number) } });
  });
  await page.goto(preview('canonical-product', 'variant-51'));
  await expect(page.getByRole('combobox')).toHaveValue('variant-51');
  expect(pinned).toBe(true);
  conflict = true;
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('changed');
  await expect(page.locator('[data-shared-catalog-detail]')).toHaveCount(0);
  conflict = false;
  await page.getByRole('button', { name: 'Reload details' }).click();
  await expect(page.getByRole('combobox')).toHaveValue('variant-51');
});

test('404 and malformed JSON never fall back to legacy or leave fake product fields', async ({
  page,
}) => {
  await page.route('**/api/products/canonical-product/detail?*', (route) =>
    route.fulfill({ status: 404, json: { ok: false } }),
  );
  await page.goto(preview('canonical-product'));
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.locator('[data-shared-catalog-detail], [data-sku-detail]')).toHaveCount(0);
  await page.unrouteAll({ behavior: 'wait' });
  await page.route('**/api/products/canonical-product/detail?*', (route) =>
    route.fulfill({ contentType: 'application/json', body: '{ broken' }),
  );
  await page.getByRole('button', { name: 'Reload details' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.locator('[data-shared-catalog-detail], [data-sku-detail]')).toHaveCount(0);
});

test('501 variants stay paged; failed later page retries without selecting an unseen SKU', async ({
  page,
}) => {
  const seen: number[] = [];
  let failSecond = true;
  await page.route('**/api/products/canonical-product/detail?*', async (route) => {
    const url = new URL(route.request().url());
    const number = Number(url.searchParams.get('page'));
    seen.push(number);
    if (number > 1) expect(url.searchParams.get('revision')).toBe('approved-r1');
    if (number === 2 && failSecond) return route.fulfill({ status: 503, json: { ok: false } });
    return route.fulfill({ json: { ok: true, data: detailFixture(501, number) } });
  });
  await page.goto(preview('canonical-product', 'variant-501'));
  const article = page.locator('[data-shared-catalog-detail]');
  const next = article.getByRole('button', { name: 'Next page', exact: true });
  const quote = article.getByRole('button', { name: 'Request a quote', exact: true });
  await expect(article.getByRole('combobox')).toHaveValue('');
  await expect(quote).toBeDisabled();
  expect(seen).toEqual([1]);
  await next.click();
  await expect(article.getByRole('alert')).toBeVisible();
  await expect(quote).toBeDisabled();
  failSecond = false;
  await article.getByRole('button', { name: 'Reload details' }).click();
  await expect(article.getByRole('combobox')).toContainText('variant-51');
  for (let number = 3; number <= 11; number++) {
    await next.click();
    if (number < 11) {
      await expect(
        article.getByRole('combobox').locator(`option[value="variant-${(number - 1) * 50 + 1}"]`),
      ).toHaveCount(1);
    }
  }
  await expect(article.getByRole('radio')).toHaveCount(1);
  await expect(article.getByRole('radio')).toBeChecked();
  await expect(next).toBeDisabled();
  await quote.click();
  await expect(page.getByRole('dialog').locator('[data-rfq-context]')).toHaveAttribute(
    'data-configuration-id',
    'variant-501',
  );
  expect(seen).toEqual([1, 2, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
});

test('empty approved fields show honest placeholders and source HTML remains text', async ({
  page,
}) => {
  const detail = detailFixture(0);
  detail.images = [];
  detail.facts = [];
  detail.descriptionText = '<img src=x onerror=alert(1)>Source text';
  await page.route('**/api/products/canonical-product/detail?*', (route) =>
    route.fulfill({ json: { ok: true, data: detail } }),
  );
  await page.goto(preview('canonical-product'));
  await expect(
    page
      .locator('[data-shared-catalog-detail]')
      .getByText('No variant configuration', { exact: false }),
  ).toBeVisible();
  await expect(page.locator('[data-gallery-frame]')).toContainText('unavailable');
  await page.getByText('Product description', { exact: true }).click();
  await expect(page.getByText(detail.descriptionText, { exact: true })).toBeVisible();
  await expect(page.locator('[data-shared-catalog-detail] img')).toHaveCount(0);
});
