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
import { list } from '@vibelingan-channel/db';
import { createDraftForSource } from './linking.ts';

export const DRAFT_MATERIALIZATION_PAGE_MAX = 20;

export interface DraftMaterializationPageInput {
  afterSourceKey?: string;
  limit?: number;
  sourceCategoryId?: string;
  now?: () => string;
}

export interface DraftMaterializationFailure {
  sourceKey: string;
  reason: 'source-not-found' | 'linked-elsewhere';
}

export interface DraftMaterializationPageResult {
  afterSourceKey: string;
  nextSourceKey: string;
  done: boolean;
  visited: number;
  created: number;
  existing: number;
  failures: DraftMaterializationFailure[];
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
  const now = input.now ?? (() => new Date().toISOString());
  for (const source of page.items) {
    const result = await createDraftForSource(source._id, { now: now() });
    if (!result.ok) {
      failures.push({ sourceKey: source._id, reason: result.reason });
    } else if (result.created) {
      created += 1;
    } else {
      existing += 1;
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
  };
}
