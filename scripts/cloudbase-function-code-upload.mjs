import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertToolSucceeded } from './cloudbase-deploy-resources.mjs';
import { decodeUtf8, fetchFully } from './smoke-http.mjs';

// Keep base64 overhead below the API's 1.5 MB inline limit.
const INLINE_ZIP_BYTES = 1024 * 1024;
const cliDeployment = () => ({ method: 'cloudbase-cli-primary', cleanup() {} });

export async function confirmFunctionCode({
  functionName,
  apiUrl,
  routePath,
  expectedRelease,
  pause = 500,
}) {
  const admin = functionName === 'admin';
  const url = `${apiUrl}${routePath}${admin ? '' : '/health'}`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetchFully(admin ? 'POST' : 'GET', url, {
        ...(admin
          ? { headers: { 'content-type': 'application/json' }, body: '{"action":"health"}' }
          : {}),
        maxBytes: 16 * 1024,
        redirect: 'error',
      });
      const body = JSON.parse(decodeUtf8(response.body));
      if (
        response.status === 200 &&
        body.ok === true &&
        body.data?.status === 'ok' &&
        body.data.service === functionName &&
        body.data.releaseId === expectedRelease
      )
        return;
    } catch {
      // A read may still reach the previous instance during code activation.
    }
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, pause));
  }
  throw new Error(`${functionName}: deployed code release ${expectedRelease} was not confirmed`);
}

function checkedUpload(data, functionName, region) {
  const invalid = () => new Error('Invalid private function upload descriptor');
  if (!data || typeof data.uploadUrl !== 'string' || /[\r\n\0]/.test(data.uploadUrl)) {
    throw invalid();
  }
  let url;
  try {
    url = new URL(data.uploadUrl);
  } catch {
    throw invalid();
  }
  const expectedKey = new RegExp(`^fnzip-upload/\\d{10}-[0-9a-f]{16}/${functionName}\\.zip$`);
  const bucket = data.cosBucketName;
  const domainSuffix = `.cos.${region}.myqcloud.com`;
  const bucketHost = url.hostname.endsWith(domainSuffix)
    ? url.hostname.slice(0, -domainSuffix.length)
    : '';
  if (
    !/^[a-z0-9][a-z0-9-]{0,61}$/.test(bucket ?? '') ||
    data.cosBucketRegion !== region ||
    !expectedKey.test(data.cosObjectName ?? '') ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    !bucketHost.startsWith(`${bucket}-`) ||
    !/^\d+$/.test(bucketHost.slice(bucket.length + 1)) ||
    url.pathname !== `/${data.cosObjectName}` ||
    !url.searchParams.has('q-signature') ||
    !Number.isInteger(data.expiresInSeconds) ||
    data.expiresInSeconds < 60 ||
    !Array.isArray(data.uploadHeaders) ||
    data.uploadHeaders.some(
      (header) =>
        header?.Key !== 'x-cos-security-token' ||
        typeof header.Value !== 'string' ||
        !header.Value ||
        /[\r\n\0]/.test(header.Value),
    )
  ) {
    throw invalid();
  }
  return data;
}

function verifyPrivateZip({ run, upload }) {
  const privateUrl = new URL(upload.uploadUrl);
  privateUrl.search = '';
  let anonymousStatus;
  try {
    anonymousStatus = run(
      'curl',
      [
        '--head',
        '--proto',
        '=https',
        '--max-time',
        '20',
        '--silent',
        '--show-error',
        '--output',
        '/dev/null',
        '--write-out',
        '%{http_code}',
        privateUrl.href,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
    ).trim();
  } catch {
    throw new Error('Could not confirm function ZIP privacy');
  }
  if (!['403', '404'].includes(anonymousStatus)) {
    throw new Error(`Function ZIP privacy check failed (HTTP ${anonymousStatus})`);
  }
}

function uploadWithStorageSdk({ callTool, envId, functionName, zipPath, upload }) {
  assertToolSucceeded(
    callTool('cloudbase.auth', { action: 'set_env', envId }),
    `${functionName}: bind storage upload environment`,
  );
  const bucket = new URL(upload.uploadUrl).hostname.split('.cos.')[0];
  const permission = callTool('cloudbase.queryPermissions', {
    action: 'getResourcePermission',
    resourceType: 'storage',
    resourceId: bucket,
  });
  assertToolSucceeded(permission, `${functionName}: inspect private storage`);
  if (
    permission.data?.envId !== envId ||
    permission.data.resourceType !== 'storage' ||
    permission.data.resourceId !== bucket ||
    permission.data.aclTag !== 'PRIVATE' ||
    !permission.data.permissions?.some(
      (entry) =>
        entry.Resource === bucket &&
        entry.ResourceType === 'storage' &&
        entry.Permission === 'PRIVATE',
    )
  )
    throw new Error(`${functionName}: SDK upload requires verified private storage`);
  try {
    const result = callTool(
      'cloudbase.manageStorage',
      {
        action: 'upload',
        localPath: zipPath,
        cloudPath: upload.cosObjectName,
        isDirectory: false,
      },
      { timeoutMs: 300_000, maxAttempts: 1 },
    );
    if (
      result?.success !== true ||
      result.data?.action !== 'upload' ||
      result.data.cloudPath !== upload.cosObjectName ||
      result.data.localPath !== zipPath
    )
      throw new Error('Storage SDK did not acknowledge the requested upload');
  } catch {
    // Upload results can include temporary URLs. Do not expose them in errors.
    throw new Error('Private function ZIP upload failed (storage SDK)');
  }
}

export function deployFunctionCode({
  functionName,
  artifactDir,
  action,
  envId,
  region,
  callTool,
  deployWithCli,
  run = execFileSync,
  logger = console,
}) {
  if (action !== 'update') {
    deployWithCli();
    return cliDeployment();
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(functionName)) throw new Error('Invalid function name');
  const temporary = mkdtempSync(join(tmpdir(), 'channel-function-code-'));
  let upload;
  let importStarted = false;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned || !upload) return;
    assertToolSucceeded(
      callTool('cloudbase.manageStorage', {
        action: 'delete',
        cloudPath: upload.cosObjectName,
        isDirectory: false,
        force: true,
      }),
      `${functionName}: remove private staging ZIP`,
    );
    cleaned = true;
  };
  try {
    const zipPath = join(temporary, 'code.zip');
    run('zip', ['-q', '-r', '-X', zipPath, '.'], {
      cwd: artifactDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    });
    chmodSync(zipPath, 0o600);
    const zipBytes = statSync(zipPath).size;
    if (zipBytes <= INLINE_ZIP_BYTES) {
      deployWithCli();
      return cliDeployment();
    }

    assertToolSucceeded(
      callTool('cloudbaseUpload.auth', { action: 'set_env', envId }),
      `${functionName}: bind private code upload environment`,
    );
    const result = callTool('cloudbaseUpload.queryFunctions', {
      action: 'getFunctionUploadUrl',
      functionName,
    });
    assertToolSucceeded(result, `${functionName}: get private code upload`);
    upload = checkedUpload(result.data, functionName, region);
    // The storage SDK handles multipart uploads for large ZIPs.
    uploadWithStorageSdk({ callTool, envId, functionName, zipPath, upload });
    verifyPrivateZip({ run, upload });
    logger.log(
      `${functionName}: private ZIP uploaded (${zipBytes} bytes); staging object ${upload.cosObjectName}`,
    );
    importStarted = true;
    assertToolSucceeded(
      callTool('cloudbaseUpload.manageFunctions', {
        action: 'updateFunctionCode',
        functionName,
        confirm: true,
        code: {
          cosBucketName: upload.cosBucketName,
          cosBucketRegion: upload.cosBucketRegion,
          cosObjectName: upload.cosObjectName,
        },
      }),
      `${functionName}: import private code ZIP`,
    );
    // The caller releases the object only after Active and config verification.
    return { method: 'private-staged-zip', cleanup };
  } catch (error) {
    if (upload && !importStarted) {
      try {
        cleanup();
      } catch {
        logger.log(
          `${functionName}: staging ZIP retained at ${upload.cosObjectName}; cleanup failed`,
        );
      }
    }
    throw error;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
