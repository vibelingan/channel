import type { InquiryRejectionReason } from '@vibelingan-channel/ai-contracts/inquiry';
import type { ChatMessage, InquiryDraft, InquiryView, PublicProduct } from './model';
import { InquiryRejectedError } from './transport-error';
export function currentPublicProducts(messages: ChatMessage[]) {
  const products = new Map<string, PublicProduct>();
  for (const message of messages) {
    for (const product of message.products ?? []) products.set(product.id, product);
    for (const id of message.unavailableProductIds ?? []) products.delete(id);
  }
  return products;
}
/** Explicitly reviewing new requirements can update a draft, never an uncertain submission. */
export function beginInquiryReview(
  current: InquiryView,
  proposal: { requirement: string; product?: PublicProduct; explicitUpdate: boolean },
  key: () => string,
): InquiryView {
  if (current.phase === 'saving' || current.phase === 'unknown') return current;
  if (
    current.phase !== 'closed' &&
    (!proposal.explicitUpdate ||
      (current.draft.requirement.trim() === proposal.requirement.trim() &&
        current.draft.product?.id === proposal.product?.id &&
        current.draft.product?.revision === proposal.product?.revision))
  )
    return current;
  const contact =
    current.phase === 'closed'
      ? { name: '', email: '', company: '' }
      : { name: current.draft.name, email: current.draft.email, company: current.draft.company };
  return {
    phase: 'editing',
    key: key(),
    errors: {},
    draft: {
      ...contact,
      requirement: proposal.requirement,
      consent: false,
      ...(proposal.product ? { product: proposal.product } : {}),
    },
  };
}
export function validateInquiry(draft: InquiryDraft): Partial<Record<keyof InquiryDraft, string>> {
  const errors: Partial<Record<keyof InquiryDraft, string>> = {};
  if (!draft.requirement.trim() || draft.requirement.length > 4000)
    errors.requirement = 'Please describe your requirement (up to 4,000 characters).';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email.trim()) || draft.email.length > 254)
    errors.email = 'Please enter a valid email address.';
  if (!draft.consent) errors.consent = 'Please agree to be contacted about this inquiry.';
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
