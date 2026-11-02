import type { CatalogAction } from '@vibelingan-channel/ai-contracts';
import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import {
  beginInquiryReview,
  currentPublicProducts,
  inquiryAfterFailure,
  inquiryCheckStart,
  nextInquiryCheckDelay,
  validateInquiry,
} from './inquiry';
import type {
  AssistantAdapter,
  AssistantState,
  InquiryDraft,
  InquiryView,
  PublicProduct,
  TurnRequest,
} from './model';
import { initialAssistantState, isTurnWorking, reduceAssistant } from './state';
import { AssistantTransportError } from './transport-error';

export interface AssistantSeed {
  state: AssistantState;
  inquiry?: InquiryView;
  inquiryOpen?: boolean;
  compareIds?: string[];
  confirmRegenerate?: boolean;
  draft?: string;
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
  const [inquiryOpen, setInquiryOpen] = useState(seed.inquiryOpen ?? false);
  const active = useRef<AbortController | null>(null);
  const cancelling = useRef<AbortController | null>(null);
  const saving = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const inquiryGeneration = useRef(0);
  const [now, setNow] = useState(Date.now());
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
    dispatch({ type: 'reset', state: initialAssistantState(crypto.randomUUID()) });
    setInquiry({ phase: 'closed' });
    inquiryRef.current = { phase: 'closed' };
    setInquiryOpen(false);
    setDraft('');
  }
  async function restore() {
    if (
      active.current ||
      isTurnWorking(latest.current.turn?.phase) ||
      ['editing', 'saving', 'unknown'].includes(inquiryRef.current.phase)
    )
      return;
    const controller = new AbortController();
    active.current = controller;
    const attempt = ++generation.current;
    inquiryGeneration.current += 1;
    dispatch({ type: 'restoring' });
    setInquiry({ phase: 'closed' });
    inquiryRef.current = { phase: 'closed' };
    setInquiryOpen(false);
    try {
      const restored = await adapter.restore(controller.signal);
      if (generation.current !== attempt || controller.signal.aborted) return;
      dispatch(restored ? { type: 'restored', conversation: restored } : { type: 'expired' });
    } catch {
      if (generation.current === attempt && !controller.signal.aborted)
        dispatch({ type: 'restore_failed' });
    } finally {
      if (active.current === controller) active.current = null;
    }
  }
  function beginInquiry(product?: PublicProduct, requirement?: string) {
    const suggestion = latest.current.messages
      .filter((message) => message.role === 'assistant')
      .at(-1)?.inquirySuggestion;
    const selected =
      product ??
      (!requirement && suggestion?.productId
        ? currentPublicProducts(latest.current.messages).get(suggestion.productId)
        : undefined);
    const next = beginInquiryReview(
      inquiryRef.current,
      {
        requirement:
          requirement ??
          suggestion?.requirement ??
          latest.current.messages.filter((message) => message.role === 'visitor').at(-1)?.text ??
          '',
        ...(selected ? { product: selected } : {}),
        explicitUpdate: requirement !== undefined || product !== undefined,
      },
      () => crypto.randomUUID(),
    );
    inquiryRef.current = next;
    setInquiry(next);
    setInquiryOpen(true);
  }
  function editInquiry(patch: Partial<InquiryDraft>) {
    const current = inquiryRef.current;
    if (current.phase !== 'editing') return;
    const next: InquiryView = { ...current, draft: { ...current.draft, ...patch }, errors: {} };
    inquiryRef.current = next;
    setInquiry(next);
  }
  /** `automatic`: a scheduled recheck of an unknown result, counted against the limit. */
  async function submitInquiry(automatic = false) {
    const current = inquiryRef.current;
    if (saving.current || (current.phase !== 'editing' && current.phase !== 'unknown')) return;
    let next: Extract<InquiryView, { phase: 'saving' }>;
    if (current.phase === 'editing') {
      const errors = validateInquiry(current.draft);
      if (Object.keys(errors).length) {
        const invalid: InquiryView = { ...current, errors, formError: undefined };
        inquiryRef.current = invalid;
        setInquiry(invalid);
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
    inquiryRef.current = next;
    setInquiry(next);
    const controller = new AbortController();
    saving.current = controller;
    const attempt = inquiryGeneration.current;
    try {
      const receipt = await adapter.submitInquiry(next.draft, next.key, controller.signal);
      if (inquiryGeneration.current !== attempt || controller.signal.aborted) return;
      const result: InquiryView = receipt
        ? { phase: 'saved', key: next.key, draft: next.draft, receipt }
        : { phase: 'unknown', key: next.key, draft: next.draft, checks: next.checks };
      inquiryRef.current = result;
      setInquiry(result);
      if (receipt) dispatch({ type: 'inquiry_saved', reference: receipt.reference });
    } catch (error) {
      if (inquiryGeneration.current === attempt && !controller.signal.aborted) {
        const result = inquiryAfterFailure(next, error);
        inquiryRef.current = result;
        setInquiry(result);
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
    inquiry,
    inquiryOpen,
    setInquiryOpen,
    beginInquiry,
    editInquiry,
    submitInquiry,
    retrySeconds: Math.max(0, Math.ceil(((retryAt ?? 0) - now) / 1000)),
  };
}
