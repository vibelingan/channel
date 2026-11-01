import type { ChatMessage, InquiryDraft, InquiryView, PublicProduct } from './model';
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
