import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { VibeKbEngine } from '@vibelingan-channel/ai-engine-vibekb';
import { engineFromEnvironment } from './worker.ts';

const config: Record<string, string | undefined> = {
  AI_ENGINE_ID: 'vibekb',
  AI_MODEL_BASE_URL: 'https://model.example.invalid/v1',
  AI_MODEL_ID: 'deepseek/deepseek-v4-pro',
  AI_MODEL_API_KEY: 'dummy',
  AI_MODEL_THINKING_MODE: 'disabled',
  VIBEKB_MCP_URL: 'https://kb.example.invalid/mcp',
  VIBEKB_MCP_API_KEY: 'dummy',
  VIBEKB_PUBLIC_WORKSPACE_ID: '2',
  VIBEKB_PUBLIC_DOCUMENT_IDS: '12',
  VIBEKB_PUBLIC_TAG: '对外公开',
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
      credentialId: createHash('sha256').update('dummy').digest('hex'),
      rotationCounter: 1,
      spaceId: '2',
    });
  });
});
test('runtime rejects missing public scope, unsafe MCP transport and invalid model controls', async () => {
  for (const patch of [
    { VIBEKB_PUBLIC_DOCUMENT_IDS: '' },
    { VIBEKB_PUBLIC_DOCUMENT_IDS: '12,NaN' },
    { VIBEKB_PUBLIC_WORKSPACE_ID: 'other' },
    { VIBEKB_MCP_URL: 'http://remote.example.invalid/mcp' },
    { AI_MODEL_THINKING_MODE: 'maybe' },
    { AI_MODEL_API_KEY: '' },
  ])
    await withConfig({ ...config, ...patch }, () => assert.throws(engineFromEnvironment));
});
