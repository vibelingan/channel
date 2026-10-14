/** Server-only workflow: browser input identifies an operation, never supplies snapshots. */
import type { CollectionDoc } from '@vibelingan-channel/shared';
import {
  CatalogDetailPublicationSchema,
  decodeCatalogDetailView,
} from '@vibelingan-channel/shared/catalog-detail';
import {
  CatalogIssueSchema,
  CatalogValidationError,
  catalogIssuesFromZod,
  catalogValidationFailure,
} from '@vibelingan-channel/shared/catalog-issues';
import { z } from 'zod';
import {
  CatalogApprovalCommandSchema,
  CatalogApprovalManifestSchema,
  prepareCatalogApprovalPlan,
} from './catalog-detail-commit.ts';
import {
  type ApprovalPersistenceCommand,
  type ApprovalStageResult,
  approvalProductFingerprint,
  catalogStagedApprovalCapacityIssues,
  prepareStagedApproval,
} from './catalog-detail-staging.ts';
import { sourceDigest } from './catalog-source-staging.ts';

const WorkflowCommandSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('review'),
      productId: z.string().trim().min(1).max(200),
      page: z.number().int().min(1).max(200).default(1),
      includePreviewMedia: z.boolean().optional(),
      includeMediaSummary: z.boolean().optional(),
      expectedDigest: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    })
    .strict(),
  z.object({ action: z.literal('begin'), command: CatalogApprovalCommandSchema }).strict(),
  z
    .object({
      action: z.literal('page'),
      jobId: z.string().regex(/^[a-f0-9]{64}$/),
      page: z.number().int().min(0).max(499),
    })
    .strict(),
  z.object({ action: z.literal('finish'), jobId: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
]);

export interface CatalogApprovalStore {
  get(collection: string, id: string): Promise<CollectionDoc | null>;
  persist(actorId: string, command: ApprovalPersistenceCommand): Promise<ApprovalStageResult>;
}

async function readCandidate(store: CatalogApprovalStore, productId: string) {
  const product = await store.get('products', productId);
  if (!product) return { ok: false as const, code: 'NOT_FOUND' as const };
  const manifest = CatalogApprovalManifestSchema.safeParse(product.detailSourceManifest);
  if (
    !manifest.success ||
    product.detailSourceReady !== true ||
    (product.detailSourceContentGeneration ?? 0) !== (product.catalogContentGeneration ?? 0) ||
    manifest.data.revision !== product.detailSourceRevision
  )
    return { ok: false as const, code: 'SOURCE_NOT_READY' as const };
  const rows: CollectionDoc[] = [];
  // Provider calls are bounded and OUTSIDE a transaction. Missing rows are not filtered out.
  for (let offset = 0; offset < manifest.data.variantIds.length; offset += 8) {
    const batch = await Promise.all(
      manifest.data.variantIds
        .slice(offset, offset + 8)
        .map((id) => store.get('productVariants', id)),
    );
    for (const row of batch) {
      if (!row || row.detailSourceRevision !== manifest.data.revision)
        return { ok: false as const, code: 'SOURCE_NOT_READY' as const };
      rows.push(row);
    }
  }
  const current = await store.get('products', productId);
  if (!current || approvalProductFingerprint(current) !== approvalProductFingerprint(product))
    return { ok: false as const, code: 'CONFLICT' as const };
  return { ok: true as const, product, rows };
}

export async function runCatalogApprovalWorkflow(
  store: CatalogApprovalStore,
  actorId: string,
  input: unknown,
) {
  const actor = await store.get('users', actorId);
  if (actor?.role !== 'admin' || actor.status === 'suspended')
    return { ok: false as const, code: 'FORBIDDEN' as const };
  const parsed = WorkflowCommandSchema.safeParse(input);
  if (!parsed.success)
    return catalogValidationFailure(
      'commit',
      catalogIssuesFromZod(parsed.error.issues, input, { stage: 'commit', remedy: 'reload' }),
    );
  const command = parsed.data;
  if (command.action === 'review' && command.includeMediaSummary && !command.includePreviewMedia)
    return catalogValidationFailure('commit', [
      CatalogIssueSchema.parse({
        code: 'INVALID_VALUE',
        stage: 'commit',
        path: 'data',
        severity: 'error',
        remedy: 'reload',
      }),
    ]);
  if (command.action === 'page' || command.action === 'finish')
    return store.persist(actorId, command);
  const productId = command.action === 'begin' ? command.command.productId : command.productId;
  const read = await readCandidate(store, productId);
  if (!read.ok) return read;
  if (command.action === 'begin') {
    const prepared = prepareStagedApproval(actorId, command.command, read.product, read.rows);
    if (!prepared.ok) return prepared;
    return store.persist(actorId, { action: 'begin', prepared: prepared.value });
  }
  try {
    const { digest: expectedDigest, plan } = prepareCatalogApprovalPlan(read.product, read.rows);
    if (command.expectedDigest !== undefined && expectedDigest !== command.expectedDigest)
      return { ok: false as const, code: 'CONFLICT' as const };
    const current =
      read.product.catalogDetailPublication == null
        ? null
        : CatalogDetailPublicationSchema.parse(read.product.catalogDetailPublication);
    if (current && current.header._id !== productId)
      return { ok: false as const, code: 'CONFLICT' as const };
    const capacity = catalogStagedApprovalCapacityIssues(read.product, plan);
    if (capacity.length) return catalogValidationFailure('review', capacity);
    const offset = (command.page - 1) * 50;
    const { descriptionImages: _descriptionImages, ...legacyHeader } = plan.publication.header;
    const detail = decodeCatalogDetailView({
      ...(command.includePreviewMedia ? plan.publication.header : legacyHeader),
      ...(plan.publication.content
        ? { schemaVersion: 'catalog-product-detail-v2', content: plan.publication.content }
        : {}),
      ...(plan.publication.noteBlocks
        ? { schemaVersion: 'catalog-product-detail-v3', noteBlocks: plan.publication.noteBlocks }
        : {}),
      variants: {
        items: plan.variants.slice(offset, offset + 50),
        total: plan.variants.length,
        page: command.page,
        pageSize: 50,
        hasMore: offset + 50 < plan.variants.length,
      },
    });
    if (!detail.ok) return catalogValidationFailure('review', detail.issues);
    return {
      ok: true as const,
      kind: 'review' as const,
      productId,
      expectedDigest,
      expectedRevision: current?.revision ?? null,
      detail: detail.value,
      // Authenticated preview metadata comes from the same fresh product read,
      // never from the potentially stale list row. Public APIs omit this field.
      ...(command.includePreviewMedia
        ? {
            previewMedia: {
              ...(command.includeMediaSummary
                ? {
                    allVariantsBound: !read.rows.some(
                      (row) =>
                        Array.isArray(row.detailSourceUnboundMediaSources) &&
                        row.detailSourceUnboundMediaSources.length > 0,
                    ),
                  }
                : {}),
              // Stable across transport-to-owned conversion, but not across any
              // reviewed content, identity, price, gallery or source mapping edit.
              importDigest: sourceDigest({
                revision: current?.revision ?? null,
                header: plan.publication.header,
                content: plan.publication.content,
                notes: plan.publication.noteBlocks,
                variants: plan.variants.map(({ images: _images, ...v }) => v),
                sources: read.rows.map((row) => [row._id, row.detailSourceMediaSources ?? []]),
              }),
              variantSources: read.rows.slice(offset, offset + 50).map((row) => ({
                id: row._id,
                sources: Array.isArray(row.detailSourceMediaSources)
                  ? row.detailSourceMediaSources
                      .filter((v): v is string => typeof v === 'string')
                      .slice(0, 9)
                  : [],
                unboundSources: Array.isArray(row.detailSourceUnboundMediaSources)
                  ? row.detailSourceUnboundMediaSources
                      .filter((v): v is string => typeof v === 'string')
                      .slice(0, 9)
                  : [],
              })),
              galleryIds: Array.isArray(read.product.imageIds)
                ? read.product.imageIds
                    .filter((v): v is string => typeof v === 'string')
                    .slice(0, 9)
                : [],
              descriptionIds: Array.isArray(read.product.descriptionImageIds)
                ? read.product.descriptionImageIds
                    .filter((v): v is string => typeof v === 'string')
                    .slice(0, 18)
                : [],
              gallerySources: Array.isArray(read.product.alibabaSourceImageUrls)
                ? read.product.alibabaSourceImageUrls
                    .filter((v): v is string => typeof v === 'string')
                    .slice(0, 9)
                : [],
              descriptionSources: Array.isArray(read.product.alibabaDescriptionImageUrls)
                ? read.product.alibabaDescriptionImageUrls
                    .filter((v): v is string => typeof v === 'string')
                    .slice(0, 18)
                : [],
            },
          }
        : {}),
    };
  } catch (error) {
    if (error instanceof CatalogValidationError)
      return catalogValidationFailure('review', error.issues);
    if (error instanceof z.ZodError)
      return catalogValidationFailure(
        'review',
        catalogIssuesFromZod(error.issues, read.product, {
          stage: 'effective-content',
          remedy: 'edit',
        }),
      );
    return { ok: false as const, code: 'VALIDATION_ERROR' as const };
  }
}
