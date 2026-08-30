import type {
  AppendMessageResponse,
  CreateConversationResponse,
  PublicSseEvent,
} from '@vibelingan-channel/ai-contracts';
import { useEffect, useRef, useState } from 'react';

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

export function AssistantWidget() {
  const apiBase = (import.meta.env.PUBLIC_AI_API_BASE_URL ?? '').replace(/\/$/, '');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState<'ready' | 'streaming' | 'unavailable'>(
    apiBase ? 'ready' : 'unavailable',
  );
  const [conversation, setConversation] = useState<StoredConversation | null>(null);
  const [lastSequence, setLastSequence] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  function closeAssistant() {
    abortRef.current?.abort();
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }

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
        abortRef.current?.abort();
        setOpen(false);
        requestAnimationFrame(() => triggerRef.current?.focus());
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  useEffect(() => () => abortRef.current?.abort(), []);

  async function submit() {
    const message = draft.trim();
    if (!message || busy || !apiBase) return;
    setBusy(true);
    setDraft('');
    setMessages((current) => [
      ...current,
      { id: crypto.randomUUID(), role: 'visitor', text: message },
    ]);
    try {
      const active = conversation ?? (await createConversation(apiBase));
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
        },
      );
      if (!response.ok) throw new Error('message_failed');
      const accepted = parseAppendMessage(await response.json());
      if (accepted.disposition !== 'replayed') await stream(active);
    } catch (caught) {
      if (isAbortError(caught)) return;
      setStatus('unavailable');
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: 'status',
          text: 'The assistant is unavailable right now. Please send us your project instead.',
        },
      ]);
    } finally {
      setBusy(false);
    }
  }

  async function stream(active: StoredConversation) {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus('streaming');
    const assistantId = crypto.randomUUID();
    let cursor = lastSequence;
    setMessages((current) => [...current, { id: assistantId, role: 'assistant', text: '' }]);
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
        cursor = Math.max(cursor, event.sequence);
        setLastSequence(cursor);
        sessionStorage.setItem(SEQUENCE_KEY, String(cursor));
        if (event.type === 'token') {
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
          controller.abort();
          return;
        } else if (event.type === 'final') {
          setStatus('ready');
          controller.abort();
          return;
        } else if (event.type === 'assistant.cancelled' || event.type === 'handoff.started') {
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
    abortRef.current?.abort();
    const active = conversation;
    if (active) {
      await fetch(`${apiBase}/api/ai/conversations/${active.conversationId}/cancel`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${active.credential}` },
      }).catch(() => undefined);
    }
    setStatus('ready');
    setBusy(false);
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 sm:bottom-6 sm:right-6">
      {open && (
        <dialog
          open
          aria-modal="false"
          aria-label="Diversity Technology AI assistant"
          className="relative mb-3 ml-0 flex h-[min(38rem,calc(100svh-7rem))] w-[min(24rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-[var(--radius-card)] border border-slate-200 bg-white p-0 shadow-2xl"
        >
          <header className="flex items-center justify-between bg-brand-950 px-4 py-3 text-white">
            <div>
              <h2 className="font-display text-sm font-semibold">Product assistant</h2>
              <p className="text-xs text-slate-300">AI answers from approved public sources</p>
            </div>
            <button
              type="button"
              onClick={closeAssistant}
              className="rounded-lg p-2 text-slate-200 hover:bg-white/10"
              aria-label="Close assistant"
            >
              <span aria-hidden="true">×</span>
            </button>
          </header>

          <div className="flex-1 space-y-3 overflow-y-auto bg-surface-alt p-4" aria-live="polite">
            {messages.length === 0 && (
              <div className="rounded-xl bg-white p-4 text-sm leading-relaxed text-ink-soft shadow-sm">
                Ask about our OEM process, products, MOQ, quality controls, or certifications. I
                will refuse rather than guess when no approved source supports an answer.
              </div>
            )}
            {messages.map((message) => (
              <div
                key={message.id}
                className={
                  message.role === 'visitor'
                    ? 'ml-8 rounded-xl bg-brand-700 px-4 py-3 text-sm text-white'
                    : message.role === 'status'
                      ? 'rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900'
                      : 'mr-6 rounded-xl bg-white px-4 py-3 text-sm leading-relaxed text-ink shadow-sm'
                }
              >
                <p className="whitespace-pre-wrap">{message.text || '…'}</p>
                {message.citations && message.citations.length > 0 && (
                  <ul className="mt-3 space-y-1 border-t border-slate-100 pt-2 text-xs text-ink-muted">
                    {message.citations.map((citation, index) => (
                      <li key={`${citation.title}-${index}`}>
                        {citation.url ? (
                          <a
                            href={citation.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-medium text-brand-700 underline"
                          >
                            {citation.title} ↗
                          </a>
                        ) : (
                          citation.title
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
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
                  placeholder="Ask a product question…"
                  className="min-h-11 flex-1 resize-none rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/20"
                />
                {status === 'streaming' ? (
                  <button
                    type="button"
                    onClick={() => void stop()}
                    className="rounded-lg border border-slate-300 px-3 py-2.5 text-sm font-semibold text-ink"
                  >
                    Stop
                  </button>
                ) : (
                  <button
                    type="submit"
                    disabled={busy || !draft.trim()}
                    className="rounded-lg bg-brand-700 px-3 py-2.5 text-sm font-semibold text-white hover:bg-brand-800 disabled:opacity-50"
                  >
                    Send
                  </button>
                )}
              </form>
            )}
            <p className="mt-2 text-center text-[11px] text-ink-muted">
              AI can make mistakes. Verify commercial terms with our team.
            </p>
          </div>
        </dialog>
      )}

      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="ml-auto flex items-center gap-2 rounded-full bg-brand-950 px-5 py-3 text-sm font-semibold text-white shadow-xl transition hover:bg-brand-800 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2"
      >
        <span
          className="flex h-6 w-6 items-center justify-center rounded-full bg-accent-500 text-brand-950"
          aria-hidden="true"
        >
          ✦
        </span>
        Ask our AI
      </button>
      <noscript>
        <a
          href="/#oem-inquiry"
          className="mt-2 block text-sm font-semibold text-brand-700 underline"
        >
          Contact our team
        </a>
      </noscript>
    </div>
  );
}

async function createConversation(apiBase: string): Promise<StoredConversation> {
  const response = await fetch(`${apiBase}/api/ai/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locale: 'en' }),
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
  if (!value) return undefined;
  try {
    const url = new URL(value, window.location.origin);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function isAbortError(value: unknown): boolean {
  return value instanceof DOMException && value.name === 'AbortError';
}
