/** Pure source input hashes and complete-capture pairing; no storage writes. */
import { createHash } from 'node:crypto';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { alibabaPricingFingerprint } from './alibaba-pricing-fingerprint.ts';
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const sourceFields = [
  '_id',
  'sourceKey',
  'connectionId',
  'sourceProductId',
  'sourceTitle',
  'sourceDescription',
  'sourceCategoryId',
  'sourceCategoryPath',
  'sourceImageUrls',
  'active',
  'sourceUpdatedAt',
  'contentHash',
] as const;
export function sourceBindingHash(source: CollectionDoc): string {
  return alibabaPricingFingerprint([
    'catalog-source-binding-v1',
    Object.fromEntries(sourceFields.map((field) => [field, source[field]])),
  ]);
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  const object = record(value);
  if (!object) return value;
  return Object.fromEntries(
    Object.keys(object)
      .sort()
      .map((key) => [key, stable(object[key])]),
  );
}

/** Capture timestamps and raw evidence IDs do not change the effective source input. */
export function sourceInputDigest(row: CollectionDoc | null): string {
  const observation = record(row?.observation);
  const source = record(observation?.source);
  const { observedAt: _at, ...identity } = source ?? {};
  const { evidence: _evidence, source: _source, ...content } = observation ?? {};
  return createHash('sha256')
    .update(
      JSON.stringify(
        stable({
          active: row?.active !== false,
          ...(row?.sourceContentHash === undefined
            ? {}
            : { sourceContentHash: row.sourceContentHash }),
          ...(row?.sourceContentHash === undefined && row?.evidenceId !== undefined
            ? { legacyEvidenceId: row.evidenceId }
            : {}),
          observation: observation ? { ...content, source: identity } : null,
        }),
      ),
    )
    .digest('hex');
}

export function normalizedSourceInputDigest(row: CollectionDoc | null): string {
  return row
    ? sourceBindingHash(row)
    : alibabaPricingFingerprint(['catalog-source-binding-v1', null]);
}

/** New captures pair by business hash; older captures pair by exact raw evidence. */
export function sourceCaptureMatches(source: CollectionDoc, row: CollectionDoc): boolean {
  if ((source.active === false) !== (row.active === false)) return false;
  if (row.sourceContentHash !== undefined)
    return (
      typeof row.sourceContentHash === 'string' &&
      /^[a-f0-9]{64}$/.test(row.sourceContentHash) &&
      row.sourceContentHash === source.contentHash
    );
  if (source.contentHash !== undefined) {
    if (typeof source.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(source.contentHash))
      return false;
    return (
      typeof source.payloadId === 'string' &&
      source.payloadId.length > 0 &&
      row.evidenceId === source.payloadId
    );
  }
  return true;
}
