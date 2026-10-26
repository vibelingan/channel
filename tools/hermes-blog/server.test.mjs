import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createBlogMcpServer } from './server.mjs';
test('the real MCP protocol exposes only two draft tools and rejects publication flags before client calls', async (t) => {
  const calls = [];
  const server = createBlogMcpServer({
    createDraft: async (input) => {
      calls.push(input);
      return { state: 'ready', editUrl: 'https://supplychainsai.com/admin/' };
    },
    getImport: async () => ({ state: 'ready' }),
  });
  const client = new Client({ name: 'isolated-protocol-test', version: '1' });
  const [one, two] = InMemoryTransport.createLinkedPair();
  await server.connect(one);
  await client.connect(two);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((t) => t.name).sort(), [
    'channel_blog_create_draft',
    'channel_blog_get_import',
  ]);
  const input = {
    idempotencyKey: 'task-1',
    externalTaskId: 'task-1',
    title: 'Draft',
    format: 'markdown',
    body: 'A private draft',
  };
  const rejected = await client.callTool({
    name: 'channel_blog_create_draft',
    arguments: { ...input, publish: true },
  });
  assert.equal(rejected.isError, true);
  assert.equal(calls.length, 0);
  const saved = await client.callTool({ name: 'channel_blog_create_draft', arguments: input });
  assert.notEqual(saved.isError, true);
  assert.equal(calls.length, 1);
});
