import { createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const directory = resolve(process.argv[2] ?? '');
if (!process.argv[2] || directory === process.cwd())
  throw Error('Explicit private directory required');
await mkdir(directory, { mode: 0o700 });
const secret = randomBytes(32).toString('hex');
const config = {
  CHANNEL_BLOG_API_ORIGIN:
    'https://diversity-123-d9grnqfux221323bb-1443560658.ap-shanghai.app.tcloudbase.com',
  CHANNEL_BLOG_SITE_ORIGIN: 'https://supplychainsai.com',
  CHANNEL_BLOG_INTEGRATION_ID: 'hermes-wecom-supplychainsai',
  CHANNEL_BLOG_TASK_ID: 'wecom-oem-enquiry-20261026',
  CHANNEL_BLOG_DRAFT_KEY: 'wecom-oem-enquiry-20261026-v1',
  CHANNEL_BLOG_CREDENTIAL: `hermes-wecom-supplychainsai-01.${secret}`,
};
const registration = {
  profile: 'wecom',
  keyId: 'hermes-wecom-supplychainsai-01',
  integrationId: config.CHANNEL_BLOG_INTEGRATION_ID,
  keyDigest: createHash('sha256').update(secret).digest('hex'),
  permissions: ['create-private-draft', 'read-own-import'],
  lifetimeDays: 14,
};
await writeFile(join(directory, 'credential.json'), JSON.stringify(config, null, 2), {
  mode: 0o600,
  flag: 'wx',
});
await writeFile(join(directory, 'registration.json'), JSON.stringify(registration, null, 2), {
  mode: 0o600,
  flag: 'wx',
});
console.log(JSON.stringify({ directory, registration, secretPrinted: false }));
