import assert from 'node:assert/strict';
import test from 'node:test';
import { formalRegistration, FORMAL_BLOG as p } from './formal-policy.mjs';
test('formal initialization is fixed to one owned integration and creates a separate due maintenance policy', () => {
  const input = { keyId: p.keyId, integrationId: p.integrationId, keyDigest: 'f'.repeat(64) };
  const now = Date.now();
  const value = formalRegistration(input, now);
  assert.equal(Date.parse(value.key.expiresAt) - now, 90 * 86400000);
  assert.equal(Date.parse(value.policy.rotateAfter), now);
  assert.equal(value.key.configRevision, 1);
  assert.equal(value.policy._id, `managed-${p.keyId}`);
  for (const changed of [
    { ...input, keyId: 'another-app' },
    { ...input, integrationId: 'another-site' },
    { ...input, enabled: true },
    { ...input, keyDigest: '' },
  ])
    assert.throws(() => formalRegistration(changed, now));
});
