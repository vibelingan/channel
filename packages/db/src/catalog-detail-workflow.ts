/** Server-only workflow: browser input identifies an operation, never supplies snapshots. */
import type { CollectionDoc } from '@vibelingan-channel/shared';
import {
  CatalogDetailPublicationSchema,
  decodeCatalogDetailView,
} from '@vibelingan-channel/shared/catalog-detail';
import { planCatalogDetailApproval } from '@vibelingan-channel/shared/catalog-detail-approval';
import { z } from 'zod';
import {
  CatalogApprovalCommandSchema,
  CatalogApprovalManifestSchema,
  catalogApprovalDigest,
} from './catalog-detail-commit.ts';
import {
  type ApprovalPersistenceCommand,
  type ApprovalStageResult,
  approvalProductFingerprint,
  prepareStagedApproval,
} from './catalog-detail-staging.ts';

const WorkflowCommandSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('review'),
      productId: z.string().trim().min(1).max(200),
      page: z.number().int().min(1).max(200).default(1),
      includePreviewMedia: z.boolean().optional(),
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
  if (!parsed.success) return { ok: false as const, code: 'VALIDATION_ERROR' as const };
  const command = parsed.data;
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
    const expectedDigest = catalogApprovalDigest(read.product, read.rows);
    if (command.expectedDigest !== undefined && expectedDigest !== command.expectedDigest)
      return { ok: false as const, code: 'CONFLICT' as const };
    const current =
      read.product.catalogDetailPublication == null
        ? null
        : CatalogDetailPublicationSchema.parse(read.product.catalogDetailPublication);
    if (current && current.header._id !== productId)
      return { ok: false as const, code: 'CONFLICT' as const };
    const plan = planCatalogDetailApproval({
      product: read.product,
      variants: read.rows,
      revision: 'review-candidate',
    });
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
    if (!detail.ok) return { ok: false as const, code: 'VALIDATION_ERROR' as const };
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
  } catch {
    return { ok: false as const, code: 'VALIDATION_ERROR' as const };
  }
}
