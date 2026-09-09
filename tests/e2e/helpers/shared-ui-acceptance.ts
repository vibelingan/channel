import { fork } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { type BrowserContext, type Page, test as base, expect } from '@playwright/test';
import {
  acceptanceReadback,
  acceptanceReady,
} from '../../../apps/local-server/src/shared-ui-acceptance-contract.ts';
import type { startSharedUiAcceptance } from '../../../apps/local-server/src/shared-ui-acceptance.ts';

type Backend = Awaited<ReturnType<typeof startSharedUiAcceptance>>;
export const test = base.extend<{
  backend: Backend;
  routeIsolated: (context: BrowserContext) => Promise<void>;
}>({
  backend: async ({ baseURL }, use) => {
    expect(baseURL).toBe('http://127.0.0.1:4328');
    if (process.env.E2E_SHARED_UI_ACCEPTANCE !== '1')
      throw new Error('Isolated acceptance opt-in missing');
    // Use the same tsx loader as the local service, not Playwright's browser-test
    // transformer. This also isolates the process-global DB/media adapter wiring.
    const local = resolve('apps/local-server');
    const child = fork(resolve(local, 'src/shared-ui-acceptance-cli.ts'), [], {
      execArgv: ['--import', createRequire(resolve(local, 'package.json')).resolve('tsx')],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const exited = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`Isolated service exited: ${code}`)),
      );
    });
    // Observe early failures immediately; await the same promise at teardown.
    void exited.catch(() => {});
    const ready = new Promise<Pick<Backend, 'apiUrl' | 'credentials' | 'file'>>(
      (resolve, reject) => {
        child.once('message', (message) => {
          const parsed = acceptanceReady.safeParse(message);
          if (parsed.success) resolve(parsed.data);
          else reject(new Error('Invalid isolated-service readiness message'));
        });
      },
    );
    try {
      const details = await Promise.race([
        ready,
        exited.then(() => {
          throw new Error('Service stopped before readiness');
        }),
      ]);
      const backend: Backend = {
        ...details,
        readDisk: async () =>
          acceptanceReadback.parse(JSON.parse(await readFile(details.file, 'utf8'))),
        dispose: async () => {},
      };
      await use(backend);
    } finally {
      if (child.connected) child.send('dispose');
      await exited;
    }
  },
  routeIsolated: async ({ backend }, use) => {
    await use(async (context) => {
      await context.route('**/*', async (route) => {
        const request = route.request();
        const origin = new URL(request.url()).origin;
        // Existing site-shell fonts are static GETs, not provider/business API calls.
        if (
          request.method() === 'GET' &&
          ((origin === 'https://fonts.googleapis.com' && request.resourceType() === 'stylesheet') ||
            (origin === 'https://fonts.gstatic.com' && request.resourceType() === 'font'))
        )
          return route.fallback();
        if (
          ['http://127.0.0.1:4328', 'http://127.0.0.1:3013'].includes(
            new URL(route.request().url()).origin,
          )
        )
          return route.fallback();
        await route.abort();
        throw new Error(
          `Non-local ${route.request().resourceType()} request blocked: ${new URL(route.request().url()).origin}`,
        );
      });
      await context.route('**/api/**', async (route) => {
        const requested = new URL(route.request().url());
        if (!['http://127.0.0.1:3013', 'http://127.0.0.1:4328'].includes(requested.origin)) {
          await route.abort();
          throw new Error('Unexpected API destination; request blocked');
        }
        const permitted =
          requested.pathname === '/api/admin' ||
          requested.pathname === '/api/catalog-quote-requests' ||
          requested.pathname === '/api/products' ||
          /^\/api\/products\/[^/]+\/detail$/.test(requested.pathname) ||
          /^\/api\/images\/[^/]+$/.test(requested.pathname);
        if (!permitted) {
          await route.abort();
          throw new Error('Unexpected API path; request blocked');
        }
        // Only the endpoint changes. Body, method and original Origin stay intact.
        const response = await route.fetch({
          url: `${backend.apiUrl}${requested.pathname}${requested.search}`,
          maxRedirects: 0,
        });
        await route.fulfill({ response });
      });
    });
  },
  context: async ({ context, routeIsolated }, use) => {
    await routeIsolated(context);
    await use(context);
  },
});
export { expect };
export const productId = '24ee8f21-1cac-49f0-93a2-30ba1746289f';
export const variantId = '3cb695af-2fc5-4796-b345-3ba2c6a82fe1';
export async function loginAdmin(page: Page, credentials: Backend['credentials']) {
  await page.goto('/admin');
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(credentials.email);
  await page.getByLabel('Password', { exact: true }).fill(credentials.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Product Inquiries', exact: true })).toBeVisible();
}

export async function reviewInquiry(page: Page) {
  await page.goto('/headphones/?preview=shared');
  await page.locator(`[data-product-card="${productId}"]`).click();
  await page.getByRole('radio', { name: `Black · ${variantId}`, exact: true }).check();
  await page.getByRole('textbox', { name: 'Requested quantity', exact: true }).fill('500');
  await page.getByRole('button', { name: 'Request a quote', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('[data-rfq-context]')).toContainText(variantId);
  await dialog.getByRole('button', { name: 'Continue to contact' }).click();
  for (const [name, value] of [
    ['Contact name', 'CUI-08 Synthetic Buyer'],
    ['Email', 'cui08@example.test'],
    ['Company', 'CUI-08 Test Company'],
  ] satisfies [string, string][])
    await dialog.getByRole('textbox', { name, exact: true }).fill(value);
  const country = dialog.getByRole('combobox', { name: 'Company country / region' });
  await country.click();
  await country.fill('Hong');
  await expect(dialog.getByRole('option', { name: /Hong Kong/ })).toBeVisible();
  await dialog.getByRole('option', { name: /Hong Kong/ }).click();
  await expect(country).toHaveValue(/Hong Kong/);
  await dialog.getByRole('button', { name: 'Review request' }).click();
  await expect(dialog.locator('[data-rfq-review]')).toContainText('500');
  return dialog;
}

export async function saveInquiry(page: Page) {
  const dialog = await reviewInquiry(page);
  await dialog.getByRole('button', { name: 'Save inquiry locally' }).click();
  const receipt = dialog.locator('[data-rfq-receipt]');
  await expect(receipt).toBeVisible();
  const id = (await receipt.innerText()).match(/[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}/i)?.[0];
  if (!id) throw new Error('No verified receipt ID');
  return id;
}

export async function nextStatus(page: Page, label: string) {
  await page.getByRole('combobox', { name: 'Next status', exact: true }).click();
  await page.getByRole('option', { name: label, exact: true }).click();
}
