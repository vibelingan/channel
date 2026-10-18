/** Safe catalog diagnostics: field names and measurements, never rejected values or messages. */
import { type ZodIssue, z } from 'zod';

const fields = new Set(
  `data field product source schemaVersion _id id name slug description descriptionText
facts value specifications packaging notes noteBlocks content kind text variants items total page pageSize
hasMore sku options images imageIds descriptionImages descriptionImageIds offers pricing currency mode
basis amountMinor unitAmountMinor minimumQuantity maximumQuantity minimumOrderQuantity tiers inventory
quantity semantics state position productId productFamily category subcategoryIds configurationPhotos
provider accountKey observedAt captureMode completeness externalProductId
sourceProductKey sourceVariantKey sourceOfferKey sourceName sourceUrl media identity attributes lifecycle
evidence warnings sourceTitle sourceCategoryId sourceImageUrls detailSourceCandidate detailSourceManifest
variantIds revision expectedRevision expectedDigest operationId catalogContentGeneration
catalogLifecycleVersion catalogClassificationRevision supplierMedia gallery unboundSources sources
configurationRowIds catalogPricingMode manualCatalogPricing unitPrice wholesalePrice moq skuCode series
modName modType active archived published websitePricing actorId contentGeneration expectedBinding observationDigest galleryDigest header priceSummary variantCount variantImageIds variantStorage
optionValues detailSourceOwner detailSourceMissing detailSourceReady detailSourceRevision
detailSourceContentCandidate detailSourceNoteBlocksCandidate`.split(/\s+/),
);

function safePath(parts: readonly (string | number)[]): string {
  const segments = parts.slice(0, 12).map((part) => {
    if (typeof part === 'number')
      return Number.isSafeInteger(part) && part >= 0 && part < 10000 ? String(part) : 'field';
    return fields.has(part) ? part : 'field';
  });
  while (segments.join('.').length > 200) segments.pop();
  return segments.join('.') || 'data';
}

const count = z.number().int().nonnegative().safe();
const measurement = z.number().finite().safe();
export const CatalogIssueSchema = z
  .object({
    code: z.enum([
      'REQUIRED',
      'INVALID_VALUE',
      'TOO_LONG',
      'TOO_MANY',
      'TOO_LARGE',
      'SOURCE_NOT_READY',
      'MISSING_CATEGORY',
      'MEDIA_NOT_READY',
      'MEDIA_BUSY',
      'INPUT_BUSY',
      'INPUT_CHANGED',
      'APPROVAL_EXPIRED',
      'FORBIDDEN',
      'NOT_FOUND',
    ]),
    stage: z.enum(['source', 'effective-content', 'classification', 'media', 'commit']),
    path: z
      .string()
      .min(1)
      .max(200)
      .refine((value) => {
        const parts = value.split('.');
        return (
          parts.length <= 12 &&
          parts.every((part) => fields.has(part) || /^(0|[1-9]\d{0,3})$/.test(part))
        );
      }),
    severity: z.enum(['error', 'warning']),
    remedy: z.enum([
      'edit',
      'classify',
      'retry-media',
      'retry',
      'resync',
      'review-change',
      'system-repair',
      'reload',
      'sign-in',
    ]),
    expected: z
      .object({
        maxChars: count.optional(),
        minChars: count.optional(),
        maxCount: count.optional(),
        minCount: count.optional(),
        maxBytes: count.optional(),
        minValue: measurement.optional(),
        maxValue: measurement.optional(),
      })
      .strict()
      .optional(),
    observed: z
      .object({ chars: count.optional(), count: count.optional(), bytes: count.optional() })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((issue, context) => {
    if (issue.code === 'TOO_LONG' && issue.expected?.maxChars === undefined)
      context.addIssue({
        code: 'custom',
        path: ['expected', 'maxChars'],
        message: 'Length limit required',
      });
    if (issue.code === 'TOO_MANY' && issue.expected?.maxCount === undefined)
      context.addIssue({
        code: 'custom',
        path: ['expected', 'maxCount'],
        message: 'Count limit required',
      });
    if (
      issue.code === 'TOO_LONG' &&
      issue.expected?.maxChars !== undefined &&
      issue.observed?.chars !== undefined &&
      issue.observed.chars <= issue.expected.maxChars
    )
      context.addIssue({
        code: 'custom',
        path: ['observed', 'chars'],
        message: 'Length does not exceed limit',
      });
    if (
      issue.code === 'TOO_MANY' &&
      issue.expected?.maxCount !== undefined &&
      issue.observed?.count !== undefined &&
      issue.observed.count <= issue.expected.maxCount
    )
      context.addIssue({
        code: 'custom',
        path: ['observed', 'count'],
        message: 'Count does not exceed limit',
      });
    if (
      issue.code === 'TOO_LARGE' &&
      issue.expected?.maxBytes !== undefined &&
      issue.observed?.bytes !== undefined &&
      issue.observed.bytes <= issue.expected.maxBytes
    )
      context.addIssue({
        code: 'custom',
        path: ['observed', 'bytes'],
        message: 'Size does not exceed limit',
      });
  });
export type CatalogIssue = z.infer<typeof CatalogIssueSchema>;

/** Input is used only for lengths/counts; callers retain the complete source privately. */
export function catalogIssuesFromZod(
  issues: readonly ZodIssue[],
  input: unknown,
  options: {
    stage: CatalogIssue['stage'];
    remedy: CatalogIssue['remedy'];
    prefix?: readonly (string | number)[];
  },
): CatalogIssue[] {
  const result = new Map<string, CatalogIssue>();
  for (const issue of flatten(issues)) {
    const value = atPath(input, issue.path);
    let code: CatalogIssue['code'] = 'INVALID_VALUE';
    let expected: CatalogIssue['expected'];
    if (issue.code === 'invalid_type' && issue.received === 'undefined') code = 'REQUIRED';
    if (issue.code === 'too_big' || issue.code === 'too_small') {
      const maximum = issue.code === 'too_big';
      const size = maximum ? issue.maximum : issue.minimum;
      if (
        typeof size === 'number' &&
        Number.isFinite(size) &&
        Math.abs(size) <= Number.MAX_SAFE_INTEGER
      ) {
        if (issue.type === 'string' && Number.isSafeInteger(size) && size >= 0) {
          code = maximum ? 'TOO_LONG' : size > 0 && value === '' ? 'REQUIRED' : 'INVALID_VALUE';
          expected = maximum ? { maxChars: size } : { minChars: size };
        } else if (issue.type === 'array' && Number.isSafeInteger(size) && size >= 0) {
          code = maximum ? 'TOO_MANY' : 'INVALID_VALUE';
          expected = maximum ? { maxCount: size } : { minCount: size };
        } else if (issue.type === 'number')
          expected = maximum ? { maxValue: size } : { minValue: size };
      }
    }
    const observed =
      typeof value === 'string'
        ? { chars: value.length, bytes: new TextEncoder().encode(value).byteLength }
        : Array.isArray(value)
          ? { count: value.length }
          : undefined;
    const safe = CatalogIssueSchema.parse({
      code,
      stage: options.stage,
      path: safePath([...(options.prefix ?? []), ...issue.path]),
      severity: 'error',
      remedy: options.remedy,
      ...(expected ? { expected } : {}),
      ...(observed ? { observed } : {}),
    });
    result.set(JSON.stringify(safe), safe);
  }
  return [...result.values()];
}

export function catalogFailureIssue(code: string): CatalogIssue {
  const make = (
    issueCode: CatalogIssue['code'],
    stage: CatalogIssue['stage'],
    path: string,
    remedy: CatalogIssue['remedy'],
  ) =>
    CatalogIssueSchema.parse({
      code: issueCode,
      stage,
      path,
      remedy,
      severity: 'error',
    });
  switch (code) {
    case 'SOURCE_NOT_READY':
      return make('SOURCE_NOT_READY', 'source', 'source', 'resync');
    case 'MISSING_CATEGORY':
      return make('MISSING_CATEGORY', 'classification', 'productFamily', 'classify');
    case 'MEDIA_BUSY':
      return make('MEDIA_BUSY', 'media', 'images', 'retry-media');
    case 'MEDIA_NOT_READY':
      return make('MEDIA_NOT_READY', 'media', 'images', 'retry-media');
    case 'BUSY':
      return make('INPUT_BUSY', 'commit', 'product', 'retry');
    case 'CONFLICT':
      return make('INPUT_CHANGED', 'commit', 'product', 'review-change');
    case 'APPROVAL_EXPIRED':
      return make('APPROVAL_EXPIRED', 'commit', 'product', 'review-change');
    case 'UNAUTHORIZED':
      return make('FORBIDDEN', 'commit', 'product', 'sign-in');
    case 'FORBIDDEN':
      return make('FORBIDDEN', 'commit', 'product', 'reload');
    case 'NOT_FOUND':
      return make('NOT_FOUND', 'commit', 'product', 'reload');
    case 'APPROVAL_TOO_LARGE':
      return make('TOO_LARGE', 'commit', 'data', 'system-repair');
    case 'VALIDATION_ERROR':
      return make('INVALID_VALUE', 'effective-content', 'data', 'edit');
    default:
      return make('INVALID_VALUE', 'commit', 'data', 'system-repair');
  }
}

/** A caller cannot turn an unvalidated message or private path into display text. */
export function catalogIssueMessage(value: unknown): string | undefined {
  const parsed = CatalogIssueSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const issue = parsed.data;
  const label = fieldLabel(issue.path);
  switch (issue.code) {
    case 'REQUIRED':
      return `${label} is required.`;
    case 'TOO_LONG':
      return `${label} exceeds the ${issue.expected?.maxChars ?? 0} character limit.`;
    case 'TOO_MANY':
      return `${label} exceeds the ${issue.expected?.maxCount ?? 0} item limit.`;
    case 'TOO_LARGE':
      return issue.expected?.maxBytes === undefined
        ? 'Product data exceeds the approval budget.'
        : issue.observed?.bytes === undefined
          ? `${label} exceeds the ${issue.expected.maxBytes} byte approval limit.`
          : `${label} is ${issue.observed.bytes} bytes; the approval limit is ${issue.expected.maxBytes} bytes.`;
    case 'SOURCE_NOT_READY':
      return 'Complete source data is not ready. Resync this product.';
    case 'MISSING_CATEGORY':
      return 'Choose a website category before publishing.';
    case 'MEDIA_NOT_READY':
      return 'Some product photos need attention.';
    case 'MEDIA_BUSY':
      return 'A product photo is being changed. Retry shortly.';
    case 'INPUT_BUSY':
      return 'The product is being changed. Retry the same operation.';
    case 'INPUT_CHANGED':
      return 'The product changed. Reload and review the current version.';
    case 'APPROVAL_EXPIRED':
      return 'This approval expired. Review the product again.';
    case 'FORBIDDEN':
      return 'Permission is required to complete this operation.';
    case 'NOT_FOUND':
      return 'This product or operation is no longer available.';
    default:
      return `${label} contains an invalid value.`;
  }
}

function atPath(input: unknown, path: readonly (string | number)[]): unknown {
  let value = input;
  for (const part of path) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) return undefined;
    value = Reflect.get(value, part);
  }
  return value;
}

function flatten(issues: readonly ZodIssue[], depth = 0): ZodIssue[] {
  return issues.flatMap((issue) => {
    if (issue.code !== 'invalid_union' || depth >= 12) return [issue];
    const branches = issue.unionErrors.map((error) => flatten(error.issues, depth + 1));
    branches.sort((left, right) => left.length - right.length);
    return branches[0] ?? [issue];
  });
}

export const CatalogValidationReportSchema = z
  .object({
    stage: z.enum([
      'source-candidate',
      'source-page',
      'source-persistence',
      'manual-source',
      'review',
      'begin',
      'page',
      'finish',
      'commit',
    ]),
    issues: z.array(CatalogIssueSchema).min(1).max(50),
    totalIssues: count.min(1),
  })
  .strict()
  .superRefine((report, context) => {
    if (report.totalIssues < report.issues.length)
      context.addIssue({
        code: 'custom',
        path: ['totalIssues'],
        message: 'Issue count is inconsistent',
      });
  });
export type CatalogValidationReport = z.infer<typeof CatalogValidationReportSchema>;

export function catalogValidationFailure(
  stage: CatalogValidationReport['stage'],
  issues: readonly CatalogIssue[],
) {
  const safe = z.array(CatalogIssueSchema).parse(issues);
  const complete = safe.length ? safe : [catalogFailureIssue('VALIDATION_ERROR')];
  return {
    ok: false as const,
    code: 'VALIDATION_ERROR' as const,
    validation: CatalogValidationReportSchema.parse({
      stage,
      issues: complete.slice(0, 50),
      totalIssues: complete.length,
    }),
  };
}

export function catalogValidationMessage(input: unknown): string | undefined {
  const parsed = CatalogValidationReportSchema.safeParse(input);
  if (!parsed.success) return undefined;
  const report = parsed.data;
  const shown = report.issues.slice(0, 5).map(catalogIssueMessage);
  const more =
    report.totalIssues > shown.length
      ? ` (${shown.length} of ${report.totalIssues} issues shown)`
      : '';
  const phases: Record<CatalogValidationReport['stage'], string> = {
    'source-candidate': 'preparing the product',
    'source-page': 'preparing configurations',
    'source-persistence': 'saving prepared data',
    'manual-source': 'checking the draft',
    review: 'checking the preview',
    begin: 'starting approval',
    page: 'saving configurations',
    finish: 'completing approval',
    commit: 'checking the operation',
  };
  return `Product data needs attention while ${phases[report.stage]}: ${shown.join(' ')}${more}`;
}

export type CatalogIssueContext = {
  stage: CatalogIssue['stage'];
  remedy: CatalogIssue['remedy'];
  prefix?: readonly (string | number)[];
};

/** Contains only validated diagnostics, so logging the exception cannot expose source values. */
export class CatalogValidationError extends Error {
  readonly issues: CatalogIssue[];
  constructor(issues: readonly CatalogIssue[]) {
    super('Product data did not pass validation.');
    this.name = 'CatalogValidationError';
    this.issues = z.array(CatalogIssueSchema).min(1).parse(issues);
  }
}

export function parseCatalogData<Output>(
  schema: z.ZodType<Output, z.ZodTypeDef, unknown>,
  input: unknown,
  context: CatalogIssueContext,
): Output {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  throw new CatalogValidationError(catalogIssuesFromZod(parsed.error.issues, input, context));
}

function fieldLabel(path: string): string {
  const parts = path.split('.');
  const labels: Record<string, string> = {
    page: 'Configuration page',
    productId: 'Product identity',
    actorId: 'Session identity',
    name: 'Product name',
    description: 'Description',
    descriptionText: 'Description',
    sku: 'SKU',
    facts: 'Specifications',
    offers: 'Quotes',
    options: 'Configuration options',
    images: 'Photos',
    imageIds: 'Photos',
    descriptionImages: 'Description photos',
    descriptionImageIds: 'Description photos',
    manualCatalogPricing: 'Website price',
    websitePricing: 'Website price',
    pricing: 'Price',
    notes: 'Notes',
    noteBlocks: 'Notes',
    specifications: 'Specifications',
    packaging: 'Packaging',
    productFamily: 'Website category',
  };
  if (parts[0] === 'source')
    return parts[1] === 'observedAt' ? 'Source capture time' : 'Source data';
  if (parts[0] === 'variants' && parts[1] === 'items' && parts[2] && /^\d+$/.test(parts[2]))
    return `Configuration ${Number(parts[2]) + 1}${parts[3] === 'sku' ? ' SKU' : parts[3] === 'options' ? ' options' : parts[3] === 'images' ? ' photos' : ' data'}`;
  if (parts[0] === 'facts' && parts[1] && /^\d+$/.test(parts[1]))
    return `Specification ${Number(parts[1]) + 1}${parts[2] === 'name' ? ' name' : ' value'}`;
  return labels[parts[0] ?? ''] ?? 'Product data';
}
