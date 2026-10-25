import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { blogMcpEnvironment } from '../../scripts/blog/mcp-environment.mjs';
test('installed MCP SDK really forwards only the explicit CloudBase credentials to its child', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('./transport-child.mjs', import.meta.url))],
    env: blogMcpEnvironment({
      GITHUB_ACTIONS: 'true',
      TENCENTCLOUD_SECRETID: 'fixture-cloud-id',
      TENCENTCLOUD_SECRETKEY: 'fixture-cloud-key',
      TENCENTCLOUD_SESSIONTOKEN: 'fixture-session',
      GITHUB_TOKEN: 'fixture-do-not-forward',
      E2E_ADMIN_PASSWORD: 'fixture-do-not-forward',
    }),
    stderr: 'pipe',
  });
  transport.stderr?.resume();
  const client = new Client(
    { name: 'transport-contract-check', version: '1.0.0' },
    { capabilities: {} },
  );
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: 'environment-shape', arguments: {} });
    assert.deepEqual(JSON.parse(result.content[0].text), {
      idForwarded: true,
      keyForwarded: true,
      tokenForwarded: true,
      environment: 'diversity-123-d9grnqfux221323bb',
      region: 'ap-shanghai',
      githubTokenPresent: false,
      passwordPresent: false,
    });
  } finally {
    await client.close();
  }
});
test('the SDK default child does not inherit the parent credentials', async () => {
  const keys = ['TENCENTCLOUD_SECRETID', 'TENCENTCLOUD_SECRETKEY', 'CLOUDBASE_ENV_ID'];
  const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.TENCENTCLOUD_SECRETID = 'fixture-cloud-id';
  process.env.TENCENTCLOUD_SECRETKEY = 'fixture-cloud-key';
  process.env.CLOUDBASE_ENV_ID = 'fixture-parent-env';
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('./transport-child.mjs', import.meta.url))],
    stderr: 'pipe',
  });
  transport.stderr?.resume();
  const client = new Client(
    { name: 'transport-default-check', version: '1.0.0' },
    { capabilities: {} },
  );
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: 'environment-shape', arguments: {} });
    const shape = JSON.parse(result.content[0].text);
    assert.equal(shape.idForwarded, false);
    assert.equal(shape.keyForwarded, false);
    assert.equal(shape.environment, null);
  } finally {
    await client.close();
    for (const key of keys) {
      if (prior[key] === undefined) delete process.env[key];
      else process.env[key] = prior[key];
    }
  }
});
