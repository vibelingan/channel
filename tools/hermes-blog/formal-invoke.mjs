import { isAbsolute } from 'node:path';
import { createBlogToolClient } from './client.mjs';
import { readPrivateJson } from './credential-file.mjs';
import { completeImageJob } from './image-client.mjs';
import { kbDraftRequest } from './kb-draft.mjs';
import { maintainCredentialFile } from './maintenance.mjs';

try {
  const args = process.argv.slice(2);
  if (
    args[0] !== '--credential' ||
    !args[1] ||
    args.length > 4 ||
    (args[2] && !['--maintain', '--get-import', '--image-job'].includes(args[2])) ||
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
      JSON.stringify({ ok: true, expiresAt: state.expiresAt, rotateAfter: state.rotateAfter }),
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
    const input = kbDraftRequest(
      {
        siteId: 'supplychainsai.com',
        integrationId: state.config.integrationId,
        workspaceId: privateFile.value.CHANNEL_BLOG_KB_WORKSPACE,
      },
      source,
    );
    const client = createBlogToolClient(state.config);
    const created = await client.createDraft(input);
    const confirmed = await client.getImport(created.operationId);
    console.log(JSON.stringify(confirmed));
  }
} catch {
  console.error('网站草稿操作尚未确认，请保留原任务检查连接或凭证维护记录。');
  process.exitCode = 1;
}
