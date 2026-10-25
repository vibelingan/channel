import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const json = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const pkg = await json('./package.json');
const lock = await json('./package-lock.json');
const cloudbase = await json('./node_modules/@cloudbase/cloudbase-mcp/package.json');
assert.equal(cloudbase.version, '2.36.1');
assert.equal(pkg.dependencies['@modelcontextprotocol/sdk'], '1.32.1');
assert.equal(lock.packages['node_modules/@modelcontextprotocol/sdk'].version, '1.32.1');
assert.equal(typeof Client, 'function');
assert.equal(typeof StdioClientTransport, 'function');
const client = new Client(
  { name: 'channel-tool-runtime-check', version: '1.0.0' },
  { capabilities: {} },
);
assert.equal(typeof client.connect, 'function');
// No process starts and no login, network or cloud-resource call occurs here.
console.log(
  JSON.stringify({
    cloudbase: cloudbase.version,
    mcpSdk: '1.32.1',
    client: 'ready',
    transport: 'ready',
  }),
);
