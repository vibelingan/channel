/**
 * Cursor-paged materialization of current Alibaba source rows into canonical
 * unpublished product drafts.
 *
 * This is an idempotent recovery/operations surface, not a second importer:
 * ordinary full and incremental runs call the same createDraftForSource()
 * primitive after their quarantine gate. The page action exists so source
 * mirrors created before draft materialization was enabled can catch up
 * without repeating 1,074 provider detail calls.
 */
import { get, list } from '@vibelingan-channel/db';
import { createAlibabaCategoryResolver, createDraftForSource } from './linking.ts';
import {
  type PricingMaterializationOutcome,
  materializeCompletedProductPricing,
} from './pricing-repair.ts';

export const DRAFT_MATERIALIZATION_PAGE_MAX = 20;

export interface DraftMaterializationPageInput {
  afterSourceKey?: string;
  limit?: number;
  sourceCategoryId?: string;
  now?: () => string;
  /** Background catch-up never materializes unapproved or incomplete source runs. */
  completedOnly?: boolean;
  runId?: string;
  onPrepared?: (sourceKey: string) => Promise<void>;
}

export interface DraftMaterializationFailure {
  sourceKey: string;
  reason: Extract<Awaited<ReturnType<typeof createDraftForSource>>, { ok: false }>['reason'];
}

export interface DraftMaterializationPageResult {
  afterSourceKey: string;
  nextSourceKey: string;
  done: boolean;
  visited: number;
  created: number;
  existing: number;
  failures: DraftMaterializationFailure[];
  pricing: PricingMaterializationOutcome[];
}

export async function materializeAlibabaDraftPage(
  input: DraftMaterializationPageInput,
): Promise<DraftMaterializationPageResult> {
  const afterSourceKey = input.afterSourceKey?.trim() ?? '';
  const limit = Math.min(
    DRAFT_MATERIALIZATION_PAGE_MAX,
    Math.max(1, Math.trunc(input.limit ?? DRAFT_MATERIALIZATION_PAGE_MAX)),
  );
  const sourceCategoryId = input.sourceCategoryId?.trim() ?? '';
  const clauses = [
    { field: 'active', op: 'eq' as const, value: true },
    ...(input.runId ? [{ field: 'lastSeenRunId', op: 'eq' as const, value: input.runId }] : []),
    ...(afterSourceKey ? [{ field: '_id', op: 'gt' as const, value: afterSourceKey }] : []),
    ...(sourceCategoryId
      ? [{ field: 'sourceCategoryId', op: 'eq' as const, value: sourceCategoryId }]
      : []),
  ];
  const page = await list({
    collection: 'alibabaSourceProducts',
    page: 1,
    pageSize: limit,
    search: '',
    sort: [{ field: '_id', dir: 'asc' }],
    filter: { combinator: 'and', clauses },
  });

  let created = 0;
  let existing = 0;
  const failures: DraftMaterializationFailure[] = [];
  const pricing: PricingMaterializationOutcome[] = [];
  const now = input.now ?? (() => new Date().toISOString());
  const resolveCategory = createAlibabaCategoryResolver();
  for (const source of page.items) {
    if (input.completedOnly) {
      const run =
        typeof source.lastSeenRunId === 'string'
          ? await get('alibabaSyncRuns', source.lastSeenRunId)
          : null;
      if (!run || !['completed', 'approved'].includes(String(run.status))) continue;
    }
    const result = await createDraftForSource(source._id, { now: now(), resolveCategory });
    if (!result.ok) {
      failures.push({ sourceKey: source._id, reason: result.reason });
    } else if (result.created) {
      created += 1;
    } else {
      existing += 1;
    }
    if (result.ok) {
      pricing.push(await materializeCompletedProductPricing(result.productId));
      await input.onPrepared?.(source._id);
    }
  }

  const last = page.items.at(-1);
  return {
    afterSourceKey,
    nextSourceKey: last?._id ?? afterSourceKey,
    done: page.items.length < limit,
    visited: page.items.length,
    created,
    existing,
    failures,
    pricing,
  };
}
