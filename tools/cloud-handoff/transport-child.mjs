import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
const server = new McpServer({ name: 'transport-contract-fixture', version: '1.0.0' });
server.registerTool('environment-shape', { inputSchema: {} }, async () => ({
  content: [
    {
      type: 'text',
      text: JSON.stringify({
        idForwarded: process.env.TENCENTCLOUD_SECRETID === 'fixture-cloud-id',
        keyForwarded: process.env.TENCENTCLOUD_SECRETKEY === 'fixture-cloud-key',
        tokenForwarded: process.env.TENCENTCLOUD_SESSIONTOKEN === 'fixture-session',
        environment: process.env.CLOUDBASE_ENV_ID ?? null,
        region: process.env.TCB_REGION ?? null,
        githubTokenPresent: Boolean(process.env.GITHUB_TOKEN),
        passwordPresent: Boolean(process.env.E2E_ADMIN_PASSWORD),
      }),
    },
  ],
}));
await server.connect(new StdioServerTransport());
