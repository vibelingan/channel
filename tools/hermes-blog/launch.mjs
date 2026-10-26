import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createBlogToolClient, readBlogToolConfig } from './client.mjs';
import { createBlogMcpServer } from './server.mjs';
try {
  const path = process.env.CHANNEL_BLOG_CREDENTIAL_FILE;
  if (!path || resolve(path) !== path) throw Error('Absolute private configuration required');
  const info = await stat(path);
  if (
    !info.isFile() ||
    info.size > 4096 ||
    (info.mode & 0o077) !== 0 ||
    (typeof process.getuid === 'function' && info.uid !== process.getuid())
  )
    throw Error('Private owned configuration required');
  const config = readBlogToolConfig(JSON.parse(await readFile(path, 'utf8')));
  await createBlogMcpServer(createBlogToolClient(config)).connect(new StdioServerTransport());
} catch {
  console.error('网站草稿工具未启动：请检查凭证文件路径、权限、有效期和配置。');
  process.exitCode = 1;
}
