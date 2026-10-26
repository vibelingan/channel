import { mkdir, writeFile } from 'node:fs/promises';
import { connectBlogMcp } from './mcp-client.mjs';
const envId = 'diversity-123-d9grnqfux221323bb';
if (
  process.env.GITHUB_REPOSITORY !== 'vibelingan/channel' ||
  process.env.GITHUB_REF !== 'refs/heads/feat/seo-foundation' ||
  process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
  process.env.TCB_ENV_ID !== envId
)
  throw Error('Fixed read-only readiness target required');
import { safeFields } from './cloud-readiness-fields.mjs';
const client = await connectBlogMcp();
const report = {
  target: { envId, region: 'ap-shanghai', service: 'blog-pages' },
  checkedAt: new Date().toISOString(),
  cloudWrites: 0,
  queries: [],
};
try {
  for (const [name, tool, args] of [
    ['environment', 'queryEnv', { action: 'info', envId }],
    ['usage', 'queryEnv', { action: 'usage', envId }],
    [
      'package-metadata',
      'callCloudApi',
      {
        service: 'tcb',
        action: 'DescribeBaasPackageList',
        params: {
          EnvId: envId,
          PackageName: 'baas_pf_standard',
          Source: 'qcloud',
          EnvChannel: 'qc_console',
          TargetAction: 'renew',
        },
      },
    ],
    [
      'blog-service',
      'queryCloudRun',
      { action: 'detail', serverName: 'blog-pages', revealEnvParams: false },
    ],
    [
      'account-balance',
      'callCloudApi',
      { service: 'billing', action: 'DescribeAccountBalance', params: {} },
    ],
  ]) {
    try {
      const value = await client.call(tool, args);
      report.queries.push({ name, status: 'read', fields: safeFields(value) });
    } catch {
      report.queries.push({ name, status: 'unconfirmed' });
    }
  }
  await mkdir('output/cloud-readiness', { recursive: true });
  await writeFile('output/cloud-readiness/result.json', JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      target: report.target,
      cloudWrites: 0,
      queries: report.queries.map(({ name, status }) => ({ name, status })),
    }),
  );
} finally {
  await client.close();
}
