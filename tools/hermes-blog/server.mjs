import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BlogToolError } from './client.mjs';
const input = z
  .object({
    idempotencyKey: z
      .string()
      .regex(/^[A-Za-z0-9:_-]{1,128}$/)
      .describe('同一篇生成结果的稳定编号，重试不能更换。'),
    externalTaskId: z.string().min(1).max(200),
    title: z.string().min(1).max(200),
    slug: z.string().max(120).optional(),
    excerpt: z.string().max(500).optional(),
    authorName: z.string().max(120).optional(),
    seoTitle: z.string().max(200).optional(),
    seoDescription: z.string().max(320).optional(),
    format: z.enum(['markdown', 'article-json-v1']),
    body: z.union([
      z.string().max(131072),
      z.object({ schemaVersion: z.literal(1), document: z.record(z.unknown()) }).strict(),
    ]),
  })
  .strict();
export function createBlogMcpServer(client) {
  const server = new McpServer({ name: 'channel-blog-drafts', version: '0.1.0' });
  async function invoke(work) {
    try {
      const value = await work();
      return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
    } catch (e) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text:
              e instanceof BlogToolError
                ? e.message
                : '草稿保存尚未确认。保留原请求号和正文后再检查。',
          },
        ],
      };
    }
  }
  server.registerTool(
    'channel_blog_create_draft',
    {
      title: '保存网站草稿',
      description:
        '仅保存为私有草稿，不发布。同一篇生成结果重试必须使用相同请求号。图片由人补充，正文不支持HTML。',
      inputSchema: input,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    (args) => invoke(() => client.createDraft(args)),
  );
  server.registerTool(
    'channel_blog_get_import',
    {
      title: '查询草稿保存结果',
      description: '只查询此连接自己导入的草稿，不读取其他人的正文。',
      inputSchema: z
        .object({ operationId: z.string().regex(/^article-import-[a-f0-9]{64}$/) })
        .strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    (args) => invoke(() => client.getImport(args.operationId)),
  );
  return server;
}
