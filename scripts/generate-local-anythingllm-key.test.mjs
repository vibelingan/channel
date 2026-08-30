import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractGeneratedApiKey, updateEnvText } from './generate-local-anythingllm-key.mjs';

test('extracts supported response shapes without printing a credential', () => {
  assert.equal(extractGeneratedApiKey({ apiKey: 'a'.repeat(32) }), 'a'.repeat(32));
  assert.equal(extractGeneratedApiKey({ apiKey: { token: 'b'.repeat(32) } }), 'b'.repeat(32));
  assert.throws(() => extractGeneratedApiKey({ ok: true }), /usable key/);
});

test('updates key and attestation together and refuses accidental rotation', () => {
  const key = 'local-test-key-that-is-long-enough';
  const next = updateEnvText('ANYTHINGLLM_API_KEY=\nAI_KNOWLEDGE_CREDENTIAL_ID=\n', key);
  assert.match(next, new RegExp(`^ANYTHINGLLM_API_KEY=${key}$`, 'm'));
  assert.match(next, /^AI_KNOWLEDGE_CREDENTIAL_ID=[0-9a-f]{16}$/m);
  assert.throws(() => updateEnvText(next, 'another-key-that-is-long-enough'), /--rotate/);
});
