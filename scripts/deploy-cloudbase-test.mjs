import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const functionRootPath = resolve(root, '.cloudbase-artifacts/functions');
const siteRootPath = resolve(root, 'apps/site');
const targetRuntime = process.env.CLOUDBASE_FUNCTION_RUNTIME || 'Nodejs20.19';
const webAppServiceName = process.env.CLOUDBASE_WEBAPP_SERVICE || 'channel-test';
const functionActiveTimeoutMs = positiveIntegerEnv('CLOUDBASE_FUNCTION_ACTIVE_TIMEOUT_MS', 300_000);
const functionPollIntervalMs = positiveIntegerEnv('CLOUDBASE_FUNCTION_POLL_INTERVAL_MS', 5_000);
const cloudBaseCliPackage = process.env.CLOUDBASE_CLI_PACKAGE || '@cloudbase/cli@3.5.9';
const cloudBaseCliDeployModes = (process.env.CLOUDBASE_CLI_DEPLOY_MODES || 'zip,cos')
  .split(',')
  .map((mode) => mode.trim())
  .filter(Boolean);
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
const resetPasswordUrl = process.env.RESET_PASSWORD_URL || `${siteUrl}/reset`;
const adminEmail = process.env.ADMIN_EMAIL || 'admin@channel.local';

function trimSlash(value) {
  return value.trim().replace(/\/+$/, '');
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function positiveIntegerEnv(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer number of milliseconds.`);
  }
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
  throw new Error(`mcporter call failed for ${selector}: ${redactToolError(lastError)}`);
}

// execFileSync's error.message embeds the full argv, including `--args <json>`
// with JWT_SECRET / ADMIN_PASSWORD_HASH / EMAIL_PASSWORD, etc. Never let that
// reach a thrown message: drop the argv/args payload and surface only a
// redacted exit-status + stderr slice.
function redactToolError(error) {
  if (!error || typeof error !== 'object') return 'unknown error';
  const status = error.status ?? error.code ?? error.signal ?? 'unknown';
  const stderr = redactSecretJson(String(error.stderr ?? '')).slice(0, 700);
  const detail = stderr.trim() ? ` stderr: ${stderr.trim()}` : '';
  return `exit ${status}${detail}`;
}

// Redact any JSON value whose key looks secret, so a stray `--args {...}`
// payload in captured stderr cannot leak a credential.
function redactSecretJson(text) {
  return text.replace(
    /("[^"]*(?:SECRET|PASSWORD|TOKEN|HASH|SECRETID|SECRETKEY|SESSIONTOKEN)[^"]*"\s*:\s*)"(?:[^"\\]|\\.)*"/gi,
    '$1"***"',
  );
}

function requestIdFrom(result) {
  return (
    result?.data?.raw?.RequestId ??
    result?.data?.raw?.codeRes?.RequestId ??
    result?.data?.raw?.configRes?.RequestId ??
    result?.data?.requestId ??
    result?.data?.RequestId ??
    result?.requestId ??
    null
  );
}

function toolMessage(result) {
  if (!result || typeof result !== 'object') return 'no result object returned';
  const raw = result.data?.raw;
  const summary = {
    success: result.success,
    code: result.code ?? raw?.Code,
    message: result.message ?? raw?.Message,
    requestId: requestIdFrom(result),
    dataKeys: result.data && typeof result.data === 'object' ? Object.keys(result.data) : [],
    rawKeys: raw && typeof raw === 'object' ? Object.keys(raw) : [],
  };
  return JSON.stringify(summary).slice(0, 700);
}

function assertToolSucceeded(result, label) {
  if (!result || typeof result !== 'object') {
    throw new Error(`${label} returned no result object.`);
  }
  if (result.success === false) {
    throw new Error(`${label} failed: ${toolMessage(result)}`);
  }
}

function parseCliJsonWithNoise(output) {
  const start = output.indexOf('{');
  if (start < 0) return null;
  try {
    return JSON.parse(output.slice(start));
  } catch {
    return null;
  }
}

function redactCliArgs(args) {
  const sensitiveFlags = new Set(['--apiKeyId', '--apiKey', '--token']);
  return args.map((arg, index) => (sensitiveFlags.has(args[index - 1]) ? '<redacted>' : arg));
}

function runCloudBaseCli(args, options = {}) {
  try {
    return execFileSync('npx', ['-y', '-p', cloudBaseCliPackage, 'tcb', ...args], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: options.timeoutMs ?? 300_000,
    });
  } catch (error) {
    const safeArgs = redactCliArgs(args).join(' ');
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`.slice(0, 1_200);
    throw new Error(`CloudBase CLI failed: tcb ${safeArgs}\n${output}`);
  }
}

let cloudBaseCliAuthenticated = false;

function ensureCloudBaseCliAuth() {
  if (cloudBaseCliAuthenticated) return;
  runCloudBaseCli(
    [
      'login',
      '--apiKeyId',
      requireEnv('TENCENTCLOUD_SECRETID'),
      '--apiKey',
      requireEnv('TENCENTCLOUD_SECRETKEY'),
      '--json',
    ],
    { timeoutMs: 180_000 },
  );
  cloudBaseCliAuthenticated = true;
  console.log('CloudBase CLI authenticated with permanent CAM credentials.');
}

function writeCloudBaseCliConfig(def) {
  const configDir = mkdtempSync(resolve(tmpdir(), `channel-${def.name}-tcb-`));
  const configPath = resolve(configDir, 'cloudbaserc.json');
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        $schema: 'https://static.cloudbase.net/cli/cloudbaserc.schema.json',
        envId,
        functionRoot: functionRootPath,
        functions: [
          {
            name: def.name,
            runtime: targetRuntime,
            handler: 'index.main',
            timeout: 20,
            memorySize: 256,
            envVariables: def.envVariables,
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return { configDir, configPath };
}

function summarizeCloudBaseCliOutput(output) {
  const parsed = parseCliJsonWithNoise(output);
  if (parsed) {
    return JSON.stringify({
      code: parsed.code,
      message: parsed.message,
      requestId: parsed.requestId ?? parsed.RequestId ?? parsed.data?.requestId,
      dataKeys: parsed.data && typeof parsed.data === 'object' ? Object.keys(parsed.data) : [],
    }).slice(0, 700);
  }
  return output.replace(/\s+/g, ' ').trim().slice(0, 700) || 'no CLI output';
}

function deployFunctionWithCloudBaseCli(def, reason, action) {
  ensureCloudBaseCliAuth();
  const { configDir, configPath } = writeCloudBaseCliConfig(def);
  const artifactDir = resolve(functionRootPath, def.name);
  try {
    const errors = [];
    for (const deployMode of cloudBaseCliDeployModes) {
      try {
        const commandArgs =
          action === 'update'
            ? [
                '--config-file',
                configPath,
                '-e',
                envId,
                'fn',
                'code',
                'update',
                def.name,
                '--dir',
                artifactDir,
                '--deployMode',
                deployMode,
                '--json',
              ]
            : [
                '--config-file',
                configPath,
                '-e',
                envId,
                'fn',
                'deploy',
                def.name,
                '--dir',
                artifactDir,
                '--runtime',
                targetRuntime,
                '--deployMode',
                deployMode,
                '--force',
                '--json',
              ];
        const output = runCloudBaseCli(commandArgs, { timeoutMs: 600_000 });
        console.log(
          `${def.name}: CloudBase CLI ${deployMode} ${action} submitted (${reason}); ${summarizeCloudBaseCliOutput(
            output,
          )}`,
        );
        return;
      } catch (error) {
        errors.push(`${deployMode}: ${error.message}`);
        if (deployMode !== cloudBaseCliDeployModes.at(-1)) {
          console.warn(
            `${def.name}: CloudBase CLI ${deployMode} ${action} failed; trying next mode.`,
          );
        }
      }
    }
    throw new Error(`${def.name}: all CloudBase CLI ${action} modes failed\n${errors.join('\n')}`);
  } finally {
    rmSync(configDir, { force: true, recursive: true });
  }
}

function isFunctionUpdatingResult(result) {
  const message = `${result?.message ?? result?.data?.raw?.Message ?? ''}`;
  return /Updating状态|updating/i.test(message);
}

function isCredentialFailure(message) {
  return /token verification failed|authfailure|unauthorized|invalid.+credential|invalid.+token|expired.+token/i.test(
    message ?? '',
  );
}

function functionDetailResult(functionName, allowFailure = false) {
  const result = callTool(
    'cloudbase.queryFunctions',
    { action: 'getFunctionDetail', functionName },
    { allowFailure },
  );
  if (result.success === false && isCredentialFailure(result.message)) {
    throw new Error(
      `CloudBase credentials are invalid or expired while querying ${functionName}: ${result.message}`,
    );
  }
  return {
    detail: result.success === false ? null : (result.data?.functionDetail ?? null),
    message: result.message,
  };
}

function functionDetail(functionName, allowFailure = false) {
  return functionDetailResult(functionName, allowFailure).detail;
}

function sleep(ms) {
  if (ms > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  }
}

function summarizeFunctionState(state) {
  const detail = state?.detail;
  if (!detail) {
    return state?.message ? `query failed: ${state.message}` : 'no function detail returned';
  }
  return JSON.stringify({
    status: detail.Status,
    availableStatus: detail.AvailableStatus,
    runtime: detail.Runtime,
    codeSize: detail.CodeSize,
    statusReason: detail.StatusReason,
    statusDesc: detail.StatusDesc,
    updateTime: detail.UpdateTime,
  });
}

function artifactSummary(functionName) {
  const indexFile = resolve(functionRootPath, functionName, 'index.js');
  const size = statSync(indexFile).size;
  const hash = createHash('sha256').update(readFileSync(indexFile)).digest('hex').slice(0, 16);
  return `${size} bytes sha256:${hash}`;
}

function waitForActive(functionName) {
  const deadline = Date.now() + functionActiveTimeoutMs;
  let nextLogAt = Date.now();
  let lastState = null;

  while (Date.now() < deadline) {
    lastState = functionDetailResult(functionName, true);
    const detail = lastState.detail;
    if (detail?.Status === 'Active' || detail?.AvailableStatus === 'Available') return detail;

    const now = Date.now();
    if (now >= nextLogAt) {
      console.log(
        `${functionName}: waiting for active state; ${summarizeFunctionState(lastState)}`,
      );
      nextLogAt = now + 30_000;
    }
    sleep(Math.min(functionPollIntervalMs, Math.max(deadline - now, 0)));
  }
  throw new Error(
    `${functionName} did not become active within ${functionActiveTimeoutMs}ms; last state: ${summarizeFunctionState(lastState)}`,
  );
}

function envEntries(record) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function updateFunctionConfig(def) {
  let configResult = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    configResult = callTool('cloudbase.manageFunctions', {
      action: 'updateFunctionConfig',
      functionName: def.name,
      handler: 'index.main',
      timeout: 20,
      envVariables: def.envVariables,
    });
    if (
      configResult.success !== false ||
      !isFunctionUpdatingResult(configResult) ||
      attempt === 3
    ) {
      break;
    }
    console.log(
      `${def.name}: config update hit Updating state; waiting before retry ${attempt + 1}`,
    );
    waitForActive(def.name);
  }
  assertToolSucceeded(configResult, `${def.name}: updateFunctionConfig`);
  return requestIdFrom(configResult) ?? 'unknown';
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
      RESET_PASSWORD_URL: resetPasswordUrl,
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
      // Same secret the admin function signs sessions with — the public catalog
      // verifies a presented Bearer token to attach role-gated VIP pricing.
      // Absent → catalog is anonymous-only (feature no-ops, fails closed).
      JWT_SECRET: requireEnv('JWT_SECRET'),
    }),
  },
];

function deployFunction(def) {
  const artifactDir = resolve(functionRootPath, def.name);
  if (!existsSync(resolve(artifactDir, 'index.js'))) {
    throw new Error(`Missing packaged function artifact for ${def.name}: ${artifactDir}`);
  }
  console.log(`${def.name}: artifact ${artifactSummary(def.name)}`);

  const before = functionDetail(def.name, true);
  if (before && before.Runtime !== targetRuntime) {
    throw new Error(
      `${def.name}: runtime drift ${before.Runtime} -> ${targetRuntime}; CloudBase function runtime is creation-time locked, so CI will not delete/recreate it automatically.`,
    );
  }

  deployFunctionWithCloudBaseCli(
    def,
    before ? 'primary CI code update' : 'primary CI create',
    before ? 'update' : 'deploy',
  );
  const after = waitForActive(def.name);
  if (after.Runtime !== targetRuntime) {
    throw new Error(`${def.name}: expected runtime ${targetRuntime}, got ${after.Runtime}`);
  }
  const configRequestId = updateFunctionConfig(def);
  const configAfter = waitForActive(def.name);
  if (configAfter.Runtime !== targetRuntime) {
    throw new Error(`${def.name}: expected runtime ${targetRuntime}, got ${configAfter.Runtime}`);
  }
  console.log(
    `${def.name}: deployed on ${configAfter.Runtime}; code deploy cloudbase-cli-primary; config request ${configRequestId}`,
  );
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

// Static hosting `upload` is additive: it creates/overwrites files but never
// deletes remote files that are absent from the new build. Pages and assets
// intentionally removed from the site therefore linger on the CDN from earlier
// deploys (e.g. the retired /headphones and /overstock storefronts). We prune
// the known legacy paths explicitly.
//
// This is a *targeted* prune, not a blanket "delete everything not in dist":
// this script runs only in CI with no local dry-run, so an over-broad prune
// could delete live files with no safety net. Add an entry here whenever a page
// or asset is intentionally removed from the site.
const legacyHostingPaths = [
  { cloudPath: 'headphones', isDir: true },
  { cloudPath: 'headphone-item', isDir: true },
  { cloudPath: 'overstock', isDir: true },
  { cloudPath: 'overstock-item', isDir: true },
  // NOTE: media/logo-channel.svg is the active OEM brand logo again (header +
  // footer on every page) — do NOT prune it.
  { cloudPath: 'media/section-heritage.png', isDir: false },
  { cloudPath: 'media/portfolio/cases/tws-speaker-2.webp', isDir: false },
  { cloudPath: 'media/portfolio/cases/tws-speaker-3.webp', isDir: false },
];

function pruneLegacyHostingPaths() {
  for (const { cloudPath, isDir } of legacyHostingPaths) {
    const result = callTool(
      'cloudbase.manageHosting',
      { action: 'delete', cloudPath, isDir, confirm: true },
      { allowFailure: true, timeoutMs: 120_000 },
    );
    const removed = result?.success !== false;
    console.log(
      `${webAppServiceName}: prune ${isDir ? 'dir ' : 'file'} ${cloudPath} -> ${
        removed ? 'removed/absent' : `left in place (${toolMessage(result)})`
      }`,
    );
  }
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

  pruneLegacyHostingPaths();

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
