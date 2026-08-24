/**
 * Public-read product normalizer (docs/catalog-architecture-hardening, MIU 3).
 *
 * `normalizePublicProduct(row)` is an immutable public-read transformation from
 * a raw catalog row to the canonical MIU 02 `PublicProduct` input. It returns
 * the canonical value plus diagnostics, or a fail-closed rejection. It never
 * mutates the source row, never guesses a family, and never normalizes
 * Admin/write contracts (role-gated and server-side keys are stripped, not
 * carried). Consumed only by the Public API projection.
 */
import {
  type ProductFamily,
  isLegacyHeadphonesCategory,
  isProductFamily,
} from '../catalog-product.ts';
import { type PublicProduct, PublicProductSchema } from './index.ts';

export interface PublicProductNormalizationIssue {
  field: string;
  code: string;
  message: string;
}

export interface PublicProductNormalizationDiagnostic {
  code: 'inferred-family-from-legacy-category' | 'dropped-stale-legacy-category';
  message: string;
}

export type NormalizedPublicProductResult =
  | { ok: true; value: PublicProduct; diagnostics: PublicProductNormalizationDiagnostic[] }
  | { ok: false; issues: PublicProductNormalizationIssue[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Supplier offer identifiers never ship (a visitor could locate the source listing and buy direct). */
const ALIBABA_PRICING_PRIVATE_KEYS = ['sourceOfferKey', 'sourceProductId', 'sourceSkuId'] as const;

/** Public sub-projection of Alibaba pricing: strip supplier offer identifiers. */
function publicAlibabaCatalogPricing(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if ((ALIBABA_PRICING_PRIVATE_KEYS as readonly string[]).includes(key)) continue;
    out[key] = entry;
  }
  return out;
}

/** Ship a constant 'linked' marker, never the brute-forceable source key. */
function publicAlibabaSourceKey(value: unknown): unknown {
  return typeof value === 'string' && value !== '' ? 'linked' : value;
}

/**
 * Public-projection optional keys (mirrors the public allowlist semantics).
 * Role-gated (`vipPrice`), server-side (`imageIds`), and Admin/write-only keys
 * are deliberately absent, so they are stripped rather than carried into the
 * public shape.
 */
const PUBLIC_OPTIONAL_KEYS = [
  'category',
  'series',
  'modName',
  'modType',
  'description',
  'productCode',
  'skuCode',
  'slug',
  'moq',
  'inventory',
  'unitPrice',
  'wholesalePrice',
  'clearancePrice',
  'published',
  'images',
  'manualCatalogPricing',
  'alibabaPrimarySourceKey',
  'alibabaCatalogPricing',
  'alibabaSourceStatus',
  'alibabaSourceLastSyncedAt',
] as const;

export function normalizePublicProduct(row: unknown): NormalizedPublicProductResult {
  if (!isRecord(row)) {
    return {
      ok: false,
      issues: [{ field: '', code: 'not-an-object', message: 'A product row must be an object' }],
    };
  }

  // Resolve the canonical family. An explicit family wins; a missing family
  // infers Headphones ONLY from a recognized legacy category; anything else is
  // a fail-closed rejection (never guess). An explicit-but-invalid family is a
  // distinct rejection from a missing one.
  let family: ProductFamily;
  const diagnostics: PublicProductNormalizationDiagnostic[] = [];
  if (Object.hasOwn(row, 'productFamily')) {
    if (!isProductFamily(row.productFamily)) {
      return {
        ok: false,
        issues: [
          {
            field: 'productFamily',
            code: 'invalid-family',
            message: `Explicit productFamily '${String(row.productFamily)}' is not a canonical family`,
          },
        ],
      };
    }
    family = row.productFamily;
  } else if (isLegacyHeadphonesCategory(row.category)) {
    family = 'headphones';
    diagnostics.push({
      code: 'inferred-family-from-legacy-category',
      message: `productFamily missing; inferred 'headphones' from legacy category '${String(row.category)}'`,
    });
  } else {
    return {
      ok: false,
      issues: [
        {
          field: 'productFamily',
          code: 'missing-family',
          message:
            'Cannot determine canonical productFamily (no explicit family and no recognized legacy category)',
        },
      ],
    };
  }

  // Build the canonical public candidate immutably (never write back to row).
  // A stale legacy category on a non-Headphones row is dropped (subcategory
  // applies only to Headphones), surfaced as a diagnostic.
  const candidate: Record<string, unknown> = {
    _id: row._id,
    name: row.name,
    productFamily: family,
  };
  for (const key of PUBLIC_OPTIONAL_KEYS) {
    if (key === 'category' && family !== 'headphones') {
      if (Object.hasOwn(row, 'category')) {
        diagnostics.push({
          code: 'dropped-stale-legacy-category',
          message: `Dropped category '${String(row.category)}' (subcategory applies only to Headphones)`,
        });
      }
      continue;
    }
    if (!Object.hasOwn(row, key)) continue;
    if (key === 'alibabaCatalogPricing') {
      candidate[key] = publicAlibabaCatalogPricing(row[key]);
    } else if (key === 'alibabaPrimarySourceKey') {
      candidate[key] = publicAlibabaSourceKey(row[key]);
    } else {
      candidate[key] = row[key];
    }
  }

  // Fail-closed validation against the MIU 02 public contract.
  const parsed = PublicProductSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        field: issue.path.join('.'),
        code: issue.code,
        message: issue.message,
      })),
    };
  }

  return { ok: true, value: parsed.data, diagnostics };
}
