import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import CloudBase from '@cloudbase/manager-node';
import { assertErrorDocument } from '../hosting-contract.mjs';
import {
  configurationStateHash,
  prepareHostingConfiguration,
  websiteArguments,
} from '../release/hosting-configuration.mjs';
import { createCloudbaseHostingProvider } from '../release/hosting-provider.mjs';
import { verifyHostingObject } from '../release/hosting-readback.mjs';
import { sha256 } from '../release/input.mjs';
import { fetchFully } from '../smoke-http.mjs';
import { connectBlogMcp } from './mcp-client.mjs';
import { BLOG_DUMMY_POLICY as policy } from './policy.mjs';
import { checkBlogSiteBaseline, readBlogSiteBaseline } from './site-baseline.mjs';
const command = process.argv[2];
if (
  !['plan', 'start-lock', 'apply', 'restore'].includes(command ?? '') ||
  !process.env.BLOG_DUMMY_PRIVATE_DIR
)
  throw new Error('Explicit repair command and external private directory required');
const directory = resolve(process.env.BLOG_DUMMY_PRIVATE_DIR);
if (directory.startsWith(`${process.cwd()}/`))
  throw new Error('Preparation record must remain outside the checkout');
const file = join(directory, '404-preparation.json');
const gh = (args) =>
  JSON.parse(
    execFileSync('gh', args, {
      encoding: 'utf8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const mcp = await connectBlogMcp();
try {
  if (command === 'start-lock') {
    const record = await readFile(file);
    if (record.length > 40000)
      throw new Error('Maintenance record exceeds the registered entry budget');
    const parsed = JSON.parse(record);
    if (parsed.codeSha !== sha) throw new Error('Maintenance record is from another checkout');
    execFileSync(
      'gh',
      [
        'workflow',
        'run',
        'seo-static-canary.yml',
        '--repo',
        policy.repository,
        '--ref',
        'feat/seo-foundation',
        '-f',
        'mode=maintenance',
        '-f',
        'action=initialize',
        '-f',
        'variant=A',
        '-f',
        'expected_activation_id=none',
        '-f',
        `plan_token=backup-v1:${record.toString('base64')}`,
        '-f',
        'reason=Restore the previously approved dedicated 404 after the legacy deployment reset; preserve business pages and all function/data resources.',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 },
    );
    console.log(
      'Existing F1 maintenance entry requested. Wait for its shared-queue lock and archived backup before apply.',
    );
  } else {
    // Temporary credentials stay in this process; they are never printed or written to a file.
    const temporary = await mcp.call('auth', {
      action: 'get_temp_credentials',
      confirm: 'yes',
      reveal: true,
    });
    if (
      temporary.credentials?.masked !== false ||
      !temporary.credentials.secretId ||
      !temporary.credentials.secretKey ||
      !temporary.credentials.token
    )
      throw new Error('Current management connection cannot supply this reviewed SDK operation');
    const manager = new CloudBase({
      ...temporary.credentials,
      envId: policy.envId,
      region: policy.region,
    });
    const provider = createCloudbaseHostingProvider({
      manager,
      target: { envId: policy.envId, site: policy.siteOrigin },
    });
    if (command === 'plan') {
      const configurationBefore = await provider.readConfiguration();
      const plan = prepareHostingConfiguration({
        target: provider.target,
        before: configurationBefore,
        errorDocument: 'errors/not-found.html',
      });
      if (plan.changes.length > 1 || plan.changes.some((change) => change.kind !== 'website'))
        throw new Error('404 repair would exceed one website configuration change');
      const response = await fetchFully('GET', `${policy.siteOrigin}/errors/not-found.html`, {
        timeoutMs: 15000,
        maxBytes: 131072,
        redirect: 'error',
      });
      if (response.status !== 200) throw new Error('Dedicated error object is unavailable');
      assertErrorDocument(response.body);
      const record = {
        schemaVersion: 1,
        target: { envId: policy.envId, siteOrigin: policy.siteOrigin },
        codeSha: sha,
        configurationBefore,
        plan,
        baseline: await readBlogSiteBaseline(),
        errorDocument: {
          path: 'errors/not-found.html',
          bytes: response.body.length,
          sha256: sha256(response.body),
        },
      };
      await writeFile(file, JSON.stringify(record), { mode: 0o600 });
      console.log(
        JSON.stringify(
          {
            target: record.target,
            codeSha: sha,
            changes: plan.changes.map((change) => ({
              kind: change.kind,
              before: change.before.website.WebsiteConfiguration,
              after: change.after.website.WebsiteConfiguration,
            })),
            backupSha256: sha256(JSON.stringify(record)),
          },
          null,
          2,
        ),
      );
    } else {
      const runId = process.env.F1_MAINTENANCE_RUN_ID;
      if (!/^[1-9][0-9]*$/.test(runId ?? ''))
        throw new Error('Exact active maintenance run required');
      const record = JSON.parse(await readFile(file, 'utf8'));
      if (record.codeSha !== sha) throw new Error('Repair checkout differs from the backup');
      async function lock() {
        const run = gh(['api', `repos/${policy.repository}/actions/runs/${runId}`]);
        const jobs = gh(['api', `repos/${policy.repository}/actions/runs/${runId}/jobs`]);
        const maintenance = jobs.jobs?.find((job) => job.name === 'maintenance');
        if (
          run.head_sha !== sha ||
          run.head_branch !== 'feat/seo-foundation' ||
          run.event !== 'workflow_dispatch' ||
          run.path !== '.github/workflows/seo-static-canary.yml' ||
          run.status !== 'in_progress' ||
          maintenance?.status !== 'in_progress' ||
          !maintenance.steps?.some(
            (step) =>
              step.name === 'Hold shared target lock for the reviewed F1 prerequisites' &&
              step.status === 'in_progress',
          ) ||
          !maintenance.steps?.some(
            (step) =>
              step.name === 'Archive the preparation and recovery inputs' &&
              step.conclusion === 'success',
          )
        )
          throw new Error('The archived F1 maintenance lock is not currently held');
      }
      await lock();
      const archiveDirectory = await mkdtemp(join(directory, `maintenance-backup-${runId}-`));
      const run = gh(['api', `repos/${policy.repository}/actions/runs/${runId}`]);
      execFileSync(
        'gh',
        [
          'run',
          'download',
          runId,
          '--repo',
          policy.repository,
          '--name',
          `f1-maintenance-backup-${runId}-${run.run_attempt}`,
          '--dir',
          archiveDirectory,
        ],
        { timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const archived = await readFile(join(archiveDirectory, 'reviewed-preparation.json'));
      if (sha256(archived) !== sha256(await readFile(file)))
        throw new Error('Archived maintenance backup differs from the reviewed local record');
      await checkBlogSiteBaseline(record.baseline);
      const current = await provider.readConfiguration();
      const expected = command === 'apply' ? record.plan.before : record.plan.after;
      if (configurationStateHash(current) !== configurationStateHash(expected))
        throw new Error('Website configuration changed since the reviewed backup');
      const config = command === 'apply' ? record.plan.after : record.plan.before;
      await writeFile(
        join(directory, `404-${command}-intent.json`),
        JSON.stringify({
          runId,
          codeSha: sha,
          beforeHash: configurationStateHash(current),
          afterHash: configurationStateHash(config),
        }),
        { flag: 'wx', mode: 0o600 },
      );
      await lock();
      const result = await manager.hosting.setWebsiteDocument(
        websiteArguments(config.website.WebsiteConfiguration),
      );
      if (result.statusCode !== 200)
        throw new Error(
          '404 configuration write was not confirmed; read back before another write',
        );
      let observed;
      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
        observed = await provider.readConfiguration();
        if (configurationStateHash(observed) === configurationStateHash(config)) break;
        await new Promise((done) => setTimeout(done, 2000));
      }
      if (configurationStateHash(observed) !== configurationStateHash(config))
        throw new Error('404 configuration did not converge; stop without repeating the write');
      await checkBlogSiteBaseline(record.baseline);
      if (command === 'apply')
        await verifyHostingObject({
          target: provider.target,
          entry: record.errorDocument,
          path: '__blog-dummy/missing-after-404-repair/index.html',
          expectedStatus: 404,
        });
      await writeFile(
        join(directory, `404-${command}-verified.json`),
        JSON.stringify({
          runId,
          codeSha: sha,
          configurationHash: configurationStateHash(observed),
          baselineUnchanged: true,
        }),
        { flag: 'wx', mode: 0o600 },
      );
      console.log(
        command === 'apply'
          ? 'Dedicated 404 and normal/revalidated/conditional requests verified; business page hashes unchanged.'
          : 'Original website configuration restored exactly; business page hashes unchanged.',
      );
    }
  }
} finally {
  await mcp.close();
}
