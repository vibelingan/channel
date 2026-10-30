import type { PublicSseEvent } from './index.ts';
import { PRODUCT_KINDS, type PublicProductCard, isProductCards } from './products.ts';
export interface ChatTurnV2 {
  protocolVersion: 2;
  conversationId: string;
  operationKey: string;
  messageId: string;
  runId: string | null;
  controlVersion: number | null;
  status: 'queued' | 'creating' | 'running' | 'completed' | 'failed' | 'cancelled';
  cancelRequested: boolean;
}
export type ChatEventV2 = PublicSseEvent & {
  products?: PublicProductCard[];
  kind?: (typeof PRODUCT_KINDS)[number];
  unavailableProductIds?: string[];
  protocolVersion: 2;
  conversationId: string;
  messageId: string;
  runId: string;
  controlVersion: number;
};
export function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}
export function isOperationKey(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{8,128}$/.test(value);
}
const positive = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, max = 32000): v is string => typeof v === 'string' && v.length <= max;
export function isChatTurnV2(value: unknown): value is ChatTurnV2 {
  if (
    !record(value) ||
    value.protocolVersion !== 2 ||
    !isUuid(value.conversationId) ||
    !isUuid(value.messageId) ||
    !isOperationKey(value.operationKey) ||
    typeof value.cancelRequested !== 'boolean'
  )
    return false;
  if (value.status === 'queued') return value.runId === null && value.controlVersion === null;
  return (
    isUuid(value.runId) &&
    positive(value.controlVersion) &&
    typeof value.status === 'string' &&
    ['creating', 'running', 'completed', 'failed', 'cancelled'].includes(value.status)
  );
}
export function isChatEventV2(value: unknown): value is ChatEventV2 {
  if (
    !record(value) ||
    value.protocolVersion !== 2 ||
    !isUuid(value.conversationId) ||
    !isUuid(value.messageId) ||
    !isUuid(value.runId) ||
    !positive(value.controlVersion) ||
    !positive(value.sequence)
  )
    return false;
  switch (value.type) {
    case 'token':
      return text(value.text);
    case 'final':
      return (
        text(value.text) &&
        (value.products === undefined || isProductCards(value.products)) &&
        (value.kind === undefined || PRODUCT_KINDS.some((kind) => kind === value.kind)) &&
        (value.unavailableProductIds === undefined ||
          (Array.isArray(value.unavailableProductIds) &&
            value.unavailableProductIds.length <= 2 &&
            value.unavailableProductIds.every(
              (id) => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id),
            )))
      );
    case 'citation':
      return (
        text(value.sourceId, 256) &&
        text(value.title, 1000) &&
        (value.url === undefined || text(value.url, 2048))
      );
    case 'error':
      return text(value.category, 100) && typeof value.retriable === 'boolean';
    case 'run.failed':
      return value.category === undefined || text(value.category, 100);
    case 'assistant.cancelled':
    case 'handoff.started':
    case 'conversation.closed':
      return true;
    default:
      return false;
  }
}
