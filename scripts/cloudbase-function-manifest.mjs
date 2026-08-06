/**
 * THE function manifest (docs/alibaba-linked-catalog-sync ARCHITECTURE §14,
 * MIU 14): the single source of truth for every CloudBase function's name,
 * gateway route, runtime limits, environment map, and timer desired-state.
 *
 * Consumers (updated in lockstep — R1 M8): scripts/package-functions.mjs,
 * scripts/smoke-function-artifacts.mjs, scripts/deploy-cloudbase-test.mjs,
 * scripts/smoke-cloudbase-deploy.mjs, scripts/runtime-contract.test.mjs.
 *
 * PRESERVATION CONTRACT (R1 M9): deploys REPLACE a function's live env
 * wholesale, so the admin/public-api maps below must stay byte-identical to
 * the pre-manifest functionDefs; scripts/function-manifest.test.mjs pins
 * them. Timeouts are manifest-owned (R1 E1): the deploy path used to
 * hardcode 20s everywhere, which would kill the 720s sync runner.
 */

export const FUNCTION_NAMES = ['admin', 'public-api', 'alibaba-catalog-sync'];

/** Drop undefined values so optional env vars are omitted, not set to "undefined". */
export function envEntries(record) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

/**
 * Build the per-function deploy definitions from a deploy context:
 * { envId, appEnv, adminEmail, apiUrl, siteUrl, corsAllowedOrigins, loginUrl,
 *   resetPasswordUrl, requireEnv, optionalEnv }.
 */
export function buildFunctionDefs(ctx) {
  return [
    {
      name: 'admin',
      routePath: '/api/admin',
      timeout: 20,
      memorySize: 256,
      envVariables: envEntries({
        TCB_ENV: ctx.envId,
        APP_ENV: ctx.appEnv,
        ADMIN_EMAIL: ctx.adminEmail,
        JWT_SECRET: ctx.requireEnv('JWT_SECRET'),
        ADMIN_PASSWORD_HASH: ctx.requireEnv('ADMIN_PASSWORD_HASH'),
        BOOTSTRAP_ENABLED: process.env.BOOTSTRAP_ENABLED || '0',
        BOOTSTRAP_ADMIN_TOKEN: ctx.optionalEnv('BOOTSTRAP_ADMIN_TOKEN'),
        CORS_ALLOWED_ORIGINS: ctx.corsAllowedOrigins,
        LOGIN_URL: ctx.loginUrl,
        RESET_PASSWORD_URL: ctx.resetPasswordUrl,
        EMAIL_HOST: ctx.optionalEnv('EMAIL_HOST'),
        EMAIL_PORT: ctx.optionalEnv('EMAIL_PORT'),
        EMAIL_SECURE: ctx.optionalEnv('EMAIL_SECURE'),
        EMAIL_USER: ctx.optionalEnv('EMAIL_USER'),
        EMAIL_PASSWORD: ctx.optionalEnv('EMAIL_PASSWORD'),
        EMAIL_FROM: ctx.optionalEnv('EMAIL_FROM'),
      }),
    },
    {
      name: 'public-api',
      routePath: '/api',
      timeout: 20,
      memorySize: 256,
      envVariables: envEntries({
        TCB_ENV: ctx.envId,
        APP_ENV: ctx.appEnv,
        PUBLIC_API_BASE_URL: ctx.apiUrl,
        CORS_ALLOWED_ORIGINS: ctx.corsAllowedOrigins,
        // Same secret the admin function signs sessions with — the public catalog
        // verifies a presented Bearer token to attach role-gated VIP pricing.
        // Absent → catalog is anonymous-only (feature no-ops, fails closed).
        JWT_SECRET: ctx.requireEnv('JWT_SECRET'),
      }),
    },
    {
      name: 'alibaba-catalog-sync',
      routePath: '/api/alibaba-catalog-sync',
      // The sync runner's 720s soft deadline needs the SCF event ceiling; the
      // gateway's interactive routes answer fast regardless (ARCHITECTURE §10).
      timeout: 900,
      memorySize: 512,
      envVariables: envEntries({
        TCB_ENV: ctx.envId,
        APP_ENV: ctx.appEnv,
        // Shared session secret: OAuth-start/run/link actions revalidate admin
        // sessions exactly like the other functions (R1 H3).
        JWT_SECRET: ctx.requireEnv('JWT_SECRET'),
        CORS_ALLOWED_ORIGINS: ctx.corsAllowedOrigins,
        SITE_URL: ctx.siteUrl,
        // Feature secrets are OPTIONAL: cold start + /health never need them
        // and the function fails closed to not_configured (R1 L7/L12).
        ALI_APP_KEY: ctx.optionalEnv('ALI_APP_KEY'),
        ALI_APP_SECRET: ctx.optionalEnv('ALI_APP_SECRET'),
        ALI_OAUTH_CALLBACK_URL: ctx.optionalEnv('ALI_OAUTH_CALLBACK_URL'),
        ALI_TOKEN_ENCRYPTION_KEY_V1: ctx.optionalEnv('ALI_TOKEN_ENCRYPTION_KEY_V1'),
        WECOM_WEBHOOK_URL: ctx.optionalEnv('WECOM_WEBHOOK_URL'),
        ALI_AUTHORIZE_BASE_URL: ctx.optionalEnv('ALI_AUTHORIZE_BASE_URL'),
        ALI_API_BASE_URL: ctx.optionalEnv('ALI_API_BASE_URL'),
      }),
    },
  ];
}

/**
 * Timer DESIRED STATE (ARCHITECTURE §14.1).
 *
 * There is ONE environment and it serves the live site, so the old
 * "test must never carry a timer / production applies its own" split does not
 * exist. This object is the single source of truth the deploy RECONCILES
 * against: a trigger listed here is created if missing, and any trigger NOT
 * listed here is removed. Same desired-state model the manifest already uses
 * for routes, timeouts and env.
 *
 * Currently EMPTY for every function — deliberately. Sync runs only when an
 * operator clicks "Run now" until a manual run has completed cleanly against
 * the real supplier account (§14.1). This is a rollout decision, not a
 * limitation: enabling the timer is now a one-line change here plus a redeploy,
 * and the deploy verifies the result instead of forbidding it.
 *
 * To turn sync on automatically, move the entry below into DESIRED and deploy.
 */
export const DESIRED_TIMER_TRIGGERS = {
  // 'alibaba-catalog-sync': [ALIBABA_SYNC_TIMER],
};

/** The 15-minute tick §10 specifies, kept declared so enabling it is one edit. */
export const ALIBABA_SYNC_TIMER = {
  name: 'alibaba-sync-tick',
  type: 'timer',
  config: '0 */15 * * * * *',
};

/** Triggers this function should carry; [] means "none, and remove any found". */
export function desiredTriggersFor(functionName) {
  return DESIRED_TIMER_TRIGGERS[functionName] ?? [];
}
