import { createHash } from 'node:crypto';
import { hashCanonicalJson } from '@vibelingan-channel/sales-contracts';
import { InquiryDetailSchema } from '@vibelingan-channel/shared/catalog-inquiry';
import { OEM_FILE_MAX_BYTES } from '@vibelingan-channel/shared/media';
import { z } from 'zod';
import type { SalesDependencies } from './handler.ts';

export class SalesSourceError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
  }
}
export const recordId = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const reference = z
  .object({
    kind: z.literal('oem'),
    id: recordId,
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    file_id: recordId,
  })
  .strict();
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

export async function readInquiry(
  deps: SalesDependencies,
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
      assets,
    },
    ...(file ? { file } : {}),
  };
}

export async function readAsset(deps: SalesDependencies, ref: string) {
  let target: z.infer<typeof reference>;
  try {
    if (!/^[A-Za-z0-9_-]{1,1800}$/.test(ref)) throw new Error('invalid');
    const bytes = Buffer.from(ref, 'base64url');
    if (bytes.toString('base64url') !== ref) throw new Error('invalid');
    target = reference.parse(JSON.parse(bytes.toString('utf8')));
  } catch {
    throw new SalesSourceError(404, 'NOT_FOUND');
  }
  const source = await readInquiry(deps, target.kind, target.id);
  if (source.view.source_revision !== target.revision)
    throw new SalesSourceError(409, 'SOURCE_CHANGED');
  if (!source.file || source.file._id !== target.file_id)
    throw new SalesSourceError(404, 'NOT_FOUND');
  const stored = await deps.readFile(source.file.storageFileId);
  if (
    stored.body.length > Math.ceil(OEM_FILE_MAX_BYTES / 3) * 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(stored.body)
  )
    throw new SalesSourceError(404, 'NOT_FOUND');
  const bytes = Buffer.from(stored.body, 'base64');
  if (
    bytes.toString('base64') !== stored.body ||
    bytes.byteLength !== source.file.byteSize ||
    bytes.byteLength > OEM_FILE_MAX_BYTES ||
    (stored.byteSize !== undefined && stored.byteSize !== bytes.byteLength) ||
    createHash('sha256').update(bytes).digest('hex') !== source.file.checksumSha256
  )
    throw new SalesSourceError(404, 'NOT_FOUND');
  const current = await readInquiry(deps, target.kind, target.id);
  if (
    current.view.source_revision !== target.revision ||
    current.file?.storageFileId !== source.file.storageFileId
  )
    throw new SalesSourceError(409, 'SOURCE_CHANGED');
  return { bytes, name: source.file.name, mime: source.file.mimeType };
}

function belongsToInstallation(row: Record<string, unknown>, deps: SalesDependencies): boolean {
  return (
    row.client_id === deps.client_id &&
    row.business_line === deps.business_line &&
    row.source_installation_id === deps.installation_id
  );
}
