import type { PublicSseEvent } from './index.ts';
import {
  type InquirySuggestion,
  PRODUCT_KINDS,
  type PublicProductCard,
  isInquirySuggestion,
  isProductCards,
} from './products.ts';
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
  inquirySuggestion?: InquirySuggestion;
  protocolVersion: 2;
  conversationId: string;
  messageId: string;
  runId: string;
  controlVersion: number;
};
/** Final-answer extras shared by live `final` events and restored answers. */
export interface AnswerExtrasV2 {
  products?: PublicProductCard[];
  kind?: (typeof PRODUCT_KINDS)[number];
  unavailableProductIds?: string[];
  inquirySuggestion?: InquirySuggestion;
}
/** Restores one conversation in the tab that holds its credential. */
export interface ConversationSnapshotV2 {
  protocolVersion: 2;
  conversationId: string;
  messages: Array<
    | {
        role: 'visitor';
        operationKey: string;
        runId: string | null;
        status: ChatTurnV2['status'];
        text: string;
      }
    | ({ role: 'assistant'; runId: string; text: string } & AnswerExtrasV2)
  >;
}
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
    case 'tool.progress':
      return ['knowledge_search', 'model_answer', 'product_search'].some(
        (action) => action === value.action,
      );
    case 'token':
      return text(value.text);
    case 'final':
      return text(value.text) && answerExtras(value);
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
function answerExtras(value: Record<string, unknown>): boolean {
  return (
    (value.products === undefined || isProductCards(value.products)) &&
    (value.inquirySuggestion === undefined ||
      (value.kind === 'team_followup' && isInquirySuggestion(value.inquirySuggestion))) &&
    (value.kind === undefined || PRODUCT_KINDS.some((kind) => kind === value.kind)) &&
    (value.unavailableProductIds === undefined ||
      (Array.isArray(value.unavailableProductIds) &&
        value.unavailableProductIds.length <= 2 &&
        value.unavailableProductIds.every(
          (id) => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id),
        )))
  );
}
const SNAPSHOT_STATUSES = ['queued', 'creating', 'running', 'completed', 'failed', 'cancelled'];
export function isConversationSnapshotV2(value: unknown): value is ConversationSnapshotV2 {
  return (
    record(value) &&
    value.protocolVersion === 2 &&
    isUuid(value.conversationId) &&
    Array.isArray(value.messages) &&
    value.messages.length <= 200 &&
    value.messages.every(
      (m) =>
        record(m) &&
        text(m.text) &&
        (m.role === 'visitor'
          ? isOperationKey(m.operationKey) &&
            (m.runId === null || isUuid(m.runId)) &&
            SNAPSHOT_STATUSES.includes(m.status as string)
          : m.role === 'assistant' && isUuid(m.runId) && answerExtras(m)),
    )
  );
}

