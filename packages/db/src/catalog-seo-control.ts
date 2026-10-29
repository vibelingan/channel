import { createHash } from 'node:crypto';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { z } from 'zod';
import { type CatalogPublicChangeStore, catalogPublicRecordId } from './catalog-public-changes.ts';
import {
  type CatalogSeoChange,
  type CatalogSeoRecordingConfig,
  CatalogSeoRecordingConfigSchema,
  type CatalogSeoRequest,
} from './catalog-seo-requests.ts';
const origin = CatalogSeoRecordingConfigSchema.shape.siteOrigin;
const id = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim() === value);
const time = z.string().datetime({ offset: true });
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const CatalogSeoControlSchema = z
  .object({
    _id: hash,
    schemaVersion: z.literal(1),
    siteOrigin: origin,
    state: z.enum(['idle', 'writing', 'needs-readback']),
    owner: id.nullable(),
    until: time.nullable(),
    fence: z.number().int().nonnegative().safe(),
    writes: z.number().int().nonnegative().safe(),
    updatedAt: time,
    products: z.array(id).max(20),
    families: z.array(z.enum(['headphones', 'ai-gadgets', 'toys', 'misc'])).max(4),
    discovery: z.boolean(),
  })
  .strict()
  .superRefine((row, ctx) => {
    const idle = row.state === 'idle';
    if (
      (idle
        ? row.owner !== null || row.until !== null
        : row.owner === null || row.until === null) ||
      (idle && (row.products.length || row.families.length || row.discovery)) ||
      new Set(row.products).size !== row.products.length ||
      new Set(row.families).size !== row.families.length
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid SEO delivery ownership' });
  });
export type CatalogSeoControl = z.infer<typeof CatalogSeoControlSchema>;
export const CatalogSeoPageSchema = z.discriminatedUnion('ready', [
  z
    .object({
      _id: hash,
      schemaVersion: z.literal(1),
      siteOrigin: origin,
      productId: id,
      ready: z.literal(false),
      changedAt: time,
    })
    .strict(),
  z
    .object({
      _id: hash,
      schemaVersion: z.literal(1),
      siteOrigin: origin,
      productId: id,
      ready: z.literal(true),
      sequence: z.number().int().positive().safe(),
      htmlSha256: hash,
      acceptedAt: time,
    })
    .strict(),
]);
export type CatalogSeoPage = z.infer<typeof CatalogSeoPageSchema>;
export class CatalogSeoWriteBusyError extends Error {
  readonly code = 'DATABASE_TRANSACTION_CONFLICT';
  constructor() {
    super('Product page delivery is finishing. Nothing was saved; retry shortly.');
    this.name = 'CatalogSeoWriteBusyError';
  }
}
export function catalogSeoControlId(siteOrigin: string): string {
  return createHash('sha256')
    .update(JSON.stringify(['catalog-seo-control-v1', origin.parse(siteOrigin)]))
    .digest('hex');
}
export function idleCatalogSeoControl(siteOrigin: string, now: string): CatalogSeoControl {
  return CatalogSeoControlSchema.parse({
    _id: catalogSeoControlId(siteOrigin),
    schemaVersion: 1,
    siteOrigin,
    state: 'idle',
    owner: null,
    until: null,
    fence: 0,
    writes: 0,
    updatedAt: now,
    products: [],
    families: [],
    discovery: false,
  });
}
export function readCatalogSeoControl(
  row: CollectionDoc | null,
  siteOrigin: string,
  now: string,
): CatalogSeoControl {
  const control = row ? CatalogSeoControlSchema.parse(row) : idleCatalogSeoControl(siteOrigin, now);
  if (control._id !== catalogSeoControlId(siteOrigin) || control.siteOrigin !== siteOrigin)
    throw Error('Wrong SEO control identity');
  return control;
}
export interface CatalogSeoWritePermit {
  control: CatalogSeoControl;
  pages: CatalogSeoPage[];
}

/** Read before business writes. The same control row fences publication and save transactions. */
export async function planCatalogSeoWrite(
  tx: CatalogPublicChangeStore,
  options: CatalogSeoRecordingConfig,
  changes: readonly CatalogSeoChange[],
  requests: readonly CatalogSeoRequest[],
  now: string,
): Promise<CatalogSeoWritePermit | undefined> {
  if (!requests.length) return undefined;
  const row = await tx.get('catalogSeoControl', catalogSeoControlId(options.siteOrigin));
  return planCatalogSeoWriteFromControl(row, options, changes, requests, now);
}
export function planCatalogSeoWriteFromControl(
  row: CollectionDoc | null,
  options: CatalogSeoRecordingConfig,
  changes: readonly CatalogSeoChange[],
  requests: readonly CatalogSeoRequest[],
  now: string,
): CatalogSeoWritePermit | undefined {
  if (!requests.length) return undefined;
  const config = CatalogSeoRecordingConfigSchema.parse(options);
  const control = readCatalogSeoControl(row, config.siteOrigin, now);
  if (
    control.state !== 'idle' &&
    requests.some(
      (request) =>
        control.discovery ||
        (request.kind === 'product'
          ? control.products.includes(request.productId)
          : control.families.includes(request.family)),
    )
  )
    throw new CatalogSeoWriteBusyError();
  const pages: CatalogSeoPage[] = [];
  const visible = (row: CollectionDoc | null) =>
    row?.published === true && (!Object.hasOwn(row, 'archived') || row.archived === false);
  for (const change of changes) {
    if (change.collection !== 'products' || visible(change.before) === visible(change.after))
      continue;
    const productId = change.after?._id ?? change.before?._id;
    if (!productId) throw Error('Missing product availability identity');
    pages.push(
      CatalogSeoPageSchema.parse({
        _id: catalogPublicRecordId(config.siteOrigin, productId),
        schemaVersion: 1,
        siteOrigin: config.siteOrigin,
        productId,
        ready: false,
        changedAt: now,
      }),
    );
  }
  return {
    control: CatalogSeoControlSchema.parse({
      ...control,
      writes: control.writes + 1,
      updatedAt: now,
    }),
    pages,
  };
}
export async function writeCatalogSeoPermit(
  tx: CatalogPublicChangeStore,
  permit: CatalogSeoWritePermit | undefined,
): Promise<void> {
  if (!permit) return;
  await tx.set('catalogSeoControl', permit.control);
  for (const page of permit.pages) await tx.set('catalogSeoPages', page);
}
