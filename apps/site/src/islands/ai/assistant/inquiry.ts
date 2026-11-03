import type { InquiryRejectionReason } from '@vibelingan-channel/ai-contracts/inquiry';
import type {
  ChatMessage,
  InquiryDraft,
  InquiryReceiptSummary,
  InquiryUpdate,
  InquiryView,
  PublicProduct,
} from './model';
import type { PersistedInquiry } from './persistence';
import { InquiryRejectedError } from './transport-error';
export function currentPublicProducts(messages: ChatMessage[]) {
  const products = new Map<string, PublicProduct>();
  for (const message of messages) {
    for (const product of message.products ?? []) products.set(product.id, product);
    for (const id of message.unavailableProductIds ?? []) products.delete(id);
  }
  return products;
}
export interface InquiryProposal {
  /** `visitor`: their own click. Only that may open a draft or replace something without asking. */
  origin: 'visitor' | 'conversation';
  requirement?: string;
  product?: PublicProduct;
}
export interface InquiryChange {
  field: 'requirement' | 'product';
  before: string;
  after: string;
}
/** What `update` would change in `draft`, shown to the visitor before they choose. */
export function inquiryChanges(
  draft: InquiryDraft,
  update: Pick<InquiryProposal, 'requirement' | 'product'>,
): InquiryChange[] {
  const changes: InquiryChange[] = [];
  const requirement = update.requirement?.trim();
  if (requirement && requirement !== draft.requirement.trim())
    changes.push({ field: 'requirement', before: draft.requirement.trim(), after: requirement });
  const product = update.product;
  if (product && (product.id !== draft.product?.id || product.revision !== draft.product.revision))
    changes.push({
      field: 'product',
      before: draft.product?.name ?? '',
      after: product.id === draft.product?.id ? `${product.name} (updated details)` : product.name,
    });
  return changes;
}
/**
 * Opens or updates the one active draft. A suggestion from the conversation
 * never opens a draft and never changes one by itself: anything it would
 * change waits on the card for the visitor. The visitor's own click may fill
 * an empty field directly, but replacing a value they can see also waits, so
 * a second product card cannot silently swap the first. A saving or uncertain
 * submission is frozen, and a saved one is only followed by a new draft the
 * visitor starts.
 */
export function proposeInquiry(
  current: InquiryView,
  proposal: InquiryProposal,
  key: () => string,
): InquiryView {
  if (current.phase === 'saving' || current.phase === 'unknown') return current;
  if (current.phase === 'closed' || current.phase === 'saved') {
    if (proposal.origin !== 'visitor') return current;
    return {
      phase: 'editing',
      key: key(),
      errors: {},
      draft: {
        name: current.phase === 'saved' ? current.draft.name : '',
        email: current.phase === 'saved' ? current.draft.email : '',
        company: current.phase === 'saved' ? current.draft.company : '',
        requirement: proposal.requirement?.trim() ?? '',
        ...(proposal.product ? { product: proposal.product } : {}),
      },
    };
  }
  const changes = inquiryChanges(current.draft, proposal);
  if (!changes.length) return current;
  const pending: InquiryUpdate = { origin: proposal.origin };
  for (const change of changes)
    if (change.field === 'requirement' && proposal.requirement)
      pending.requirement = proposal.requirement.trim();
    else if (change.field === 'product' && proposal.product) pending.product = proposal.product;
  const next = { ...current, pending };
  return proposal.origin === 'visitor' && changes.every((c) => !c.before)
    ? applyInquiryUpdate(next, key)
    : next;
}
/** Use the pending change: contact details stay and the unsent key changes. */
export function applyInquiryUpdate(view: InquiryView, key: () => string): InquiryView {
  if (view.phase !== 'editing' || !view.pending) return view;
  const { requirement, product } = view.pending;
  return {
    phase: 'editing',
    key: key(),
    errors: {},
    draft: {
      ...view.draft,
      ...(requirement ? { requirement } : {}),
      ...(product ? { product } : {}),
    },
  };
}
/** Keep the draft as the visitor has it and drop the pending change. */
export function keepInquiryDraft(view: InquiryView): InquiryView {
  if (view.phase !== 'editing' || !view.pending) return view;
  const { pending: _dropped, ...rest } = view;
  return rest;
}
export function inquiryReceipt(
  view: Extract<InquiryView, { phase: 'saved' }>,
): InquiryReceiptSummary {
  return {
    reference: view.receipt.reference,
    requirement: view.draft.requirement,
    ...(view.draft.product ? { product: view.draft.product.name } : {}),
  };
}
export function validateInquiry(draft: InquiryDraft): Partial<Record<keyof InquiryDraft, string>> {
  const errors: Partial<Record<keyof InquiryDraft, string>> = {};
  if (!draft.requirement.trim() || draft.requirement.length > 4000)
    errors.requirement = 'Please describe your requirement (up to 4,000 characters).';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email.trim()) || draft.email.length > 254)
    errors.email = 'Please enter a valid email address.';
  if (draft.name.length > 120) errors.name = 'Please use up to 120 characters.';
  if (draft.company.length > 200) errors.company = 'Please use up to 200 characters.';
  return errors;
}

type Saving = Extract<InquiryView, { phase: 'saving' }>;
type Unknown = Extract<InquiryView, { phase: 'unknown' }>;
/** Automatic rechecks of an unknown result; afterwards the visitor checks manually. */
export const INQUIRY_AUTO_CHECK_DELAYS_MS = [3000, 8000, 20000] as const;
const refusals: Record<InquiryRejectionReason, string> = {
  INVALID_DETAILS: 'Nothing was submitted. Please check the details and try again.',
  PRODUCT_UNVERIFIED:
    'Nothing was submitted. We could not verify this product just now; please try again shortly.',
  NOT_ACCEPTING:
    'Nothing was submitted. We are not accepting inquiries here right now; please try again later.',
};
/**
 * Only a refusal of a key that was never uncertain may reopen the form: once an
 * attempt may have been saved, the draft stays frozen until a receipt arrives.
 */
export function inquiryAfterFailure(saving: Saving, error: unknown): InquiryView {
  if (error instanceof InquiryRejectedError && !saving.uncertain)
    return {
      phase: 'editing',
      key: saving.key,
      draft: saving.draft,
      errors: {},
      formError: refusals[error.reason],
    };
  return { phase: 'unknown', key: saving.key, draft: saving.draft, checks: saving.checks };
}
export function nextInquiryCheckDelay(view: InquiryView): number | null {
  if (view.phase !== 'unknown') return null;
  return INQUIRY_AUTO_CHECK_DELAYS_MS[view.checks] ?? null;
}
/** Recheck with the same key and frozen draft; the save is idempotent on that key. */
export function inquiryCheckStart(view: Unknown, automatic: boolean): Saving {
  return {
    phase: 'saving',
    key: view.key,
    draft: view.draft,
    checks: view.checks + (automatic ? 1 : 0),
    uncertain: true,
  };
}
/** A save interrupted by navigation is uncertain, so it comes back as `unknown`. */
export function persistedInquiry(view: InquiryView): PersistedInquiry | undefined {
  switch (view.phase) {
    case 'closed':
      return undefined;
    case 'editing':
      return { phase: 'editing', key: view.key, draft: view.draft };
    case 'saving':
    case 'unknown':
      return { phase: 'unknown', key: view.key, draft: view.draft, checks: view.checks };
    case 'saved':
      return {
        phase: 'saved',
        key: view.key,
        draft: view.draft,
        reference: view.receipt.reference,
      };
  }
}
export function restoredInquiry(saved: PersistedInquiry | undefined): InquiryView {
  if (!saved) return { phase: 'closed' };
  switch (saved.phase) {
    case 'editing':
      return { ...saved, errors: {} };
    case 'unknown':
      return saved;
    case 'saved':
      return {
        phase: 'saved',
        key: saved.key,
        draft: saved.draft,
        receipt: { reference: saved.reference },
      };
  }
}
