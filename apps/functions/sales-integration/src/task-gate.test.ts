import assert from 'node:assert/strict';
import test from 'node:test';
import { setup } from './test-fixtures.ts';

test('a service credential without task authorization cannot read private inquiries', async () => {
  const s = await setup();
  const request = s.request();
  delete request.headers['x-sales-task'];
  delete request.headers['x-sales-lease'];
  assert.equal((await s.handler(request)).status, 403);
  assert.deepEqual(s.calls, []);
});

test('legacy inquiry without explicit ownership is not implicitly this installation', async () => {
  const s = await setup();
  const row: { _id: string; [key: string]: unknown } = { ...s.oem };
  delete row.client_id;
  delete row.business_line;
  delete row.source_installation_id;
  s.rows.set('oemProjects/oem_a', row);
  assert.equal((await s.handler(s.request())).status, 404);
});

test('the same customer cannot substitute another inquiry, task, run or lease', async () => {
  const s = await setup();
  assert.equal((await s.handler(s.request('/inquiries/oem/other_inquiry'))).status, 403);
  const base = JSON.parse(
    Buffer.from(String(s.request().headers['x-sales-task']), 'base64url').toString(),
  );
  for (const patch of [
    { task_id: 'other_task' },
    { run_id: 'old_run' },
    { task_revision: 0 },
    { task_revision: true },
    { protocol: 'sales-auth/9' },
    { admin: true },
  ]) {
    const request = s.request();
    request.headers['x-sales-task'] = Buffer.from(JSON.stringify({ ...base, ...patch })).toString(
      'base64url',
    );
    assert.equal((await s.handler(request)).status, 403);
  }
  const request = s.request();
  request.headers['x-sales-lease'] = s.authorization('product').token;
  assert.equal((await s.handler(request)).status, 403);
});

test('revoked lease, unverified task and wrong installation fail closed', async () => {
  for (const mutate of [
    (s: Awaited<ReturnType<typeof setup>>) => {
      s.authorization().lease.revoked = true;
    },
    (s: Awaited<ReturnType<typeof setup>>) => {
      s.authorization().handoff.state = 'revoked';
    },
    (s: Awaited<ReturnType<typeof setup>>) => {
      s.authorization().authority.mode = 'paused';
    },
    (s: Awaited<ReturnType<typeof setup>>) => {
      s.authorization().authority.source_verified = false;
    },
    (s: Awaited<ReturnType<typeof setup>>) => {
      s.dependencies.taskAccess.loadInstallation = async () => ({
        client_id: 'client_a',
        business_line: 'website_sales',
        source_installation_id: 'site_a',
        environment: 'test',
        cloud_env_id: 'other_environment',
        state: 'active',
      });
    },
  ]) {
    const s = await setup();
    mutate(s);
    assert.equal((await s.handler(s.request())).status, 403);
  }
});

test('missing OEM finalization is rejected even with a valid stored lease', async () => {
  const s = await setup();
  s.oem.salesSubmissionState = 'pending';
  assert.equal((await s.handler(s.request())).status, 403);
});

test('a trusted lease still cannot include an attachment outside its source inquiry', async () => {
  const s = await setup();
  s.authorization().lease.asset_refs.push('other_task_asset');
  assert.equal((await s.handler(s.request())).status, 403);
});

test('control outage or forged permit cannot release product data', async () => {
  for (const forged of [false, true]) {
    const s = await setup();
    s.setPermit(async () => {
      if (!forged) throw new Error('private-control-key');
      return {
        protocol: 'sales-auth/1',
        allowed: true,
        request_sha256: '0'.repeat(64),
        issued_at: 1700000000,
        expires_at: 1700000010,
      };
    });
    const request = s.request('/products/query');
    request.method = 'POST';
    request.headers['content-type'] = 'application/json';
    request.headers['x-sales-permit'] = 'model-claims-approved';
    request.body = Buffer.from('{"ids":[{"id":"product_a"}]}');
    const response = await s.handler(request);
    assert.equal(response.status, forged ? 403 : 503);
    assert.ok(!response.body.toString().includes('private-control-key'));
    assert.ok(!s.calls.some((call) => call.startsWith('product/')));
  }
});

test('revocation during a real reader discards its prepared result', async () => {
  const s = await setup();
  const read = s.dependencies.readApprovedProduct;
  s.dependencies.readApprovedProduct = async (...args) => {
    const result = await read(...args);
    s.authorization().authority.task_revision++;
    return result;
  };
  const request = s.request('/products/query');
  request.method = 'POST';
  request.headers['content-type'] = 'application/json';
  request.body = Buffer.from('{"ids":[{"id":"product_a"}]}');
  const response = await s.handler(request);
  assert.equal(response.status, 403);
  assert.ok(!response.body.toString().includes('Approved product'));
});

test('product lookup requires its own action while remaining a current approved query', async () => {
  const s = await setup();
  const request = s.request('/products/query');
  request.method = 'POST';
  request.headers['content-type'] = 'application/json';
  request.body = Buffer.from('{"ids":[{"id":"product_a"}]}');
  assert.equal((await s.handler(request)).status, 200);
  assert.ok(s.calls.includes('product/product_a/1/20/'));
  s.authorization().lease.allowed_actions = ['inquiry.read'];
  assert.equal((await s.handler(request)).status, 403);
});

test('attachment bytes are discarded if lease revokes during download', async () => {
  const s = await setup();
  const ref = s.authorization().lease.asset_refs[0];
  assert.ok(ref);
  const read = s.dependencies.readFile;
  s.dependencies.readFile = async (...args) => {
    const result = await read(...args);
    s.authorization().lease.revoked = true;
    return result;
  };
  const reply = await s.handler(s.request(`/assets/${ref}`));
  assert.equal(reply.status, 403);
  assert.ok(!reply.body.includes(s.pdf));
});

test('business closure blocks preparation even if the Hermes task still appears active', async () => {
  const s = await setup();
  s.rows.set('oemProjects/oem_a', { ...s.oem, status: 'closed' });
  const response = await s.handler(s.request());
  assert.equal(response.status, 403);
  assert.ok(!response.body.toString().includes('buyer@example.invalid'));
});

test('pause during source revalidation discards already prepared product data', async () => {
  const s = await setup();
  let prepared = false;
  const product = s.dependencies.readApprovedProduct;
  s.dependencies.readApprovedProduct = async (...args) => {
    const result = await product(...args);
    prepared = true;
    return result;
  };
  const read = s.dependencies.readDoc;
  s.dependencies.readDoc = async (...args) => {
    const result = await read(...args);
    if (prepared) s.authorization().authority.mode = 'paused';
    return result;
  };
  const request = s.request('/products/query');
  request.method = 'POST';
  request.headers['content-type'] = 'application/json';
  request.body = Buffer.from('{"ids":[{"id":"product_a"}]}');
  assert.equal((await s.handler(request)).status, 403);
});

test('lease revocation during the final remote permit check discards the result', async () => {
  const s = await setup();
  const permit = s.dependencies.taskAccess.fetchPermit;
  let calls = 0;
  s.dependencies.taskAccess.fetchPermit = async (request) => {
    const result = await permit(request);
    if (++calls === 2) s.authorization().lease.revoked = true;
    return result;
  };
  assert.equal((await s.handler(s.request())).status, 403);
});
