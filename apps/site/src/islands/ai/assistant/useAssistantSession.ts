import type { CatalogAction } from '@vibelingan-channel/ai-contracts';
import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import {
  applyInquiryUpdate,
  currentPublicProducts,
  inquiryAfterFailure,
  inquiryCheckStart,
  inquiryReceipt,
  keepInquiryDraft,
  nextInquiryCheckDelay,
  persistedInquiry,
  proposeInquiry,
  restoredInquiry,
  validateInquiry,
} from './inquiry';
import type {
  AssistantAdapter,
  AssistantState,
  ChatMessage,
  InquiryDraft,
  InquiryView,
  PublicProduct,
  TurnRequest,
} from './model';
import type { AssistantAnchor, AssistantPersistence } from './persistence';
import { initialAssistantState, isTurnWorking, reduceAssistant, resumableRequest } from './state';
import { AssistantTransportError } from './transport-error';

export interface AssistantSeed {
  state: AssistantState;
  inquiry?: InquiryView;
  /** Whether the inquiry card in the conversation shows its form or only a summary. */
  inquiryExpanded?: boolean;
  confirmRegenerate?: boolean;
  draft?: string;
  /** The tab's saved conversation; restored once on mount when present. */
  persistence?: AssistantPersistence;
}

export function useAssistantSession(adapter: AssistantAdapter, seed: AssistantSeed) {
  const [state, dispatch] = useReducer(reduceAssistant, seed.state);
  const latest = useRef(state);
  useLayoutEffect(() => {
    latest.current = state;
  }, [state]);
  const [draft, setDraft] = useState(seed.draft ?? '');
  const [inquiry, setInquiry] = useState<InquiryView>(seed.inquiry ?? { phase: 'closed' });
  const inquiryRef = useRef(inquiry);
  useLayoutEffect(() => {
    inquiryRef.current = inquiry;
  }, [inquiry]);
  function commitInquiry(next: InquiryView) {
    inquiryRef.current = next;
    setInquiry(next);
  }
  const [inquiryExpanded, setInquiryExpanded] = useState(seed.inquiryExpanded ?? false);
  /** The product card the visitor left from, shown first when the panel opens. */
  const [anchor, setAnchor] = useState<Omit<AssistantAnchor, 'arriving'> | null>(null);
  /** This page was opened from a product link in the conversation. */
  const [arrived, setArrived] = useState(false);
  /** An answer finished while the panel was closed; the launcher shows a dot. */
  const [unseenAnswer, setUnseenAnswer] = useState(false);
  /** Bumped when the visitor asks to see the card, so it can take focus. */
  const [inquiryFocus, setInquiryFocus] = useState(0);
  // Suggestions already in the conversation when it was seeded or restored are
  // not offered again; only answers that arrive while a draft is open are.
  const suggestionSeen = useRef<string | undefined | null>(null);
  if (suggestionSeen.current === null)
    suggestionSeen.current = lastSuggestion(seed.state.messages)?.id;
  const active = useRef<AbortController | null>(null);
  const cancelling = useRef<AbortController | null>(null);
  const saving = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const inquiryGeneration = useRef(0);
  const [now, setNow] = useState(Date.now());
  // Read in a ref, not state: the server render has no storage, and the first
  // client render must match it. Until the restore settles nothing is written,
  // so an empty first render cannot overwrite what the tab saved.
  const pendingRestore = useRef<boolean | null>(null);
  if (pendingRestore.current === null) pendingRestore.current = Boolean(seed.persistence?.load());
  const retryAt = state.turn?.retryAt;
  useEffect(() => {
    if (!retryAt || retryAt <= now) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(1000, retryAt - now));
    return () => clearTimeout(timer);
  }, [retryAt, now]);
  useEffect(
    () => () => {
      generation.current += 1;
      inquiryGeneration.current += 1;
      active.current?.abort();
      cancelling.current?.abort();
      saving.current?.abort();
    },
    [],
  );

  async function drive(request: TurnRequest, cursor: number) {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    const attempt = ++generation.current;
    let ended = false;
    let appliedCursor = cursor;
    try {
      await adapter.run(
        request,
        cursor,
        (event) => {
          if (generation.current !== attempt || controller.signal.aborted) return;
          if (
            event.turnKey !== request.turnKey ||
            event.conversationKey !== request.conversationKey
          )
            return;
          if (!Number.isSafeInteger(event.sequence) || event.sequence <= appliedCursor) return;
          appliedCursor = event.sequence;
          if (event.type === 'rate_limited') setNow(Date.now());
          const terminal = ['finished', 'failed', 'rate_limited', 'cancelled'].includes(event.type);
          if (terminal) ended = true;
          dispatch({ type: 'event', event });
          if (terminal) {
            controller.abort();
            if (active.current === controller) active.current = null;
          }
        },
        controller.signal,
      );
      if (!ended && generation.current === attempt && !controller.signal.aborted)
        dispatch({ type: 'connection_error' });
    } catch (error) {
      if (generation.current === attempt && !controller.signal.aborted) {
        if (error instanceof AssistantTransportError) {
          if (error.expired) {
            dispatch({ type: 'expired' });
            return;
          }
          setNow(Date.now());
          dispatch({
            type: 'transport_error',
            message: error.message,
            ...(error.retryAt ? { retryAt: error.retryAt } : {}),
          });
        } else dispatch({ type: 'connection_error' });
      }
    } finally {
      if (active.current === controller) active.current = null;
    }
  }
  function send(message = draft, regenerate = false, catalogAction?: CatalogAction) {
    const current = latest.current;
    if (
      !message.trim() ||
      message.length > 8000 ||
      active.current ||
      isTurnWorking(current.turn?.phase) ||
      current.sessionStatus === 'restoring' ||
      current.sessionStatus === 'expired' ||
      current.sessionStatus === 'unavailable' ||
      (current.turn?.retryAt ?? 0) > Date.now()
    )
      return;
    const key = crypto.randomUUID();
    const request = {
      conversationKey: current.conversationKey,
      turnKey: key,
      idempotencyKey: key,
      message: message.trim(),
      ...(catalogAction ? { catalogAction } : {}),
    };
    dispatch({ type: 'begin', request, regenerate });
    setDraft('');
    // A new question moves the conversation on; later pages open at the latest.
    setAnchor(null);
    seed.persistence?.update({ anchor: undefined });
    // The answer appears above the card; a folded card keeps it in view.
    setInquiryExpanded(false);
    void drive(request, 0);
  }
  function retry() {
    const turn = latest.current.turn;
    if (
      !turn ||
      active.current ||
      !['reconnecting', 'failed', 'rate_limited'].includes(turn.phase) ||
      (turn.retryAt ?? 0) > Date.now()
    )
      return;
    dispatch({ type: 'resume' });
    void drive(turn.request, turn.cursor);
  }
  async function stop() {
    const turn = latest.current.turn;
    if (!turn || cancelling.current || !isTurnWorking(turn.phase)) return;
    const controller = new AbortController();
    cancelling.current = controller;
    const attempt = generation.current;
    const running = active.current;
    dispatch({ type: 'stop_requested' });
    try {
      const result = await adapter.stop(turn.request, controller.signal);
      if (generation.current !== attempt || controller.signal.aborted) return;
      dispatch({ type: result === 'stopped' ? 'stop_confirmed' : 'stop_unknown' });
      if (result === 'stopped') {
        running?.abort();
        if (active.current === running) active.current = null;
      }
    } catch (error) {
      if (generation.current === attempt && !controller.signal.aborted) {
        if (error instanceof AssistantTransportError && error.expired) {
          running?.abort();
          dispatch({ type: 'expired' });
        } else dispatch({ type: 'stop_unknown' });
      }
    } finally {
      if (cancelling.current === controller) cancelling.current = null;
    }
  }
  function reset() {
    if (saving.current || ['saving', 'unknown'].includes(inquiryRef.current.phase)) return;
    generation.current += 1;
    inquiryGeneration.current += 1;
    active.current?.abort();
    active.current = null;
    cancelling.current?.abort();
    cancelling.current = null;
    adapter.forget?.();
    dispatch({ type: 'reset', state: initialAssistantState(crypto.randomUUID()) });
    commitInquiry({ phase: 'closed' });
    suggestionSeen.current = undefined;
    setInquiryExpanded(false);
    setDraft('');
  }
  /**
   * `resync`: this page came back from the browser's back-forward cache, so the
   * tab's record (which the page in between may have moved on) wins over what
   * this page still holds in memory.
   */
  async function restore(resync = false) {
    if (resync) {
      pendingRestore.current = true;
      generation.current += 1;
      active.current?.abort();
      active.current = null;
      saving.current?.abort();
      saving.current = null;
    } else if (
      active.current ||
      isTurnWorking(latest.current.turn?.phase) ||
      ['editing', 'saving', 'unknown'].includes(inquiryRef.current.phase)
    ) {
      pendingRestore.current = false;
      return;
    }
    const controller = new AbortController();
    active.current = controller;
    const attempt = ++generation.current;
    inquiryGeneration.current += 1;
    dispatch({ type: 'restoring' });
    commitInquiry({ phase: 'closed' });
    setInquiryExpanded(false);
    try {
      const restored = await adapter.restore(controller.signal);
      if (generation.current !== attempt || controller.signal.aborted) return;
      if (!restored) {
        dispatch({ type: 'expired' });
        return;
      }
      suggestionSeen.current = lastSuggestion(restored.messages)?.id;
      const { arriving, ...left } = restored.anchor ?? { messageId: '' };
      // Arriving from a product link: the product stays readable at every
      // width and the launcher offers to continue. Otherwise the panel is as
      // it was left.
      const open = arriving ? false : restored.open;
      dispatch({
        type: 'restored',
        conversation: { ...restored, ...(open === undefined ? {} : { open }) },
      });
      setAnchor(restored.anchor ? left : null);
      setArrived(Boolean(arriving));
      if (arriving) seed.persistence?.update({ anchor: left });
      setUnseenAnswer(Boolean(restored.finishedWhileAway) && open === false);
      const view = restoredInquiry(restored.inquiry);
      commitInquiry(view);
      setInquiryExpanded(view.phase === 'editing' || view.phase === 'unknown');
      if (view.phase === 'saved')
        dispatch({ type: 'inquiry_saved', receipt: inquiryReceipt(view) });
      if (active.current === controller) active.current = null;
      if (restored.resume) void drive(restored.resume, 0);
    } catch {
      if (generation.current === attempt && !controller.signal.aborted)
        dispatch({ type: 'restore_failed' });
    } finally {
      if (active.current === controller) active.current = null;
      pendingRestore.current = false;
    }
  }
  const restoreOnMount = useRef(restore);
  useLayoutEffect(() => {
    restoreOnMount.current = restore;
  });
  useEffect(() => {
    if (pendingRestore.current) void restoreOnMount.current();
    const returned = (event: PageTransitionEvent) => {
      if (event.persisted && seed.persistence?.load()) void restoreOnMount.current(true);
    };
    window.addEventListener('pageshow', returned);
    return () => window.removeEventListener('pageshow', returned);
  }, [seed.persistence]);
  const lastPhase = useRef(state.turn?.phase);
  useEffect(() => {
    const finished = state.turn?.phase === 'complete' && lastPhase.current !== 'complete';
    lastPhase.current = state.turn?.phase;
    if (state.open) setUnseenAnswer(false);
    else if (finished) setUnseenAnswer(true);
  }, [state.open, state.turn?.phase]);
  /** Called as the visitor follows a product link in this tab. */
  function leaveForProduct(messageId: string, productId: string) {
    seed.persistence?.update({ anchor: { messageId, productId, arriving: true } });
  }
  // The tab record mirrors what a refresh needs: the conversation key, whether
  // the panel was open, an unfinished question and an unsent or uncertain inquiry.
  const resumable = resumableRequest(state.turn);
  useEffect(() => {
    if (!seed.persistence || pendingRestore.current) return;
    seed.persistence.update({
      conversationKey: state.conversationKey,
      open: state.open,
      turn: resumable
        ? {
            turnKey: resumable.turnKey,
            idempotencyKey: resumable.idempotencyKey,
            message: resumable.message,
            ...(resumable.catalogAction ? { catalogAction: resumable.catalogAction } : {}),
          }
        : undefined,
      inquiry: persistedInquiry(inquiry),
    });
  }, [seed.persistence, state.conversationKey, state.open, resumable, inquiry]);
  /**
   * The visitor's own request to start or review an inquiry. With a product or
   * requirement it proposes that change to the draft; without, it opens a new
   * draft from the latest suggestion or simply shows the existing one.
   */
  function beginInquiry(product?: PublicProduct, requirement?: string) {
    const current = inquiryRef.current;
    const messages = latest.current.messages;
    if (product || requirement !== undefined)
      commitInquiry(
        proposeInquiry(
          current,
          {
            origin: 'visitor',
            requirement:
              requirement ??
              (current.phase === 'editing' ? undefined : defaultRequirement(messages)),
            ...(product ? { product } : {}),
          },
          () => crypto.randomUUID(),
        ),
      );
    else if (current.phase === 'closed' || current.phase === 'saved') {
      const suggestion = lastSuggestion(messages)?.inquirySuggestion;
      const suggested = suggestion?.productId
        ? currentPublicProducts(messages).get(suggestion.productId)
        : undefined;
      commitInquiry(
        proposeInquiry(
          current,
          {
            origin: 'visitor',
            requirement: defaultRequirement(messages),
            ...(suggested ? { product: suggested } : {}),
          },
          () => crypto.randomUUID(),
        ),
      );
    }
    setInquiryExpanded(true);
    setInquiryFocus((count) => count + 1);
  }
  function editInquiry(patch: Partial<InquiryDraft>) {
    const current = inquiryRef.current;
    if (current.phase !== 'editing') return;
    commitInquiry({ ...current, draft: { ...current.draft, ...patch }, errors: {} });
  }
  // A new answer that suggests a different requirement or product puts that
  // change on the open draft for the visitor to accept or keep; it never opens
  // a draft or edits one by itself.
  const working = isTurnWorking(state.turn?.phase);
  useEffect(() => {
    const message = lastSuggestion(state.messages);
    if (working || !message?.inquirySuggestion || message.id === suggestionSeen.current) return;
    suggestionSeen.current = message.id;
    const { requirement, productId } = message.inquirySuggestion;
    const product = productId ? currentPublicProducts(state.messages).get(productId) : undefined;
    const next = proposeInquiry(
      inquiryRef.current,
      { origin: 'conversation', requirement, ...(product ? { product } : {}) },
      () => crypto.randomUUID(),
    );
    inquiryRef.current = next;
    setInquiry(next);
  }, [state.messages, working]);
  /** `automatic`: a scheduled recheck of an unknown result, counted against the limit. */
  async function submitInquiry(automatic = false) {
    const current = inquiryRef.current;
    if (saving.current || (current.phase !== 'editing' && current.phase !== 'unknown')) return;
    let next: Extract<InquiryView, { phase: 'saving' }>;
    if (current.phase === 'editing') {
      const errors = validateInquiry(current.draft);
      if (Object.keys(errors).length) {
        const { formError: _cleared, ...rest } = current;
        commitInquiry({ ...rest, errors });
        return;
      }
      next = {
        phase: 'saving',
        key: current.key,
        draft: structuredClone(current.draft),
        checks: 0,
        uncertain: false,
      };
    } else next = inquiryCheckStart(current, automatic);
    commitInquiry(next);
    const controller = new AbortController();
    saving.current = controller;
    const attempt = inquiryGeneration.current;
    try {
      const receipt = await adapter.submitInquiry(next.draft, next.key, controller.signal);
      if (inquiryGeneration.current !== attempt || controller.signal.aborted) return;
      if (receipt) {
        const saved = { phase: 'saved', key: next.key, draft: next.draft, receipt } as const;
        commitInquiry(saved);
        setInquiryExpanded(false);
        dispatch({ type: 'inquiry_saved', receipt: inquiryReceipt(saved) });
      } else
        commitInquiry({ phase: 'unknown', key: next.key, draft: next.draft, checks: next.checks });
    } catch (error) {
      if (inquiryGeneration.current === attempt && !controller.signal.aborted) {
        commitInquiry(inquiryAfterFailure(next, error));
      }
    } finally {
      if (saving.current === controller) saving.current = null;
    }
  }
  // An unknown result is rechecked with the same key a few times, then waits for
  // the visitor. The save is idempotent on the key, so a recheck never duplicates.
  const recheckInquiry = useRef(submitInquiry);
  useLayoutEffect(() => {
    recheckInquiry.current = submitInquiry;
  });
  useEffect(() => {
    const delay = nextInquiryCheckDelay(inquiry);
    if (delay === null) return;
    const timer = setTimeout(() => void recheckInquiry.current(true), delay);
    return () => clearTimeout(timer);
  }, [inquiry]);
  return {
    state,
    draft,
    setDraft,
    send,
    retry,
    stop,
    reset,
    restore,
    setOpen: (open: boolean) => dispatch({ type: 'open', open }),
    anchor,
    arrived,
    unseenAnswer,
    leaveForProduct,
    inquiry,
    inquiryExpanded,
    setInquiryExpanded,
    inquiryFocus,
    beginInquiry,
    editInquiry,
    applyInquiryUpdate: () =>
      commitInquiry(applyInquiryUpdate(inquiryRef.current, () => crypto.randomUUID())),
    keepInquiryDraft: () => commitInquiry(keepInquiryDraft(inquiryRef.current)),
    submitInquiry,
    retrySeconds: Math.max(0, Math.ceil(((retryAt ?? 0) - now) / 1000)),
  };
}

function lastSuggestion(messages: ChatMessage[]) {
  return messages.findLast((message) => message.role === 'assistant' && message.inquirySuggestion);
}
/** A new draft starts from the latest suggestion, else from the visitor's last question. */
function defaultRequirement(messages: ChatMessage[]) {
  return (
    lastSuggestion(messages)?.inquirySuggestion?.requirement ??
    messages.findLast((message) => message.role === 'visitor')?.text ??
    ''
  );
}
