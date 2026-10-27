import { spawn } from 'node:child_process';
import { dirname, isAbsolute, join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readPrivateJson } from './credential-file.mjs';
import { draftInput } from './input.mjs';

export async function createRelayServer(path) {
  if (!isAbsolute(path)) throw Error('Absolute relay configuration required');
  const { value: config } = await readPrivateJson(path);
  if (
    !['content', 'publisher'].includes(config.role) ||
    config.siteId !== 'supplychainsai.com' ||
    config.workspaceId !== 2
  )
    throw Error('Fixed relay role and workspace required');
  const server = new McpServer({ name: `channel-blog-${config.role}`, version: '1.0.0' });
  async function call(operation, value) {
    try {
      const result = await new Promise((resolve, reject) => {
        const child = spawn(
          '/usr/bin/python3',
          [join(dirname(path), 'relay.py'), '--config', path, '--operation', operation],
          {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: Object.fromEntries(
              ['HOME', 'PATH', 'LANG']
                .filter((key) => process.env[key])
                .map((key) => [key, process.env[key]]),
            ),
            timeout: 150000,
            killSignal: 'SIGTERM',
          },
        );
        let output = '';
        child.stderr.resume();
        child.stdout.on('data', (data) => {
          output += data;
          if (Buffer.byteLength(output) > 32768) child.kill();
        });
        child.once('error', reject);
        child.once('close', (code) => {
          try {
            if (code !== 0) throw Error('Relay result unconfirmed');
            resolve(JSON.parse(output));
          } catch (error) {
            reject(error);
          }
        });
        child.stdin.on('error', () => {});
        child.stdin.end(JSON.stringify(value));
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
        ...(result.ok === false ? { isError: true } : {}),
      };
    } catch {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: '网站草稿尚未确认，请保留已入库的文档编号；不要换编号或另建文章重试。',
          },
        ],
      };
    }
  }
  const document = z.object({ documentId: z.number().int().positive().safe() }).strict();
  if (config.role === 'content') {
    server.registerTool(
      'channel_blog_save_draft',
      {
        description:
          '客户明确要求网站 Blog 草稿时使用。固定存入 diversity 工作区并交给发布机保存网站私有草稿，返回真实编辑链接；不公开发布。同一篇重试保持原 slug 和正文。',
        inputSchema: z
          .object({
            article: draftInput.omit({ idempotencyKey: true, externalTaskId: true }).extend({
              slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
              format: z.literal('markdown'),
              body: z.string().max(131072),
              authorName: z.literal('Diversity Technology Limited'),
            }),
          })
          .strict(),
        annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      (args) => call('save', args),
    );
    server.registerTool(
      'channel_blog_submit_document',
      {
        description:
          '将已经入库 diversity 的指定文章交给发布机保存网站私有草稿。超时重试使用原 documentId，不重新入库。',
        inputSchema: document,
        annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      (args) => call('submit', args),
    );
  } else {
    server.registerTool(
      'channel_blog_create_draft',
      {
        description:
          '从 diversity 读取指定 VibeKB 文档，保存网站私有草稿。只接收真实文档编号，任务编号由程序生成，不公开。',
        inputSchema: document,
        annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      (args) => call('submit', args),
    );
    server.registerTool(
      'channel_blog_get_import',
      {
        description: '查询此连接自己保存的草稿。',
        inputSchema: z
          .object({ operationId: z.string().regex(/^article-import-[a-f0-9]{64}$/) })
          .strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      },
      (args) => call('get-import', args),
    );
  }
  return server;
}

if (process.env.CHANNEL_BLOG_RELAY_FILE) {
  try {
    await (await createRelayServer(process.env.CHANNEL_BLOG_RELAY_FILE)).connect(
      new StdioServerTransport(),
    );
  } catch {
    console.error('网站草稿专用连接未启动，请检查本机私有配置。');
    process.exitCode = 1;
  }
}
