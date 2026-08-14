import { strict as assert } from 'node:assert';
import { createHash, createHmac } from 'node:crypto';
import test from 'node:test';
import { canonicalTopSignBase, signTopRequest, topTimestamp } from './alibaba-signature.ts';

// --- canonicalization --------------------------------------------------------

test('TOP base sorts by key and concatenates key+value with NO path prefix', () => {
  const base = canonicalTopSignBase({
    method: 'alibaba.icbu.product.list',
    app_key: '511630',
    v: '2.0',
    format: 'json',
  });
  // ASCII order: app_key, format, method, v — and nothing prepended.
  assert.equal(base, 'app_key511630formatjsonmethodalibaba.icbu.product.listv2.0');
  assert.equal(base.startsWith('/'), false, 'TOP has no API path in the base');
});

test('TOP base excludes sign, and excludes EMPTY values', () => {
  const base = canonicalTopSignBase({
    app_key: '511630',
    sign: 'SHOULD-NOT-APPEAR',
    empty: '',
    session: 'tok',
  });
  assert.equal(base, 'app_key511630sessiontok');
  assert.ok(!base.includes('SHOULD-NOT-APPEAR'));
  assert.ok(
    !base.includes('empty'),
    'an empty value would produce a signature the gateway rejects',
  );
});

// --- signature ---------------------------------------------------------------

test('sign_method=hmac is HMAC-MD5 over the base, uppercase hex', () => {
  const params = { app_key: '511630', method: 'taobao.top.auth.token.create', code: 'abc' };
  const expected = createHmac('md5', 'SECRET')
    .update(canonicalTopSignBase(params), 'utf8')
    .digest('hex')
    .toUpperCase();
  const actual = signTopRequest({ params, appSecret: 'SECRET' });
  assert.equal(actual, expected);
  assert.match(actual, /^[0-9A-F]{32}$/, 'MD5 is 32 uppercase hex chars');
});

test('sign_method=md5 wraps the base in the secret on BOTH sides', () => {
  const params = { app_key: '511630', v: '2.0' };
  const base = canonicalTopSignBase(params);
  const expected = createHash('md5')
    .update(`SECRET${base}SECRET`, 'utf8')
    .digest('hex')
    .toUpperCase();
  assert.equal(signTopRequest({ params, appSecret: 'SECRET', signMethod: 'md5' }), expected);
});

test('the signature is NOT the GOP HMAC-SHA256 shape', () => {
  const sig = signTopRequest({ params: { a: '1' }, appSecret: 'S' });
  assert.equal(sig.length, 32, 'HMAC-SHA256 would be 64 hex chars — that was the old protocol');
});

test('changing any signed parameter changes the signature', () => {
  const base = { app_key: '511630', method: 'alibaba.icbu.product.list', session: 'tok' };
  const a = signTopRequest({ params: base, appSecret: 'S' });
  const b = signTopRequest({ params: { ...base, session: 'tok2' }, appSecret: 'S' });
  assert.notEqual(a, b);
});

// --- timestamp ---------------------------------------------------------------

test('timestamp is yyyy-MM-dd HH:mm:ss in GMT+8, not UTC and not ISO', () => {
  // 2026-08-14T00:00:00Z is 08:00 on the same day in GMT+8.
  assert.equal(topTimestamp(Date.parse('2026-08-14T00:00:00.000Z')), '2026-08-14 08:00:00');
  // 16:00Z rolls over into the NEXT day in GMT+8 — the case a naive
  // UTC formatter gets wrong.
  assert.equal(topTimestamp(Date.parse('2026-08-14T16:00:00.000Z')), '2026-08-15 00:00:00');
  const stamp = topTimestamp(Date.parse('2026-01-05T01:02:03.000Z'));
  assert.equal(stamp, '2026-01-05 09:02:03', 'single digits are zero-padded');
  assert.ok(!stamp.includes('T') && !stamp.endsWith('Z'), 'not ISO');
});
