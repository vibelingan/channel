/** LOCAL ONLY: actual intake/save/source code, local transaction substitute. No external senders. */
import { readFile, rename, writeFile } from 'node:fs/promises';
import { createAssistantInquiryStore } from '../../../../packages/db/src/assistant-inquiry.ts';
import { createSalesTestDatabase } from '../../../../packages/db/src/testing/sales-database.ts';
import { createAssistantIntake } from '../src/assistant-intake.ts';
import { createSalesServer } from '../src/server.ts';
const token = process.env.ASSISTANT_FIXTURE_TOKEN;
const file = process.env.ASSISTANT_FIXTURE_FILE;
if (!token || !file) throw new Error('Local fixture requires dedicated token and state file');
const scope = {
  client_id: 'local_fixture',
  business_line: 'website_sales',
  source_installation_id: 'local_website',
  environment: 'test' as const,
  cloud_env_id: 'local_fixture_only',
  cutover_at: 1700000000,
};
const { cutover_at: _cutover, ...installation } = scope;
let initial: Record<string, Record<string, unknown>>;
try {
  initial = JSON.parse(await readFile(file, 'utf8'));
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  initial = {
    'channelSalesInstallations/local_website': { record: { ...installation, state: 'active' } },
  };
}
const fixture = createSalesTestDatabase(initial, async (rows) => {
  await writeFile(`${file}.tmp`, JSON.stringify(rows), { mode: 0o600 });
  await rename(`${file}.tmp`, file);
});
const intake = createAssistantIntake(
  createAssistantInquiryStore(fixture.db, scope, async (id) => {
    const response = await fetch(`http://127.0.0.1:62383/api/products/${encodeURIComponent(id)}`, {
      redirect: 'error',
      signal: AbortSignal.timeout(3000),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error('Fixture catalog unavailable');
    const data = (await response.json()) as { data: { _id: string; name: string } };
    return { productId: data.data._id, productName: data.data.name, revision: 'local-r1' };
  }),
  token,
);
const server = createSalesServer(async (request) => {
  if (request.url === '/__fixture/ready')
    return {
      status: request.headers.authorization === `Bearer ${token}` ? 200 : 401,
      headers: { 'Content-Type': 'application/json' },
      body: Buffer.from(JSON.stringify({ fixtureId: process.env.ASSISTANT_FIXTURE_ID })),
    };
  // Loopback test observation only; this endpoint is not in the production runtime.
  if (request.url === '/__fixture/state')
    return {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: Buffer.from(JSON.stringify(fixture.snapshot())),
    };
  if (request.url !== '/api/integrations/sales/assistant-inquiries')
    return { status: 404, headers: {}, body: Buffer.from('{}') };
  return intake(request);
});
server.listen(62384, '127.0.0.1');
const shutdown = () => {
  server.closeAllConnections();
  server.close();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
