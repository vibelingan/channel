import { writeFile } from 'node:fs/promises';
import { createBlogBridgeServer } from './bridge-http.mjs';
import { readBlogInvocation } from './invocation.mjs';
import { connectBlogMcp } from './mcp-client.mjs';
const port = Number(process.env.BLOG_DUMMY_BRIDGE_PORT);
if (
  !Number.isInteger(port) ||
  port < 1024 ||
  port > 65535 ||
  !process.env.BLOG_DUMMY_EXPECTED_SHA ||
  !process.env.BLOG_DUMMY_BRIDGE_READY_FILE
)
  throw new Error('Explicit owned bridge port, code SHA and readiness file required');
const mcp = await connectBlogMcp();
const invoke = async (payload) =>
  readBlogInvocation(
    await mcp.call('manageFunctions', {
      action: 'invokeFunction',
      functionName: 'seo-blog-dummy',
      params: payload,
    }),
  );
const health = await invoke({ action: 'health' });
if (
  health.data?.codeSha !== process.env.BLOG_DUMMY_EXPECTED_SHA ||
  health.data?.envId !== 'diversity-123-d9grnqfux221323bb'
) {
  await mcp.close();
  throw new Error('Dummy cloud code identity mismatch');
}
const server = createBlogBridgeServer({ invoke, adminOrigin: process.env.BLOG_DUMMY_ADMIN_ORIGIN });
server.listen(port, '127.0.0.1', async () => {
  await writeFile(
    process.env.BLOG_DUMMY_BRIDGE_READY_FILE,
    JSON.stringify({ port, codeSha: health.data.codeSha }),
    { flag: 'wx' },
  );
  console.log(
    `Isolated article bridge ready at 127.0.0.1:${port}; real CloudBase function verified.`,
  );
});
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => {
    server.close();
    void mcp.close().finally(() => process.exit(0));
  });
