import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { BlogToolError } from './client.mjs';
import { createBlogToolClient } from './client.mjs';
import { readPrivateJson } from './credential-file.mjs';
import { saveKbDocument } from './draft.mjs';
import { completeImageJob } from './image-client.mjs';
import { maintainCredentialFile } from './maintenance.mjs';
import { publishKbDocument } from './publication.mjs';

try {
  const args = process.argv.slice(2);
  if (
    args[0] !== '--credential' ||
    !args[1] ||
    args.length > 4 ||
    (args[2] &&
      !['--maintain', '--get-import', '--image-job', '--publication'].includes(args[2])) ||
    (args[2] === '--get-import'
      ? !/^article-import-[a-f0-9]{64}$/.test(args[3] ?? '')
      : args[2] === '--image-job'
        ? !args[3] || !isAbsolute(args[3])
        : args.length > 3)
  )
    throw Error('Fixed private invocation required');
  const state = await maintainCredentialFile(args[1]);
  if (args[2] === '--maintain') {
    console.log(
      JSON.stringify({
        ok: true,
        expiresAt: state.expiresAt,
        rotateAfter: state.rotateAfter,
      }),
    );
  } else if (args[2] === '--get-import') {
    console.log(JSON.stringify(await createBlogToolClient(state.config).getImport(args[3])));
  } else if (args[2] === '--image-job') {
    try {
      console.log(JSON.stringify(await completeImageJob(args[3], state.config)));
    } catch {
      const { value: job } = await readPrivateJson(args[3], 32768);
      if (!Number.isSafeInteger(job.documentId) || job.documentId <= 0)
        throw Error('Invalid image job');
      console.log(
        JSON.stringify({
          ok: false,
          state: 'images-incomplete',
          documentId: job.documentId,
          requestedImageCount: job.images.length,
          message:
            '图片结果尚未全部确认。请沿用原文档、文件、位置重试；如果后台已有人改稿，须核对后处理，不另建文章或覆盖原稿。',
        }),
      );
    }
  } else {
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 256000) throw Error('Article exceeds size limit');
      chunks.push(chunk);
    }
    const source = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
    );
    const privateFile = await readPrivateJson(args[1]);
    const binding = {
      siteId: 'supplychainsai.com',
      integrationId: state.config.integrationId,
      workspaceId: privateFile.value.CHANNEL_BLOG_KB_WORKSPACE,
    };
    const client = createBlogToolClient(state.config);
    if (args[2] === '--publication') {
      const input = z
        .object({
          documentId: z.number().int().positive().safe(),
          workspaceId: z.string(),
          article: z.record(z.unknown()),
          action: z.enum(['publish', 'withdraw', 'status']),
          approval: z.record(z.unknown()).optional(),
        })
        .strict()
        .parse(source);
      const selected = {
        documentId: input.documentId,
        workspaceId: input.workspaceId,
        article: input.article,
      };
      if (input.action === 'status') {
        const { kbImportOperation } = await import('./kb-draft.mjs');
        console.log(
          JSON.stringify(
            await client.getPublication(
              kbImportOperation(binding, input.documentId, input.workspaceId),
            ),
          ),
        );
      } else
        console.log(
          JSON.stringify(await publishKbDocument(client, binding, selected, input.approval)),
        );
    } else {
      console.log(JSON.stringify(await saveKbDocument(client, binding, source)));
    }
  }
} catch (error) {
  console.log(
    JSON.stringify({
      ok: false,
      state: 'operation-unconfirmed',
      ...(error instanceof BlogToolError && error.receipt ? error.receipt : {}),
      message:
        error instanceof BlogToolError
          ? error.message
          : '网站操作尚未确认，请保留原任务检查连接或凭证维护记录。',
    }),
  );
  process.exitCode = 1;
}
