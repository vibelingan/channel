import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { blogMcpEnvironment } from './mcp-environment.mjs';
const requireTools = createRequire(
  new URL('../../tools/cloud-handoff/package.json', import.meta.url),
);
export async function connectBlogMcp() {
  const { Client } = await import(
    pathToFileURL(requireTools.resolve('@modelcontextprotocol/sdk/client/index.js')).href
  );
  const { StdioClientTransport } = await import(
    pathToFileURL(requireTools.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href
  );
  const packageFile = new URL(
    '../../tools/cloud-handoff/node_modules/@cloudbase/cloudbase-mcp/package.json',
    import.meta.url,
  );
  const meta = JSON.parse(readFileSync(packageFile, 'utf8'));
  if (meta.version !== '2.36.1') throw new Error('Pinned CloudBase MCP version mismatch');
  const packagePath = dirname(fileURLToPath(packageFile));
  const bin = typeof meta.bin === 'string' ? meta.bin : meta.bin['cloudbase-mcp'];
  if (typeof bin !== 'string') throw new Error('Pinned CloudBase MCP binary missing');
  const client = new Client(
    { name: 'channel-blog-isolated-test', version: '1.0.0' },
    { capabilities: {} },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(packagePath, bin)],
    stderr: 'pipe',
    env: blogMcpEnvironment(process.env),
  });
  transport.stderr?.resume();
  try {
    await client.connect(transport, { timeout: 60000 });
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
  async function call(name, args) {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
    const block = result.content?.find((item) => item.type === 'text');
    if (!block) throw new Error('CloudBase MCP returned no structured response');
    const value = JSON.parse(block.text);
    if (result.isError || value.success === false || value.ok === false)
      throw new Error(
        `${name}: ${String(value.code ?? 'unconfirmed')}: ${String(
          value.message ?? 'CloudBase did not confirm success',
        )
          .replace(/[a-f0-9]{64}/g, '[redacted hash]')
          .replace(/eyJ[A-Za-z0-9_.-]+/g, '[redacted session]')}`,
      );
    return value;
  }
  let status;
  try {
    status = await call('auth', { action: 'status' });
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
  if (
    status.auth_status !== 'READY' ||
    status.current_env_id !== 'diversity-123-d9grnqfux221323bb' ||
    status.current_region !== 'ap-shanghai'
  ) {
    await client.close();
    throw new Error(
      `CloudBase target not confirmed: ${JSON.stringify({ auth: status.auth_status, envId: status.current_env_id, region: status.current_region })}`,
    );
  }
  return {
    call,
    async describe(name) {
      const list = await client.listTools();
      const tool = list.tools.find((tool) => tool.name === name);
      if (!tool) throw new Error('CloudBase tool is not available');
      return tool.inputSchema;
    },
    close: () => client.close(),
  };
}
