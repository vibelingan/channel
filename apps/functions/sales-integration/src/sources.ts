import { createHash } from 'node:crypto';
import { z } from 'zod';
import { OEM_FILE_MAX_BYTES } from '@vibelingan-channel/shared/media';
import {
  readSalesInquiry,
  recordId,
  SalesSourceError,
} from '@vibelingan-channel/db/sales-inquiry-source';
import type { SalesDependencies } from './handler.ts';
export {
  recordId,
  SalesSourceError,
  type InquiryView,
} from '@vibelingan-channel/db/sales-inquiry-source';
export function readInquiry(deps: SalesDependencies, kind: 'oem' | 'product', id: string) {
  return readSalesInquiry({ ...deps, source_installation_id: deps.installation_id }, kind, id);
}
const reference = z
  .object({
    kind: z.literal('oem'),
    id: recordId,
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    file_id: recordId,
  })
  .strict();
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
