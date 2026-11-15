/** Exercise the built public widget, with every API response supplied locally. */
import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const build = path.join(root, 'apps/site/dist');
const evidence = path.join(root, 'output/assistant-final-delivery');
const apiOrigin = 'https://ai-bff-298020-11-1443560658.sh.run.tcloudbase.com';
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
};
await stat(path.join(build, 'index.html'));
await mkdir(evidence, { recursive: true });

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    let filename = path.resolve(build, `.${decodeURIComponent(url.pathname)}`);
    if (filename !== build && !filename.startsWith(build + path.sep))
      throw new Error('Outside build');
    if ((await stat(filename)).isDirectory()) filename = path.join(filename, 'index.html');
    response.writeHead(200, {
      'Content-Type': types[path.extname(filename)] ?? 'application/octet-stream',
    });
    response.end(await readFile(filename));
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const results = [];
let browser;
try {
  browser = await chromium.launch();
  for (const viewport of [
    { name: 'desktop', width: 1440, height: 1000 },
    { name: 'mobile', width: 390, height: 844 },
  ]) {
    for (const delivery of ['final-only', 'token-and-final']) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        isMobile: viewport.name === 'mobile',
        hasTouch: viewport.name === 'mobile',
        deviceScaleFactor: 1,
      });
      const page = await context.newPage();
      const errors = [];
      const requests = { create: 0, message: 0, events: 0 };
      const unexpectedApi = [];
      const answer =
        delivery === 'final-only'
          ? 'Synthetic final-only answer for rendering verification.'
          : 'Synthetic streamed answer for rendering verification.';
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.origin === origin && !url.pathname.startsWith('/api/')) return route.continue();
        if (url.origin !== apiOrigin || !url.pathname.startsWith('/api/ai/')) return route.abort();
        const headers = {
          'access-control-allow-origin': origin,
          'access-control-allow-headers': 'Authorization, Content-Type, Last-Event-ID',
          'access-control-allow-methods': 'GET, POST, OPTIONS',
        };
        if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
        if (url.pathname === '/api/ai/conversations' && route.request().method() === 'POST') {
          requests.create += 1;
          return route.fulfill({
            status: 201,
            headers,
            contentType: 'application/json',
            body: JSON.stringify({
              conversationId: 'rendering-fixture',
              credential: 'synthetic-browser-fixture-not-a-real-credential',
              expiresAt: '2099-01-01T00:00:00Z',
            }),
          });
        }
        if (
          url.pathname === '/api/ai/conversations/rendering-fixture/messages' &&
          route.request().method() === 'POST'
        ) {
          requests.message += 1;
          return route.fulfill({
            status: 202,
            headers,
            contentType: 'application/json',
            body: JSON.stringify({
              messageId: 'fixture-message',
              runId: 'fixture-run',
              disposition: 'started',
            }),
          });
        }
        if (
          url.pathname === '/api/ai/conversations/rendering-fixture/events' &&
          route.request().method() === 'GET'
        ) {
          requests.events += 1;
          const events =
            delivery === 'final-only'
              ? [{ type: 'final', sequence: 1, text: answer }]
              : [
                  { type: 'token', sequence: 1, text: 'Synthetic streamed ' },
                  { type: 'token', sequence: 2, text: 'answer for rendering verification.' },
                  { type: 'final', sequence: 3, text: answer },
                ];
          return route.fulfill({
            status: 200,
            headers,
            contentType: 'text/event-stream',
            body: events
              .map(
                (event) =>
                  `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
              )
              .join(''),
          });
        }
        unexpectedApi.push({ method: route.request().method(), pathname: url.pathname });
        return route.abort();
      });
      const result = { viewport: viewport.name, delivery, passed: false, requests };
      try {
        await page.goto(origin, { waitUntil: 'domcontentloaded' });
        await page.getByRole('button', { name: 'Ask our AI' }).click();
        const dialog = page.getByRole('dialog');
        const question = dialog.getByRole('textbox', { name: 'Your question' });
        await expect(
          question,
          'Build with PUBLIC_AI_API_BASE_URL set to the public BFF and PUBLIC_AI_CHAT_V2=0.',
        ).toBeVisible();
        await question.fill('Helo, what does your company provide?');
        await dialog.getByRole('button', { name: 'Send', exact: true }).click();
        await expect(question).toBeEnabled();
        // The defect completes the run but leaves this exact bubble as an ellipsis.
        const reply = dialog.locator('p.whitespace-pre-wrap').last();
        await expect(reply).toHaveText(answer, { timeout: 5000 });
        await expect(dialog.getByText(answer, { exact: true })).toHaveCount(1);
        assert.deepEqual(requests, { create: 1, message: 1, events: 1 });
        assert.deepEqual(unexpectedApi, []);
        assert.deepEqual(errors, []);
        result.passed = true;
      } catch (error) {
        result.error = error.message;
      } finally {
        await page.screenshot({
          path: path.join(evidence, `${viewport.name}-${delivery}.png`),
          animations: 'disabled',
        });
        results.push(result);
        await context.close();
      }
    }
  }
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await writeFile(
    path.join(evidence, 'results.json'),
    JSON.stringify(
      {
        scope:
          'Built public homepage widget; synthetic API responses; no production model, database or email calls',
        results,
      },
      null,
      2,
    ),
  );
}
console.log(
  JSON.stringify(
    { passed: results.filter((result) => result.passed).length, total: results.length, results },
    null,
    2,
  ),
);
assert.equal(results.length, 4);
assert.ok(
  results.every((result) => result.passed),
  'The built public widget must render final-only answers and avoid duplicating token+final answers.',
);
