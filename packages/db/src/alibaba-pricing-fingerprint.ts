import { createHash } from 'node:crypto';

/** Stable fingerprints for read plans; field absence remains distinct from null. */
export function alibabaPricingFingerprint(value: unknown): string {
  const canonical = (entry: unknown): string => {
    if (entry === null || typeof entry !== 'object') return JSON.stringify(entry) ?? 'null';
    if (Array.isArray(entry)) return `[${entry.map(canonical).join(',')}]`;
    const row = entry as Record<string, unknown>;
    return `{${Object.keys(row)
      .filter((key) => row[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`)
      .join(',')}}`;
  };
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export interface AlibabaPricingEvidenceExpectation {
  collection: 'alibabaSourceProducts' | 'alibabaSupplierOffers' | 'alibabaSyncRuns';
  id: string;
  hash: string;
}
