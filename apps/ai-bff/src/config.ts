/**
 * Startup configuration. Every value is required or refused — nothing here
 * falls back to a permissive default.
 *
 * This codebase has the opposite pattern in production already: the public
 * catalog treats a missing JWT_SECRET as "anonymous viewer" and serves on. That
 * is the right call for a catalog and the wrong one here, where the equivalent
 * would be an assistant with no knowledge source answering from the model's own
 * memory — the single outcome SECURITY.md forbids outright.
 */

export interface BffConfig {
  port: number;
  databaseUrl: string;
  /** Exact origins allowed to call this service. The widget is cross-origin. */
  corsAllowedOrigins: string[];
  /**
   * Absent means the conversation route is disabled and says so. The service
   * still starts, because liveness, readiness and the deploy path must remain
   * verifiable without a configured engine.
   */
  engine?: EngineConfig;
}

export interface EngineConfig {
  baseUrl: string;
  apiKey: string;
  workspaceSlug: string;
  engineVersion: string;
  /**
   * Serve even though the startup capability gate found unmet guarantees.
   *
   * The gate is real and stays on: this engine family has no idempotent create
   * and no run lookup, and the compensating machinery for both is LLD-001 §7
   * work that does not exist yet. Until it does, production must refuse. Local
   * development needs to run anyway, so the bypass is explicit, named unsafe,
   * never defaulted on, and prints every refusal it is stepping over.
   */
  allowUngated: boolean;
}

export class ConfigError extends Error {
  constructor(missing: string[]) {
    super(
      `refusing to start; missing or invalid configuration:\n${missing.map((m) => `  - ${m}`).join('\n')}`,
    );
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BffConfig {
  const problems: string[] = [];

  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) problems.push('DATABASE_URL is not set');

  const rawPort = env.PORT?.trim() ?? '8080';
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    problems.push(`PORT is not a valid port number: ${rawPort}`);
  }

  // The assistant is served from its own hostname (architecture §6), so the
  // widget always calls cross-origin and CORS is load-bearing rather than
  // incidental. An empty list is a refusal, not a permissive default: '*' with
  // credentials is exactly the mistake this check exists to prevent.
  const origins = (env.CORS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  if (origins.length === 0) problems.push('CORS_ALLOWED_ORIGINS is empty');
  if (origins.includes('*'))
    problems.push("CORS_ALLOWED_ORIGINS contains '*', which is never valid here");

  // The engine block is all-or-nothing: a half-configured engine would fail at
  // the first visitor instead of at startup.
  const engineFields = {
    baseUrl: env.ANYTHINGLLM_BASE_URL?.trim(),
    apiKey: env.ANYTHINGLLM_API_KEY?.trim(),
    workspaceSlug: env.ANYTHINGLLM_WORKSPACE?.trim(),
  };
  const providedFields = Object.entries(engineFields).filter(([, v]) => v);
  let engine: EngineConfig | undefined;
  if (providedFields.length > 0) {
    const missing = Object.entries(engineFields)
      .filter(([, v]) => !v)
      .map(([k]) => k);
    if (missing.length > 0) {
      problems.push(`engine is partially configured; missing: ${missing.join(', ')}`);
    } else {
      engine = {
        baseUrl: engineFields.baseUrl as string,
        apiKey: engineFields.apiKey as string,
        workspaceSlug: engineFields.workspaceSlug as string,
        engineVersion: env.ANYTHINGLLM_VERSION?.trim() || 'unpinned',
        allowUngated: env.AI_DEV_UNSAFE_ALLOW_UNGATED_ENGINE === '1',
      };
    }
  }

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    port,
    databaseUrl: databaseUrl as string,
    corsAllowedOrigins: origins,
    ...(engine ? { engine } : {}),
  };
}
