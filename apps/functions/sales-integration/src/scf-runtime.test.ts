import assert from 'node:assert/strict';
import test from 'node:test';
import { createScfSalesHandler } from './index.ts';
const platform = (id: string) => ({
  'x-scf-name': 'sales-integration',
  'x-scf-namespace': 'test-env',
  'x-scf-request-id': id,
  'x-scf-secret-id': `secret-${id}`,
  'x-scf-secret-key': `key-${id}`,
  'x-scf-session-token': `session-${id}`,
  'x-sales-authorization': `Bearer ${'a'.repeat(48)}`,
  authorization: 'TC3-HMAC-SHA256 platform-signature',
});
test('SCF requests use distinct credentials and preserve business authorization without global mutation', async () => {
  const prior = { enabled: process.env.SALES_INTEGRATION_ENABLED, env: process.env.TCB_ENV };
  process.env.SALES_INTEGRATION_ENABLED = '1';
  process.env.TCB_ENV = 'test-env';
  const envBefore = JSON.stringify(process.env);
  const received: string[] = [];
  try {
    const handler = createScfSalesHandler((identity) => async (request) => {
      await new Promise((resolve) => setTimeout(resolve, identity.secretId.endsWith('a') ? 10 : 1));
      assert.equal(request.headers.authorization, `Bearer ${'a'.repeat(48)}`);
      assert.equal(request.headers['x-sales-authorization'], undefined);
      received.push(identity.secretId);
      return { status: 200, headers: {}, body: Buffer.from(identity.secretId) };
    });
    const [a, b] = await Promise.all(
      ['a', 'b'].map((id) =>
        handler({ method: 'POST', url: '/', headers: platform(id), body: Buffer.from('{}') }),
      ),
    );
    assert.ok(a);
    assert.ok(b);
    assert.equal(a.body.toString(), 'secret-a');
    assert.equal(b.body.toString(), 'secret-b');
    assert.equal(received.length, 2);
    assert.equal(JSON.stringify(process.env), envBefore);
    for (const headers of [
      { ...platform('a'), 'x-scf-session-token': undefined },
      { ...platform('a'), 'x-scf-name': 'other' },
      { ...platform('a'), 'x-scf-namespace': 'other' },
      { ...platform('a'), 'x-scf-secret-id': ['a', 'b'] },
    ]) {
      assert.equal((await handler({ method: 'POST', url: '/', headers })).status, 503);
    }
    assert.equal(received.length, 2);
    assert.equal(
      (
        await handler({
          method: 'POST',
          url: '/',
          headers: { ...platform('a'), 'x-sales-authorization': ['a', 'b'] },
        })
      ).status,
      401,
    );
  } finally {
    for (const [key, value] of Object.entries({
      SALES_INTEGRATION_ENABLED: prior.enabled,
      TCB_ENV: prior.env,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
