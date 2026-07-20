import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const envId = requireEnv('TCB_ENV_ID');
const webAppServiceName = process.env.CLOUDBASE_WEBAPP_SERVICE || 'channel-test';
const targetRuntime = process.env.CLOUDBASE_FUNCTION_RUNTIME || 'Nodejs20.19';
const expectedReleaseId = process.env.CHANNEL_BUILD_SHA || process.env.GITHUB_SHA || 'local';
const siteUrl = trimSlash(
  process.env.SITE_URL || `https://${webAppServiceName}-${envId}.webapps.tcloudbase.com`,
);
const apiUrl = trimSlash(
  process.env.PUBLIC_API_BASE_URL || `https://${envId}.service.tcloudbase.com`,
);

function trimSlash(value) {
  return value.trim().replace(/\/+$/, '');
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function parseJsonWithNoise(output) {
  const start = output.indexOf('{');
  if (start < 0) throw new Error('No JSON object returned by mcporter.');
  return JSON.parse(output.slice(start));
}

function callTool(selector, args, options = {}) {
  const output = execFileSync(
    'npx',
    ['mcporter', 'call', selector, '--args', JSON.stringify(args), '--output', 'json'],
    {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: options.timeoutMs ?? 180_000,
    },
  );
  return parseJsonWithNoise(output);
}

async function expectHttp(method, url, expectedStatus, body) {
  const response = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.status !== expectedStatus) {
    const text = await response.text();
    throw new Error(
      `${method} ${url} expected ${expectedStatus}, got ${response.status}: ${text.slice(0, 300)}`,
    );
  }
  console.log(`${method} ${url} -> ${response.status}`);
  return response;
}

async function expectJson(method, url, expectedStatus, body) {
  const response = await expectHttp(method, url, expectedStatus, body);
  return await response.json();
}

async function expectImage(url) {
  const response = await expectHttp('GET', url, 200);
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('image/')) {
    throw new Error(`GET ${url} expected an image response, got ${contentType || '<missing>'}`);
  }
}

function assertRelease(service, body) {
  if (body?.ok !== true) {
    throw new Error(
      `${service}: health response was not ok: ${JSON.stringify(body).slice(0, 300)}`,
    );
  }
  const data = body.data ?? {};
  if (data.status !== 'ok' || data.service !== service) {
    throw new Error(`${service}: unexpected health payload: ${JSON.stringify(body).slice(0, 300)}`);
  }
  if (data.releaseId !== expectedReleaseId) {
    throw new Error(
      `${service}: expected release ${expectedReleaseId}, got ${data.releaseId ?? '<missing>'}`,
    );
  }
  if (typeof data.buildTime !== 'string' || data.buildTime.length === 0) {
    throw new Error(`${service}: missing buildTime in health payload`);
  }
  console.log(`${service}: release ${data.releaseId} (${data.buildTime})`);
}

function verifyFunctionRuntime(functionName) {
  const result = callTool('cloudbase.queryFunctions', {
    action: 'getFunctionDetail',
    functionName,
  });
  const detail = result.data?.functionDetail;
  if (!detail) throw new Error(`${functionName}: missing function detail`);
  if (detail.Runtime !== targetRuntime) {
    throw new Error(`${functionName}: expected runtime ${targetRuntime}, got ${detail.Runtime}`);
  }
  if (detail.Status !== 'Active' && detail.AvailableStatus !== 'Available') {
    throw new Error(`${functionName}: function is not active`);
  }
  console.log(`${functionName}: runtime ${detail.Runtime}, status ${detail.Status}`);
}

callTool('cloudbase.auth', { action: 'set_env', envId });
verifyFunctionRuntime('admin');
verifyFunctionRuntime('public-api');

for (const path of ['/', '/admin', '/login', '/oem', '/portfolio']) {
  await expectHttp('GET', `${siteUrl}${path}`, 200);
}

// The headphones/overstock storefronts were retired in the OEM refresh. Static
// hosting upload is additive, so deployWebApp() prunes them; assert they stay
// gone. A 200 here means a stale page resurfaced and the prune regressed.
for (const path of ['/headphones', '/overstock']) {
  await expectHttp('GET', `${siteUrl}${path}`, 404);
}

// The canonical portfolio must publish both current case images and retire the
// superseded TWS object. Query strings bypass stale CDN cache entries so this
// checks the just-deployed hosting state rather than a previous release.
for (const path of [
  '/media/portfolio/cases/sleep-clock.webp',
  '/media/portfolio/cases/disc-repair.jpg',
]) {
  await expectImage(`${siteUrl}${path}?deployment-smoke=${encodeURIComponent(expectedReleaseId)}`);
}
await expectHttp(
  'GET',
  `${siteUrl}/media/portfolio/cases/tws-speaker-1.webp?deployment-smoke=${encodeURIComponent(expectedReleaseId)}`,
  404,
);

assertRelease('public-api', await expectJson('GET', `${apiUrl}/api/health`, 200));
assertRelease('admin', await expectJson('POST', `${apiUrl}/api/admin`, 200, { action: 'health' }));
await expectHttp('GET', `${apiUrl}/api/products?pageSize=1`, 200);
await expectHttp('GET', `${apiUrl}/api/overstock?pageSize=1`, 200);
await expectHttp('GET', `${apiUrl}/api/files/__missing__`, 404);
await expectHttp('POST', `${apiUrl}/api/admin`, 401, {
  action: 'list',
  data: { collection: 'users' },
});

console.log(`CloudBase smoke passed for ${siteUrl}`);
