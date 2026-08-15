/**
 * The closed error taxonomy (LLD-002 §6).
 *
 * Adapters map every vendor failure into this set. The BFF branches on the
 * category and never on a vendor message — that is what keeps a vendor swap
 * from rippling into business logic.
 */

export const ENGINE_ERROR_CATEGORIES = [
  /** Network blip, 5xx, stream reset. The adapter already retried its transport. */
  'transient',
  /** Exceeded `maxStreamDurationMs`. */
  'timeout',
  /** Budget or rate ceiling at the vendor. */
  'quota',
  /** Engine or knowledge source down. */
  'unavailable',
  /** The BFF built a bad request. A bug, not a visitor problem. */
  'invalid_request',
  /** The vendor refused to produce output. */
  'content_filtered',
  /** No grounding evidence found. */
  'knowledge_empty',
] as const;

export type EngineErrorCategory = (typeof ENGINE_ERROR_CATEGORIES)[number];

export function isEngineErrorCategory(value: unknown): value is EngineErrorCategory {
  return (
    typeof value === 'string' && (ENGINE_ERROR_CATEGORIES as readonly string[]).includes(value)
  );
}

/**
 * Whether a category is worth another business-level attempt.
 *
 * This is advice for the BFF, not permission for the adapter: LLD-002 §8 rule 3
 * forbids an adapter from re-creating a run under any circumstances, because a
 * duplicate run defeats the fence LLD-001 counts on. Transport-level retry
 * inside one attempt is the adapter's business; a second run is never.
 */
export function isRetriableCategory(category: EngineErrorCategory): boolean {
  return category === 'transient' || category === 'timeout';
}

/**
 * A vendor failure, normalized. `safeDetail` is a short operator-facing string
 * and is bound by SECURITY.md §7's log rules: no stack traces, prompts,
 * credentials, hostnames, or retrieved document bodies.
 */
export class EngineError extends Error {
  readonly category: EngineErrorCategory;
  readonly retriable: boolean;
  readonly safeDetail: string | undefined;

  constructor(
    category: EngineErrorCategory,
    options: { safeDetail?: string; retriable?: boolean } = {},
  ) {
    super(`engine error: ${category}`);
    this.name = 'EngineError';
    this.category = category;
    this.retriable = options.retriable ?? isRetriableCategory(category);
    this.safeDetail = options.safeDetail;
  }
}
