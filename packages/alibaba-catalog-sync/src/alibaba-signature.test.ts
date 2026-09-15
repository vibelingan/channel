import { strict as assert } from 'node:assert';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import {
  canonicalSignBase,
  canonicalTopSignBase,
  signGopRequest,
  signTopRequest,
} from './alibaba-signature.ts';

test('canonical base is apiPath + ASCII-sorted key/value concatenation', () => {
  const base = canonicalSignBase('/alibaba.icbu.product.list', {
    timestamp: '1722900000000',
    app_key: '511630',
    access_token: 'tok',
    page_size: '30',
  });
  assert.equal(
    base,
    '/alibaba.icbu.product.listaccess_tokentokapp_key511630page_size30timestamp1722900000000',
  );
});

test('sign param itself is excluded from the base', () => {
  const withSign = canonicalSignBase('/p', { a: '1', sign: 'SHOULD_NOT_APPEAR' });
  assert.equal(withSign, '/pa1');
});

test('golden vector: HMAC-SHA256 uppercase hex over the canonical base', () => {
  // Vector constructed per the documented algorithm; pins the implementation
  // against regressions. Live-gateway confirmation is the MIU 15 gate.
  const sign = signGopRequest({
    apiPath: '/alibaba.icbu.product.get',
    params: { app_key: '511630', timestamp: '1722900000000', sign_method: 'sha256' },
    appSecret: 'test-secret',
  });
  const expected = createHmac('sha256', 'test-secret')
    .update('/alibaba.icbu.product.getapp_key511630sign_methodsha256timestamp1722900000000', 'utf8')
    .digest('hex')
    .toUpperCase();
  assert.equal(sign, expected);
  // Hard-pinned literal so a canonicalization change cannot slip through by
  // recomputing both sides with the same bug upstream of HMAC.
  assert.equal(sign, 'D11A1E5E4CFB372CEB5F16E27BC738EBF152BE1E82BC00285A6BC3C0ED6A96B7');
});

test('deterministic for permuted param insertion order', () => {
  const a = signGopRequest({
    apiPath: '/x',
    params: { b: '2', a: '1', c: '3' },
    appSecret: 's',
  });
  const b = signGopRequest({
    apiPath: '/x',
    params: { c: '3', a: '1', b: '2' },
    appSecret: 's',
  });
  assert.equal(a, b);
});

test('rejects apiPath without leading slash', () => {
  assert.throws(() => signGopRequest({ apiPath: 'x', params: {}, appSecret: 's' }));
});

test('TOP signs sorted non-empty params without a path prefix', () => {
  const params = {
    method: 'alibaba.icbu.product.list',
    app_key: '511630',
    timestamp: '1722900000000',
    format: 'json',
    v: '2.0',
    sign_method: 'sha256',
    session: 'tok-123',
    page_size: '30',
    ignored: '',
  };
  assert.equal(
    canonicalTopSignBase(params),
    'app_key511630formatjsonmethodalibaba.icbu.product.listpage_size30sessiontok-123sign_methodsha256timestamp1722900000000v2.0',
  );
  assert.equal(
    signTopRequest({ params, appSecret: 'secret' }),
    'C394D67DA43DDA765722730925EAFD3A96085531A1422D32FBD9B64FBC6D41BE',
  );
});
