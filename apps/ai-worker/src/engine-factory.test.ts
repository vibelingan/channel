import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { PUBLIC_KNOWLEDGE_SERVER, VibeKbEngine } from '@vibelingan-channel/ai-engine-vibekb';
import { engineFromEnvironment } from './worker.ts';

const publicKey = `kbpub_${'k'.repeat(40)}`;

const config: Record<string, string | undefined> = {
  AI_ENGINE_ID: 'vibekb',
  AI_MODEL_BASE_URL: 'https://model.example.invalid/v1',
  AI_MODEL_ID: 'deepseek/deepseek-v4-pro',
  AI_MODEL_API_KEY: 'dummy',
  AI_MODEL_THINKING_MODE: 'disabled',
  VIBEKB_MCP_URL: 'https://kb.example.invalid/mcp',
  VIBEKB_PUBLIC_API_KEY: publicKey,
  VIBEKB_MCP_ALLOW_LOOPBACK_HTTP: '0',
  AI_ENGINE_PROVENANCE_KIND: 'git',
  AI_ENGINE_GIT_COMMIT: 'a'.repeat(40),
  AI_ENGINE_GIT_REPOSITORY: 'vibelingan/channel',
  AI_ENGINE_CONFIG_DIGEST: `sha256:${'b'.repeat(64)}`,
  KB_API_KEY: undefined,
  KB_BASE_URL: undefined,
  KB_WORKSPACE_SLUG: undefined,
};
async function withConfig(values: typeof config, action: () => unknown) {
  const prior = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  const apply = (entries: typeof config) => {
    for (const [key, value] of Object.entries(entries)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(values);
  try {
    await action();
  } finally {
    apply(prior);
  }
}
test('runtime builds the VibeKB adapter from fixed server settings without legacy KB credentials', async () => {
  await withConfig(config, async () => {
    const engine = engineFromEnvironment();
    assert.ok(engine instanceof VibeKbEngine);
    assert.equal(engine.capabilities.engineId, 'vibekb');
    assert.deepEqual(await engine.attestKnowledgeCredential(), {
      credentialId: createHash('sha256').update(publicKey).digest('hex'),
      rotationCounter: 1,
      spaceId: PUBLIC_KNOWLEDGE_SERVER,
    });
  });
});
test('runtime rejects a missing or non-public knowledge key, unsafe MCP transport and invalid model controls', async () => {
  for (const patch of [
    { VIBEKB_PUBLIC_API_KEY: undefined },
    { VIBEKB_PUBLIC_API_KEY: '' },
    // A management key has no public prefix, however long it is.
    { VIBEKB_PUBLIC_API_KEY: 'm'.repeat(48) },
    { VIBEKB_PUBLIC_API_KEY: 'kbpub_short' },
    { VIBEKB_MCP_URL: 'http://remote.example.invalid/mcp' },
    { AI_MODEL_THINKING_MODE: 'maybe' },
    { AI_MODEL_API_KEY: '' },
  ])
    await withConfig({ ...config, ...patch }, () => assert.throws(engineFromEnvironment));
});
