import type {
  AppendMessageResponse,
  CreateConversationResponse,
  PublicSseEvent,
} from '@vibelingan-channel/ai-contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChatPanel } from '../../components/chat/ChatPanel';
import { safePublicChatLink } from '../../components/chat/public-link';
import { AnswerAttribution } from './assistant/AnswerAttribution';
import { AssistantActivity } from './assistant/AssistantActivity';
import type { TurnPhase } from './assistant/model';

interface StoredConversation {
  conversationId: string;
  credential: string;
  expiresAt: string;
}

interface ChatMessage {
  id: string;
  role: 'visitor' | 'assistant' | 'status';
  text: string;
  citations?: Array<{ title: string; url?: string }>;
}

const STORAGE_KEY = 'channel.ai.conversation.v1';
const SEQUENCE_KEY = 'channel.ai.sequence.v1';

import { ConnectedAssistant } from './assistant/ConnectedAssistant';

export function AssistantWidget() {
  return import.meta.env.PUBLIC_AI_CHAT_V2 === '1' ? (
    <ConnectedAssistant />
  ) : (
    <LegacyAssistantWidget />
  );
}

export function LegacyAssistantWidget({
  apiBase: configuredApiBase = import.meta.env.PUBLIC_AI_API_BASE_URL ?? '',
}: { apiBase?: string } = {}) {
  const apiBase = configuredApiBase.replace(/\/$/, '');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [phase, setPhase] = useState<TurnPhase>('queued');
  const [activity, setActivity] = useState<string>();
  const [answerId, setAnswerId] = useState<string>();
  const [status, setStatus] = useState<'ready' | 'streaming' | 'unavailable'>(
    apiBase ? 'ready' : 'unavailable',
  );
  const [conversation, setConversation] = useState<StoredConversation | null>(null);
  const [lastSequence, setLastSequence] = useState(0);
  const transcriptVersion = messages.reduce(
    (size, message) => size + message.text.length + (message.citations?.length ?? 0),
    0,
  );
  const abortRef = useRef<AbortController | null>(null);
  const stoppingRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  const closeAssistant = useCallback(() => {
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  useEffect(() => {
    const saved = readConversation();
    if (saved) {
      setConversation(saved);
      setLastSequence(readSequence());
    }
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && open) {
        closeAssistant();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, closeAssistant]);

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    if (!open || transcriptVersion === 0) return;
    const frame = requestAnimationFrame(() => {
      const transcript = transcriptRef.current;
      if (!transcript) return;
      transcript.scrollTo({
        top: transcript.scrollHeight,
        behavior: status === 'streaming' ? 'auto' : 'smooth',
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, status, transcriptVersion]);

  async function submit() {
    const message = draft.trim();
    if (!message || busy || abortRef.current || !apiBase) return;
    const controller = new AbortController();
    abortRef.current = controller;
    const assistantId = crypto.randomUUID();
    setAnswerId(assistantId);
    setPhase('queued');
    setActivity(undefined);
    setBusy(true);
    setDraft('');
    setMessages((current) => [
      ...current,
      { id: crypto.randomUUID(), role: 'visitor', text: message },
      { id: assistantId, role: 'assistant', text: '' },
    ]);
    try {
      const active = conversation ?? (await createConversation(apiBase, controller.signal));
      controller.signal.throwIfAborted();
      if (!conversation) {
        setConversation(active);
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(active));
        sessionStorage.setItem(SEQUENCE_KEY, '0');
      }
      const response = await fetch(
        `${apiBase}/api/ai/conversations/${active.conversationId}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${active.credential}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ message, idempotencyKey: crypto.randomUUID() }),
          signal: controller.signal,
        },
      );
      controller.signal.throwIfAborted();
      if (!response.ok) throw new Error('message_failed');
      parseAppendMessage(await response.json());
      controller.signal.throwIfAborted();
      await stream(active, controller, assistantId);
    } catch (caught) {
      if (isAbortError(caught) || controller.signal.aborted || abortRef.current !== controller)
        return;
      setStatus('unavailable');
      setPhase('failed');
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: 'status',
          text: 'The assistant is unavailable right now. Please send us your project instead.',
        },
      ]);
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setBusy(false);
      }
      if (stoppingRef.current === controller) stoppingRef.current = null;
    }
  }

  async function stream(
    active: StoredConversation,
    controller: AbortController,
    assistantId: string,
  ) {
    setStatus('streaming');
    let cursor = lastSequence;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await fetch(
        `${apiBase}/api/ai/conversations/${active.conversationId}/events`,
        {
          headers: {
            Authorization: `Bearer ${active.credential}`,
            'Last-Event-ID': String(cursor),
          },
          signal: controller.signal,
        },
      );
      if (!response.ok || !response.body) throw new Error('stream_failed');
      for await (const event of eventStream(response.body)) {
        if (controller.signal.aborted || abortRef.current !== controller) return;
        cursor = Math.max(cursor, event.sequence);
        setLastSequence(cursor);
        sessionStorage.setItem(SEQUENCE_KEY, String(cursor));
        if (event.type === 'tool.progress') {
          if (['knowledge_search', 'product_search', 'model_answer'].includes(event.action)) {
            setPhase('reading');
            setActivity(event.action);
          }
        } else if (event.type === 'token') {
          if (!event.text) continue;
          setPhase('streaming');
          setActivity(undefined);
          setMessages((current) =>
            current.map((item) =>
              item.id === assistantId ? { ...item, text: item.text + event.text } : item,
            ),
          );
        } else if (event.type === 'citation') {
          const safeUrl = safeCitationUrl(event.url);
          setMessages((current) =>
            current.map((item) =>
              item.id === assistantId
                ? {
                    ...item,
                    citations: [
                      ...(item.citations ?? []),
                      { title: event.title, ...(safeUrl ? { url: safeUrl } : {}) },
                    ],
                  }
                : item,
            ),
          );
        } else if (event.type === 'error' || event.type === 'run.failed') {
          setMessages((current) =>
            current.map((item) =>
              item.id === assistantId
                ? {
                    ...item,
                    role: 'status',
                    text: 'I could not ground an answer. Please ask our team.',
                  }
                : item,
            ),
          );
          setStatus('unavailable');
          setPhase('failed');
          controller.abort();
          return;
        } else if (event.type === 'final') {
          setMessages((current) =>
            current.map((item) =>
              item.id === assistantId
                ? {
                    ...item,
                    text: event.text?.trim()
                      ? event.text
                      : item.text.trim()
                        ? item.text
                        : 'I could not find an answer for this question. Please ask our team.',
                  }
                : item,
            ),
          );
          setPhase('complete');
          setStatus('ready');
          controller.abort();
          return;
        } else if (event.type === 'assistant.cancelled' || event.type === 'handoff.started') {
          setPhase('stopped');
          setStatus('ready');
          controller.abort();
          return;
        }
      }
      if (controller.signal.aborted) return;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
    throw new Error('stream_interrupted');
  }

  async function stop() {
    const controller = abortRef.current;
    const active = conversation;
    if (status !== 'streaming' || !controller || !active || stoppingRef.current) return;
    stoppingRef.current = controller;
    setPhase('stopping');
    try {
      const response = await fetch(
        `${apiBase}/api/ai/conversations/${active.conversationId}/cancel`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${active.credential}` },
        },
      );
      const result: unknown = response.ok ? await response.json() : undefined;
      if (abortRef.current !== controller || controller.signal.aborted) return;
      if (
        typeof result !== 'object' ||
        result === null ||
        !('cancelled' in result) ||
        result.cancelled !== true
      )
        throw new Error('cancellation_unconfirmed');
      controller.abort();
      abortRef.current = null;
      setPhase('stopped');
      setStatus('ready');
      setBusy(false);
    } catch {
      if (abortRef.current !== controller || controller.signal.aborted) return;
      setPhase((current) => (current === 'stopping' ? phase : current));
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: 'status',
          text: 'I could not confirm stopping this answer. It may still arrive.',
        },
      ]);
    } finally {
      if (stoppingRef.current === controller) stoppingRef.current = null;
    }
  }

  return (
    <ChatPanel
      open={open}
      onOpenChange={(next) => {
        if (next) setOpen(true);
        else closeAssistant();
      }}
      triggerRef={triggerRef}
    >
      <div
        ref={transcriptRef}
        className="flex-1 space-y-3 overflow-y-auto bg-surface-alt p-4"
        aria-live="polite"
      >
        {messages.length === 0 && (
          <div className="rounded-2xl border border-slate-200/80 bg-white p-5 text-sm leading-relaxed text-ink-soft shadow-sm">
            <p className="mb-2 text-base font-semibold tracking-tight text-brand-950">
              What are you working on?
            </p>
            Ask about our products, OEM process or quality standards. If a detail needs confirming,
            we will help you reach our team.
          </div>
        )}
        <LegacyTranscript
          messages={messages}
          {...(busy && phase === 'streaming' && answerId ? { streamingMessageId: answerId } : {})}
        />
        {busy && (
          <AssistantActivity
            phase={phase}
            activity={activity}
            hasContent={Boolean(messages.find((message) => message.id === answerId)?.text.trim())}
          />
        )}
      </div>

      <div className="border-t border-slate-200 bg-white p-3">
        {status === 'unavailable' ? (
          <a
            href="/#oem-inquiry"
            className="flex w-full items-center justify-center rounded-lg bg-accent-500 px-4 py-3 text-sm font-semibold text-brand-950 hover:bg-accent-400"
          >
            Send your project to our team
          </a>
        ) : (
          <form
            // The panel only renders once hydrated, so this form never
            // reaches a browser with no JavaScript. `method="post"` is
            // declared anyway: a <form> with no method natively submits
            // GET, which would put whatever the visitor typed into the URL,
            // their history and the Referer header. Making that safe by
            // construction beats relying on a render-order argument that a
            // later refactor can silently invalidate.
            method="post"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
            className="flex items-end gap-2"
          >
            <label htmlFor="ai-assistant-message" className="sr-only">
              Your question
            </label>
            <textarea
              ref={inputRef}
              id="ai-assistant-message"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              rows={2}
              maxLength={8000}
              disabled={busy}
              placeholder="Ask about products or your project…"
              className="min-h-12 min-w-0 flex-1 resize-none rounded-2xl border border-slate-200 bg-surface-alt px-3.5 py-3 text-sm leading-5 focus:border-brand-400 focus:outline-2 focus:outline-offset-1 focus:outline-brand-500 disabled:bg-slate-100"
            />
            {status === 'streaming' ? (
              <button
                type="button"
                onClick={() => void stop()}
                disabled={phase === 'stopping'}
                className="min-h-12 min-w-[4.5rem] rounded-xl border border-brand-200 bg-brand-50 px-3 text-xs font-semibold text-brand-900 hover:bg-brand-100 focus-visible:outline-2 focus-visible:outline-brand-600 disabled:opacity-50"
              >
                {phase === 'stopping' ? 'Stopping…' : 'Stop'}
              </button>
            ) : (
              <button
                type="submit"
                disabled={busy || !draft.trim()}
                className="min-h-12 min-w-[4.5rem] rounded-xl bg-brand-700 px-3 text-sm font-semibold text-white hover:bg-brand-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:opacity-40"
              >
                Send
              </button>
            )}
          </form>
        )}
        <p className="mt-2 text-center text-[11px] text-ink-muted">
          AI can make mistakes. Verify commercial terms with our team. ·{' '}
          <a href="/privacy/" target="_blank" rel="noopener noreferrer" className="underline">
            Privacy
          </a>
        </p>
      </div>
    </ChatPanel>
  );
}

export function LegacyTranscript({
  messages,
  streamingMessageId,
}: { messages: ChatMessage[]; streamingMessageId?: string }) {
  return (
    <>
      {messages
        .filter((message) => message.text.trim())
        .map((message) => (
          <div key={message.id}>
            <div
              data-message-role={message.role}
              className={
                message.role === 'visitor'
                  ? 'assistant-message ml-8 rounded-2xl rounded-br-md bg-brand-700 px-4 py-3 text-sm leading-relaxed text-white'
                  : message.role === 'status'
                    ? 'rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900'
                    : 'assistant-message mr-2 rounded-2xl rounded-bl-md border border-slate-200/80 bg-white p-4 text-sm leading-7 text-ink shadow-sm'
              }
            >
              <p className="whitespace-pre-wrap break-words">
                {message.text}
                {message.id === streamingMessageId && (
                  <span className="assistant-writing-cursor" aria-hidden="true" />
                )}
              </p>
            </div>
            {message.role === 'assistant' && <AnswerAttribution citations={message.citations} />}
          </div>
        ))}
    </>
  );
}

async function createConversation(
  apiBase: string,
  signal: AbortSignal,
): Promise<StoredConversation> {
  const response = await fetch(`${apiBase}/api/ai/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locale: 'en' }),
    signal,
  });
  if (!response.ok) throw new Error('conversation_failed');
  return parseCreateConversation(await response.json());
}

/**
 * Narrow, rather than assert, at the boundary.
 *
 * A type assertion is erased at build time and checks nothing. A response
 * missing `credential` would sail through, then surface much later in an
 * Authorization header reading "Bearer undefined" and fail with an HTTP 401
 * nowhere near the cause. These throw where the bad data actually arrives.
 */
function parseCreateConversation(value: unknown): CreateConversationResponse {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('conversationId' in value) ||
    typeof value.conversationId !== 'string' ||
    !('credential' in value) ||
    typeof value.credential !== 'string' ||
    !('expiresAt' in value) ||
    typeof value.expiresAt !== 'string'
  ) {
    throw new Error('conversation_malformed');
  }
  return {
    conversationId: value.conversationId,
    credential: value.credential,
    expiresAt: value.expiresAt,
  };
}

function parseAppendMessage(value: unknown): AppendMessageResponse {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('messageId' in value) ||
    typeof value.messageId !== 'string' ||
    !('runId' in value) ||
    (value.runId !== null && typeof value.runId !== 'string') ||
    !('disposition' in value) ||
    (value.disposition !== 'started' &&
      value.disposition !== 'queued' &&
      value.disposition !== 'replayed')
  ) {
    throw new Error('message_malformed');
  }
  return { messageId: value.messageId, runId: value.runId, disposition: value.disposition };
}

function readConversation(): StoredConversation | null {
  const value = sessionStorage.getItem(STORAGE_KEY);
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'conversationId' in parsed &&
      'credential' in parsed &&
      'expiresAt' in parsed &&
      typeof parsed.conversationId === 'string' &&
      typeof parsed.credential === 'string' &&
      typeof parsed.expiresAt === 'string' &&
      Date.parse(parsed.expiresAt) > Date.now()
    ) {
      return parsed as StoredConversation;
    }
  } catch {
    // Corrupt browser-local state is discarded and never treated as identity.
  }
  clearStoredConversation();
  return null;
}

function readSequence(): number {
  const value = Number(sessionStorage.getItem(SEQUENCE_KEY) ?? 0);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function clearStoredConversation(): void {
  sessionStorage.removeItem(STORAGE_KEY);
  sessionStorage.removeItem(SEQUENCE_KEY);
}

async function* eventStream(stream: ReadableStream<Uint8Array>): AsyncIterable<PublicSseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const data = frame
          .split(/\r?\n/)
          .find((line) => line.startsWith('data:'))
          ?.slice(5)
          .trim();
        if (!data) continue;
        const parsed = JSON.parse(data) as unknown;
        if (isPublicEvent(parsed)) yield parsed;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function isPublicEvent(value: unknown): value is PublicSseEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    'sequence' in value &&
    typeof value.type === 'string' &&
    typeof value.sequence === 'number'
  );
}

function safeCitationUrl(value: string | undefined): string | undefined {
  return safePublicChatLink(value, window.location.origin);
}

function isAbortError(value: unknown): boolean {
  return value instanceof DOMException && value.name === 'AbortError';
}
