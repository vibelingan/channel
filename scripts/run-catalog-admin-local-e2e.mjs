import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'channel-catalog-e2e-'));
const databaseFile = join(temporaryDirectory, 'db.json');
const readyFile = join(temporaryDirectory, 'api-ready.json');
const readyToken = randomUUID();
const bin = (packageDirectory, name) =>
  join(process.cwd(), packageDirectory, 'node_modules', '.bin', name);
const processes = [];
const failStage = process.env.E2E_CATALOG_RUNNER_FAIL_STAGE ?? '';
let cleanupPromise;

function start(command, args, env, cwd = process.cwd(), pipeOutput = false) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: pipeOutput ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    detached: true,
  });
  child.spawnError = null;
  child.once('error', (error) => {
    child.spawnError = error;
  });
  if (pipeOutput) {
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
  }
  processes.push(child);
  return child;
}

async function waitForOwnedApi(child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.spawnError) throw child.spawnError;
    if (child.exitCode !== null) {
      throw new Error(`Local API exited before readiness (${child.exitCode ?? child.signalCode}).`);
    }
    try {
      const ready = JSON.parse(await readFile(readyFile, 'utf8'));
      if (
        ready.token !== readyToken ||
        ready.db !== databaseFile ||
        !Number.isSafeInteger(ready.port)
      ) {
        throw new Error('Local API readiness identity does not match the owned process and DB.');
      }
      const apiUrl = `http://127.0.0.1:${ready.port}`;
      const response = await fetch(`${apiUrl}/api/health`);
      const body = await response.json();
      if (response.ok && body?.data?.mode === 'local' && body?.data?.db === databaseFile) {
        return apiUrl;
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('identity does not match')) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for the owned local API.');
}

async function waitForSite(child) {
  const deadline = Date.now() + 30_000;
  let output = '';
  const append = (chunk) => {
    output += chunk.toString();
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  while (Date.now() < deadline) {
    if (child.spawnError) throw child.spawnError;
    if (child.exitCode !== null) throw new Error('Astro site exited before readiness.');
    const match = output.match(/Local\s+http:\/\/127\.0\.0\.1:(\d+)\//);
    if (match) {
      const url = `http://127.0.0.1:${match[1]}`;
      const response = await fetch(url);
      if (response.ok) return url;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for the owned Astro site.');
}

async function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = start(command, args, env);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code ?? signal}`));
    });
  });
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function signalGroup(child, signal) {
  if (child.exitCode !== null || !Number.isSafeInteger(child.pid)) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
  }
}

async function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    for (const child of processes.reverse()) signalGroup(child, 'SIGTERM');
    const exited = await Promise.all(processes.map((child) => waitForExit(child, 3_000)));
    for (const [index, child] of processes.entries()) {
      if (!exited[index]) signalGroup(child, 'SIGKILL');
    }
    await Promise.all(processes.map((child) => waitForExit(child, 3_000)));
    await rm(temporaryDirectory, { recursive: true, force: true });
    await access(temporaryDirectory).then(
      () => {
        throw new Error(`Temporary catalog E2E directory still exists: ${temporaryDirectory}`);
      },
      () => undefined,
    );
    console.log(`[catalog-admin-local] removed ${temporaryDirectory}`);
  })();
  return cleanupPromise;
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    cleanup()
      .then(() => process.exit(128 + (signal === 'SIGINT' ? 2 : 15)))
      .catch((error) => {
        console.error(error);
        process.exit(1);
      });
  });
}

try {
  const api = start(
    failStage === 'api' ? join(temporaryDirectory, 'missing-api') : bin('apps/local-server', 'tsx'),
    ['src/main.ts'],
    {
      PORT: '0',
      LOCAL_DB_FILE: databaseFile,
      LOCAL_MEDIA_DIR: join(temporaryDirectory, 'media'),
      LOCAL_READY_FILE: readyFile,
      LOCAL_READY_TOKEN: readyToken,
      ADMIN_EMAIL: 'admin@channel.local',
      ADMIN_PASSWORD: 'admin',
    },
    join(process.cwd(), 'apps/local-server'),
  );
  const apiUrl = await waitForOwnedApi(api);

  const site = start(
    failStage === 'site' ? join(temporaryDirectory, 'missing-site') : bin('apps/site', 'astro'),
    ['dev', '--host', '127.0.0.1', '--port', '0'],
    { PUBLIC_CB_HOST: new URL(apiUrl).host },
    join(process.cwd(), 'apps/site'),
    true,
  );
  const siteUrl = await waitForSite(site);

  const e2eEnvironment = {
    E2E_SITE_URL: siteUrl,
    E2E_API_URL: apiUrl,
    E2E_ADMIN_EMAIL: 'admin@channel.local',
    E2E_ADMIN_PASSWORD: 'admin',
    E2E_ALLOW_MUTATION: '1',
    E2E_CATALOG_LOCAL_SEED: '1',
    E2E_CATALOG_LOCAL_DB: databaseFile,
  };
  await run(
    bin('.', 'playwright'),
    ['test', 'tests/e2e/catalog-local-seed.spec.ts'],
    e2eEnvironment,
  );
  await run(bin('.', 'playwright'), ['test', 'tests/e2e/catalog-admin.spec.ts'], e2eEnvironment);
} finally {
  await cleanup();
}
