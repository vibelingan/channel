import { useEffect, useMemo, useRef, useState } from 'react';
import { ChatComposer } from '../../../components/chat/ChatComposer';
import { ChatPanel } from '../../../components/chat/ChatPanel';
import { useChatViewport } from '../../../components/chat/useChatViewport';
import { AssistantMessages } from './AssistantMessages';
import { InquiryCard } from './InquiryCard';
import { currentPublicProducts } from './inquiry';
import type { AssistantAdapter, PublicProduct, TurnView } from './model';
import { isTurnWorking } from './state';
import { type AssistantSeed, useAssistantSession } from './useAssistantSession';
import { waitText } from './wait-text';

/** Set once a tab has seen the launcher's first-visit nudge. */
const WELCOME_NUDGE_KEY = 'channel.ai.welcome-nudge';

const actionClass =
  'min-h-11 rounded-lg border border-slate-300 bg-white px-3 text-xs font-semibold text-ink hover:bg-slate-50 disabled:opacity-50';
function turnStatus(turn: TurnView | null): string {
  if (!turn) return '';
  switch (turn.phase) {
    case 'queued':
      return 'Your question is received. Waiting for this answer…';
    case 'reading':
      return 'Checking approved product information…';
    case 'streaming':
      return 'Preparing your answer…';
    case 'stopping':
      return 'Stopping this answer. Waiting for confirmation…';
    case 'stop_unknown':
      return 'The stop result is not confirmed. Check this answer before starting another.';
    case 'stopped':
      return 'This answer has stopped. Your question and earlier content are kept.';
    case 'complete':
      return 'Answer ready.';
    case 'reconnecting':
      return 'The connection was interrupted. Resume this answer without sending a second question.';
    case 'failed':
      return (
        turn.detail ?? 'This answer could not finish. You can retry or ask a different question.'
      );
    case 'rate_limited':
      return 'The service asks you to wait before retrying. Your question is kept.';
  }
}

export function AssistantExperience({
  adapter,
  seed,
  preview = false,
  capabilities = { history: true, inquiries: true },
}: {
  adapter: AssistantAdapter;
  seed: AssistantSeed;
  preview?: boolean;
  capabilities?: { history: boolean; inquiries: boolean };
}) {
  const session = useAssistantSession(adapter, seed);
  const { state, inquiry } = session;
  const [confirmRegenerate, setConfirmRegenerate] = useState(seed.confirmRegenerate ?? false);
  const composer = useRef<HTMLTextAreaElement>(null);
  // A first visit in this tab gets one nudge towards the chat; later pages do not.
  const [welcome, setWelcome] = useState(false);
  useEffect(() => {
    try {
      if (sessionStorage.getItem(WELCOME_NUDGE_KEY)) return;
      sessionStorage.setItem(WELCOME_NUDGE_KEY, '1');
      setWelcome(true);
    } catch {
      // No storage: no nudge, the launcher still works.
    }
  }, []);
  // Once the visitor has opened the chat on this page, closing it is a choice:
  // the launcher stops nudging.
  const [openedHere, setOpenedHere] = useState(false);
  if (state.open && !openedHere) setOpenedHere(true);
  const messageRevision = state.messages
    .map(
      (message) =>
        `${message.id}:${message.text.length}:${message.products?.length ?? 0}:${message.citations?.length ?? 0}`,
    )
    .join('|');
  const revision = `${messageRevision}:${state.turn?.phase}:${inquiry.phase}:${session.inquiryExpanded}:${inquiry.phase === 'editing' && Boolean(inquiry.pending)}`;
  // Arriving from a product page: open at the card the visitor left from. When
  // that card is no longer in the restored history, open at the latest and say so.
  const anchor = session.anchor;
  const anchorMissing =
    Boolean(anchor) &&
    state.sessionStatus === 'ready' &&
    !state.messages.some((message) => message.id === anchor?.messageId);
  const anchorSelectors = useMemo(() => {
    if (!anchor || anchorMissing) return undefined;
    const message = `[data-message-id="${CSS.escape(anchor.messageId)}"]`;
    return anchor.productId
      ? [`${message} [data-product-id="${CSS.escape(anchor.productId)}"]`, message]
      : [message];
  }, [anchor, anchorMissing]);
  const viewport = useChatViewport(state.open, revision, anchorSelectors);
  const working = isTurnWorking(state.turn?.phase);
  const blocked =
    state.sessionStatus === 'restoring' ||
    state.sessionStatus === 'expired' ||
    state.sessionStatus === 'unavailable';
  const products = currentPublicProducts(state.messages);
  const talked = state.messages.some((message) => message.role === 'visitor');
  function send(message?: string) {
    setConfirmRegenerate(false);
    session.send(message);
  }

  return (
    <ChatPanel
      open={state.open}
      onOpenChange={session.setOpen}
      {...(!state.open && talked ? { launcherLabel: 'Continue conversation' } : {})}
      {...(session.unseenAnswer ? { launcherNotice: 'New answer' } : {})}
      nudge={
        !state.open &&
        !openedHere &&
        !blocked &&
        ((session.arrived && talked) || (welcome && !talked))
      }
      headerActions={
        capabilities.history && (
          <button
            type="button"
            aria-label="Restore conversation"
            title={
              inquiry.phase === 'editing'
                ? 'Finish reviewing your inquiry before restoring another conversation'
                : 'Restore conversation'
            }
            disabled={
              working || blocked || ['editing', 'saving', 'unknown'].includes(inquiry.phase)
            }
            onClick={() => void session.restore()}
            className="min-h-11 min-w-11 rounded-lg text-white disabled:opacity-40"
          >
            ↶
          </button>
        )
      }
    >
      {preview && (
        <p className="shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900">
          Component preview · sample data · no live service or submission
        </p>
      )}
      <div
        ref={viewport.transcriptRef}
        onScroll={viewport.onScroll}
        data-testid="assistant-transcript"
        role="log"
        aria-label="Conversation"
        aria-live="off"
        className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain bg-surface-alt p-4"
      >
        {state.sessionStatus === 'restoring' && (
          <output className="block rounded-xl bg-white p-4 text-sm">
            Restoring your conversation…
          </output>
        )}
        {state.restoreFailed && (
          <output className="block rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            Could not restore the saved conversation. Your current conversation is kept. Use Restore
            conversation to try again.
          </output>
        )}
        {state.sessionStatus === 'expired' && (
          <section className="rounded-xl bg-white p-4 text-sm">
            <h3 className="font-semibold">Start a new conversation</h3>
            <p className="mt-2">
              This conversation is no longer available. Earlier contact details will not be carried
              over.
            </p>
            <button type="button" onClick={session.reset} className={`${actionClass} mt-3`}>
              Start new conversation
            </button>
          </section>
        )}
        {state.messages.length === 0 &&
          (state.sessionStatus === 'welcome' || state.sessionStatus === 'ready') && (
            <section className="rounded-xl bg-white p-4 text-sm leading-relaxed shadow-sm">
              <p>
                {capabilities.inquiries
                  ? 'Find product options, understand OEM details, or prepare an inquiry for our team.'
                  : 'Find product options and understand OEM details. For a quote, use the website inquiry form below.'}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => send('Help me choose headphones for 500 company gifts.')}
                  className={actionClass}
                >
                  Help me choose
                </button>
                <button
                  type="button"
                  onClick={() => send('What can I customize for an OEM order?')}
                  className={actionClass}
                >
                  OEM options
                </button>
              </div>
            </section>
          )}
        <AssistantMessages
          messages={state.messages}
          currentProducts={products}
          inquiriesEnabled={capabilities.inquiries}
          onInquiry={session.beginInquiry}
          onViewProduct={session.leaveForProduct}
          {...(!working && !blocked && state.messages.at(-1)?.resultSet?.hasMore
            ? { showMoreFor: state.messages.at(-1)?.id }
            : {})}
          onShowMore={(messageId) => {
            const after = messageId.replace(/^answer:/, '');
            setConfirmRegenerate(false);
            session.send('Show more options', false, { kind: 'more', after });
          }}
          {...(!working && !blocked && session.retrySeconds === 0
            ? { suggestionsFor: state.messages.at(-1)?.id }
            : {})}
          onSuggestion={(suggestion) => {
            setConfirmRegenerate(false);
            // A visitor's unsent words are never replaced or sent for them.
            if (session.draft.trim()) {
              session.setDraft(`${session.draft.trimEnd()}\n${suggestion.utterance}`);
              composer.current?.focus();
            } else session.send(suggestion.utterance);
          }}
        />
        {anchorMissing && (
          <output className="block rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            The product card you opened is no longer shown here, so the conversation continues from
            the latest messages.
          </output>
        )}
        {state.turn?.steps.length ? (
          <ol
            aria-label="Product checks"
            className="space-y-1 rounded-lg border border-slate-200 p-3 text-xs text-ink-muted"
          >
            {[...new Set(state.turn.steps)].map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        ) : null}
        {state.turn && (
          <section
            aria-label="Answer status"
            className="rounded-xl border border-slate-200 bg-white p-3 text-xs text-ink-soft"
          >
            <output aria-live="polite">{turnStatus(state.turn)}</output>
            {session.retrySeconds > 0 && state.turn.phase === 'rate_limited' && (
              <p className="mt-2">
                Retry available in {waitText(session.retrySeconds)}, as requested by the service.
                {capabilities.inquiries &&
                  ' You can still send your requirement to our team with Prepare inquiry.'}
              </p>
            )}
            {['reconnecting', 'failed', 'rate_limited'].includes(state.turn.phase) && (
              <button
                type="button"
                onClick={() =>
                  state.turn?.retryMode === 'new_answer'
                    ? session.send(
                        state.turn.request.message,
                        true,
                        state.turn.request.catalogAction,
                      )
                    : session.retry()
                }
                disabled={session.retrySeconds > 0}
                className={`${actionClass} mt-2`}
              >
                {state.turn.retryMode === 'new_answer' ? 'Try again' : 'Resume this answer'}
              </button>
            )}
            {state.turn.phase === 'stop_unknown' && (
              <button
                type="button"
                onClick={() => void session.stop()}
                className={`${actionClass} mt-2`}
              >
                Check stop status
              </button>
            )}
            {state.turn.phase === 'stopped' && !confirmRegenerate && (
              <button
                type="button"
                onClick={() => setConfirmRegenerate(true)}
                className={`${actionClass} mt-2`}
              >
                Answer again
              </button>
            )}
            {confirmRegenerate && state.turn.phase === 'stopped' && (
              <div className="mt-3">
                <p>Start a new answer? The earlier answer will remain in this conversation.</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setConfirmRegenerate(false);
                      session.send(
                        state.turn?.request.message,
                        true,
                        state.turn?.request.catalogAction,
                      );
                    }}
                    className={actionClass}
                  >
                    Start new answer
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmRegenerate(false)}
                    className={actionClass}
                  >
                    Keep earlier answer
                  </button>
                </div>
              </div>
            )}
          </section>
        )}
        {capabilities.inquiries &&
          (inquiry.phase === 'editing' ||
            inquiry.phase === 'saving' ||
            inquiry.phase === 'unknown') && (
            <InquiryCard
              view={inquiry}
              expanded={session.inquiryExpanded}
              focusRequest={session.inquiryFocus}
              onToggle={session.setInquiryExpanded}
              onEdit={session.editInquiry}
              onSubmit={() => void session.submitInquiry()}
              onApply={session.applyInquiryUpdate}
              onKeep={session.keepInquiryDraft}
            />
          )}
      </div>
      <footer className="shrink-0 border-t border-slate-200 bg-white p-3">
        {viewport.hasNew && (
          <button
            type="button"
            className={`${actionClass} mb-2 w-full`}
            onClick={viewport.jumpToLatest}
          >
            New messages · Jump to latest
          </button>
        )}
        {state.sessionStatus === 'unavailable' ? (
          // biome-ignore lint/a11y/useValidAnchor: This link navigates normally; the handler only closes the overlay.
          <a
            href="/#oem-inquiry"
            onClick={() => session.setOpen(false)}
            className="flex min-h-11 items-center justify-center rounded-lg bg-accent-500 p-3 text-sm font-semibold text-brand-950"
          >
            Send your project to our team
          </a>
        ) : (
          <>
            <ChatComposer
              value={session.draft}
              onChange={session.setDraft}
              onSend={() => send()}
              onStop={() => void session.stop()}
              working={working}
              stopping={state.turn?.phase === 'stopping'}
              disabled={blocked || session.retrySeconds > 0}
              textareaRef={composer}
            />
            {!capabilities.inquiries && (
              // biome-ignore lint/a11y/useValidAnchor: This link navigates normally; the handler only closes the overlay.
              <a
                href="/#oem-inquiry"
                onClick={() => session.setOpen(false)}
                className="mt-1 flex min-h-11 w-full items-center justify-center text-xs font-semibold text-brand-700 underline"
              >
                Request a quote · Website inquiry form
              </a>
            )}
            {!blocked && capabilities.inquiries && (
              <button
                type="button"
                onClick={() => session.beginInquiry()}
                className="mt-1 min-h-11 w-full text-xs font-semibold text-brand-700 underline"
              >
                {inquiry.phase === 'closed'
                  ? 'Prepare inquiry'
                  : inquiry.phase === 'saved'
                    ? 'Start another inquiry'
                    : 'Review your inquiry'}
              </button>
            )}
          </>
        )}
        <p className="mt-1 text-center text-[11px] text-ink-muted">
          AI can make mistakes. Verify commercial terms with our team. ·{' '}
          <a href="/privacy/" target="_blank" rel="noopener noreferrer" className="underline">
            Privacy
          </a>
        </p>
      </footer>
    </ChatPanel>
  );
}
