import {
  type ChatTurnV2,
  isChatEventV2,
  isChatTurnV2,
  isUuid,
} from '@vibelingan-channel/ai-contracts';
import type { AssistantAdapter, TurnEvent, TurnRequest } from './model';
import { AssistantTransportError } from './transport-error';

/** One mounted conversation; no browser storage, history restore, or inquiry submission. */
export function createHttpAssistantAdapter(
  baseUrl: string,
  requestFetch: typeof fetch = fetch,
): AssistantAdapter {
  const base = `${baseUrl.replace(/\/$/, '')}/api/ai/v2`;
  let credentials: Promise<{ conversationId: string; credential: string }> | undefined;
  let current:
    | { request: TurnRequest; emit: (e: TurnEvent) => void; turn: ChatTurnV2; cursor: number }
    | undefined;
  async function checked(
    url: string,
    signal: AbortSignal,
    credential?: string,
    body?: unknown,
    stream = false,
    cursor = 0,
  ) {
    const response = await requestFetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
        ...(stream ? { 'Last-Event-ID': String(cursor) } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(stream ? 90000 : 10000)]),
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 401) {
        credentials = undefined;
        current = undefined;
        throw new AssistantTransportError(
          'This conversation expired. Start a new conversation.',
          undefined,
          true,
        );
      }
      const seconds = Number(response.headers.get('Retry-After'));
      throw new AssistantTransportError(
        response.status === 409
          ? 'Another answer is active, or this submission has changed. Please try a new question.'
          : 'The service could not complete this request. Please try again.',
        response.status === 429 && Number.isFinite(seconds) && seconds > 0
          ? Date.now() + Math.min(seconds, 86400) * 1000
          : undefined,
      );
    }
    return response;
  }
  function auth(signal: AbortSignal) {
    if (!credentials)
      credentials = (async () => {
        const response = await checked(`${base}/conversations`, signal, undefined, {});
        const data: unknown = await response.json();
        if (
          !data ||
          typeof data !== 'object' ||
          !('conversationId' in data) ||
          !isUuid(data.conversationId) ||
          !('credential' in data) ||
          typeof data.credential !== 'string' ||
          data.credential.length < 32 ||
          data.credential.length > 128
        )
          throw new AssistantTransportError(
            'The conversation could not be verified. Please try again.',
          );
        return { conversationId: data.conversationId, credential: data.credential };
      })().catch((error) => {
        credentials = undefined;
        throw error;
      });
    return credentials;
  }
  async function state(request: TurnRequest, signal: AbortSignal, body?: unknown) {
    const c = await auth(signal);
    const response = await checked(
      `${base}/conversations/${c.conversationId}/${body === undefined ? `turns/${encodeURIComponent(request.idempotencyKey)}` : 'messages'}`,
      signal,
      c.credential,
      body,
    );
    const data: unknown = await response.json();
    if (
      !isChatTurnV2(data) ||
      data.conversationId !== c.conversationId ||
      data.operationKey !== request.idempotencyKey
    )
      throw new AssistantTransportError('The reply could not be verified. Please retry.');
    return data;
  }
  async function read(
    turn: ChatTurnV2,
    request: TurnRequest,
    cursor: number,
    emit: (e: TurnEvent) => void,
    signal: AbortSignal,
  ) {
    const c = await auth(signal);
    const response = await checked(
      `${base}/conversations/${c.conversationId}/events?turn=${encodeURIComponent(request.idempotencyKey)}`,
      signal,
      c.credential,
      undefined,
      true,
      cursor,
    );
    if (!response.body)
      throw new AssistantTransportError('The reply could not be read. Please retry.');
    let last = cursor;
    for await (const data of frames(response.body)) {
      const event: unknown = JSON.parse(data);
      if (
        !isChatEventV2(event) ||
        event.conversationId !== c.conversationId ||
        event.runId !== turn.runId ||
        event.messageId !== turn.messageId ||
        event.controlVersion !== turn.controlVersion
      )
        throw new AssistantTransportError('The reply could not be verified. Please retry.');
      if (event.sequence <= last) continue;
      last = event.sequence;
      if (current?.request.turnKey === request.turnKey) current.cursor = last;
      const identity = {
        conversationKey: request.conversationKey,
        turnKey: request.turnKey,
        sequence: event.sequence,
      };
      switch (event.type) {
        case 'token':
          emit({ ...identity, type: 'token', text: event.text });
          break;
        case 'citation':
          emit({
            ...identity,
            type: 'citation',
            title: event.title,
            ...(event.url ? { url: event.url } : {}),
          });
          break;
        case 'final':
          emit({
            ...identity,
            type: 'finished',
            text: event.text,
            ...(event.products ? { products: event.products } : {}),
            ...(event.kind ? { kind: event.kind } : {}),
            ...(event.unavailableProductIds
              ? { unavailableProductIds: event.unavailableProductIds }
              : {}),
          });
          return;
        case 'assistant.cancelled':
          emit({ ...identity, type: 'cancelled' });
          return;
        case 'error':
        case 'run.failed':
          emit({
            ...identity,
            type: 'failed',
            message:
              'I could not verify an answer for this question. Try another question or contact our team.',
          });
          return;
        default:
          throw new AssistantTransportError(
            'This answer is no longer available. Please contact our team.',
          );
      }
    }
  }
  return {
    async run(request, cursor, emit, signal) {
      const turn = await state(request, signal, {
        message: request.message,
        ...(request.catalogAction ? { catalogAction: request.catalogAction } : {}),
        idempotencyKey: request.idempotencyKey,
      });
      if (!turn.runId)
        throw new AssistantTransportError(
          'Another answer is being processed. Please retry shortly.',
        );
      current = { request, emit, turn, cursor };
      await read(turn, request, cursor, emit, signal);
    },
    async stop(request, signal) {
      const turn = await state(request, signal, {
        message: request.message,
        ...(request.catalogAction ? { catalogAction: request.catalogAction } : {}),
        idempotencyKey: request.idempotencyKey,
      });
      if (turn.status === 'cancelled') return 'stopped';
      if (turn.status === 'completed' || turn.status === 'failed') {
        if (current?.request.turnKey === request.turnKey)
          await read(turn, request, current.cursor, current.emit, signal);
        return 'unknown';
      }
      if (!turn.runId || turn.controlVersion === null) return 'unknown';
      const c = await auth(signal);
      await checked(
        `${base}/conversations/${c.conversationId}/turns/${encodeURIComponent(request.idempotencyKey)}/cancel`,
        signal,
        c.credential,
        { runId: turn.runId, controlVersion: turn.controlVersion },
      );
      const after = await state(request, signal);
      if (after.status === 'cancelled') return 'stopped';
      return 'unknown';
    },
    async restore() {
      throw new Error('History restore is not enabled');
    },
    async submitInquiry() {
      throw new Error('Inquiry submission is not enabled');
    },
  };
}

async function* frames(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  try {
    while (true) {
      const chunk = await reader.read();
      buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      if (buffer.length > 131072)
        throw new AssistantTransportError('The reply was too large to verify.');
      buffer = buffer.replace(/\r\n/g, '\n');
      let end = buffer.indexOf('\n\n');
      while (end >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data) yield data;
        end = buffer.indexOf('\n\n');
      }
      if (chunk.done) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
