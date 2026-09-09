/**
 * The import run itself: parse a source file, stage what it found, and report
 * what changed since last time.
 *
 * Ordering matters and is deliberate. The job row is written BEFORE the parse,
 * so a workbook that defeats the parser still leaves evidence of the attempt
 * rather than vanishing. A byte-identical re-upload stops at that first step
 * and returns the original job untouched: re-importing the same file is a
 * no-op unless an operator explicitly asks for a replay.
 */
import type { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { CatalogImportDetail } from '@vibelingan-channel/catalog-import';
import { parseDianxiaomiWorkbook } from '@vibelingan-channel/catalog-import/dianxiaomi';
import { mediaStorage } from '@vibelingan-channel/media-storage';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import {
  ImportSourceEvidenceAttachUncertainError,
  failImportJobEvidence,
  listStoreLinksForProvider,
  recordImportSourceEvidence,
  recordParsedBundle,
  startImportJob,
} from './catalog-import-store.ts';

export interface RunImportInput {
  bytes: Buffer;
  sourceFileName: string;
  /** Re-import the same bytes as a new job instead of reusing the old one. */
  replay?: boolean;
  settings?: Record<string, unknown>;
  now?: string;
}

export interface RunImportResult {
  job: CollectionDoc;
  detail: CatalogImportDetail;
  /** True when the file had already been imported and nothing was re-staged. */
  reused: boolean;
}

/**
 * Parse and stage one source file.
 *
 * Only the Dianxiaomi workbook collector exists today, so the provider is
 * fixed here. Other acquisition transports keep their own orchestration and
 * converge on the validated source-observation contract after collection.
 */
export async function runCatalogImport(input: RunImportInput): Promise<RunImportResult> {
  const now = input.now ?? new Date().toISOString();
  const sourceFileSha256 = createHash('sha256').update(input.bytes).digest('hex');

  const started = await startImportJob({
    provider: 'dianxiaomi',
    sourceFileName: input.sourceFileName,
    sourceFileSha256,
    sourceByteSize: input.bytes.length,
    now,
    ...(input.settings === undefined ? {} : { settings: input.settings }),
    ...(input.replay === undefined ? {} : { replay: input.replay }),
  });

  let job = started.job;
  if (started.reused && job.status === 'created') {
    throw new Error(
      'this source import is already in progress; retry as an explicit replay if stale',
    );
  }
  if (
    started.reused &&
    job.status === 'failed' &&
    String(job.failureCode).startsWith('source-evidence-')
  ) {
    throw new Error('the previous source evidence write failed; retry as an explicit replay');
  }
  if (typeof job.sourceStorageFileId !== 'string' || job.sourceStorageFileId === '') {
    const jobObjectSha256 = createHash('sha256').update(job._id).digest('hex');
    let stored: Awaited<ReturnType<ReturnType<typeof mediaStorage>['putObject']>>;
    try {
      stored = await mediaStorage().putObject({
        namespace: 'catalog-import-raw',
        logicalId: sourceFileSha256,
        fileName: `${jobObjectSha256}.xlsx`,
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        content: input.bytes,
      });
    } catch (error) {
      await failImportJobEvidence(job._id, now, 'source-evidence-write-failed');
      throw new Error('catalog import source evidence could not be stored', { cause: error });
    }
    try {
      job = await recordImportSourceEvidence(
        job._id,
        {
          storageFileId: stored.storageFileId,
          storagePath: stored.storagePath,
          storageProvider: stored.storageProvider,
          storageMode: stored.storageMode,
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        },
        now,
      );
    } catch (error) {
      if (error instanceof ImportSourceEvidenceAttachUncertainError) {
        // The attach may already be durable. Preserve the only exact workbook
        // object and leave an operator-visible repair pointer when the database
        // accepts it; a second DB outage is logged but never turns uncertainty
        // into a destructive delete.
        console.error('[catalog-import] source evidence attachment uncertain; object retained', {
          jobId: job._id,
          storageFileId: stored.storageFileId,
          storagePath: stored.storagePath,
        });
        try {
          await failImportJobEvidence(
            job._id,
            now,
            'source-evidence-attach-uncertain-object-retained',
            {
              retainedSourceStorageFileId: stored.storageFileId,
              retainedSourceStoragePath: stored.storagePath,
            },
          );
        } catch (recordError) {
          console.error(
            '[catalog-import] could not record uncertain source evidence attachment',
            recordError,
          );
        }
        throw new Error(
          'catalog import source evidence attachment could not be confirmed; object retained',
          { cause: error },
        );
      }
      let cleanupFailed = false;
      try {
        await mediaStorage().deleteObject(stored.storageFileId);
      } catch {
        cleanupFailed = true;
      }
      await failImportJobEvidence(
        job._id,
        now,
        cleanupFailed
          ? 'source-evidence-attach-failed-object-retained'
          : 'source-evidence-attach-failed',
        cleanupFailed
          ? {
              orphanedSourceStorageFileId: stored.storageFileId,
              orphanedSourceStoragePath: stored.storagePath,
            }
          : {},
      );
      throw new Error(
        cleanupFailed
          ? 'catalog import source evidence could not be attached and cleanup failed'
          : 'catalog import source evidence could not be attached',
        { cause: error },
      );
    }
  }

  const detail = parseDianxiaomiWorkbook(input.bytes);
  if (detail.bundle.sourceFileSha256 !== sourceFileSha256) {
    throw new Error('catalog import parser digest disagrees with acquisition digest');
  }

  if (started.reused && job.status !== 'created') return { job, detail, reused: true };

  const recorded = await recordParsedBundle(job._id, detail, now);
  return { job: recorded, detail, reused: false };
}

// ---------------------------------------------------------------------------
// Repeat-import delta
// ---------------------------------------------------------------------------

export type DeltaKind = 'added' | 'changed' | 'unchanged' | 'sourceMissing';

export interface DeltaEntry {
  kind: DeltaKind;
  sourceVariantKey: string;
  storeKey: string;
  sku: string;
  /** Source-owned fields whose values moved, with before and after. */
  changes: { field: string; before: unknown; after: unknown }[];
}

export interface ImportDelta {
  added: DeltaEntry[];
  changed: DeltaEntry[];
  unchanged: DeltaEntry[];
  /**
   * Records that exist in the catalog but are absent from this file. NEVER
   * deleted or unpublished here: a merchant exporting one shop by mistake must
   * not take the other three shops' products off the website.
   */
  sourceMissing: DeltaEntry[];
  /**
   * False when the file could not be fully interpreted. A partial or invalid
   * workbook can say "here is what I found"; it can never say "everything else
   * is gone", so `sourceMissing` stays empty.
   */
  completeSource: boolean;
}

/** The fields a source import owns. Everything else belongs to the operator. */
const SOURCE_OWNED_LINK_FIELDS = [
  'sourceListingStatus',
  'sourceRegularPrice',
  'sourcePromotionPrice',
  'quantity',
  'externalProductId',
  'externalVariantId',
] as const;

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined && b === '') return true;
  if (a === '' && b === undefined) return true;
  // Money and snapshot objects: compare by value, not identity.
  if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

/**
 * Compare a freshly parsed file against the source state already stored.
 *
 * The comparison is on STORE lines, because that is the granularity at which
 * a source actually reports: one shop changing its price for one SKU is one
 * change, not a whole product rewritten.
 */
export async function computeImportDelta(detail: CatalogImportDetail): Promise<ImportDelta> {
  const stored = await listStoreLinksForProvider(detail.bundle.provider);
  const storedByKey = new Map(
    stored.map((doc) => [String(doc.sourceVariantKey ?? ''), doc] as const),
  );

  const added: DeltaEntry[] = [];
  const changed: DeltaEntry[] = [];
  const unchanged: DeltaEntry[] = [];
  const seen = new Set<string>();

  for (const listing of detail.storeListings) {
    seen.add(listing.sourceVariantKey);
    const previous = storedByKey.get(listing.sourceVariantKey);
    const base = {
      sourceVariantKey: listing.sourceVariantKey,
      storeKey: listing.storeKey,
      sku: listing.sku,
    };
    if (previous === undefined) {
      added.push({ kind: 'added', ...base, changes: [] });
      continue;
    }
    const changes = SOURCE_OWNED_LINK_FIELDS.flatMap((field) => {
      const before = previous[field];
      const after = (listing as unknown as Record<string, unknown>)[field];
      return sameValue(before, after) ? [] : [{ field, before, after }];
    });
    if (changes.length === 0) {
      unchanged.push({ kind: 'unchanged', ...base, changes: [] });
    } else {
      changed.push({ kind: 'changed', ...base, changes });
    }
  }

  // A structurally invalid file proves nothing about what is missing.
  const completeSource = detail.structurallyValid;
  const sourceMissing: DeltaEntry[] = completeSource
    ? stored
        .filter((doc) => !seen.has(String(doc.sourceVariantKey ?? '')))
        .map((doc) => ({
          kind: 'sourceMissing' as const,
          sourceVariantKey: String(doc.sourceVariantKey ?? ''),
          storeKey: String(doc.storeKey ?? ''),
          sku: String(doc.sku ?? ''),
          changes: [],
        }))
    : [];

  return { added, changed, unchanged, sourceMissing, completeSource };
}
