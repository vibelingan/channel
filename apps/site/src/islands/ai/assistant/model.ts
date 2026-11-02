import type {
  CatalogAction,
  InquirySuggestion,
  PublicProductCard,
} from '@vibelingan-channel/ai-contracts';
/** View contracts only. A server adapter must authorize and decode its own wire data. */
export interface TurnRequest {
  conversationKey: string;
  turnKey: string;
  idempotencyKey: string;
  message: string;
  catalogAction?: CatalogAction;
}
export type AnswerKind =
  | 'answer'
  | 'clarification'
  | 'no_match'
  | 'unsupported'
  | 'team_followup'
  | 'product_updated';
export type PublicProduct = PublicProductCard;
import type { AssistantAnchor, PersistedInquiry } from './persistence';
export interface ChatMessage {
  id: string;
  role: 'visitor' | 'assistant';
  text: string;
  kind?: AnswerKind;
  citations?: Array<{ title: string; url?: string }>;
  products?: PublicProduct[];
  unavailableProductIds?: string[];
  inquirySuggestion?: InquirySuggestion;
  /** A saved inquiry, shown in the conversation where the review card was. */
  receipt?: InquiryReceiptSummary;
}
export interface InquiryReceiptSummary {
  reference: string;
  requirement: string;
  product?: string;
}
export type TurnPhase =
  | 'queued'
  | 'reading'
  | 'streaming'
  | 'stopping'
  | 'stop_unknown'
  | 'stopped'
  | 'complete'
  | 'reconnecting'
  | 'failed'
  | 'rate_limited';
export interface TurnView {
  request: TurnRequest;
  phase: TurnPhase;
  cursor: number;
  steps: string[];
  detail?: string;
  retryAt?: number;
  retryMode?: 'new_answer';
}
export interface AssistantState {
  conversationKey: string;
  open: boolean;
  sessionStatus: 'welcome' | 'ready' | 'restoring' | 'expired' | 'unavailable';
  restoreFailed?: boolean;
  messages: ChatMessage[];
  turn: TurnView | null;
}
type EventIdentity = { conversationKey: string; turnKey: string; sequence: number };
export type TurnEvent = EventIdentity &
  (
    | { type: 'reading' }
    | { type: 'tool'; label: string }
    | { type: 'token'; text: string }
    | { type: 'products'; products: PublicProduct[] }
    | { type: 'citation'; title: string; url?: string }
    | {
        type: 'finished';
        text?: string;
        kind?: AnswerKind;
        products?: PublicProduct[];
        unavailableProductIds?: string[];
        inquirySuggestion?: InquirySuggestion;
      }
    | { type: 'failed'; message: string }
    | { type: 'rate_limited'; retryAt?: number }
    | { type: 'cancelled' }
  );
export interface RestoredConversation {
  conversationKey: string;
  messages: ChatMessage[];
  /** A question still being answered; continue it with the same key from cursor 0. */
  resume?: TurnRequest;
  open?: boolean;
  inquiry?: PersistedInquiry;
  anchor?: AssistantAnchor;
  /** A question in flight when the visitor left has since finished. */
  finishedWhileAway?: true;
}
export interface InquiryDraft {
  requirement: string;
  name: string;
  email: string;
  company: string;
  consent: boolean;
  product?: PublicProduct;
}
export interface InquiryReceipt {
  reference: string;
}
export interface AssistantAdapter {
  run(
    request: TurnRequest,
    cursor: number,
    emit: (event: TurnEvent) => void,
    signal: AbortSignal,
  ): Promise<void>;
  stop(request: TurnRequest, signal: AbortSignal): Promise<'stopped' | 'unknown'>;
  restore(signal: AbortSignal): Promise<RestoredConversation | null>;
  /** Drop the conversation so the next question starts a new one. */
  forget?(): void;
  submitInquiry(
    draft: InquiryDraft,
    submissionKey: string,
    signal: AbortSignal,
  ): Promise<InquiryReceipt | null>;
}
/**
 * A change to the requirement or product the visitor has not accepted yet. The
 * draft keeps its current values until they choose to use it.
 */
export interface InquiryUpdate {
  origin: 'visitor' | 'conversation';
  requirement?: string;
  product?: PublicProduct;
}
export type InquiryView =
  | { phase: 'closed' }
  | {
      phase: 'editing';
      draft: InquiryDraft;
      key: string;
      errors: Partial<Record<keyof InquiryDraft, string>>;
      /** Why the service refused it before saving; nothing was submitted. */
      formError?: string;
      pending?: InquiryUpdate;
    }
  /** `uncertain`: an earlier attempt with this key may have been saved. */
  | { phase: 'saving'; draft: InquiryDraft; key: string; checks: number; uncertain: boolean }
  /** `checks`: automatic rechecks already made with the frozen draft and key. */
  | { phase: 'unknown'; draft: InquiryDraft; key: string; checks: number }
  | { phase: 'saved'; draft: InquiryDraft; key: string; receipt: InquiryReceipt };
