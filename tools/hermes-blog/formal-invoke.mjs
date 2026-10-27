import { createBlogToolClient } from './client.mjs';
import { readPrivateJson } from './credential-file.mjs';
import { kbDraftRequest } from './kb-draft.mjs';
import { maintainCredentialFile } from './maintenance.mjs';

try {
  const args = process.argv.slice(2);
  if (
    args[0] !== '--credential' ||
    !args[1] ||
    args.length > 3 ||
    (args[2] && args[2] !== '--maintain')
  )
    throw Error('Fixed private invocation required');
  const state = await maintainCredentialFile(args[1]);
  if (args[2] === '--maintain') {
    console.log(
      JSON.stringify({ ok: true, expiresAt: state.expiresAt, rotateAfter: state.rotateAfter }),
    );
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
