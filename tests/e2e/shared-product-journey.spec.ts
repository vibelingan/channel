import { test as componentTest } from '@playwright/test';
import ts from 'typescript';
import type { InquiryDetail } from '../../packages/shared/src/catalog/inquiry.ts';
import {
  expect,
  loginAdmin,
  nextStatus,
  productId,
  reviewInquiry,
  saveInquiry,
  test,
  variantId,
} from './helpers/shared-ui-acceptance.ts';

// @skip-when Local acceptance opt-in is off; these checks require the dedicated shared-product-ui config.
test.skip(process.env.E2E_SHARED_UI_ACCEPTANCE !== '1', 'Run the isolated CUI-08 configuration');

componentTest(
  'inquiry editor mounted form uses native POST without backend access',
  async ({ page }) => {
    const apiRequests: string[] = [];
    await page.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname.startsWith('/api/')) apiRequests.push(request.url());
      if (
        url.origin === 'http://127.0.0.1:4328' &&
        request.method() === 'GET' &&
        !url.pathname.startsWith('/api/')
      )
        return route.fallback();
      await route.abort();
    });
    const item: InquiryDetail = {
      id: '12345678-1234-4123-8123-123456789abc',
      target: { intent: 'variant_quote', productId: 'p1', revision: 'r1', variantId: 'v1' },
      fields: {
        intent: 'variant_quote',
        quantity: '500',
        deliveryDate: '',
        customizationTypes: [],
        brief: '',
        contactName: 'Synthetic Buyer',
        company: 'Test Company',
        email: 'buyer@example.test',
        country: 'HK',
      },
      snapshot: {
        productId: 'p1',
        revision: 'r1',
        productName: 'Synthetic headset',
        images: [],
        productOffers: [],
        variant: {
          id: 'v1',
          options: [],
          images: [],
          inventory: { state: 'unknown' },
          offers: [],
        },
      },
      status: 'new',
      version: 0,
      notification: 'disabled-local',
      createdAt: '2026-09-15T00:00:00.000Z',
      updatedAt: '2026-09-15T00:00:00.000Z',
      events: [],
    };
    await page.goto('/login');
    const componentResponse = await page.request.get(
      '/src/islands/admin/inquiries/InquiryDetailPanel.tsx',
    );
    expect(componentResponse.ok()).toBe(true);
    const componentSource = ts.createSourceFile(
      'InquiryDetailPanel.js',
      await componentResponse.text(),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const queryUrl = componentSource.statements
      .filter(ts.isImportDeclaration)
      .map((declaration) => declaration.moduleSpecifier)
      .filter(ts.isStringLiteral)
      .map((specifier) => specifier.text)
      .find((url) => url.includes('/@tanstack_react-query.js'));
    if (!queryUrl) throw new Error('Expected the component runtime React Query import');
    await page.evaluate(
      async ({ inquiry, queryUrl }) => {
        const modules = [
          '/@id/react',
          '/@id/react-dom/client',
          queryUrl,
          '/src/islands/admin/inquiries/InquiryDetailPanel.tsx',
        ];
        const [reactModule, rendererModule, query, panel] = await Promise.all(
          modules.map((module) => import(module)),
        );
        const react = reactModule.default;
        const renderer = rendererModule.default;
        const client = new query.QueryClient({
          defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY, retry: false } },
        });
        client.setQueryData(['product-inquiries', 'detail', inquiry.id], {
          kind: 'detail',
          item: inquiry,
          currentProduct: { state: 'same' },
        });
        const container = document.createElement('div');
        document.body.append(container);
        renderer
          .createRoot(container)
          .render(
            react.createElement(
              query.QueryClientProvider,
              { client },
              react.createElement(panel.InquiryDetailPanel, { id: inquiry.id, onBack: () => {} }),
            ),
          );
      },
      { inquiry: item, queryUrl },
    );
    const form = page.getByRole('region', { name: 'Process inquiry' }).locator('form');
    await expect(form).toBeVisible();
    await expect(form).toHaveAttribute('method', 'post');
    expect(await form.evaluate((element) => (element as HTMLFormElement).method)).toBe('post');
    expect(apiRequests).toEqual([]);
  },
);

test('buyer submission -> admin attention, note, processing and completion are persisted; print excludes internal history', async ({
  page,
  backend,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const id = await saveInquiry(page);
  const saved = await backend.readDisk();
  expect(saved.catalogQuoteRequests).toHaveLength(1);
  expect(saved.catalogQuoteRequests[0]).toMatchObject({
    _id: id,
    status: 'new',
    version: 0,
    notification: 'disabled-local',
    target: { productId, variantId },
    fields: { quantity: '500', country: 'HK' },
    snapshot: { productId, variant: { id: variantId } },
    events: [],
  });
  await loginAdmin(page, backend.credentials);
  await expect(
    page.getByText('1 unprocessed · 1 matching inquiries', { exact: false }),
  ).toBeVisible();
  await page.locator(`[id="inquiry-${id}"]`).click();
  const process = page.getByRole('region', { name: 'Process inquiry' });
  await expect(process).toContainText('Unprocessed');
  await expect(process.locator('form')).toHaveAttribute('method', 'post');
  await expect(page.getByText('cui08@example.test', { exact: false }).first()).toBeVisible();
  await process
    .getByRole('textbox', { name: 'Internal note', exact: true })
    .fill('INTERNAL-CUI08 Awaiting sales review');
  await page.getByRole('button', { name: 'Save follow-up' }).click();
  await expect(process).toHaveAttribute('data-inquiry-version', '1');
  await expect(process).toContainText('Unprocessed');
  expect((await backend.readDisk()).catalogQuoteRequests[0]).toMatchObject({
    status: 'new',
    version: 1,
  });
  await page.getByRole('button', { name: 'Back to inquiries', exact: false }).click();
  await expect(
    page.getByText('1 unprocessed · 1 matching inquiries', { exact: false }),
  ).toBeVisible();
  await page.locator(`[id="inquiry-${id}"]`).click();
  await nextStatus(page, 'In progress');
  await page.getByRole('button', { name: 'Save follow-up' }).click();
  await expect(process).toHaveAttribute('data-inquiry-version', '2');
  await nextStatus(page, 'Completed');
  await expect(page.getByRole('button', { name: 'Save follow-up' })).toBeDisabled();
  await process
    .getByRole('textbox', { name: 'Reason / internal note (required)', exact: true })
    .fill('INTERNAL-CUI08 Follow-up concluded with buyer');
  await page.getByRole('button', { name: 'Save follow-up' }).click();
  await expect(process).toHaveAttribute('data-inquiry-version', '3');
  await expect(process).toContainText('Completed');
  await page.screenshot({
    path: `output/playwright/cui08-${testInfo.project.name}-admin-completed.png`,
    fullPage: true,
  });
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('#inquiry-print')).toBeVisible();
  await expect(page.locator('#inquiry-print')).toContainText('cui08@example.test');
  await expect(page.locator('#inquiry-print')).not.toContainText('INTERNAL-CUI08');
  if (testInfo.project.name === 'chromium')
    await page.pdf({ path: 'output/playwright/cui08-inquiry-summary.pdf', format: 'A4' });
  await page.emulateMedia({ media: 'screen' });
  await page.reload();
  await expect(page.locator(`[id="inquiry-${id}"]`)).toContainText('Completed');
  await expect(
    page.getByText('0 unprocessed · 1 matching inquiries', { exact: false }),
  ).toBeVisible();
  const disk = await backend.readDisk();
  expect(disk.catalogQuoteRequests).toHaveLength(1);
  expect(disk.catalogQuoteRequests[0]).toMatchObject({
    status: 'completed',
    version: 3,
    notification: 'disabled-local',
  });
  expect(disk.catalogQuoteRequests[0]?.events).toHaveLength(3);
  expect(errors).toEqual([]);
});

test('lost buyer receipt retries the same request and produces exactly one stored inquiry', async ({
  page,
  backend,
}) => {
  const requests: string[] = [];
  let lose = true;
  await page.route('**/api/catalog-quote-requests', async (route) => {
    requests.push(route.request().postDataJSON().idempotencyKey);
    const response = await route.fetch({
      url: `${backend.apiUrl}/api/catalog-quote-requests`,
      maxRedirects: 0,
    });
    expect(response.status()).toBe(200);
    if (lose) {
      lose = false;
      await route.abort('failed');
    } else await route.fulfill({ response });
  });
  const dialog = await reviewInquiry(page);
  await dialog.getByRole('button', { name: 'Save inquiry locally' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Save could not be confirmed');
  await expect(dialog.locator('[data-rfq-receipt]')).toHaveCount(0);
  expect((await backend.readDisk()).catalogQuoteRequests).toHaveLength(1);
  await dialog.getByRole('button', { name: 'Save inquiry locally' }).click();
  await expect(dialog.locator('[data-rfq-receipt]')).toBeVisible();
  expect(requests).toHaveLength(2);
  expect(requests[0]).toBe(requests[1]);
  expect((await backend.readDisk()).catalogQuoteRequests).toHaveLength(1);
});

test('two admin sessions cannot silently overwrite each other; stale editor reloads before continuing', async ({
  page,
  browser,
  backend,
  routeIsolated,
}) => {
  const id = await saveInquiry(page);
  await loginAdmin(page, backend.credentials);
  await page.locator(`[id="inquiry-${id}"]`).click();
  const second = await browser.newContext({ baseURL: 'http://127.0.0.1:4328' });
  await routeIsolated(second);
  try {
    const other = await second.newPage();
    await loginAdmin(other, backend.credentials);
    await other.locator(`[id="inquiry-${id}"]`).click();
    await expect(other.getByRole('region', { name: 'Process inquiry' })).toHaveAttribute(
      'data-inquiry-version',
      '0',
    );
    await other
      .getByRole('textbox', { name: 'Internal note', exact: true })
      .fill('CUI08 stale edit must not commit');
    await nextStatus(page, 'In progress');
    await page.getByRole('button', { name: 'Save follow-up' }).click();
    await expect(page.getByRole('region', { name: 'Process inquiry' })).toHaveAttribute(
      'data-inquiry-version',
      '1',
    );
    await other.getByRole('button', { name: 'Save follow-up' }).click();
    await expect(other.getByRole('alert')).toContainText('Another update was saved');
    await expect(other.getByRole('button', { name: 'Save follow-up' })).toBeDisabled();
    expect((await backend.readDisk()).catalogQuoteRequests[0]?.events).toHaveLength(1);
    await other.getByRole('button', { name: 'Reload latest (discard unsaved edit)' }).click();
    await expect(other.getByRole('region', { name: 'Process inquiry' })).toHaveAttribute(
      'data-inquiry-version',
      '1',
    );
    await expect(other.getByRole('textbox', { name: 'Internal note', exact: true })).toHaveValue(
      '',
    );
    await other
      .getByRole('textbox', { name: 'Internal note', exact: true })
      .fill('CUI08 reviewed latest status');
    await other.getByRole('button', { name: 'Save follow-up' }).click();
    await expect(other.getByRole('region', { name: 'Process inquiry' })).toHaveAttribute(
      'data-inquiry-version',
      '2',
    );
    const disk = await backend.readDisk();
    expect(disk.catalogQuoteRequests[0]?.events).toHaveLength(2);
    expect(JSON.stringify(disk.catalogQuoteRequests[0]?.events)).not.toContain(
      'stale edit must not commit',
    );
  } finally {
    await second.close();
  }
});
