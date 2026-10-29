import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'apps/site/dist');
const forbidden = [
  'Component preview · sample data',
  'Local interaction evidence',
  'PREVIEW-001',
  'assistant-preview.html',
];
let checked = 0;
async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    assert.notEqual(
      entry.name,
      'assistant-preview.html',
      'Development preview must not be published',
    );
    if (entry.isDirectory()) await visit(filename);
    else if (/\.(?:html|js|json|xml|css)$/.test(entry.name)) {
      const content = await readFile(filename, 'utf8');
      for (const marker of forbidden)
        assert.ok(
          !content.includes(marker),
          `Development marker leaked: ${marker} in ${path.relative(root, filename)}`,
        );
      checked += 1;
    }
  }
}
await visit(output);
assert.ok(checked > 10, 'Build verification needs the complete site output');
console.log(
  JSON.stringify({ checked, development_preview_absent: true, simulated_content_absent: true }),
);

// Exercise the existing public island from the built files, with all service IO blocked.
const { createServer } = await import('node:http');
const { stat } = await import('node:fs/promises');
const { chromium, expect } = await import('@playwright/test');
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
};
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    let filename = path.resolve(output, `.${decodeURIComponent(url.pathname)}`);
    if (filename !== output && !filename.startsWith(output + path.sep))
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
let browser;
const errors = [];
const routes = ['/', '/headphones/', '/oem/'];
try {
  browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    return url.origin === origin && !url.pathname.startsWith('/api/')
      ? route.continue()
      : route.abort();
  });
  for (const route of routes) {
    await page.goto(origin + route);
    await page.getByRole('button', { name: 'Ask our AI' }).click();
    await page.getByRole('dialog').waitFor();
    await page.getByRole('link', { name: 'Send your project to our team' }).waitFor();
    await page.getByRole('button', { name: 'Close assistant' }).click();
    await expect(page.getByRole('button', { name: 'Ask our AI' })).toBeFocused();
  }
  await page.goto(`${origin}/login/`);
  assert.equal(await page.getByRole('button', { name: 'Ask our AI' }).count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      built_widget_routes: routes,
      excluded_route: '/login/',
      no_config_fallback: 'visible',
      runtime_errors: errors,
      service_requests_blocked: true,
    }),
  );
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
