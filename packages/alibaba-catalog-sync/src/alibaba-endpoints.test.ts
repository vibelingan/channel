import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  DEFAULT_ALIBABA_ENDPOINTS,
  buildAuthorizeUrl,
  resolveAlibabaEndpoints,
} from './alibaba-endpoints.ts';

test('defaults apply with empty env', () => {
  const result = resolveAlibabaEndpoints({});
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.endpoints, DEFAULT_ALIBABA_ENDPOINTS);
});

test('valid alibaba.com overrides apply', () => {
  const result = resolveAlibabaEndpoints({
    ALI_AUTHORIZE_BASE_URL: 'https://other-auth.alibaba.com/oauth/authorize',
    ALI_API_BASE_URL: 'https://other-api.alibaba.com/rest/',
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(
      result.endpoints.authorizeBaseUrl,
      'https://other-auth.alibaba.com/oauth/authorize',
    );
    // trailing slash trimmed so path concatenation stays canonical
    assert.equal(result.endpoints.apiBaseUrl, 'https://other-api.alibaba.com/rest');
  }
});

test('rejects non-https, non-alibaba, and malformed overrides', () => {
  assert.equal(
    resolveAlibabaEndpoints({ ALI_API_BASE_URL: 'http://openapi-api.alibaba.com/rest' }).ok,
    false,
  );
  assert.equal(
    resolveAlibabaEndpoints({ ALI_API_BASE_URL: 'https://evil.example.com/rest' }).ok,
    false,
  );
  assert.equal(
    resolveAlibabaEndpoints({ ALI_API_BASE_URL: 'https://notalibaba.com/rest' }).ok,
    false,
  );
  assert.equal(resolveAlibabaEndpoints({ ALI_AUTHORIZE_BASE_URL: '::not a url::' }).ok, false);
});

test('suffix check is dot-anchored (no evil-alibaba.com bypass)', () => {
  assert.equal(
    resolveAlibabaEndpoints({ ALI_API_BASE_URL: 'https://evilalibaba.com/rest' }).ok,
    false,
  );
});

test('the default authorize host is the NEW open-api domain, not the old one', () => {
  // The whole `param-appkey.not.exists` incident was this hostname. The old
  // host still answers and still redirects to login, so a smoke test that only
  // checks "did we reach Alibaba" cannot catch a regression here.
  assert.equal(
    DEFAULT_ALIBABA_ENDPOINTS.authorizeBaseUrl,
    'https://open-api.alibaba.com/oauth/authorize',
  );
  assert.equal(DEFAULT_ALIBABA_ENDPOINTS.apiBaseUrl, 'https://open-api.alibaba.com/rest');
  for (const value of Object.values(DEFAULT_ALIBABA_ENDPOINTS)) {
    assert.ok(!value.includes('oauth.alibaba.com'), 'oauth.alibaba.com is the RETIRED host');
    assert.ok(
      !value.includes('openapi-api.alibaba.com'),
      'openapi-api.alibaba.com is a different host that rejects every key',
    );
    assert.ok(!value.includes('eco.taobao.com'), 'this app is not on the TOP platform');
  }
});

test('buildAuthorizeUrl sends the 2026-08-31 support shape PLUS required state', () => {
  // Named precisely: this is NOT "every parameter support ever supplied" — the
  // previous name said that while the code sent a union of two conflicting
  // replies, and that union failed a real merchant test.
  const url = buildAuthorizeUrl(DEFAULT_ALIBABA_ENDPOINTS, {
    appKey: '511630',
    redirectUri: 'https://supplychainsai.com/api/alibaba-catalog-sync/oauth/callback',
    state: 'abc123',
  });
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, 'https://open-api.alibaba.com/oauth/authorize');

  // EXACT key set — a new parameter must be a deliberate change, not a drift.
  assert.deepEqual([...parsed.searchParams.keys()].sort(), [
    'client_id',
    'force_auth',
    'redirect_uri',
    'response_type',
    'state',
  ]);

  assert.equal(parsed.searchParams.get('response_type'), 'code');
  assert.equal(parsed.searchParams.get('client_id'), '511630');
  assert.equal(
    parsed.searchParams.get('redirect_uri'),
    'https://supplychainsai.com/api/alibaba-catalog-sync/oauth/callback',
  );
  assert.equal(parsed.searchParams.get('force_auth'), 'true');
  assert.equal(parsed.searchParams.get('state'), 'abc123');

  // Each absence is a specific failed hypothesis; naming them stops a revert.
  assert.equal(parsed.searchParams.get('sp'), null, 'sp shapes failed merchant tests twice');
  assert.equal(parsed.searchParams.get('State'), null, 'duplicate casing was the original bug');
  assert.equal(parsed.searchParams.get('view'), null, 'not in any support reply');
  assert.equal(parsed.searchParams.get('force_login'), null, 'no support evidence');
});
