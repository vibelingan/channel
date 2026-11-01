/** Local cross-repository acceptance: actual component and BFF, no model or mail. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { createInquiryClient } from '../apps/ai-bff/src/inquiry-client.ts';
import { createAiBffServer } from '../apps/ai-bff/src/server.ts';
import { createServer } from '../apps/site/node_modules/vite/dist/node/index.js';
import { AiStore, waitForDatabase } from '../packages/ai-store/src/index.ts';

function loopback(value: string | undefined) {
  const url = new URL(value ?? '');
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  return url;
}
const database = loopback(process.env.SALES_ASSISTANT_TEST_DATABASE_URL);
assert.match(database.pathname, /^\/assistant_sales_[a-z0-9_]+$/);
const intake = loopback(process.env.SALES_ASSISTANT_TEST_ORIGIN);
assert.equal(intake.protocol, 'http:');
assert.equal(intake.pathname, '/');
const directory = resolve(process.env.SALES_ASSISTANT_TEST_OUTPUT ?? 'output/assistant-handoff');
await mkdir(directory, { recursive: true });
const store = new AiStore(database.href);
const origins = new Set<string>();
let bff: ReturnType<typeof createAiBffServer> | undefined;
let preview: Awaited<ReturnType<typeof createServer>> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await waitForDatabase(store, { signal: AbortSignal.timeout(15000), delaysMs: [100, 250, 500] });
  bff = createAiBffServer(
    store,
    {
      allowedOrigins: origins,
      credentialTtlSeconds: 600,
      engineId: 'fake',
      engineVersion: '0.1.0',
      globalRequestsPerMinute: 1000,
      ipRequestsPerMinute: 1000,
      ipHashSecret: randomUUID(),
      trustProxy: false,
      ssePollMs: 30,
      sseHeartbeatMs: 1000,
      sseMaxDurationMs: 5000,
    },
    {
      inquiryClient: createInquiryClient(
        intake.href,
        process.env.SALES_ASSISTANT_TEST_TOKEN ?? '',
        fetch,
        true,
      ),
    },
  );
  await new Promise<void>((done) => bff?.listen(0, '127.0.0.1', done));
  const address = bff.address() as AddressInfo;
  preview = await createServer({
    root: resolve('apps/site'),
    configFile: resolve('apps/site/assistant-preview.vite.ts'),
    logLevel: 'silent',
    server: {
      host: '127.0.0.1',
      port: 0,
      proxy: { '/api/ai': `http://127.0.0.1:${address.port}` },
    },
  });
  await preview.listen();
  const web = preview.httpServer?.address() as AddressInfo;
  origins.add(`http://127.0.0.1:${web.port}`);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const browserErrors: string[] = [];
  page.on('pageerror', (e) => browserErrors.push(e.message));
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (
      ['http:', 'https:'].includes(url.protocol) &&
      !['127.0.0.1', 'localhost'].includes(url.hostname)
    ) {
      browserErrors.push('External request refused by local acceptance');
      await route.abort('blockedbyclient');
    } else await route.continue();
  });
  await page.goto(`http://127.0.0.1:${web.port}/assistant-chat.html`);
  await page.getByRole('button', { name: 'Prepare inquiry', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Your requirement' })
    .fill('500 headphones for customer gifts. Need delivery options.');
  await page.getByRole('textbox', { name: 'Email *', exact: true }).fill('buyer@example.invalid');
  await page.getByRole('checkbox').check();
  const requests: string[] = [];
  await page.route('**/api/ai/v2/conversations/*/inquiries', async (route) => {
    const body = route.request().postData();
    assert.ok(body);
    requests.push(body);
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    if (requests.length === 1 && process.env.SALES_ASSISTANT_TEST_DROP_RECEIPT === '1') {
      await response.dispose();
      await route.abort('connectionreset');
    } else await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Confirm & submit' }).click();
  if (process.env.SALES_ASSISTANT_TEST_DROP_RECEIPT === '1') {
    await expect(page.getByText('We have not confirmed the result.')).toBeVisible();
    await page.getByRole('button', { name: 'Check original submission' }).click();
    assert.equal(requests.length, 2);
    assert.equal(requests[0], requests[1]);
  }
  const receipt = page.getByLabel('Inquiry receipt');
  await expect(receipt).toContainText('Your inquiry is recorded');
  const reference = /ai_[a-f0-9]{64}/.exec(await receipt.innerText())?.[0];
  assert.ok(reference);
  assert.deepEqual(browserErrors, []);
  await page.screenshot({ path: resolve(directory, 'assistant-confirmed.png'), fullPage: true });
  console.log(
    JSON.stringify({
      reference,
      browser: 'chromium-mobile-size',
      requests: requests.length,
      sameBodyOnRetry: requests.every((v) => v === requests[0]),
      entry: 'actual-component-bff-http',
      model: 'not-used-for-confirmation',
      emailSent: false,
    }),
  );
} finally {
  await browser?.close();
  await preview?.close();
  if (bff) {
    bff.closeAllConnections();
    await new Promise<void>((done) => bff?.close(() => done()));
  }
  await store.close();
}
