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
  /**
   * Local harness mode — ONE switch for everything that must never face the
   * public internet.
   *
   * It controls three things together, because they are one decision: the
   * hand-driving page at `/dev/chat`, the conversation route `/api/ai/chat`,
   * and permission to serve with unmet engine guarantees.
   *
   * They were three separate conditions before, and that was the bug: the chat
   * route registered whenever an engine happened to be injected, so hiding the
   * page did nothing. A route with no rate limiting, no admission control, no
   * persistence and no takeover fence must be one flag away from existing at
   * all, not three independent ones.
   *
   * Production cannot turn it on. `loadConfig` refuses to return at all when
   * this is set in a production environment.
   */
  localHarness: boolean;
}

export interface EngineConfig {
  baseUrl: string;
  apiKey: string;
  workspaceSlug: string;
  engineVersion: string;
  /**
   * The engine's own generated-token ceiling. The only bound the vendor
   * honours, and therefore the only honest input to a cost model — see
   * LLD-002's output-limits table.
   */
  vendorMaxOutputTokens?: number;
}

export class ConfigError extends Error {
  constructor(missing: string[]) {
    super(
      `refusing to start; missing or invalid configuration:\n${missing.map((m) => `  - ${m}`).join('\n')}`,
    );
    this.name = 'ConfigError';
  }
}

/**
 * Whether this process considers itself production.
 *
 * Two independent signals, and EITHER one is enough. A deployment that sets
 * only `APP_ENV=production` is production; so is one that sets only
 * `NODE_ENV=production`. Requiring both to agree would mean a single missing
 * variable silently downgrades a production service into one that will accept
 * the harness flag.
 */
export function isProductionEnv(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV?.trim() === 'production' || env.APP_ENV?.trim() === 'production';
}

/**
 * The engine's advertised generation ceiling, validated.
 *
 * `Number(x) ? …` accepted "4096abc" as 4096 and silently dropped 0, -1 and
 * "many". This value is what the cost model multiplies by, so a wrong one is a
 * wrong budget rather than a crash.
 */
function vendorCeiling(
  raw: string | undefined,
  problems: string[],
): { vendorMaxOutputTokens?: number } {
  const text = raw?.trim();
  if (!text) return {};
  const value = Number(text);
  if (!Number.isInteger(value) || value <= 0) {
    problems.push(`ANYTHINGLLM_MAX_TOKENS must be a positive integer, got: ${text}`);
    return {};
  }
  return { vendorMaxOutputTokens: value };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BffConfig {
  const problems: string[] = [];

  const localHarness = env.AI_LOCAL_HARNESS?.trim() === '1';
  if (localHarness && isProductionEnv(env)) {
    // Refusing to start, rather than ignoring the flag. Silently downgrading
    // would leave an operator believing the harness is on while the assistant
    // answers nobody, and would make the same image behave differently
    // depending on a variable nobody is looking at.
    problems.push(
      'AI_LOCAL_HARNESS=1 in a production environment. The harness exposes an ' +
        'unauthenticated conversation route with no rate limiting and permits ' +
        'serving with unmet engine guarantees. It is local-only, and production ' +
        'refuses rather than quietly ignoring it.',
    );
  }

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
        ...vendorCeiling(env.ANYTHINGLLM_MAX_TOKENS, problems),
      };
    }
  }

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    port,
    databaseUrl: databaseUrl as string,
    corsAllowedOrigins: origins,
    localHarness,
    ...(engine ? { engine } : {}),
  };
}
