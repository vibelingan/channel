/**
 * The decisions behind an AI CloudRun deploy, kept free of side effects so each
 * one can be tested: which settings a deploy needs and where each lives, what
 * every service is configured with, and how to tell from CloudRun's answers
 * whether a deploy really worked. scripts/deploy-ai-cloudrun.mjs carries them
 * out.
 */
import { isAbsolute } from 'node:path';
import { SECRET_ENV_KEYS } from './cloudrun-service-manifest.mjs';
import { knowledgeEvidenceRefusals } from './probe-anythingllm.mjs';

/**
 * Left out of the uploaded copy of the repository. .dockerignore already keeps
 * both out of the Docker build, so the images are identical without them, and
 * together they are about 50 MB of the 57 MB a full copy would upload.
 */
export const STAGING_EXCLUDES = ['apps/site/public/media', 'docs'];

/**
 * How old a knowledge-base proof may be when a deploy ships it. The workflow
 * records it minutes before deploying; anything older came from somewhere else.
 */
export const EVIDENCE_MAX_AGE_AT_DEPLOY_MS = 60 * 60 * 1000;

/**
 * Settings that live in GitHub's secret store rather than as plain variables:
 * the services' own secrets, and the Tencent Cloud key the deploy signs in with.
 * The deploy masks every one of their values in anything it prints.
 */
export const GITHUB_SECRETS = new Set([
  ...SECRET_ENV_KEYS,
  'TENCENTCLOUD_SECRETID',
  'TENCENTCLOUD_SECRETKEY',
]);

// Not configured anywhere: the deploy workflow produces this one itself.
const PRODUCED_BY_WORKFLOW = {
  AI_KB_EVIDENCE_JSON: 'the knowledge-base probe step writes it to AI_KB_EVIDENCE_FILE',
};

/** Read one deploy setting, or say exactly where the missing one has to be set. */
export function requireSetting(env, name) {
  const value = env[name]?.trim();
  if (value) return value;
  if (PRODUCED_BY_WORKFLOW[name]) {
    throw new Error(`Missing ${name}: ${PRODUCED_BY_WORKFLOW[name]}`);
  }
  const kind = GITHUB_SECRETS.has(name) ? 'GitHub secret' : 'GitHub variable';
  throw new Error(`Missing ${name}: set it as a ${kind} on the "test" environment`);
}

/** The manifest's deploy context, read from the workflow's environment. */
export function deployContextFromEnv(env) {
  return {
    envId: requireSetting(env, 'TCB_ENV_ID'),
    appEnv: requireSetting(env, 'APP_ENV'),
    vpc: {
      vpcId: requireSetting(env, 'AI_VPC_ID'),
      subnetId: requireSetting(env, 'AI_CLOUDRUN_SUBNET_ID'),
    },
    siteOrigins: requireSetting(env, 'CORS_ALLOWED_ORIGINS'),
    engineProvenanceKind: requireSetting(env, 'AI_ENGINE_PROVENANCE_KIND'),
    requireEnv: (name) => requireSetting(env, name),
  };
}

// PUBLIC is a visitor's browser reaching the BFF over HTTPS. VPC is reachable
// only from inside the private network, which is all the worker needs: nothing
// calls it, it only calls out.
function accessTypes(def) {
  return def.publicAccess ? ['PUBLIC'] : ['VPC'];
}

/** Arguments for CloudBase MCP `manageCloudRun` to deploy one manifest service. */
export function cloudRunDeployArgs(def, targetPath) {
  if (!isAbsolute(targetPath)) {
    throw new Error(`The staged copy for ${def.name} must be an absolute path, got ${targetPath}`);
  }
  return {
    action: 'deploy',
    serverName: def.name,
    serverType: 'container',
    targetPath,
    // Without this a deploy merges into the settings already on the service,
    // so one removed from the manifest, or added by hand in the console, would
    // stay switched on.
    envParamsReplaceAll: true,
    serverConfig: {
      OpenAccessTypes: accessTypes(def),
      Cpu: def.cpu,
      Mem: def.mem,
      MinNum: def.minNum,
      MaxNum: def.maxNum,
      Port: def.containerPort,
      Dockerfile: 'Dockerfile',
      VpcConf: { VpcId: def.vpc.vpcId, SubnetId: def.vpc.subnetId },
      EnvParams: JSON.stringify(def.envVariables),
    },
  };
}

/**
 * Why a knowledge-base proof must not be shipped, or an empty list. The worker
 * refuses to start on any of these, so catching one here turns a worker that
 * silently never starts into a failed deploy that says why.
 */
export function evidenceProblems(evidence, env) {
  return knowledgeEvidenceRefusals(evidence, {
    credentialId: requireSetting(env, 'AI_KNOWLEDGE_CREDENTIAL_ID'),
    workspaceSlug: requireSetting(env, 'KB_WORKSPACE_SLUG'),
    workspaceId: requireSetting(env, 'KB_WORKSPACE_ID'),
    rotationCounter: Number(requireSetting(env, 'KB_CREDENTIAL_ROTATION')),
    corpusGeneration: requireSetting(env, 'AI_CORPUS_GENERATION'),
    maxAgeMs: EVIDENCE_MAX_AGE_AT_DEPLOY_MS,
  });
}

const FAILED_STATUS = /fail|error|abnormal/i;

/** A client timeout does not cancel the task already accepted by CloudRun. */
export function existingDeploymentSettled(detail) {
  if (detail?.latestDeploy?.IsReleasing === true) return false;
  const status = String(detail?.latestDeploy?.Status ?? detail?.service?.BaseInfo?.Status ?? '');
  return status === 'normal' || FAILED_STATUS.test(status);
}

/**
 * Where a deploy stands, from `queryCloudRun detail`. A deploy only counts once
 * a NEW deployment record appears: until then the service still shows the
 * previous deployment, whose "normal" says nothing about this one.
 */
export function deployProgress(detail, { previousDeployId }) {
  const latest = detail?.latestDeploy;
  const deployId = latest?.DeployId ?? null;
  const status = String(latest?.Status ?? '');
  const isNewRecord = deployId !== null && deployId !== previousDeployId;
  if (isNewRecord && FAILED_STATUS.test(status)) return { state: 'failed', status, deployId };
  if (isNewRecord && status === 'normal' && latest.IsReleasing !== true) {
    return { state: 'succeeded', status, deployId };
  }
  // A first deploy that fails can leave no record at all, only a failed service.
  const serviceStatus = String(detail?.service?.BaseInfo?.Status ?? '');
  if (previousDeployId === null && FAILED_STATUS.test(serviceStatus)) {
    return { state: 'failed', status: serviceStatus, deployId };
  }
  return { state: 'pending', status, deployId };
}

function envParamKeys(raw) {
  try {
    const parsed = JSON.parse(String(raw ?? '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? Object.keys(parsed)
      : [];
  } catch {
    return [];
  }
}

/**
 * How a deployed service differs from its manifest entry, read back from
 * `queryCloudRun detail` rather than assumed from what the deploy was sent.
 * Setting values come back masked, so settings are compared by name.
 */
export function deployedConfigProblems(def, config) {
  const problems = [];

  const vpc = config?.VpcConf ?? {};
  if (vpc.VpcId !== def.vpc.vpcId || vpc.SubnetId !== def.vpc.subnetId) {
    problems.push(
      `${def.name} is not in the database VPC ${def.vpc.vpcId} / ${def.vpc.subnetId} (it has "${vpc.VpcId ?? ''}" / "${vpc.SubnetId ?? ''}"), so it cannot reach PostgreSQL`,
    );
  }

  const access = [...(config?.OpenAccessTypes ?? [])];
  const expected = accessTypes(def);
  const sameAccess =
    access.length === expected.length && expected.every((type) => access.includes(type));
  if (!sameAccess && !def.publicAccess && access.some((type) => type !== 'VPC')) {
    problems.push(
      `${def.name} can be reached from the internet (access: ${access.join(', ')}); it must be VPC-only`,
    );
  } else if (!sameAccess) {
    problems.push(
      `${def.name} access is [${access.join(', ')}], expected [${expected.join(', ')}]`,
    );
  }

  const deployedKeys = envParamKeys(config?.EnvParams);
  const manifestKeys = Object.keys(def.envVariables);
  const unexpected = deployedKeys.filter((key) => !manifestKeys.includes(key));
  const absent = manifestKeys.filter((key) => !deployedKeys.includes(key));
  if (unexpected.length > 0) {
    problems.push(`${def.name} carries settings the manifest does not: ${unexpected.join(', ')}`);
  }
  if (absent.length > 0) {
    problems.push(`${def.name} is missing settings: ${absent.join(', ')}`);
  }

  for (const [field, value] of [
    ['Port', def.containerPort],
    ['MinNum', def.minNum],
    ['MaxNum', def.maxNum],
  ]) {
    if (Number(config?.[field]) !== value) {
      problems.push(`${def.name} ${field} is ${config?.[field]}, expected ${value}`);
    }
  }

  // A service that calls the knowledge base goes out to the internet through
  // CloudRun's default exit. Switched off, that path needs a NAT gateway in the
  // VPC, and this VPC has none.
  if (def.envVariables.KB_BASE_URL && config?.PublicNetConf?.PublicNetStatus === 'DISABLE') {
    problems.push(
      `${def.name} has internet egress switched off, so it cannot reach the knowledge base unless the VPC gets a NAT gateway`,
    );
  }

  return problems;
}

/** The BFF's public address, as CloudRun assigned it. */
export function publicUrl(detail) {
  const url = String(detail?.service?.BaseInfo?.DefaultDomainName ?? '').replace(/\/+$/, '');
  if (!/^https:\/\/[^/\s]+$/.test(url)) {
    throw new Error(`CloudRun reported no HTTPS address for the service (got "${url}")`);
  }
  return url;
}

/**
 * Replace every occurrence of each value with ***, including the escaped forms
 * it takes inside JSON and inside JSON nested in a JSON string (the service
 * settings travel as exactly that), and URI-encoded in MCP issue links.
 * Short values are skipped: they are not
 * secrets, and masking every "true" would hide the log instead of the secret.
 */
export function redactValues(text, values) {
  const forms = new Set();
  for (const value of values) {
    if (typeof value !== 'string' || value.length < 8) continue;
    const once = JSON.stringify(value).slice(1, -1);
    for (const form of [value, once, JSON.stringify(once).slice(1, -1)]) {
      forms
        .add(form)
        .add(encodeURIComponent(form))
        .add(encodeURIComponent(encodeURIComponent(form)));
    }
  }
  let result = String(text);
  for (const form of [...forms].sort((a, b) => b.length - a.length)) {
    result = result.split(form).join('***');
  }
  return result;
}

const STARTUP_EVENTS = {
  worker_started: 'started',
  knowledge_base_unreachable: 'knowledge_base_unreachable',
  database_unavailable: 'database_unavailable',
};

/** The worker's start-up state: the last start-up event among its log lines. */
export function workerStartupVerdict(lines) {
  let verdict = 'unknown';
  for (const line of lines) {
    const text = String(line);
    const start = text.indexOf('{');
    if (start < 0) continue;
    let event;
    try {
      event = JSON.parse(text.slice(start))?.event;
    } catch {
      continue;
    }
    if (typeof event === 'string' && Object.hasOwn(STARTUP_EVENTS, event)) {
      verdict = STARTUP_EVENTS[event];
    }
  }
  return { verdict };
}

/** The JSON a tool printed, skipping any banner printed before it. */
export function parseToolOutput(output) {
  const text = String(output);
  const start = text.indexOf('{');
  if (start < 0) throw new Error(`No JSON object in tool output (it began: ${text.slice(0, 120)})`);
  return JSON.parse(text.slice(start));
}
