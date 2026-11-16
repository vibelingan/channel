import assert from 'node:assert/strict';
import test from 'node:test';
import { createScfCamFetch, scfCamHeaders, scfRuntimeCredential } from './index.ts';
const base = 'https://1443560658-example.ap-shanghai.tencentscf.com';
const credential = { secretId: 'AKIDEXAMPLE', secretKey: 'public-fixture-secret-key' };
test('TC3 vector agrees with independent Python signer and binds path and payload', () => {
  const url = `${base}/api/integrations/sales/source-grants`;
  const signed = scfCamHeaders(
    url,
    'POST',
    '{"hello":"world"}',
    credential,
    '100049822712',
    1700000000,
  );
  assert.ok(
    signed.Authorization?.endsWith(
      'Signature=c9aff80c51c019f2cecdb5660875829f3359bb28532625b00e9342fdf163fb61',
    ),
  );
  assert.notEqual(
    signed.Authorization,
    scfCamHeaders(url, 'POST', '{}', credential, '100049822712', 1700000000).Authorization,
  );
  assert.notEqual(
    signed.Authorization,
    scfCamHeaders(
      `${base}/other`,
      'POST',
      '{"hello":"world"}',
      credential,
      '100049822712',
      1700000000,
    ).Authorization,
  );
  assert.equal(signed['X-Scf-Cam-Timestamp'], '1700000000');
  assert.equal(
    scfCamHeaders(
      url,
      'POST',
      '{}',
      { ...credential, sessionToken: 'session-fixture' },
      '100049822712',
      1700000000,
    )['X-Scf-Cam-Token'],
    'session-fixture',
  );
});
test('application credential is separate and neither credential follows a changed destination', async () => {
  const sent: RequestInit[] = [];
  const wrapped = createScfCamFetch(base, credential, '100049822712', async (_input, init) => {
    assert.ok(init);
    sent.push(init);
    return new Response('{}');
  });
  const init = {
    method: 'POST',
    body: '{}',
    headers: { Authorization: `Bearer ${'a'.repeat(48)}` },
  };
  await wrapped(`${base}/api/integrations/sales/assistant-inquiries`, init);
  const headers = new Headers(sent[0]?.headers);
  assert.match(headers.get('authorization') ?? '', /^TC3-HMAC-SHA256 /);
  assert.equal(headers.get('x-sales-authorization'), init.headers.Authorization);
  assert.equal(sent[0]?.redirect, 'error');
  for (const url of [
    'http://localhost/a',
    'https://other.ap-shanghai.tencentscf.com/a',
    `${base}/a?x=1`,
    `${base}/a#x`,
  ])
    await assert.rejects(() => wrapped(url, init));
  assert.equal(sent.length, 1);
  assert.throws(() => createScfCamFetch(base, { secretId: '', secretKey: '' }, '100049822712'));
});
test('runtime credentials require all single-valued platform fields and the fixed function', () => {
  const context = {
    'x-scf-name': 'f',
    'x-scf-namespace': 'e',
    'x-scf-request-id': 'r',
    'x-scf-secret-id': 'id',
    'x-scf-secret-key': 'key',
    'x-scf-session-token': 'token',
  };
  assert.deepEqual(scfRuntimeCredential(context, { name: 'f', namespace: 'e' }), {
    secretId: 'id',
    secretKey: 'key',
    sessionToken: 'token',
  });
  assert.throws(() =>
    scfRuntimeCredential(
      { ...context, 'x-scf-secret-id': ['one', 'two'] },
      { name: 'f', namespace: 'e' },
    ),
  );
  assert.throws(() =>
    scfRuntimeCredential(
      { ...context, 'x-scf-session-token': undefined },
      { name: 'f', namespace: 'e' },
    ),
  );
  assert.throws(() => scfRuntimeCredential(context, { name: 'other', namespace: 'e' }));
});
