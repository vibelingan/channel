/** Opt-in live protocol probe; SSH preserves server-side credentials. */
import { createHash } from 'node:crypto';
import { VibeKbEngine } from '../packages/ai-engine-vibekb/src/index.ts';
import { sshAccess } from './assistant-ssh-fetch.ts';
const access = sshAccess(
  process.env.ASSISTANT_SSH_CONFIG ?? '',
  process.env.ASSISTANT_SSH_HOST ?? '',
);
const metadata = await access.install();
console.log(
  JSON.stringify({
    phase: 'connected',
    model: metadata.model,
    workspace: metadata.workspace_id,
    public_document_ids: metadata.public_document_ids,
  }),
);
const engine = new VibeKbEngine({
  modelBaseUrl: 'https://model.ssh.invalid/v1',
  model: metadata.model,
  modelApiKey: 'ssh',
  thinkingMode: 'disabled',
  fetch: access.fetch,
  knowledge: {
    url: metadata.mcp,
    apiKey: 'ssh',
    workspaceId: metadata.workspace_id,
    publicDocumentIds: metadata.public_document_ids,
    publicTag: '对外公开',
    sourcePrefix: 'channelkb',
    fetch: access.fetch,
    allowLocalHttp: true,
  },
  provenance: {
    kind: 'git',
    commit: process.env.ASSISTANT_SOURCE_COMMIT ?? '',
    repository: 'vibelingan/channel',
    configDigest: `sha256:${createHash('sha256').update(JSON.stringify(metadata)).digest('hex')}`,
  },
});
console.log(JSON.stringify({ phase: 'knowledge', result: await engine.verifyKnowledge() }));
for (const message of [
  '请介绍一下你们公司，主要提供什么服务？',
  'We need wireless headphones for 500 employee gifts. Please show some product options.',
]) {
  const h = await engine.createRun(
    {
      operationId: crypto.randomUUID(),
      conversationRef: crypto.randomUUID(),
      locale: 'en',
      profileId: 'channel-products-v1',
      turns: [{ role: 'visitor', text: message }],
      limits: { maxDeliveredOutputUnits: 4096, maxStreamDurationMs: 120000, maxToolCalls: 8 },
    },
    new AbortController().signal,
  );
  for await (const event of engine.streamRun(h, new AbortController().signal))
    console.log(JSON.stringify({ phase: 'model_result', question: message, event }));
}
