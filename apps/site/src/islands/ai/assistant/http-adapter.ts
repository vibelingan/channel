import {
  type ChatTurnV2,
  isChatEventV2,
  isChatTurnV2,
  isConversationSnapshotV2,
  isUuid,
} from '@vibelingan-channel/ai-contracts';
import {
  INQUIRY_CONSENT_VERSION,
  isInquiryRejectionReason,
  isInquirySubmissionReceipt,
} from '@vibelingan-channel/ai-contracts/inquiry';
import type { AssistantAdapter, ChatMessage, TurnEvent, TurnRequest } from './model';
import type { AssistantPersistence } from './persistence';
import { AssistantTransportError, InquiryRejectedError } from './transport-error';

/**
 * One conversation per tab. Without `persistence` the credential stays in
 * memory; with it, a refresh or same-tab navigation continues the conversation.
 */
export function createHttpAssistantAdapter(
  baseUrl: string,
  requestFetch: typeof fetch = fetch,
  persistence?: AssistantPersistence,
): AssistantAdapter {
  const base = `${baseUrl.replace(/\/$/, '')}/api/ai/v2`;
  const saved = persistence?.load();
  let credentials: Promise<{ conversationId: string; credential: string }> | undefined = saved
    ? Promise.resolve({ conversationId: saved.conversationId, credential: saved.credential })
    : undefined;
  const submissions = new Map<string, { conversationId: string; credential: string; body: string }>(
    (saved?.submissions ?? []).map((s) => [
      s.key,
      {
        conversationId: saved?.conversationId ?? '',
        credential: saved?.credential ?? '',
        body: s.body,
      },
    ]),
  );
  function rememberSubmissions() {
    persistence?.update({
      submissions: [...submissions].slice(-4).map(([key, s]) => ({ key, body: s.body })),
    });
  }
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
    timeoutMs = 10000,
    inquiry = false,
  ) {
    const response = await requestFetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
        ...(stream ? { 'Last-Event-ID': String(cursor) } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(stream ? 90000 : timeoutMs)]),
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
    });
    if (!response.ok) {
      if (inquiry && (response.status === 400 || response.status === 422)) {
        // Only an explicit "not_started" may tell the visitor nothing was saved.
        const refusal: unknown = await response.json().catch(() => undefined);
        const detail =
          refusal && typeof refusal === 'object' ? Reflect.get(refusal, 'error') : null;
        if (
          detail &&
          typeof detail === 'object' &&
          Reflect.get(detail, 'outcome') === 'not_started' &&
          isInquiryRejectionReason(Reflect.get(detail, 'reason'))
        )
          throw new InquiryRejectedError(Reflect.get(detail, 'reason'));
      }
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 401) {
        credentials = undefined;
        current = undefined;
        persistence?.clear();
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
  function auth(signal: AbortSignal, conversationKey = 'website-chat') {
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
        const expiresAt =
          'expiresAt' in data && typeof data.expiresAt === 'string' ? data.expiresAt : '';
        if (Number.isFinite(Date.parse(expiresAt)))
          persistence?.save({
            version: 1,
            conversationId: data.conversationId,
            credential: data.credential,
            expiresAt,
            conversationKey,
            open: true,
          });
        return { conversationId: data.conversationId, credential: data.credential };
      })().catch((error) => {
        credentials = undefined;
        throw error;
      });
    return credentials;
  }
  async function state(request: TurnRequest, signal: AbortSignal, body?: unknown) {
    const c = await auth(signal, request.conversationKey);
    if (body !== undefined) {
      // Record the question before sending it: after a reload, resending it with
      // the same key either finds it or creates it once. The tab record may only
      // exist from this request on; the session clears it when the answer ends.
      const { conversationKey: _key, ...question } = request;
      persistence?.update({ turn: question });
    }
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
        case 'tool.progress':
          emit({
            ...identity,
            type: 'tool',
            label:
              event.action === 'knowledge_search'
                ? 'Checking public company information'
                : event.action === 'product_search'
                  ? 'Checking current published products'
                  : 'Preparing a helpful response',
          });
          break;
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
            ...(event.inquirySuggestion ? { inquirySuggestion: event.inquirySuggestion } : {}),
            ...(event.resultSet ? { resultSet: event.resultSet } : {}),
            ...(event.suggestions ? { suggestions: event.suggestions } : {}),
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
      // Cancellation is queued. Wait briefly for that exact run to terminalize.
      for (let attempt = 0; attempt < 8; attempt++) {
        const after = await state(request, signal);
        if (after.runId !== turn.runId || after.controlVersion !== turn.controlVersion)
          return 'unknown';
        if (after.status === 'cancelled') return 'stopped';
        if (after.status === 'completed' || after.status === 'failed') return 'unknown';
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', finish);
            resolve();
          };
          const timer = setTimeout(finish, 100);
          signal.addEventListener('abort', finish, { once: true });
          if (signal.aborted) finish();
        });
        signal.throwIfAborted();
      }
      return 'unknown';
    },
    async restore(signal) {
      const record = persistence?.load();
      if (!record) return null;
      credentials = Promise.resolve({
        conversationId: record.conversationId,
        credential: record.credential,
      });
      let response: Response;
      try {
        response = await checked(
          `${base}/conversations/${record.conversationId}/snapshot`,
          signal,
          record.credential,
        );
      } catch (error) {
        if (error instanceof AssistantTransportError && error.expired) return null;
        throw error;
      }
      const snapshot: unknown = await response.json();
      if (!isConversationSnapshotV2(snapshot) || snapshot.conversationId !== record.conversationId)
        throw new AssistantTransportError('The saved conversation could not be verified.');
      const messages: ChatMessage[] = [];
      const questionByRun = new Map<string, string>();
      let resume: TurnRequest | undefined;
      let resumeSeen = false;
      for (const m of snapshot.messages) {
        if (m.role === 'visitor') {
          if (m.runId) questionByRun.set(m.runId, m.operationKey);
          messages.push({ id: `visitor:${m.operationKey}`, role: 'visitor', text: m.text });
          if (record.turn?.idempotencyKey === m.operationKey) {
            resumeSeen = true;
            if (['queued', 'creating', 'running'].includes(m.status))
              resume = { conversationKey: record.conversationKey, ...record.turn };
          }
          if (m.status === 'failed' || m.status === 'cancelled')
            messages.push({
              id: `answer:${m.operationKey}`,
              role: 'assistant',
              kind: 'answer',
              text:
                m.status === 'failed'
                  ? 'This answer could not finish. You can ask again.'
                  : 'This answer was stopped.',
            });
          continue;
        }
        const { role: _role, runId, ...answer } = m;
        messages.push({
          ...answer,
          id: `answer:${questionByRun.get(runId) ?? `run:${runId}`}`,
          role: 'assistant',
          kind: answer.kind ?? 'answer',
        });
      }
      // A question sent just before leaving may not have reached the server:
      // resending it with the same key either finds it or creates it once.
      if (record.turn && !resumeSeen)
        resume = { conversationKey: record.conversationKey, ...record.turn };
      return {
        conversationKey: record.conversationKey,
        messages,
        open: record.open,
        ...(resume ? { resume } : {}),
        ...(record.inquiry ? { inquiry: record.inquiry } : {}),
        ...(record.anchor ? { anchor: record.anchor } : {}),
        ...(record.turn && !resume ? { finishedWhileAway: true as const } : {}),
      };
    },
    forget() {
      credentials = undefined;
      current = undefined;
      submissions.clear();
      persistence?.clear();
    },
    async submitInquiry(draft, submissionKey, signal) {
      const body = {
        submissionKey,
        requirement: draft.requirement.trim(),
        name: draft.name.trim(),
        email: draft.email.trim(),
        company: draft.company.trim(),
        consent: draft.consent,
        consentVersion: INQUIRY_CONSENT_VERSION,
        ...(draft.product ? { productId: draft.product.id } : {}),
      };
      let original = submissions.get(submissionKey);
      if (!original) {
        const identity = await auth(signal);
        original = { ...identity, body: JSON.stringify(body) };
        submissions.set(submissionKey, original);
        rememberSubmissions();
      }
      if (original.body !== JSON.stringify(body))
        throw new AssistantTransportError(
          'Check the original inquiry before starting another one.',
        );
      let response: Response;
      try {
        response = await checked(
          `${base}/conversations/${original.conversationId}/inquiries`,
          signal,
          original.credential,
          body,
          false,
          0,
          45000,
          true,
        );
      } catch (error) {
        // Nothing was saved under this key, so a corrected draft may reuse it.
        if (error instanceof InquiryRejectedError) {
          submissions.delete(submissionKey);
          rememberSubmissions();
        }
        throw error;
      }
      const receipt: unknown = await response.json();
      if (
        !isInquirySubmissionReceipt(receipt) ||
        receipt.conversationId !== original.conversationId ||
        receipt.submissionKey !== submissionKey
      )
        throw new AssistantTransportError(
          'The inquiry receipt could not be verified. Check the original submission.',
        );
      return { reference: receipt.reference };
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
