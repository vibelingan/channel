import assert from 'node:assert/strict';
import test from 'node:test';
import { readAdminRuntimeVersion, readFunctionRuntimeVersion } from './blog/runtime-health.mjs';
const sha = 'a'.repeat(40);
const response = (service) => ({
  status: 200,
  body: Buffer.from(JSON.stringify({ ok: true, data: { service, status: 'ok', releaseId: sha } })),
});
test('read running versions through the actual distinct admin and public HTTP entry contracts', async () => {
  const calls = [];
  const request = async (method, url, options) => {
    calls.push({ method, url, options });
    return response(method === 'POST' ? 'admin' : 'public-api');
  };
  assert.equal(await readAdminRuntimeVersion('reviewed-env', request), sha);
  assert.equal(await readFunctionRuntimeVersion('reviewed-env', 'public-api', request), sha);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, 'https://reviewed-env.service.tcloudbase.com/api/admin');
  assert.deepEqual(JSON.parse(calls[0].options.body), { action: 'health' });
  assert.equal(calls[1].method, 'GET');
  assert.equal(calls[1].url, 'https://reviewed-env.service.tcloudbase.com/api/health');
  assert.equal(calls[1].options.body, undefined);
});
test('a wrong service, local version, bad environment or unplanned function cannot verify a deployment', async () => {
  await assert.rejects(
    readFunctionRuntimeVersion('reviewed-env', 'public-api', async () => response('admin')),
  );
  await assert.rejects(readFunctionRuntimeVersion('../another', 'admin'));
  await assert.rejects(readFunctionRuntimeVersion('reviewed-env', 'alibaba-catalog-sync'));
  await assert.rejects(
    readFunctionRuntimeVersion('reviewed-env', 'admin', async () => ({
      status: 200,
      body: Buffer.from(
        JSON.stringify({ ok: true, data: { service: 'admin', status: 'ok', releaseId: 'local' } }),
      ),
    })),
  );
});
