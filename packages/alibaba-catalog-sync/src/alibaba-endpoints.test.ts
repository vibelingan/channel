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

test('the confirmed ICBU authorize host is the default', () => {
  assert.equal(DEFAULT_ALIBABA_ENDPOINTS.authorizeBaseUrl, 'https://oauth.alibaba.com/authorize');
});

test('buildAuthorizeUrl carries the ICBU OAuth params and encodes the redirect', () => {
  const url = buildAuthorizeUrl(DEFAULT_ALIBABA_ENDPOINTS, {
    appKey: '511630',
    redirectUri: 'https://env-id.service.tcloudbase.com/api/alibaba-catalog-sync/oauth/callback',
    state: 'abc123',
  });
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, DEFAULT_ALIBABA_ENDPOINTS.authorizeBaseUrl);
  assert.equal(parsed.searchParams.get('response_type'), 'code');
  assert.equal(parsed.searchParams.get('client_id'), '511630');
  assert.equal(
    parsed.searchParams.get('redirect_uri'),
    'https://env-id.service.tcloudbase.com/api/alibaba-catalog-sync/oauth/callback',
  );
  // Both state casings ride the request (the official example sends State=,
  // the callback returns state=); the platform selector pins Alibaba.com.
  assert.equal(parsed.searchParams.get('state'), 'abc123');
  assert.equal(parsed.searchParams.get('State'), 'abc123');
  assert.equal(parsed.searchParams.get('sp'), 'ICBU');
  assert.equal(parsed.searchParams.get('view'), 'web');
});
