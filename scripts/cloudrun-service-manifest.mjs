/**
 * THE CloudRun (云托管) service manifest for the AI assistant — the single
 * source of truth for every containerised service's name, build recipe, port,
 * network, scaling, public exposure, and environment map.
 *
 * It exists for the same reason `cloudbase-function-manifest.mjs` does: a
 * deployable that is not in a manifest drifts silently, and the first time
 * anyone notices is when a service is running with the wrong environment or,
 * worse, is publicly reachable when it was never meant to be.
 *
 * Consumers (must be updated in lockstep): scripts/cloudrun-manifest.test.mjs,
 * scripts/deploy-ai-cloudrun.mjs, scripts/smoke-ai-bff.mjs,
 * scripts/smoke-ai-worker.mjs, docker-compose.ai.yml.
 *
 * MIU 0 measured that CloudRun serves each service on its OWN hostname and is
 * not mounted under the CloudBase environment service domain. That is why the
 * BFF is a separate origin with an explicit CORS allowlist, and why nothing
 * here declares a gateway prefix route: `/api` and `/api/admin` are already
 * claimed by `public-api` and `admin`, and adding `/api/ai` there would take
 * assistant traffic away from this service rather than towards it.
 */

export const CLOUDRUN_SERVICE_NAMES = ['ai-bff', 'ai-worker'];

/**
 * Environment values that must come from a secret store at deploy time and
 * must never appear as literals in this repository.
 */
export const SECRET_ENV_KEYS = [
  'DATABASE_URL',
  'KB_API_KEY',
  'AI_IP_HASH_SECRET',
  'AI_MODEL_API_KEY',
  'VIBEKB_MCP_API_KEY',
  'AI_INQUIRY_TOKEN',
];

/** The engines a deployment can run, each with the settings its worker needs. */
export const ENGINE_IDS = ['anythingllm', 'vibekb'];

/**
 * Switches that must never appear in a deployed service definition.
 *
 * `AI_LOCAL_HARNESS` turns on an unauthenticated conversation route with no
 * rate limiting and permits serving with unmet engine guarantees. The service
 * itself refuses to start with it in a production environment, but that is the
 * last line rather than the first: a deploy manifest that sets it at all is a
 * mistake, and the manifest test fails on its presence.
 */
// Flags that disable a control. Each one is legitimate on a developer's machine
// and never in production, so production refuses to deploy carrying any of them.
// ALLOW_INSECURE_KB turns off the HTTPS requirement on the knowledge
// base — which carries an INSTANCE-WIDE developer token — so it belongs here
// beside the harness flag rather than relying on nobody copying a compose file.
// VIBEKB_MCP_ALLOW_LOOPBACK_HTTP is the same switch for the MCP knowledge
// path: plain HTTP to a local SSH tunnel, which only a developer has.
export const FORBIDDEN_ENV_KEYS = [
  'AI_LOCAL_HARNESS',
  'AI_DEV_UNSAFE_ALLOW_UNGATED_ENGINE',
  'ALLOW_INSECURE_KB',
  'VIBEKB_MCP_ALLOW_LOOPBACK_HTTP',
];

/** Drop undefined values so optional variables are omitted, not set to "undefined". */
export function envEntries(record) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

/**
 * The engine's provenance, as a discriminated pair of variables.
 *
 * `AI_ENGINE_IMAGE_DIGEST` used to be required unconditionally. The knowledge
 * base this deployment talks to is a Git checkout on a VM, so the only values
 * an operator could put there were a Git SHA or a placeholder — false in a
 * variable named for an OCI digest, and false in the direction that makes an
 * audit succeed. A deployment now says which kind of artifact it runs, and
 * supplies the fields that kind actually has.
 *
 * Emitted identically for BFF and worker: the BFF stamps the run row, the
 * worker serves the run, and a difference between them would make every run's
 * provenance unfalsifiable.
 */
export function provenanceEnv(ctx) {
  // Read from the deployment context, NOT requireEnv: the kind decides which
  // other variables exist, so it is a shape decision the manifest must know at
  // build time. Indirecting it through a secret reference would make the
  // manifest emit a branch it cannot evaluate.
  const kind = ctx.engineProvenanceKind;
  if (kind === 'oci') {
    return {
      AI_ENGINE_PROVENANCE_KIND: kind,
      AI_ENGINE_IMAGE_DIGEST: ctx.requireEnv('AI_ENGINE_IMAGE_DIGEST'),
    };
  }
  if (kind === 'git') {
    return {
      AI_ENGINE_PROVENANCE_KIND: kind,
      AI_ENGINE_GIT_COMMIT: ctx.requireEnv('AI_ENGINE_GIT_COMMIT'),
      AI_ENGINE_GIT_REPOSITORY: ctx.requireEnv('AI_ENGINE_GIT_REPOSITORY'),
      AI_ENGINE_CONFIG_DIGEST: ctx.requireEnv('AI_ENGINE_CONFIG_DIGEST'),
    };
  }
  throw new Error(`AI_ENGINE_PROVENANCE_KIND must be "oci" or "git", got: ${JSON.stringify(kind)}`);
}

/**
 * What the worker needs to reach its knowledge and its model, by engine.
 *
 * `anythingllm` sends each question to the knowledge base's own chat API and
 * the knowledge base answers; it needs the workspace and a recorded proof that
 * the workspace is the approved one. `vibekb` calls the model itself and reads
 * approved documents through the knowledge base's MCP tools; it needs the
 * model, the MCP address and the public document scope, plus the public
 * catalog for product cards. Like the provenance kind, the engine is a shape
 * decision read from the deployment context, not through requireEnv.
 */
export function engineEnv(ctx) {
  const engine = ctx.engineId;
  if (engine === 'anythingllm') {
    return {
      KB_BASE_URL: ctx.requireEnv('KB_BASE_URL'),
      KB_API_KEY: ctx.requireEnv('KB_API_KEY'),
      KB_WORKSPACE_SLUG: ctx.requireEnv('KB_WORKSPACE_SLUG'),
      KB_WORKSPACE_ID: ctx.requireEnv('KB_WORKSPACE_ID'),
      AI_KNOWLEDGE_CREDENTIAL_ID: ctx.requireEnv('AI_KNOWLEDGE_CREDENTIAL_ID'),
      KB_CITATIONS_VERIFIED: ctx.requireEnv('KB_CITATIONS_VERIFIED'),
      KB_CREDENTIAL_ROTATION: ctx.requireEnv('KB_CREDENTIAL_ROTATION'),
      AI_CORPUS_GENERATION: ctx.requireEnv('AI_CORPUS_GENERATION'),
      AI_KB_EVIDENCE_JSON: ctx.requireEnv('AI_KB_EVIDENCE_JSON'),
    };
  }
  if (engine === 'vibekb') {
    return {
      AI_MODEL_BASE_URL: ctx.requireEnv('AI_MODEL_BASE_URL'),
      AI_MODEL_ID: ctx.requireEnv('AI_MODEL_ID'),
      AI_MODEL_API_KEY: ctx.requireEnv('AI_MODEL_API_KEY'),
      AI_MODEL_THINKING_MODE: ctx.optionalEnv('AI_MODEL_THINKING_MODE'),
      VIBEKB_MCP_URL: ctx.requireEnv('VIBEKB_MCP_URL'),
      VIBEKB_MCP_API_KEY: ctx.requireEnv('VIBEKB_MCP_API_KEY'),
      VIBEKB_PUBLIC_WORKSPACE_ID: ctx.requireEnv('VIBEKB_PUBLIC_WORKSPACE_ID'),
      VIBEKB_PUBLIC_DOCUMENT_IDS: ctx.requireEnv('VIBEKB_PUBLIC_DOCUMENT_IDS'),
      VIBEKB_PUBLIC_TAG: ctx.optionalEnv('VIBEKB_PUBLIC_TAG'),
      AI_PUBLIC_CATALOG_ORIGIN: ctx.requireEnv('AI_PUBLIC_CATALOG_ORIGIN'),
    };
  }
  throw new Error(
    `AI_ENGINE_ID must be one of ${ENGINE_IDS.join(', ')}, got: ${JSON.stringify(engine)}`,
  );
}

/**
 * The BFF hands a confirmed inquiry to the sales intake only when this is
 * switched on, and then both the address and its dedicated token are required.
 */
function inquiryEnv(ctx) {
  if (ctx.optionalEnv('AI_INQUIRY_ENABLED') !== '1') return {};
  return {
    AI_INQUIRY_ENABLED: '1',
    AI_INQUIRY_BASE_URL: ctx.requireEnv('AI_INQUIRY_BASE_URL'),
    AI_INQUIRY_TOKEN: ctx.requireEnv('AI_INQUIRY_TOKEN'),
  };
}

/**
 * The private network both services join. PostgreSQL has no public address:
 * it accepts connections only from inside its VPC, and its security group
 * admits only the CloudRun subnet. A service deployed outside it has no route
 * to the database and would report "starting" forever, so a missing or
 * malformed id is refused before anything is uploaded.
 */
function databaseVpc(vpc) {
  const vpcId = vpc?.vpcId ?? '';
  const subnetId = vpc?.subnetId ?? '';
  if (!/^vpc-[a-z0-9]+$/.test(vpcId) || !/^subnet-[a-z0-9]+$/.test(subnetId)) {
    throw new Error(
      'Both AI services must join the database VPC: pass vpc.vpcId (vpc-…) and vpc.subnetId (subnet-…)',
    );
  }
  return { vpcId, subnetId };
}

/**
 * Build the per-service deploy definitions from a deploy context:
 * { envId, appEnv, vpc: { vpcId, subnetId }, siteOrigins, engineId,
 *   engineProvenanceKind, requireEnv, optionalEnv }.
 *
 * CloudRun builds each image itself: a deploy uploads a clean copy of one
 * commit and CloudRun runs the service's Dockerfile against it. No image is
 * built anywhere else, so there is no image reference to pin here — the commit
 * the copy came from is what identifies a deployment.
 */
export function buildCloudRunServiceDefs(ctx) {
  const vpc = databaseVpc(ctx.vpc);

  return [
    {
      name: 'ai-bff',
      workspacePackage: '@vibelingan-channel/ai-bff',
      dockerfile: 'apps/ai-bff/Dockerfile',
      buildContext: '.',
      containerPort: 8080,
      healthPath: '/api/ai/healthz',
      readyPath: '/api/ai/readyz',
      // Public: the widget in the visitor's browser calls this directly, on
      // this service's own hostname.
      publicAccess: true,
      vpc,
      cpu: 0.5,
      mem: 1,
      // Not zero. A scaled-to-zero BFF makes the first visitor of the hour wait
      // out a container start before the assistant says anything.
      minNum: 1,
      maxNum: 5,
      envVariables: envEntries({
        NODE_ENV: 'production',
        APP_ENV: ctx.appEnv,
        PORT: '8080',
        TCB_ENV: ctx.envId,
        DATABASE_URL: ctx.requireEnv('DATABASE_URL'),
        CORS_ALLOWED_ORIGINS: ctx.siteOrigins,
        AI_ENGINE_ID: ctx.engineId,
        AI_ENGINE_VERSION: ctx.requireEnv('AI_ENGINE_VERSION'),
        ...provenanceEnv(ctx),
        AI_IP_HASH_SECRET: ctx.requireEnv('AI_IP_HASH_SECRET'),
        AI_TRUST_PROXY: ctx.requireEnv('AI_TRUST_PROXY'),
        ...inquiryEnv(ctx),
      }),
    },
    {
      name: 'ai-worker',
      workspacePackage: '@vibelingan-channel/ai-worker',
      dockerfile: 'apps/ai-worker/Dockerfile',
      buildContext: '.',
      containerPort: 8080,
      healthPath: '/healthz',
      readyPath: '/readyz',
      // Private. The worker has no visitor-facing routes — it holds engine
      // streams and drains the outbox. Exposing it would publish a health
      // surface and an attack surface for no benefit.
      publicAccess: false,
      // Same network as the BFF, for the database. The worker ALSO calls the
      // knowledge base (and, for vibekb, the model) over the internet, and joining a VPC does not by itself
      // give a service an internet route: without one (a NAT gateway) the
      // worker keeps logging knowledge_base_unreachable instead of starting.
      vpc,
      cpu: 0.5,
      mem: 1,
      // Also not zero, for a different reason: the worker is not request-driven.
      // At zero instances there is nothing to drain the outbox, so a queued run
      // would simply never start.
      minNum: 1,
      maxNum: 3,
      envVariables: envEntries({
        NODE_ENV: 'production',
        APP_ENV: ctx.appEnv,
        PORT: '8080',
        TCB_ENV: ctx.envId,
        DATABASE_URL: ctx.requireEnv('DATABASE_URL'),
        AI_ENGINE_ID: ctx.engineId,
        AI_ENGINE_VERSION: ctx.requireEnv('AI_ENGINE_VERSION'),
        ...provenanceEnv(ctx),
        AI_PROFILE_ID: ctx.requireEnv('AI_PROFILE_ID'),
        AI_WORKER_LEASE_SECONDS: ctx.requireEnv('AI_WORKER_LEASE_SECONDS'),
        AI_MAX_STREAM_DURATION_MS: ctx.requireEnv('AI_MAX_STREAM_DURATION_MS'),
        AI_MAX_OUTPUT_TOKENS: ctx.requireEnv('AI_MAX_OUTPUT_TOKENS'),
        AI_MAX_TOOL_CALLS: ctx.requireEnv('AI_MAX_TOOL_CALLS'),
        ...engineEnv(ctx),
        AI_APPROVED_SOURCE_PREFIX: ctx.requireEnv('AI_APPROVED_SOURCE_PREFIX'),
        AI_SITE_ORIGIN: ctx.requireEnv('AI_SITE_ORIGIN'),
      }),
    },
  ];
}
