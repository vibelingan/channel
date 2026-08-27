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
export const SECRET_ENV_KEYS = ['DATABASE_URL', 'ZENMUX_API_KEY', 'ANYTHINGLLM_API_KEY'];

/**
 * Switches that must never appear in a deployed service definition.
 *
 * `AI_LOCAL_HARNESS` turns on an unauthenticated conversation route with no
 * rate limiting and permits serving with unmet engine guarantees. The service
 * itself refuses to start with it in a production environment, but that is the
 * last line rather than the first: a deploy manifest that sets it at all is a
 * mistake, and the manifest test fails on its presence.
 */
export const FORBIDDEN_ENV_KEYS = ['AI_LOCAL_HARNESS', 'AI_DEV_UNSAFE_ALLOW_UNGATED_ENGINE'];

/** Drop undefined values so optional variables are omitted, not set to "undefined". */
export function envEntries(record) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

/**
 * Build the per-service deploy definitions from a deploy context:
 * { envId, appEnv, imageTag, siteOrigins, requireEnv, optionalEnv }.
 *
 * `imageTag` is required and must be a digest or an immutable tag. ADR-002 §4
 * requires pinned images for the engine; the same rule applies to our own
 * services, because "redeploy the same manifest" has to mean the same bytes.
 */
export function buildCloudRunServiceDefs(ctx) {
  if (!ctx.imageTag) throw new Error('imageTag is required; a floating tag is not deployable');

  return [
    {
      name: 'ai-bff',
      workspacePackage: '@vibelingan-channel/ai-bff',
      dockerfile: 'apps/ai-bff/Dockerfile',
      buildContext: '.',
      image: `${ctx.imageTag}/ai-bff`,
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
      }),
    },
    {
      name: 'ai-worker',
      workspacePackage: '@vibelingan-channel/ai-worker',
      dockerfile: 'apps/ai-worker/Dockerfile',
      buildContext: '.',
      image: `${ctx.imageTag}/ai-worker`,
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
        PORT: '8081',
        TCB_ENV: ctx.envId,
        DATABASE_URL: ctx.requireEnv('DATABASE_URL'),
      }),
    },
  ];
}
