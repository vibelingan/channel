import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
for (const role of ['content', 'publisher']) {
  test(`standalone ${role} MCP bundle runs without source dependencies or website credentials`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'relay-standalone-'));
    const program = join(root, 'relay.mjs');
    const binding = join(root, 'binding.json');
    await copyFile(resolve('output/hermes-blog-bundle/channel-blog-relay.mjs'), program);
    await writeFile(
      binding,
      JSON.stringify({ role, siteId: 'supplychainsai.com', workspaceId: 2 }),
      { mode: 0o600 },
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [program],
      cwd: root,
      stderr: 'pipe',
      env: { CHANNEL_BLOG_RELAY_FILE: binding },
    });
    transport.stderr?.resume();
    const client = new Client({ name: 'relay-bundle-acceptance', version: '1' });
    t.after(async () => {
      await client.close();
      await rm(root, { recursive: true });
    });
    await client.connect(transport, { timeout: 10000 });
    const names = (await client.listTools()).tools.map((x) => x.name).sort();
    assert.deepEqual(
      names,
      role === 'content'
        ? ['channel_blog_attach_images', 'channel_blog_save_draft', 'channel_blog_submit_document']
        : ['channel_blog_create_draft', 'channel_blog_get_import'],
    );
  });
}
