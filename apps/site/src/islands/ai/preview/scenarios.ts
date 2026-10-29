import screenData from '../../../../../../docs/ai-platform/assistant-ui/screens.json';
import type { ChatMessage, InquiryDraft, PublicProduct, TurnPhase } from '../assistant/model';
import { initialAssistantState, reduceAssistant } from '../assistant/state';
import type { AssistantSeed } from '../assistant/useAssistantSession';

export const screens = screenData.screens;
export const products: PublicProduct[] = [
  {
    id: 'sample-a',
    name: 'Logo-ready wireless headphones',
    summary: 'An over-ear direction for company gifts.',
    revision: 'sample-r1',
    href: '/headphones',
  },
  {
    id: 'sample-b',
    name: 'Compact wireless earbuds',
    summary: 'A pocket-sized direction for travel and events.',
    revision: 'sample-r2',
    href: '/headphones',
  },
];
export const sampleInquiry: InquiryDraft = {
  requirement:
    '500 headphones for a company event. Logo printing needed. Model and budget not decided.',
  name: 'Alex (sample)',
  email: 'buyer@example.invalid',
  company: 'Sample company',
  consent: false,
};
export function sampleHistory(): ChatMessage[] {
  return Array.from({ length: 40 }, (_, index) => ({
    id: `history-${index}`,
    role: index % 2 ? 'assistant' : 'visitor',
    text:
      index % 2
        ? `Earlier product discussion ${index}: we can check the approved options and keep commercial terms for your team to confirm. This is sample history used to verify reading and scrolling.`
        : `Earlier question ${index}: please help me understand the options for our company event.`,
  }));
}
export function seedFor(id: string): AssistantSeed {
  let state = initialAssistantState('preview-conversation');
  if (id === 'closed') return { state: { ...state, open: false } };
  if (id === 'welcome') return { state };
  if (id === 'composing') return { state, draft: 'I need 500 headphones for a company event.' };
  if (id === 'history_restoring') return { state: { ...state, sessionStatus: 'restoring' } };
  if (id === 'history_expired') return { state: { ...state, sessionStatus: 'expired' } };
  if (id === 'history_restored')
    return { state: { ...state, sessionStatus: 'ready', messages: sampleHistory() } };
  const request = {
    conversationKey: state.conversationKey,
    turnKey: 'preview-turn',
    idempotencyKey: 'preview-turn',
    message: 'I need 500 headphones for a company event. Can you suggest some options?',
  };
  state = reduceAssistant(state, { type: 'begin', request });
  const event = { conversationKey: request.conversationKey, turnKey: request.turnKey, sequence: 1 };
  if (!['queued', 'retrieving', 'tool_progress', 'stop_requested'].includes(id))
    state = reduceAssistant(state, {
      type: 'event',
      event: {
        ...event,
        type: 'token',
        text: 'Here are product directions to discuss. Model, price and delivery terms will be confirmed by our team.',
      },
    });
  if (['product_results', 'comparison', 'source_changed'].includes(id))
    state = reduceAssistant(state, {
      type: 'event',
      event: { ...event, sequence: 2, type: 'products', products },
    });
  const phase: Partial<Record<string, TurnPhase>> = {
    queued: 'queued',
    retrieving: 'reading',
    tool_progress: 'reading',
    streaming: 'streaming',
    network_failure: 'failed',
    reconnecting: 'reconnecting',
    rate_limit: 'rate_limited',
    stop_requested: 'stopping',
    stop_unconfirmed: 'stop_unknown',
    stopped: 'stopped',
    retry_after_stop: 'stopped',
  };
  if (state.turn)
    state = {
      ...state,
      turn: {
        ...state.turn,
        phase: phase[id] ?? 'complete',
        ...(id === 'tool_progress'
          ? { steps: ['Checked the approved product catalog', 'Comparing the published options'] }
          : {}),
        ...(id === 'rate_limit' ? { retryAt: Date.now() + 12000 } : {}),
      },
    };
  const replies: Record<string, { text: string; kind: ChatMessage['kind'] }> = {
    clarification: {
      text: 'What is your destination and preferred delivery date? You can still prepare an inquiry before choosing a model.',
      kind: 'clarification',
    },
    no_match: {
      text: 'I have not found an approved match for that requirement. Share your priorities and we can prepare the request for our team.',
      kind: 'no_match',
    },
    out_of_scope: {
      text: 'I cannot verify that topic here. I can help with our products, OEM options and purchase requirements.',
      kind: 'unsupported',
    },
    handoff: {
      text: 'Our team can follow up after you review and submit your requirement and contact details.',
      kind: 'team_followup',
    },
    source_changed: {
      text: 'Product details have changed since the earlier discussion. Please check the current version before confirming.',
      kind: 'product_updated',
    },
  };
  if (replies[id])
    state = {
      ...state,
      messages: state.messages.map((message) =>
        message.role === 'assistant' ? { ...message, ...replies[id] } : message,
      ),
    };
  const seed: AssistantSeed = {
    state,
    ...(id === 'comparison' ? { compareIds: products.map((product) => product.id) } : {}),
    ...(id === 'retry_after_stop' ? { confirmRegenerate: true } : {}),
  };
  if (id.startsWith('inquiry_')) {
    const draft = {
      ...sampleInquiry,
      consent: !['inquiry_review', 'inquiry_validation'].includes(id),
      ...(id === 'inquiry_validation' ? { email: 'invalid', requirement: '' } : {}),
    };
    const base = { key: 'preview-inquiry-key', draft };
    seed.inquiryOpen = true;
    seed.inquiry =
      id === 'inquiry_submitting'
        ? { ...base, phase: 'saving' }
        : id === 'inquiry_unknown'
          ? { ...base, phase: 'unknown' }
          : id === 'inquiry_saved'
            ? { ...base, phase: 'saved', receipt: { reference: 'PREVIEW-001' } }
            : {
                ...base,
                phase: 'editing',
                errors:
                  id === 'inquiry_validation'
                    ? {
                        requirement: 'Please describe your requirement.',
                        email: 'Please enter a valid email address.',
                        consent: 'Please agree to be contacted about this inquiry.',
                      }
                    : {},
              };
  }
  return seed;
}
