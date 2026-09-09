import { createHash } from 'node:crypto';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import {
  InquiryCommandSchema,
  type InquiryDetail,
  InquiryDetailSchema,
  type InquiryErrorCode,
  InquiryEventSchema,
  type InquiryResult,
  isTerminalInquiry,
  nextInquiryStatuses,
} from '@vibelingan-channel/shared/catalog-inquiry';
import { z } from 'zod';

const storedEvent = InquiryEventSchema.extend({
  operationId: z.string().uuid(),
  fingerprint: z.string(),
});
const eventsSchema = z.array(storedEvent).max(1000);
export function projectInquiry(row: CollectionDoc): InquiryDetail | undefined {
  const events = eventsSchema.safeParse(row.events ?? []);
  if (!events.success) return;
  const result = InquiryDetailSchema.safeParse({
    id: row._id,
    target: row.target,
    fields: row.fields,
    snapshot: row.snapshot,
    status: row.status,
    notification: row.notification,
    version: row.version ?? 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    events: events.data.map(
      ({ operationId: _operation, fingerprint: _fingerprint, ...event }) => event,
    ),
  });
  if (!result.success || row.schemaVersion !== 'catalog-quote-request-v1') return;
  const { data } = result;
  if (
    data.target.productId !== data.snapshot.productId ||
    data.target.revision !== data.snapshot.revision ||
    data.target.intent !== data.fields.intent ||
    data.target.variantId !== data.snapshot.variant?.id ||
    data.version !== data.events.length
  )
    return;
  return data;
}

/** Called only inside the adapter's serialized transaction. It plans one updated
 * row; the adapter persists before returning success. Never trusts browser actor. */
export function processCatalogInquiry(
  store: Record<string, CollectionDoc[]>,
  actorId: string,
  input: unknown,
): { result: InquiryResult; changed?: CollectionDoc } {
  const fail = (code: InquiryErrorCode) => ({ result: { ok: false as const, code } });
  const actor = store.users?.find((row) => row._id === actorId);
  if (!actor || actor.role !== 'admin' || actor.status === 'suspended') return fail('FORBIDDEN');
  const command = InquiryCommandSchema.safeParse(input);
  if (!command.success) return fail('VALIDATION_ERROR');
  const cmd = command.data;
  const rows = store.catalogQuoteRequests ?? [];
  if (cmd.action === 'list') {
    const parsed = rows.map(projectInquiry);
    if (parsed.some((row) => !row)) return fail('INVALID_RECORD');
    const items = parsed.filter((row): row is InquiryDetail => !!row);
    const filtered = items
      .filter((row) => !cmd.status || row.status === cmd.status)
      .sort(
        (a, b) =>
          Number(b.status === 'new') - Number(a.status === 'new') ||
          b.createdAt.localeCompare(a.createdAt) ||
          a.id.localeCompare(b.id),
      );
    return {
      result: {
        ok: true,
        data: {
          kind: 'list',
          page: cmd.page,
          pageSize: cmd.pageSize,
          total: filtered.length,
          newCount: items.filter((row) => row.status === 'new').length,
          items: filtered
            .slice((cmd.page - 1) * cmd.pageSize, cmd.page * cmd.pageSize)
            .map((row) => ({
              id: row.id,
              status: row.status,
              version: row.version,
              notification: row.notification,
              createdAt: row.createdAt,
              updatedAt: row.updatedAt,
              productName: row.snapshot.productName,
              quantity: row.fields.quantity,
              intent: row.target.intent,
            })),
        },
      },
    };
  }
  const stored = rows.find((row) => row._id === cmd.id);
  if (!stored) return fail('NOT_FOUND');
  const item = projectInquiry(stored);
  if (!item) return fail('INVALID_RECORD');
  if (cmd.action === 'get') {
    const product = store.products?.find((row) => row._id === item.target.productId);
    const publication = z
      .object({ revision: z.string() })
      .safeParse(product?.catalogDetailPublication);
    const revision = publication.success ? publication.data.revision : undefined;
    return {
      result: {
        ok: true,
        data: {
          kind: 'detail',
          item,
          currentProduct: {
            state: !product
              ? 'missing'
              : product.published !== true ||
                  (product.archived !== false && product.archived !== undefined)
                ? 'unavailable'
                : revision !== item.target.revision
                  ? 'changed'
                  : 'same',
            ...(typeof product?.name === 'string' ? { name: product.name } : {}),
            ...(revision ? { revision } : {}),
          },
        },
      },
    };
  }
  const events = eventsSchema.parse(stored.events ?? []);
  const fingerprint = createHash('sha256').update(JSON.stringify(cmd)).digest('hex');
  const accepted = events.find((event) => event.operationId === cmd.operationId);
  if (accepted)
    return accepted.fingerprint === fingerprint
      ? { result: { ok: true, data: { kind: 'updated', id: item.id, version: accepted.version } } }
      : fail('IDEMPOTENCY_CONFLICT');
  if (cmd.version !== item.version) return fail('VERSION_CONFLICT');
  if (events.length >= 1000) return fail('HISTORY_LIMIT');
  if (!cmd.status && !cmd.note) return fail('VALIDATION_ERROR');
  if (cmd.status && !nextInquiryStatuses(item.status).includes(cmd.status))
    return fail('INVALID_TRANSITION');
  if (
    ((cmd.status && isTerminalInquiry(cmd.status)) || isTerminalInquiry(item.status)) &&
    !cmd.note
  )
    return fail('REASON_REQUIRED');
  if (isTerminalInquiry(item.status) && cmd.status !== 'in_progress')
    return fail('INVALID_TRANSITION');
  const at = new Date().toISOString();
  const nextVersion = item.version + 1;
  const event = storedEvent.parse({
    id: cmd.operationId,
    actorId,
    actorName: String(actor.username || 'Admin').slice(0, 200),
    at,
    from: item.status,
    to: cmd.status ?? item.status,
    version: nextVersion,
    ...(cmd.note ? { note: cmd.note } : {}),
    operationId: cmd.operationId,
    fingerprint,
  });
  const changed = {
    ...stored,
    status: event.to,
    attentionRank: event.to === 'new' ? 0 : 1,
    version: nextVersion,
    updatedAt: at,
    events: [...events, event],
  };
  if (Buffer.byteLength(JSON.stringify(changed), 'utf8') > 512 * 1024) return fail('HISTORY_LIMIT');
  return {
    result: { ok: true, data: { kind: 'updated', id: item.id, version: nextVersion } },
    changed,
  };
}
