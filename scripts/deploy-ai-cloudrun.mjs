/**
 * Deploy the AI assistant's CloudRun services (ai-bff and ai-worker) from the
 * current commit, then prove they answer.
 *
 * CloudRun builds both images itself. This uploads a clean copy of the commit
 * with the service's Dockerfile at its root, and CloudRun runs that Dockerfile;
 * nothing here builds or pushes an image.
 *
 * .github/workflows/deploy-ai-cloudrun.yml runs it with every setting and a
 * knowledge-base proof recorded minutes earlier (AI_KB_EVIDENCE_FILE). In order:
 *   1. check every setting and the proof, before anything in the cloud changes
 *   2. start both deploys and wait until both have finished
 *   3. read each service's configuration back and compare it with the manifest
 *   4. wait until the BFF reports ready, which needs PostgreSQL
 *   5. ask the assistant one real question through the BFF; the answer only
 *      arrives if the worker reached both PostgreSQL and the knowledge base
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  GITHUB_SECRETS,
  STAGING_EXCLUDES,
  cloudRunDeployArgs,
  cloudRunNetworkApiArgs,
  cloudRunNetworkUpdateArgs,
  deployContextFromEnv,
  deployProgress,
  deployedConfigProblems,
  evidenceProblems,
  existingDeploymentSettled,
  networkBindingProblems,
  parseToolOutput,
  publicUrl,
  redactValues,
  requireSetting,
  withVpcInventory,
  workerStartupVerdict,
} from './ai-cloudrun-deploy-plan.mjs';
import { buildCloudRunServiceDefs } from './cloudrun-service-manifest.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stagingRoot = join(root, '.cloudbase-artifacts', 'cloudrun');
// Pinned: CloudBase MCP 2.34.3 is the first version whose deploy can replace a
// service's settings outright and attach a VPC when it creates a service.
const mcpConfig = 'config/mcporter.infra.json';
const mcporterPackage = 'mcporter@0.13.13';

const DEPLOY_TIMEOUT_MS = 40 * 60 * 1000;
const POLL_INTERVAL_MS = 20_000;
const READY_TIMEOUT_MS = 5 * 60 * 1000;
const SMOKE_ATTEMPTS = 3;
// Includes source upload and the MCP server's 45-second registration wait.
// mcporter otherwise times out at 60 seconds, before execFileSync's deadline.
const MCP_CALL_TIMEOUT_MS = 240_000;

const secretValues = [...GITHUB_SECRETS].map((name) => process.env[name]);
const safe = (text) => redactValues(text, secretValues);
const log = (message) => console.log(safe(message));

/**
 * Call one CloudBase MCP tool in a fresh process. Keep-alive is off so no
 * daemon carries state between calls: the environment id and credentials come
 * from this process's environment every time, and the tool's working directory
 * is the repository, which is where it requires the staged copies to be.
 */
function callTool(tool, args, { attempts = 3 } = {}) {
  let failure = '';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const output = execFileSync(
        'npx',
        [
          '--yes',
          mcporterPackage,
          '--config',
          mcpConfig,
          '--root',
          root,
          'call',
          `cloudbase.${tool}`,
          '--args',
          JSON.stringify(args),
          '--timeout',
          String(MCP_CALL_TIMEOUT_MS),
          '--output',
          'json',
        ],
        {
          cwd: root,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 5 * 60 * 1000,
          maxBuffer: 64 * 1024 * 1024,
          env: {
            ...process.env,
            MCPORTER_DISABLE_KEEPALIVE: 'cloudbase',
            CLOUDBASE_ENV_ID: requireSetting(process.env, 'TCB_ENV_ID'),
          },
        },
      );
      const result = parseToolOutput(output);
      if (result.success !== false && !result.error) return result;
      failure = safe(JSON.stringify({ error: result.error, message: result.message })).slice(
        0,
        1500,
      );
    } catch (error) {
      // Never error.message: it embeds the full command line, settings included.
      failure = `exit ${error.status ?? error.signal ?? 'unknown'}: ${error.stdout ?? ''}${error.stderr ?? ''}`;
      // Redact before truncation: a partial credential cannot match its full value.
      failure = safe(failure).slice(0, 1500);
    }
  }
  throw new Error(safe(`cloudbase.${tool} ${args.action ?? ''} failed: ${failure}`));
}

function serviceDetail(name) {
  return callTool('queryCloudRun', { action: 'detail', detailServerName: name }).data;
}

/** The id of the deployment a service is on now, or null for a service that does not exist yet. */
async function currentDeployId(name) {
  const services =
    callTool('queryCloudRun', { action: 'list', pageSize: 100 }).data?.services ?? [];
  if (!services.some((service) => service.ServerName === name)) return null;
  const deadline = Date.now() + DEPLOY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const detail = serviceDetail(name);
    if (existingDeploymentSettled(detail)) return detail?.latestDeploy?.DeployId ?? null;
    log(
      `${name}: waiting for existing cloud task (${detail?.latestDeploy?.Status ?? 'unknown'}) before uploading`,
    );
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`${name}: existing cloud task has not settled; no duplicate deploy submitted`);
}

/**
 * A clean copy of one commit for one service: tracked files only, so nothing
 * uncommitted, ignored or secret can be uploaded, with the service's Dockerfile
 * at the root because that is the file CloudRun builds.
 */
function stageService(def, commit) {
  const dir = join(stagingRoot, def.name);
  const tarball = `${dir}.tar`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['archive', '--format=tar', '-o', tarball, commit], { cwd: root });
  execFileSync('tar', ['-xf', tarball, '-C', dir]);
  rmSync(tarball, { force: true });
  for (const path of STAGING_EXCLUDES) rmSync(join(dir, path), { recursive: true, force: true });
  copyFileSync(join(dir, def.dockerfile), join(dir, 'Dockerfile'));
  return dir;
}

function loadEvidenceJson(env) {
  const file = env.AI_KB_EVIDENCE_FILE?.trim();
  const raw = file ? readFileSync(file, 'utf8') : requireSetting(env, 'AI_KB_EVIDENCE_JSON');
  const evidence = JSON.parse(raw);
  const problems = evidenceProblems(evidence, env);
  if (problems.length > 0) {
    throw new Error(`The knowledge-base proof cannot be shipped: ${problems.join('; ')}`);
  }
  return JSON.stringify(evidence);
}

function printProcessLog(name) {
  try {
    const lines = callTool('queryCloudRun', { action: 'getProcessLog', detailServerName: name })
      .data?.processLogs;
    log(`${name} deploy log:\n${(lines ?? []).join('\n')}`);
    return lines ?? [];
  } catch (error) {
    log(`${name} deploy log unavailable: ${error.message}`);
    return [];
  }
}

function printManageTask(name, taskId = 0) {
  const raw = callTool('callCloudApi', {
    service: 'tcbr',
    action: 'DescribeServerManageTask',
    version: '2022-02-17',
    params: { EnvId: requireSetting(process.env, 'TCB_ENV_ID'), ServerName: name, TaskId: taskId },
  });
  const result = raw.Response ?? raw;
  const task = result.Task;
  log(
    JSON.stringify({
      service: name,
      managementTask: {
        exists: result.IsExist,
        id: task?.Id,
        status: task?.Status,
        failReason: task?.FailReason,
        version: task?.VersionName,
        steps: task?.Steps?.map(({ Name, Status, FailReason }) => ({ Name, Status, FailReason })),
      },
    }),
  );
}

async function waitForDeploys(deployments) {
  const deadline = Date.now() + DEPLOY_TIMEOUT_MS;
  const pending = new Set(deployments);
  while (pending.size > 0) {
    if (Date.now() > deadline) {
      const names = [...pending].map((deployment) => deployment.def.name).join(', ');
      for (const deployment of pending) printProcessLog(deployment.def.name);
      throw new Error(`Timed out after ${DEPLOY_TIMEOUT_MS / 60_000} minutes waiting for ${names}`);
    }
    await delay(POLL_INTERVAL_MS);
    for (const deployment of pending) {
      let detail;
      try {
        detail = serviceDetail(deployment.def.name);
      } catch (error) {
        // A service being created can briefly fail to describe itself. The
        // deadline above still ends a wait that never recovers.
        log(`${deployment.def.name}: status unavailable for now (${error.message})`);
        continue;
      }
      const progress = deployProgress(detail, deployment);
      if (progress.status !== deployment.lastStatus) {
        log(
          `${deployment.def.name}: ${progress.status || 'waiting for the deployment to register'}`,
        );
        deployment.lastStatus = progress.status;
      }
      if (progress.state === 'failed') {
        printProcessLog(deployment.def.name);
        throw new Error(`${deployment.def.name} failed to deploy (status ${progress.status})`);
      }
      if (progress.state === 'succeeded') {
        deployment.detail = detail;
        pending.delete(deployment);
        log(`${deployment.def.name}: deployed as ${progress.deployId}`);
      }
    }
  }
}

async function waitForReady(url) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let last = 'no response yet';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      const body = await response.json().catch(() => ({}));
      if (response.ok && body.status === 'ready') return;
      last = `HTTP ${response.status} ${body.status ?? ''}`.trim();
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    log(`BFF not ready yet (${last})`);
    await delay(10_000);
  }
  throw new Error(
    `The BFF never became ready (${last}). It reports "starting" while it cannot reach PostgreSQL: check DATABASE_URL, and that the database security group admits the CloudRun subnet.`,
  );
}

async function waitForNetworkUpdates(deployments) {
  const deadline = Date.now() + 10 * 60 * 1000;
  for (const deployment of deployments) {
    while (Date.now() < deadline) {
      const detail = serviceDetail(deployment.def.name);
      const problems = deployedConfigProblems(deployment.def, detail?.service?.ServerConfig);
      if (problems.length === 0 && existingDeploymentSettled(detail)) {
        deployment.detail = detail;
        log(`${deployment.def.name}: full VPC binding verified`);
        break;
      }
      log(`${deployment.def.name}: waiting for network update (${problems.join('; ')})`);
      await delay(POLL_INTERVAL_MS);
    }
    if (!deployment.detail)
      throw new Error(`${deployment.def.name}: network update did not become effective`);
  }
}

async function smokeRoundTrip(url) {
  for (let attempt = 1; attempt <= SMOKE_ATTEMPTS; attempt += 1) {
    try {
      execFileSync(process.execPath, [join(root, 'scripts/smoke-ai-bff.mjs'), url], {
        cwd: root,
        stdio: 'inherit',
        timeout: 3 * 60 * 1000,
        // Only what the smoke needs. It has no use for the deploy's secrets.
        env: { PATH: process.env.PATH, AI_SMOKE_STREAM_TIMEOUT_MS: '90000' },
      });
      return;
    } catch {
      if (attempt === SMOKE_ATTEMPTS) break;
      log(
        `Round trip attempt ${attempt} failed; the worker may still be starting. Retrying in 30s.`,
      );
      await delay(30_000);
    }
  }
  throw new Error(
    'The BFF is ready but no answer came back, so the worker is not processing questions. ' +
      'It keeps retrying rather than exiting, so CloudRun still shows it as running: open ai-worker ' +
      'in the CloudRun console and look for knowledge_base_unreachable (it cannot reach the ' +
      'knowledge base) or database_unavailable (it cannot reach PostgreSQL).',
  );
}

function summarize(lines) {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) appendFileSync(summaryFile, `${lines.join('\n')}\n`);
}

async function main() {
  const env = { ...process.env };
  if (env.CI === 'true') {
    requireSetting(env, 'TENCENTCLOUD_SECRETID');
    requireSetting(env, 'TENCENTCLOUD_SECRETKEY');
  }
  if (env.AI_CLOUDRUN_INSPECT_ONLY === '1') {
    for (const name of ['ai-bff', 'ai-worker']) {
      const detail = serviceDetail(name);
      const service = detail?.service;
      const config = service?.ServerConfig;
      log(
        JSON.stringify({
          name,
          serviceKeys: Object.keys(service ?? {}),
          configKeys: Object.keys(config ?? {}),
          defaultDomain: service?.BaseInfo?.DefaultDomainName,
          status: service?.BaseInfo?.Status,
          latestDeploy: {
            id: detail?.latestDeploy?.DeployId,
            status: detail?.latestDeploy?.Status,
            isReleasing: detail?.latestDeploy?.IsReleasing,
            buildId: detail?.latestDeploy?.BuildId,
            runId: detail?.latestDeploy?.RunId,
          },
          vpc: config?.VpcConf ?? null,
          internalAccess: config?.InternalAccess,
          access: config?.OpenAccessTypes,
          publicNet: config?.PublicNetConf,
          port: config?.Port,
        }),
      );
      if (name === 'ai-bff') {
        const url = publicUrl(detail);
        for (const path of ['/api/ai/healthz', '/api/ai/readyz']) {
          const response = await fetch(`${url}${path}`, { signal: AbortSignal.timeout(15_000) });
          const body = await response.json();
          log(JSON.stringify({ url: `${url}${path}`, httpStatus: response.status, body }));
        }
      }
      printProcessLog(name);
      printManageTask(name);
    }
    return;
  }
  env.AI_KB_EVIDENCE_JSON = loadEvidenceJson(env);
  // Builds every service definition, so a missing setting stops the deploy
  // here, before either service has changed.
  const ctx = deployContextFromEnv(env);
  const baseDefs = buildCloudRunServiceDefs(ctx);
  const region = requireSetting(env, 'TCB_REGION');
  const vpcs = callTool('callCloudApi', {
    service: 'vpc',
    action: 'DescribeVpcs',
    version: '2017-03-12',
    region,
    params: { VpcIds: [env.AI_VPC_ID] },
  });
  const subnets = callTool('callCloudApi', {
    service: 'vpc',
    action: 'DescribeSubnets',
    version: '2017-03-12',
    region,
    params: { SubnetIds: [env.AI_CLOUDRUN_SUBNET_ID] },
  });
  const defs = baseDefs.map((def) => withVpcInventory(def, vpcs, subnets));
  log(
    `Resolved network: ${JSON.stringify(cloudRunNetworkUpdateArgs(defs[0]).serverConfig.VpcConf)}`,
  );
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  log(`Deploying ${defs.map((def) => def.name).join(' and ')} from ${commit} to ${ctx.envId}`);

  const deployments = [];
  if (env.AI_CLOUDRUN_NETWORK_ONLY === '1') {
    for (const def of defs) {
      const previousDeployId = await currentDeployId(def.name);
      if (!previousDeployId)
        throw new Error(`${def.name}: network-only mode requires an existing deployment`);
      const updated = callTool('callCloudApi', cloudRunNetworkApiArgs(def, ctx.envId), {
        attempts: 1,
      });
      log(
        `${def.name}: raw network update submitted (task ${updated.TaskId ?? updated.Response?.TaskId ?? 'synchronous'})`,
      );
      deployments.push({ def, previousDeployId, detail: undefined });
    }
    await waitForNetworkUpdates(deployments);
  } else {
    try {
      for (const def of defs) {
        const previousDeployId = await currentDeployId(def.name);
        const targetPath = stageService(def, commit);
        // One attempt only: repeating a deploy that did start queues a second one.
        const started = callTool('manageCloudRun', cloudRunDeployArgs(def, targetPath), {
          attempts: 1,
        });
        log(
          `${def.name}: ${previousDeployId ? 'update' : 'first deploy'} started. ${started.message ?? ''}`,
        );
        deployments.push({ def, previousDeployId, lastStatus: undefined, detail: undefined });
      }
      await waitForDeploys(deployments);
    } finally {
      rmSync(stagingRoot, { recursive: true, force: true });
    }
  }

  // New services and source updates also need an actual network read-back.
  // manageCloudRun 2.34.3 drops CIDRs at its schema boundary, even if the
  // caller supplies them, so repair through the raw API before acceptance.
  if (env.AI_CLOUDRUN_NETWORK_ONLY !== '1') {
    const repairs = deployments.filter(
      ({ def, detail }) => networkBindingProblems(def, detail?.service?.ServerConfig).length > 0,
    );
    for (const deployment of repairs) {
      await currentDeployId(deployment.def.name);
      callTool('callCloudApi', cloudRunNetworkApiArgs(deployment.def, ctx.envId), { attempts: 1 });
      deployment.detail = undefined;
    }
    await waitForNetworkUpdates(repairs);
  }

  for (const { def, detail } of deployments) {
    const problems = deployedConfigProblems(def, detail?.service?.ServerConfig);
    if (problems.length > 0) {
      throw new Error(
        `${def.name} is not configured as the manifest says:\n- ${problems.join('\n- ')}`,
      );
    }
  }
  log('Both services are configured as the manifest says.');

  const bff = deployments.find(({ def }) => def.publicAccess);
  const worker = deployments.find(({ def }) => !def.publicAccess);
  const url = publicUrl(bff.detail);
  log(`AI BFF address: ${url}`);
  await waitForReady(`${url}${bff.def.readyPath}`);
  log('The BFF is ready: it reached PostgreSQL.');

  // Best effort: CloudRun's deploy log sometimes carries the container's own
  // start-up lines, and when it does they name the problem exactly.
  const { verdict } = workerStartupVerdict(printProcessLog(worker.def.name));
  if (verdict === 'knowledge_base_unreachable' || verdict === 'database_unavailable') {
    throw new Error(
      `ai-worker is running but has not started work: ${verdict}. ${
        verdict === 'knowledge_base_unreachable'
          ? 'It cannot reach the knowledge base from CloudRun.'
          : 'It cannot reach PostgreSQL from CloudRun.'
      }`,
    );
  }

  await smokeRoundTrip(url);
  summarize([
    '### AI CloudRun deploy',
    `- Commit: \`${commit}\``,
    `- AI BFF: ${url}`,
    '- ai-worker: private (VPC only)',
    '- Round trip through BFF, worker and knowledge base: passed',
  ]);
  log(`Deployed and verified. AI BFF: ${url}`);
}

main().catch((error) => {
  console.error(safe(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
