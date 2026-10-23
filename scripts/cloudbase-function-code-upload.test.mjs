import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { confirmFunctionCode, deployFunctionCode } from './cloudbase-function-code-upload.mjs';

function fixture(t, overrides = {}) {
  const artifactDir = mkdtempSync(join(tmpdir(), 'channel-code-fixture-'));
  t.after(() => rmSync(artifactDir, { recursive: true, force: true }));
  writeFileSync(join(artifactDir, 'index.js'), 'exports.main = async () => ({ ok: true });');
  writeFileSync(join(artifactDir, 'package.json'), '{"main":"index.js"}');
  const binary = overrides.small ? null : randomBytes(2 * 1024 * 1024);
  if (binary) {
    mkdirSync(join(artifactDir, 'vendor'));
    writeFileSync(join(artifactDir, 'vendor/decoder.node'), binary);
  }
  const objectKey = 'fnzip-upload/1792732800-0123456789abcdef/alibaba-catalog-sync.zip';
  const upload = {
    uploadUrl: `https://channel-test-123456.cos.ap-shanghai.myqcloud.com/${objectKey}?q-signature=private-signature`,
    uploadHeaders: [{ Key: 'x-cos-security-token', Value: 'private-token' }],
    cosBucketName: 'channel-test',
    cosBucketRegion: 'ap-shanghai',
    cosObjectName: objectKey,
    expiresInSeconds: 300,
    ...overrides.upload,
  };
  const calls = [];
  const tempDirs = [];
  let cliCalls = 0;
  let uploadCalls = 0;
  const options = {
    functionName: 'alibaba-catalog-sync',
    artifactDir,
    action: 'update',
    envId: 'channel-test-env',
    region: 'ap-shanghai',
    logger: { log() {} },
    deployWithCli() {
      cliCalls += 1;
      if (!overrides.small && !overrides.create) {
        throw new Error('ZipFile exceeds 1.5MB; COS upload timed out after 60 seconds');
      }
    },
    callTool(selector, args) {
      calls.push({ selector, args });
      if (args.action === 'set_env') return { success: true };
      if (args.action === 'getFunctionUploadUrl') return { success: true, data: upload };
      if (args.action === 'updateFunctionCode') {
        if (overrides.importError) throw new Error('code import reply lost');
        return { success: true, data: { raw: { RequestId: 'original-import' } } };
      }
      if (args.action === 'delete')
        return args.force === true
          ? { success: true }
          : { success: false, message: 'Delete operation requires force: true' };
      throw new Error(`Unexpected tool action: ${args.action}`);
    },
    run(command, args, settings) {
      if (command !== 'curl') return execFileSync(command, args, settings);
      if (args.includes('--head')) return overrides.anonymousStatus ?? '403';
      uploadCalls += 1;
      const configPath = args[args.indexOf('--config') + 1];
      const zipPath = args[args.indexOf('--upload-file') + 1];
      tempDirs.push(dirname(configPath));
      const config = readFileSync(configPath, 'utf8');
      assert.match(config, /x-cos-acl: private/);
      assert.match(config, /private-token/);
      assert.match(config, /request = "PUT"/);
      assert.ok(!args.join(' ').includes('private-signature'));
      assert.ok(!args.join(' ').includes('private-token'));
      assert.ok(!args.includes('--location'));
      assert.equal(args[args.indexOf('--proto') + 1], '=https');
      assert.equal(args[args.indexOf('--output') + 1], '/dev/null');
      const unpacked = execFileSync('unzip', ['-p', zipPath, 'vendor/decoder.node'], {
        maxBuffer: binary.length + 65536,
      });
      assert.deepEqual(unpacked, binary);
      assert.equal(
        execFileSync('unzip', ['-p', zipPath, 'index.js'], { encoding: 'utf8' }),
        readFileSync(join(artifactDir, 'index.js'), 'utf8'),
      );
      if (overrides.transportError) {
        throw Object.assign(new Error('private-signature private-token'), {
          status: overrides.transportExit ?? 28,
          stdout: overrides.transportStatus ?? '000',
        });
      }
      return overrides.httpStatus ?? '200';
    },
  };
  if (overrides.create) options.action = 'deploy';
  return {
    options,
    calls,
    tempDirs,
    objectKey,
    cliCalls: () => cliCalls,
    uploadCalls: () => uploadCalls,
  };
}

test('large native package uses a private ZIP and retains it until confirmed active', (t) => {
  const client = fixture(t);
  const deployment = deployFunctionCode(client.options);
  assert.equal(client.cliCalls(), 0);
  assert.equal(client.uploadCalls(), 1);
  assert.equal(deployment.method, 'private-staged-zip');
  assert.deepEqual(
    client.calls.map(({ args }) => args.action),
    ['set_env', 'getFunctionUploadUrl', 'updateFunctionCode'],
  );
  assert.deepEqual(client.calls[2], {
    selector: 'cloudbaseUpload.manageFunctions',
    args: {
      action: 'updateFunctionCode',
      functionName: 'alibaba-catalog-sync',
      confirm: true,
      code: {
        cosBucketName: 'channel-test',
        cosBucketRegion: 'ap-shanghai',
        cosObjectName: client.objectKey,
      },
    },
  });
  assert.ok(client.tempDirs.every((path) => !existsSync(path)));
  deployment.cleanup();
  deployment.cleanup();
  assert.deepEqual(client.calls.at(-1), {
    selector: 'cloudbase.manageStorage',
    args: { action: 'delete', cloudPath: client.objectKey, isDirectory: false, force: true },
  });
  assert.equal(client.calls.filter(({ args }) => args.action === 'delete').length, 1);
});

for (const overrides of [{ small: true }, { create: true }]) {
  test(`existing CLI path remains unchanged for ${JSON.stringify(overrides)}`, (t) => {
    const client = fixture(t, overrides);
    const deployment = deployFunctionCode(client.options);
    assert.equal(deployment.method, 'cloudbase-cli-primary');
    assert.equal(client.cliCalls(), 1);
    assert.equal(client.uploadCalls(), 0);
    deployment.cleanup();
    assert.deepEqual(client.calls, []);
  });
}

for (const upload of [
  { uploadUrl: 'https://attacker.invalid/code.zip?q-signature=private-signature' },
  {
    uploadUrl:
      'https://channel-test-123456.other.cos.ap-shanghai.myqcloud.com/fnzip-upload/1792732800-0123456789abcdef/alibaba-catalog-sync.zip?q-signature=private-signature',
  },
  { cosObjectName: 'products/customer-image.png' },
  { cosBucketRegion: 'ap-beijing' },
  { uploadHeaders: [{ Key: 'x-cos-security-token', Value: 'secret\nheader: injected' }] },
]) {
  test(`untrusted upload descriptor is rejected before any byte upload: ${Object.keys(upload)}`, (t) => {
    const client = fixture(t, { upload });
    assert.throws(() => deployFunctionCode(client.options), /Invalid private function upload/);
    assert.equal(client.uploadCalls(), 0);
    assert.ok(!client.calls.some(({ args }) => args.action === 'updateFunctionCode'));
  });
}

for (const overrides of [
  { transportError: true },
  { transportError: true, transportExit: 22, transportStatus: '403' },
  { httpStatus: '403' },
  { httpStatus: '302' },
]) {
  test(`failed upload cannot import code or leak credentials: ${JSON.stringify(overrides)}`, (t) => {
    const client = fixture(t, overrides);
    assert.throws(
      () => deployFunctionCode(client.options),
      (error) => {
        assert.match(error.message, /Private function ZIP upload failed/);
        assert.doesNotMatch(error.message, /private-signature|private-token/);
        if (overrides.transportExit === 22) assert.match(error.message, /curl 22, HTTP 403/);
        return true;
      },
    );
    assert.equal(client.uploadCalls(), 1);
    assert.ok(!client.calls.some(({ args }) => args.action === 'updateFunctionCode'));
    assert.ok(client.tempDirs.every((path) => !existsSync(path)));
  });
}

test('unconfirmed code import keeps its private source package for recovery', (t) => {
  const client = fixture(t, { importError: true });
  assert.throws(() => deployFunctionCode(client.options), /code import reply lost/);
  assert.ok(!client.calls.some(({ args }) => args.action === 'delete'));
  assert.ok(client.tempDirs.every((path) => !existsSync(path)));
});

test('publicly readable staging object is removed before any function import', (t) => {
  const client = fixture(t, { anonymousStatus: '200' });
  assert.throws(() => deployFunctionCode(client.options), /privacy check failed/);
  assert.ok(!client.calls.some(({ args }) => args.action === 'updateFunctionCode'));
  assert.deepEqual(client.calls.at(-1), {
    selector: 'cloudbase.manageStorage',
    args: { action: 'delete', cloudPath: client.objectKey, isDirectory: false, force: true },
  });
});

test('only the code upload adapter uses the newer pinned MCP contract', () => {
  const config = JSON.parse(
    readFileSync(new URL('../config/mcporter.json', import.meta.url), 'utf8'),
  );
  assert.deepEqual(config.mcpServers.cloudbase.args, ['@cloudbase/cloudbase-mcp@2.24.1']);
  assert.deepEqual(config.mcpServers.cloudbaseUpload.args, [
    '-y',
    '@cloudbase/cloudbase-mcp@2.36.1',
  ]);
  assert.deepEqual(config.mcpServers.cloudbaseUpload.env, {
    CLOUDBASE_MCP_PLUGINS_ENABLED: 'env,functions',
  });
});

for (const functionName of ['admin', 'alibaba-catalog-sync']) {
  test(`staging release waits for actual health identity before cleanup: ${functionName}`, async (t) => {
    const requests = [];
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      requests.push({ method: request.method, url: request.url, body });
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          ok: true,
          data: {
            status: 'ok',
            service: functionName,
            releaseId: requests.length === 1 ? 'old-release' : 'expected-release',
          },
        }),
      );
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const apiUrl = `http://127.0.0.1:${server.address().port}`;
    await confirmFunctionCode({
      functionName,
      apiUrl,
      routePath: `/api/${functionName}`,
      expectedRelease: 'expected-release',
      pause: 0,
    });
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0], {
      method: functionName === 'admin' ? 'POST' : 'GET',
      url: `/api/${functionName}${functionName === 'admin' ? '' : '/health'}`,
      body: functionName === 'admin' ? '{"action":"health"}' : '',
    });
  });
}

test('old or wrong-service healthy instance cannot authorize staging cleanup', async (t) => {
  let reads = 0;
  const server = createServer((request, response) => {
    reads += 1;
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        ok: true,
        data: { status: 'ok', service: 'different-service', releaseId: 'expected' },
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await assert.rejects(
    confirmFunctionCode({
      functionName: 'admin',
      apiUrl: `http://127.0.0.1:${server.address().port}`,
      routePath: '/api/admin',
      expectedRelease: 'expected',
      pause: 0,
    }),
    /was not confirmed/,
  );
  assert.equal(reads, 3);
  const source = readFileSync(new URL('./deploy-cloudbase-test.mjs', import.meta.url), 'utf8');
  assert.ok(source.indexOf('await confirmFunctionCode(') < source.indexOf('deployment.cleanup()'));
  assert.ok(source.includes('await deployFunction(def)'));
});
