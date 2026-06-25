import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const functionRootPath = resolve(root, '.cloudbase-artifacts/functions');
const siteRootPath = resolve(root, 'apps/site');
const targetRuntime = process.env.CLOUDBASE_FUNCTION_RUNTIME || 'Nodejs20.19';
const webAppServiceName = process.env.CLOUDBASE_WEBAPP_SERVICE || 'channel-test';
const envId = requireEnv('TCB_ENV_ID');
const appEnv = process.env.APP_ENV || 'test';
const siteUrl = trimSlash(
  process.env.SITE_URL || `https://${webAppServiceName}-${envId}.webapps.tcloudbase.com`,
);
const apiUrl = trimSlash(
  process.env.PUBLIC_API_BASE_URL || `https://${envId}.service.tcloudbase.com`,
);
const corsAllowedOrigins = process.env.CORS_ALLOWED_ORIGINS || `${siteUrl},http://localhost:4321`;
const loginUrl = process.env.LOGIN_URL || `${siteUrl}/login`;
const adminEmail = process.env.ADMIN_EMAIL || 'admin@channel.local';

function trimSlash(value) {
  return value.trim().replace(/\/+$/, '');
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function optionalEnv(name) {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

function parseJsonWithNoise(output) {
  const start = output.indexOf('{');
  if (start < 0) {
    throw new Error(
      `No JSON object returned by mcporter. Output started with: ${output.slice(0, 120)}`,
    );
  }
  return JSON.parse(output.slice(start));
}

function callTool(selector, args, options = {}) {
  const maxAttempts = options.maxAttempts ?? 3;
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
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
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) continue;
    }
  }
  if (options.allowFailure) {
    const text = `${lastError?.stdout ?? ''}${lastError?.stderr ?? ''}`;
    try {
      return parseJsonWithNoise(text);
    } catch {
      return { success: false, message: `mcporter call failed for ${selector}` };
    }
  }
  throw new Error(`mcporter call failed for ${selector}: ${lastError?.message ?? 'unknown error'}`);
}

function functionDetail(functionName, allowFailure = false) {
  const result = callTool(
    'cloudbase.queryFunctions',
    { action: 'getFunctionDetail', functionName },
    { allowFailure },
  );
  if (result.success === false) return null;
  return result.data?.functionDetail ?? null;
}

function waitForGone(functionName) {
  for (let i = 0; i < 12; i += 1) {
    if (!functionDetail(functionName, true)) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
  }
  throw new Error(`${functionName} still exists after delete.`);
}

function waitForActive(functionName) {
  for (let i = 0; i < 18; i += 1) {
    const detail = functionDetail(functionName, true);
    if (detail?.Status === 'Active' || detail?.AvailableStatus === 'Available') return detail;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
  }
  throw new Error(`${functionName} did not become active.`);
}

function envEntries(record) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function createFunction(def) {
  const result = callTool(
    'cloudbase.manageFunctions',
    {
      action: 'createFunction',
      functionRootPath,
      force: true,
      func: {
        name: def.name,
        runtime: targetRuntime,
        handler: 'index.main',
        timeout: 20,
        memorySize: 256,
        type: 'Event',
        installDependency: false,
        envVariables: def.envVariables,
      },
    },
    { timeoutMs: 240_000 },
  );
  return (
    result.data?.raw?.RequestId ??
    result.data?.raw?.codeRes?.RequestId ??
    result.data?.raw?.configRes?.RequestId ??
    'unknown'
  );
}

function updateFunction(def) {
  const codeResult = callTool(
    'cloudbase.manageFunctions',
    {
      action: 'updateFunctionCode',
      functionName: def.name,
      functionRootPath,
    },
    { timeoutMs: 240_000 },
  );
  const configResult = callTool('cloudbase.manageFunctions', {
    action: 'updateFunctionConfig',
    functionName: def.name,
    handler: 'index.main',
    timeout: 20,
    envVariables: def.envVariables,
  });
  return {
    codeRequestId: codeResult.data?.raw?.RequestId ?? codeResult.data?.requestId ?? 'unknown',
    configRequestId: configResult.data?.raw?.RequestId ?? configResult.data?.requestId ?? 'unknown',
  };
}

const functionDefs = [
  {
    name: 'admin',
    routePath: '/api/admin',
    envVariables: envEntries({
      TCB_ENV: envId,
      APP_ENV: appEnv,
      ADMIN_EMAIL: adminEmail,
      JWT_SECRET: requireEnv('JWT_SECRET'),
      ADMIN_PASSWORD_HASH: requireEnv('ADMIN_PASSWORD_HASH'),
      BOOTSTRAP_ENABLED: process.env.BOOTSTRAP_ENABLED || '0',
      BOOTSTRAP_ADMIN_TOKEN: optionalEnv('BOOTSTRAP_ADMIN_TOKEN'),
      CORS_ALLOWED_ORIGINS: corsAllowedOrigins,
      LOGIN_URL: loginUrl,
      EMAIL_HOST: optionalEnv('EMAIL_HOST'),
      EMAIL_PORT: optionalEnv('EMAIL_PORT'),
      EMAIL_SECURE: optionalEnv('EMAIL_SECURE'),
      EMAIL_USER: optionalEnv('EMAIL_USER'),
      EMAIL_PASSWORD: optionalEnv('EMAIL_PASSWORD'),
      EMAIL_FROM: optionalEnv('EMAIL_FROM'),
    }),
  },
  {
    name: 'public-api',
    routePath: '/api',
    envVariables: envEntries({
      TCB_ENV: envId,
      APP_ENV: appEnv,
      PUBLIC_API_BASE_URL: apiUrl,
      CORS_ALLOWED_ORIGINS: corsAllowedOrigins,
    }),
  },
];

function deployFunction(def) {
  const artifactDir = resolve(functionRootPath, def.name);
  if (!existsSync(resolve(artifactDir, 'index.js'))) {
    throw new Error(`Missing packaged function artifact for ${def.name}: ${artifactDir}`);
  }

  const before = functionDetail(def.name, true);
  if (before && before.Runtime !== targetRuntime) {
    console.log(
      `${def.name}: runtime drift ${before.Runtime} -> ${targetRuntime}; deleting for recreate`,
    );
    callTool('cloudbase.manageFunctions', {
      action: 'deleteFunction',
      functionName: def.name,
      confirm: true,
    });
    waitForGone(def.name);
  }

  const current = functionDetail(def.name, true);
  if (current) {
    const requests = updateFunction(def);
    const after = waitForActive(def.name);
    if (after.Runtime !== targetRuntime) {
      throw new Error(`${def.name}: expected runtime ${targetRuntime}, got ${after.Runtime}`);
    }
    console.log(
      `${def.name}: updated on ${after.Runtime}; code request ${requests.codeRequestId}; config request ${requests.configRequestId}`,
    );
    return;
  }

  const requestId = createFunction(def);

  const after = waitForActive(def.name);
  if (after.Runtime !== targetRuntime) {
    throw new Error(`${def.name}: expected runtime ${targetRuntime}, got ${after.Runtime}`);
  }
  console.log(`${def.name}: deployed on ${after.Runtime}; request ${requestId}`);
}

function ensureGateway(def) {
  const current = callTool(
    'cloudbase.queryGateway',
    { action: 'getAccess', targetType: 'function', targetName: def.name },
    { allowFailure: true },
  );
  const apis = current.data?.apis ?? current.data?.raw?.accessList?.APISet ?? [];
  if (apis.some((api) => api.Path === def.routePath)) {
    console.log(`${def.name}: gateway route ${def.routePath} already present`);
    return;
  }

  const created = callTool('cloudbase.manageGateway', {
    action: 'createAccess',
    targetType: 'function',
    targetName: def.name,
    path: def.routePath,
    type: 'Event',
    auth: false,
  });
  const requestId = created.data?.requestId ?? created.data?.raw?.RequestId ?? 'unknown';
  console.log(`${def.name}: created gateway route ${def.routePath}; request ${requestId}`);
}

function deployWebApp() {
  const distPath = resolve(siteRootPath, 'dist');
  if (!existsSync(resolve(distPath, 'index.html'))) {
    throw new Error(`Missing site build output: ${distPath}`);
  }

  const uploaded = callTool(
    'cloudbase.manageHosting',
    {
      action: 'upload',
      localPath: distPath,
      cloudPath: '/',
      isDir: true,
    },
    { timeoutMs: 300_000 },
  );
  const uploadRequestId = uploaded.data?.requestId ?? uploaded.data?.raw?.RequestId ?? 'unknown';
  console.log(`${webAppServiceName}: static hosting upload finished; request ${uploadRequestId}`);

  const configured = callTool('cloudbase.manageHosting', {
    action: 'setWebsiteDocument',
    indexDocument: 'index.html',
    errorDocument: 'index.html',
  });
  const configRequestId =
    configured.data?.requestId ?? configured.data?.raw?.RequestId ?? 'unknown';
  console.log(`${webAppServiceName}: website document configured; request ${configRequestId}`);
}

console.log(`Deploying CloudBase test env ${envId} with function runtime ${targetRuntime}`);
callTool('cloudbase.auth', { action: 'set_env', envId });

for (const def of functionDefs) {
  deployFunction(def);
  ensureGateway(def);
}

deployWebApp();

console.log(`Deployment submitted for ${siteUrl}`);
