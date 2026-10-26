import assert from 'node:assert/strict';
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
test('the standalone production tool runs on the actual Node runtime with only its bundle and an owned private file', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'channel-hermes-bundle-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'secrets'), { mode: 0o700 });
  const file = join(dir, 'secrets/credential.json');
  const secret = 'a'.repeat(64);
  await writeFile(
    file,
    JSON.stringify({
      CHANNEL_BLOG_API_ORIGIN:
        'https://diversity-123-d9grnqfux221323bb-1443560658.ap-shanghai.app.tcloudbase.com',
      CHANNEL_BLOG_SITE_ORIGIN: 'https://supplychainsai.com',
      CHANNEL_BLOG_INTEGRATION_ID: 'hermes-wecom-supplychainsai',
      CHANNEL_BLOG_CREDENTIAL: `test.${secret}`,
    }),
    { mode: 0o600 },
  );
  await copyFile(
    resolve('output/hermes-blog-bundle/channel-blog-mcp.mjs'),
    join(dir, 'server.mjs'),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(dir, 'server.mjs')],
    env: { PATH: process.env.PATH, CHANNEL_BLOG_CREDENTIAL_FILE: file },
    stderr: 'pipe',
  });
  let errors = '';
  transport.stderr?.on('data', (chunk) => {
    errors += chunk;
  });
  const client = new Client({ name: 'production-package-check', version: '1' });
  t.after(() => client.close());
  await client.connect(transport, { timeout: 10000 });
  assert.deepEqual((await client.listTools()).tools.map((x) => x.name).sort(), [
    'channel_blog_create_draft',
    'channel_blog_get_import',
  ]);
  const denied = await client.callTool({
    name: 'channel_blog_create_draft',
    arguments: {
      idempotencyKey: 'one',
      externalTaskId: 'one',
      title: 'One',
      format: 'markdown',
      body: 'Body',
      publish: true,
    },
  });
  assert.equal(denied.isError, true);
  assert(!errors.includes(secret));
  await client.close();
  await chmod(file, 0o644);
  const unprotected = new Client({ name: 'private-file-check', version: '1' });
  const bad = new StdioClientTransport({
    command: process.execPath,
    args: [join(dir, 'server.mjs')],
    env: { PATH: process.env.PATH, CHANNEL_BLOG_CREDENTIAL_FILE: file },
    stderr: 'pipe',
  });
  bad.stderr?.resume();
  await assert.rejects(unprotected.connect(bad, { timeout: 10000 }));
  await unprotected.close();
});
