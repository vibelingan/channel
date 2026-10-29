import type { InquiryDraft } from './model';
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
