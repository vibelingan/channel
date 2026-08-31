/**
 * THE CloudRun (云托管) service manifest for the AI assistant — the single
 * source of truth for every containerised service's name, image build context,
 * port, scaling, public exposure, and environment map.
 *
 * It exists for the same reason `cloudbase-function-manifest.mjs` does: a
 * deployable that is not in a manifest drifts silently, and the first time
 * anyone notices is when a service is running with the wrong environment or,
 * worse, is publicly reachable when it was never meant to be.
 *
 * Consumers (must be updated in lockstep): scripts/cloudrun-manifest.test.mjs,
 * scripts/smoke-ai-bff.mjs, scripts/smoke-ai-worker.mjs, docker-compose.ai.yml.
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
export const SECRET_ENV_KEYS = ['DATABASE_URL', 'ANYTHINGLLM_API_KEY', 'AI_IP_HASH_SECRET'];

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
// ALLOW_INSECURE_ANYTHINGLLM turns off the HTTPS requirement on the knowledge
// base — which carries an INSTANCE-WIDE developer token — so it belongs here
// beside the harness flag rather than relying on nobody copying a compose file.
export const FORBIDDEN_ENV_KEYS = [
  'AI_LOCAL_HARNESS',
  'AI_DEV_UNSAFE_ALLOW_UNGATED_ENGINE',
  'ALLOW_INSECURE_ANYTHINGLLM',
];

/** Drop undefined values so optional variables are omitted, not set to "undefined". */
export function envEntries(record) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

/**
 * Build the per-service deploy definitions from a deploy context:
 * { envId, appEnv, images, siteOrigins, requireEnv, optionalEnv }.
 *
 * Each complete service image reference must end in a sha256 digest. Appending
 * a service path after a digest produces an invalid OCI reference, so callers
 * pass the two final references rather than a pseudo-prefix.
 */
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
      ...(ctx.optionalEnv?.('AI_ENGINE_CONFIG_DIGEST')
        ? { AI_ENGINE_CONFIG_DIGEST: ctx.optionalEnv('AI_ENGINE_CONFIG_DIGEST') }
        : {}),
    };
  }
  throw new Error(`AI_ENGINE_PROVENANCE_KIND must be "oci" or "git", got: ${JSON.stringify(kind)}`);
}

export function buildCloudRunServiceDefs(ctx) {
  const digestReference =
    /^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?\/)?[a-z0-9]+(?:[._/-][a-z0-9]+)*@sha256:[0-9a-f]{64}$/;
  for (const service of CLOUDRUN_SERVICE_NAMES) {
    const image = ctx.images?.[service];
    if (!image || !digestReference.test(image)) {
      throw new Error(`${service} image must be a complete immutable sha256 OCI reference`);
    }
  }

  return [
    {
      name: 'ai-bff',
      workspacePackage: '@vibelingan-channel/ai-bff',
      dockerfile: 'apps/ai-bff/Dockerfile',
      buildContext: '.',
      image: ctx.images['ai-bff'],
      containerPort: 8080,
      healthPath: '/api/ai/healthz',
      readyPath: '/api/ai/readyz',
      // Public: the widget in the visitor's browser calls this directly, on
      // this service's own hostname.
      publicAccess: true,
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
        AI_ENGINE_ID: ctx.requireEnv('AI_ENGINE_ID'),
        AI_ENGINE_VERSION: ctx.requireEnv('AI_ENGINE_VERSION'),
        ...provenanceEnv(ctx),
        AI_IP_HASH_SECRET: ctx.requireEnv('AI_IP_HASH_SECRET'),
        AI_TRUST_PROXY: ctx.requireEnv('AI_TRUST_PROXY'),
      }),
    },
    {
      name: 'ai-worker',
      workspacePackage: '@vibelingan-channel/ai-worker',
      dockerfile: 'apps/ai-worker/Dockerfile',
      buildContext: '.',
      image: ctx.images['ai-worker'],
      containerPort: 8080,
      healthPath: '/healthz',
      readyPath: '/readyz',
      // Private. The worker has no visitor-facing routes — it holds engine
      // streams and drains the outbox. Exposing it would publish a health
      // surface and an attack surface for no benefit.
      publicAccess: false,
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
        AI_ENGINE_ID: ctx.requireEnv('AI_ENGINE_ID'),
        AI_ENGINE_VERSION: ctx.requireEnv('AI_ENGINE_VERSION'),
        ...provenanceEnv(ctx),
        AI_PROFILE_ID: ctx.requireEnv('AI_PROFILE_ID'),
        AI_WORKER_LEASE_SECONDS: ctx.requireEnv('AI_WORKER_LEASE_SECONDS'),
        AI_MAX_STREAM_DURATION_MS: ctx.requireEnv('AI_MAX_STREAM_DURATION_MS'),
        AI_MAX_OUTPUT_TOKENS: ctx.requireEnv('AI_MAX_OUTPUT_TOKENS'),
        AI_MAX_TOOL_CALLS: ctx.requireEnv('AI_MAX_TOOL_CALLS'),
        ANYTHINGLLM_BASE_URL: ctx.requireEnv('ANYTHINGLLM_BASE_URL'),
        ANYTHINGLLM_API_KEY: ctx.requireEnv('ANYTHINGLLM_API_KEY'),
        ANYTHINGLLM_WORKSPACE_SLUG: ctx.requireEnv('ANYTHINGLLM_WORKSPACE_SLUG'),
        AI_KNOWLEDGE_CREDENTIAL_ID: ctx.requireEnv('AI_KNOWLEDGE_CREDENTIAL_ID'),
        ANYTHINGLLM_CITATIONS_VERIFIED: ctx.requireEnv('ANYTHINGLLM_CITATIONS_VERIFIED'),
        ANYTHINGLLM_CREDENTIAL_ROTATION: ctx.requireEnv('ANYTHINGLLM_CREDENTIAL_ROTATION'),
        AI_APPROVED_SOURCE_PREFIX: ctx.requireEnv('AI_APPROVED_SOURCE_PREFIX'),
        AI_SITE_ORIGIN: ctx.requireEnv('AI_SITE_ORIGIN'),
      }),
    },
  ];
}
