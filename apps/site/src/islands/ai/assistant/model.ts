import type { CatalogAction, PublicProductCard } from '@vibelingan-channel/ai-contracts';
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
export interface ChatMessage {
  id: string;
  role: 'visitor' | 'assistant';
  text: string;
  kind?: AnswerKind;
  citations?: Array<{ title: string; url?: string }>;
  products?: PublicProduct[];
  unavailableProductIds?: string[];
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
      }
    | { type: 'failed'; message: string }
    | { type: 'rate_limited'; retryAt?: number }
    | { type: 'cancelled' }
  );
export interface RestoredConversation {
  conversationKey: string;
  messages: ChatMessage[];
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
  submitInquiry(
    draft: InquiryDraft,
    submissionKey: string,
    signal: AbortSignal,
  ): Promise<InquiryReceipt | null>;
}
export type InquiryView =
  | { phase: 'closed' }
  | {
      phase: 'editing';
      draft: InquiryDraft;
      key: string;
      errors: Partial<Record<keyof InquiryDraft, string>>;
    }
  | { phase: 'saving' | 'unknown'; draft: InquiryDraft; key: string }
  | { phase: 'saved'; draft: InquiryDraft; key: string; receipt: InquiryReceipt };
