export interface CreateConversationRequest {
  locale?: string;
}

export interface CreateConversationResponse {
  conversationId: string;
  credential: string;
  expiresAt: string;
}

export interface AppendMessageRequest {
  message: string;
  idempotencyKey: string;
}

export interface AppendMessageResponse {
  messageId: string;
  runId: string | null;
  disposition: 'started' | 'queued' | 'replayed';
}

export interface CancelResponse {
  cancelled: boolean;
}

export type PublicSseEvent =
  | { type: 'token'; sequence: number; text: string }
  | {
      type: 'citation';
      sequence: number;
      sourceId: string;
      title: string;
      url?: string;
    }
  | { type: 'final'; sequence: number; text: string }
  | { type: 'error'; sequence: number; category: string; retriable: boolean }
  | { type: 'handoff.started'; sequence: number }
  | { type: 'assistant.cancelled'; sequence: number }
  | { type: 'run.failed'; sequence: number; category?: string }
  | { type: 'conversation.closed'; sequence: number };

export type AiApiErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'BUDGET_EXHAUSTED'
  | 'UNAVAILABLE'
  | 'INTERNAL';

export interface AiApiErrorEnvelope {
  error: {
    code: AiApiErrorCode;
    message: string;
    requestId: string;
  };
}

export function isAppendMessageRequest(value: unknown): value is AppendMessageRequest {
  if (!isRecord(value)) return false;
  return (
    typeof value.message === 'string' &&
    value.message.trim().length > 0 &&
    value.message.length <= 8000 &&
    typeof value.idempotencyKey === 'string' &&
    value.idempotencyKey.length >= 8 &&
    value.idempotencyKey.length <= 128
  );
}

export function isCreateConversationRequest(value: unknown): value is CreateConversationRequest {
  if (!isRecord(value)) return false;
  return (
    value.locale === undefined ||
    (typeof value.locale === 'string' && /^[a-z]{2}(?:-[A-Z]{2})?$/.test(value.locale))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
