import type {
  AssistantState,
  ChatMessage,
  RestoredConversation,
  TurnEvent,
  TurnPhase,
  TurnRequest,
} from './model';

export type AssistantAction =
  | { type: 'open'; open: boolean }
  | { type: 'begin'; request: TurnRequest; regenerate?: boolean }
  | { type: 'event'; event: TurnEvent }
  | { type: 'transport_error'; message: string; retryAt?: number }
  | {
      type:
        | 'resume'
        | 'connection_error'
        | 'stop_requested'
        | 'stop_unknown'
        | 'stop_confirmed'
        | 'restoring'
        | 'restore_failed'
        | 'expired';
    }
  | { type: 'restored'; conversation: RestoredConversation }
  | { type: 'reset'; state: AssistantState };

export function initialAssistantState(conversationKey: string): AssistantState {
  return { conversationKey, open: true, sessionStatus: 'welcome', messages: [], turn: null };
}
export function isTurnWorking(phase: TurnPhase | undefined): boolean {
  return (
    phase !== undefined &&
    ['queued', 'reading', 'streaming', 'stopping', 'stop_unknown'].includes(phase)
  );
}
function terminal(phase: TurnPhase): boolean {
  return phase === 'complete' || phase === 'stopped';
}

export function reduceAssistant(state: AssistantState, action: AssistantAction): AssistantState {
  if (action.type === 'reset') return action.state;
  if (action.type === 'open') return { ...state, open: action.open };
  if (action.type === 'restoring')
    return { ...state, sessionStatus: 'restoring', restoreFailed: false };
  if (action.type === 'restore_failed')
    return { ...state, sessionStatus: 'ready', restoreFailed: true };
  if (action.type === 'expired')
    return { ...state, sessionStatus: 'expired', messages: [], turn: null, restoreFailed: false };
  if (action.type === 'restored')
    return {
      ...initialAssistantState(action.conversation.conversationKey),
      messages: action.conversation.messages,
      sessionStatus: 'ready',
      open: state.open,
    };
  if (action.type === 'begin') {
    if (
      action.request.conversationKey !== state.conversationKey ||
      isTurnWorking(state.turn?.phase)
    )
      return state;
    const visitor: ChatMessage[] = action.regenerate
      ? []
      : [
          {
            id: `visitor:${action.request.turnKey}`,
            role: 'visitor',
            text: action.request.message,
          },
        ];
    return {
      ...state,
      sessionStatus: 'ready',
      messages: [
        ...state.messages,
        ...visitor,
        { id: `answer:${action.request.turnKey}`, role: 'assistant', text: '' },
      ],
      turn: { request: action.request, phase: 'queued', cursor: 0, steps: [] },
    };
  }
  const turn = state.turn;
  if (!turn) return state;
  if (action.type === 'event') {
    const event = action.event;
    if (event.conversationKey !== state.conversationKey || event.turnKey !== turn.request.turnKey)
      return state;
    if (
      !Number.isSafeInteger(event.sequence) ||
      event.sequence <= turn.cursor ||
      terminal(turn.phase)
    )
      return state;
    const next = { ...turn, cursor: event.sequence };
    const update = (patch: Partial<ChatMessage>) =>
      state.messages.map((message) =>
        message.id === `answer:${turn.request.turnKey}` ? { ...message, ...patch } : message,
      );
    const answer = state.messages.find(
      (message) => message.id === `answer:${turn.request.turnKey}`,
    );
    const keepStop = turn.phase === 'stopping' || turn.phase === 'stop_unknown';
    switch (event.type) {
      case 'reading':
        return { ...state, turn: { ...next, phase: keepStop ? turn.phase : 'reading' } };
      case 'tool':
        return { ...state, turn: { ...next, steps: [...turn.steps, event.label] } };
      case 'token':
        return {
          ...state,
          messages: update({ text: (answer?.text ?? '') + event.text }),
          turn: { ...next, phase: keepStop ? turn.phase : 'streaming' },
        };
      case 'products':
        return { ...state, messages: update({ products: event.products }), turn: next };
      case 'citation':
        return {
          ...state,
          messages: update({
            citations: [
              ...(answer?.citations ?? []),
              { title: event.title, ...(event.url ? { url: event.url } : {}) },
            ],
          }),
          turn: next,
        };
      case 'finished':
        return {
          ...state,
          messages: update({
            text: event.text?.trim()
              ? event.text
              : answer?.text?.trim()
                ? answer.text
                : 'I could not find an answer for this question. Try another question or share your requirement with our team.',
            kind: event.kind ?? 'answer',
          }),
          turn: { ...next, phase: 'complete' },
        };
      case 'failed':
        return { ...state, turn: { ...next, phase: 'failed', detail: event.message } };
      case 'rate_limited':
        return {
          ...state,
          turn: {
            ...next,
            phase: 'rate_limited',
            ...(event.retryAt === undefined ? {} : { retryAt: event.retryAt }),
          },
        };
      case 'cancelled':
        return { ...state, turn: { ...next, phase: 'stopped' } };
    }
  }
  if (terminal(turn.phase)) return state;
  if (action.type === 'transport_error')
    return {
      ...state,
      turn: {
        ...turn,
        phase:
          turn.phase === 'stopping' || turn.phase === 'stop_unknown'
            ? 'stop_unknown'
            : action.retryAt
              ? 'rate_limited'
              : 'failed',
        detail: action.message,
        ...(action.retryAt ? { retryAt: action.retryAt } : {}),
      },
    };
  switch (action.type) {
    case 'resume':
      return { ...state, turn: { ...turn, phase: 'reconnecting', detail: undefined } };
    case 'connection_error':
      return {
        ...state,
        turn: {
          ...turn,
          phase:
            turn.phase === 'stopping' || turn.phase === 'stop_unknown'
              ? 'stop_unknown'
              : 'reconnecting',
        },
      };
    case 'stop_requested':
      return { ...state, turn: { ...turn, phase: 'stopping' } };
    case 'stop_unknown':
      return { ...state, turn: { ...turn, phase: 'stop_unknown' } };
    case 'stop_confirmed':
      return { ...state, turn: { ...turn, phase: 'stopped' } };
  }
}
