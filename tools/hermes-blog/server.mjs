import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BlogToolError } from './client.mjs';
import { draftInput as input } from './input.mjs';
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
