import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRelayServer } from './relay-launch.mjs';

for (const role of ['content', 'publisher']) {
  test(`real MCP ${role} tools expose only the fixed role and reject arbitrary workspace and publication`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'channel-relay-protocol-'));
    const config = join(root, 'binding.json');
    await writeFile(
      config,
      JSON.stringify({ role, siteId: 'supplychainsai.com', workspaceId: 2 }),
      { mode: 0o600 },
    );
    const server = await createRelayServer(config);
    const client = new Client({ name: 'relay-protocol-acceptance', version: '1' });
    const [one, two] = InMemoryTransport.createLinkedPair();
    await server.connect(one);
    await client.connect(two);
    t.after(async () => {
      await client.close();
      await server.close();
      await rm(root, { recursive: true });
    });
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((x) => x.name).sort(),
      role === 'content'
        ? ['channel_blog_attach_images', 'channel_blog_save_draft', 'channel_blog_submit_document']
        : ['channel_blog_create_draft', 'channel_blog_get_import'],
    );
    const name = role === 'content' ? 'channel_blog_submit_document' : 'channel_blog_create_draft';
    for (const arguments_ of [
      { documentId: 201, workspaceId: 1 },
      { documentId: 201, publish: true },
      { documentId: '201' },
    ]) {
      const result = await client.callTool({ name, arguments: arguments_ });
      assert.equal(result.isError, true);
    }
  });
}
