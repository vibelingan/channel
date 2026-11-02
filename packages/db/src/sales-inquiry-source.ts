import {
  hashCanonicalJson,
  validateContract,
  type InquirySubmitted,
} from '@vibelingan-channel/sales-contracts';
import { InquiryDetailSchema } from '@vibelingan-channel/shared/catalog-inquiry';
import { OEM_FILE_MAX_BYTES } from '@vibelingan-channel/shared/media';
import { z } from 'zod';
import type { CollectionDoc } from '@vibelingan-channel/shared';
export interface SalesSourceScope {
  client_id: string;
  business_line: string;
  source_installation_id: string;
  cloud_env_id: string;
}
export type SalesSourceCollection = 'oemProjects' | 'catalogQuoteRequests' | 'files';
export interface SalesSourceReader extends SalesSourceScope {
  readDoc(collection: SalesSourceCollection, id: string): Promise<CollectionDoc | null>;
}

export class SalesSourceError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
  }
}
export const recordId = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const oemSchema = z.object({
  _id: recordId,
  company: z.string().max(300),
  contact: z.string().max(200),
  email: z
    .string()
    .email()
    .max(254)
    .regex(/^[^\r\n]+$/),
  whatsapp: z.string().max(200).optional(),
  category: z.string().max(500).optional(),
  quantity: z.union([z.string().max(200), z.number()]).optional(),
  drawing: z.string().max(200).optional(),
  status: z.enum(['new', 'reviewing', 'quoted', 'closed']),
  createdAt: z.string().datetime(),
  assistantSubmission: z
    .object({
      fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      conversationId: z.string().uuid(),
      submissionKey: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
      requirement: z.string().min(1).max(4000),
      consentVersion: z.literal('inquiry-contact-v1'),
      consentedAt: z.string().datetime(),
      productReference: z
        .object({
          requestedId: recordId,
          queriedAt: z.string().datetime(),
          current: z
            .object({
              productId: recordId,
              productName: z.string().min(1).max(500),
              revision: z.string().min(1).max(200),
            })
            .strict()
            .nullable(),
        })
        .strict()
        .optional(),
    })
    .strict()
    .optional(),
});
const fileSchema = z.object({
  _id: recordId,
  name: z.string().min(1).max(512),
  purpose: z.literal('oem-drawing'),
  status: z.literal('active'),
  ownerProjectId: recordId,
  storageProvider: z.literal('cloudbase-storage'),
  storageFileId: z.string().max(1000),
  storagePath: z.string().max(800),
  byteSize: z.number().int().positive().max(OEM_FILE_MAX_BYTES),
  checksumSha256: z.string().regex(/^[a-f0-9]{64}$/),
  mimeType: z.enum([
    'application/pdf',
    'image/png',
    'image/jpeg',
    'image/webp',
    'application/zip',
    'application/x-zip-compressed',
    'application/x-rar-compressed',
    'application/vnd.rar',
    'application/octet-stream',
  ]),
  uploadSecretHash: z.literal(''),
});
export interface InquiryView {
  kind: 'oem' | 'product';
  source_record_id: string;
  source_revision: string;
  submitted_at: string;
  record_status: string;
  contact: { email: string; name: string; company: string };
  requirements: Record<string, unknown>;
  product_snapshot?: unknown;
  assets: Array<{
    ref: string;
    filename: string;
    mime: string;
    size: number;
    sha256: string;
  }>;
}
type Source = { view: InquiryView; file?: z.infer<typeof fileSchema> };

export async function readSalesInquiry(
  deps: SalesSourceReader,
  kind: 'oem' | 'product',
  id: string,
): Promise<Source> {
  const row = await deps.readDoc(kind === 'oem' ? 'oemProjects' : 'catalogQuoteRequests', id);
  if (!row || row._id !== id || !belongsToInstallation(row, deps))
    throw new SalesSourceError(404, 'NOT_FOUND');
  if (kind === 'product') {
    const detail = InquiryDetailSchema.safeParse({
      id: row._id,
      target: row.target,
      fields: row.fields,
      snapshot: row.snapshot,
      status: row.status,
      version: row.version,
      notification: row.notification,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      events: row.events,
    });
    if (row.schemaVersion !== 'catalog-quote-request-v1' || !detail.success)
      throw new SalesSourceError(404, 'NOT_FOUND');
    const value = detail.data;
    if (
      value.target.productId !== value.snapshot.productId ||
      value.target.revision !== value.snapshot.revision ||
      value.target.variantId !== value.snapshot.variant?.id ||
      value.version !== value.events.length
    )
      throw new SalesSourceError(404, 'NOT_FOUND');
    const contact = {
      email: value.fields.email,
      name: value.fields.contactName,
      company: value.fields.company,
    };
    const requirements = {
      quantity_text: value.fields.quantity,
      brief: value.fields.brief,
      intent: value.fields.intent,
      delivery_date: value.fields.deliveryDate,
      customization_types: value.fields.customizationTypes,
      country: value.fields.country,
    };
    const revision = hashCanonicalJson({
      id,
      kind,
      submitted_at: value.createdAt,
      contact,
      requirements,
      snapshot: value.snapshot,
    });
    return {
      view: {
        kind,
        source_record_id: id,
        source_revision: revision,
        submitted_at: value.createdAt,
        record_status: value.status,
        contact,
        requirements,
        product_snapshot: value.snapshot,
        assets: [],
      },
    };
  }
  const result = oemSchema.safeParse(row);
  if (!result.success) throw new SalesSourceError(404, 'NOT_FOUND');
  const oem = result.data;
  let file: z.infer<typeof fileSchema> | undefined;
  if (oem.drawing) {
    const rawFile = await deps.readDoc('files', oem.drawing);
    if (!rawFile || !belongsToInstallation(rawFile, deps))
      throw new SalesSourceError(404, 'NOT_FOUND');
    const candidate = fileSchema.safeParse(rawFile);
    if (
      !candidate.success ||
      candidate.data._id !== oem.drawing ||
      candidate.data.ownerProjectId !== id ||
      !candidate.data.storageFileId.startsWith(`cloud://${deps.cloud_env_id}.`) ||
      !candidate.data.storagePath.startsWith('oem/') ||
      candidate.data.storagePath.includes('..') ||
      !candidate.data.storageFileId.endsWith(`/${candidate.data.storagePath}`)
    )
      throw new SalesSourceError(404, 'NOT_FOUND');
    file = candidate.data;
  }
  const contact = { email: oem.email, name: oem.contact, company: oem.company };
  const requirements = {
    category: oem.category ?? '',
    quantity_text: oem.quantity === undefined ? '' : String(oem.quantity),
    whatsapp: oem.whatsapp ?? '',
    ...(oem.assistantSubmission
      ? {
          brief: oem.assistantSubmission.requirement,
          inquiry_entry: 'assistant',
          ...(oem.assistantSubmission.productReference
            ? {
                requested_product_id: oem.assistantSubmission.productReference.requestedId,
                product_available_at_submission:
                  oem.assistantSubmission.productReference.current !== null,
                product_reference: oem.assistantSubmission.productReference,
              }
            : {}),
        }
      : {}),
  };
  const revision = hashCanonicalJson({
    id,
    kind,
    submitted_at: oem.createdAt,
    contact,
    requirements,
    attachment: file
      ? {
          id: file._id,
          name: file.name,
          mime: file.mimeType,
          size: file.byteSize,
          sha256: file.checksumSha256,
        }
      : null,
  });
  const assets = file
    ? [
        {
          ref: Buffer.from(JSON.stringify({ kind, id, revision, file_id: file._id })).toString(
            'base64url',
          ),
          filename: file.name,
          mime: file.mimeType,
          size: file.byteSize,
          sha256: file.checksumSha256,
        },
      ]
    : [];
  return {
    view: {
      kind,
      source_record_id: id,
      source_revision: revision,
      submitted_at: oem.createdAt,
      record_status: oem.status,
      contact,
      requirements,
      ...(oem.assistantSubmission?.productReference?.current
        ? {
            product_snapshot: {
              ...oem.assistantSubmission.productReference.current,
              queriedAt: oem.assistantSubmission.productReference.queriedAt,
            },
          }
        : {}),
      assets,
    },
    ...(file ? { file } : {}),
  };
}

function belongsToInstallation(row: Record<string, unknown>, deps: SalesSourceReader): boolean {
  return (
    row.client_id === deps.client_id &&
    row.business_line === deps.business_line &&
    row.source_installation_id === deps.source_installation_id
  );
}

export interface InquiryOwner {
  client_id: string;
  business_line: string;
  source_installation_id: string;
}

/** Build only from a server-read, owned submission, never from model assertions. */
export function canonicalInquiryEvent(owner: InquiryOwner, view: InquiryView): InquirySubmitted {
  const scope = {
    client_id: owner.client_id,
    business_line: owner.business_line,
    source_installation_id: owner.source_installation_id,
  };
  const text =
    view.requirements.brief ?? (view.kind === 'oem' ? view.requirements.category : undefined);
  const snapshot = view.product_snapshot;
  const name =
    snapshot && typeof snapshot === 'object' && 'productName' in snapshot
      ? snapshot.productName
      : undefined;
  const fallback =
    view.kind === 'oem'
      ? 'OEM inquiry'
      : typeof name === 'string' && name.trim()
        ? `Product inquiry: ${name}`
        : 'Product inquiry';
  const summary = typeof text === 'string' && text.trim() ? text.trim() : fallback;
  const quantityText = view.requirements.quantity_text;
  const quantity =
    typeof quantityText === 'string' &&
    /^[1-9][0-9]{0,9}$/.test(quantityText) &&
    Number(quantityText) <= 1000000000
      ? Number(quantityText)
      : undefined;
  return validateContract('inquiry', {
    schema_version: '1.0',
    event_id: `submission_${hashCanonicalJson({
      ...scope,
      kind: view.kind,
      id: view.source_record_id,
      revision: view.source_revision,
    })}`,
    ...scope,
    source: view.kind === 'oem' ? 'website_oem' : 'website_product',
    source_record_id: view.source_record_id,
    source_revision: view.source_revision,
    submitted_at: view.submitted_at,
    contact: view.contact,
    requirements: {
      confirmed_summary: summary,
      ...(quantity === undefined ? {} : { quantity }),
    },
    product_snapshot_refs: snapshot ? [`snapshot:${hashCanonicalJson(snapshot)}`] : [],
    attachment_refs: view.assets.map((asset) => asset.ref),
  });
}
