/** Website-owned form confirmation. Neither model output nor marketing consent. */
export const INQUIRY_CONSENT_VERSION = 'inquiry-contact-v1';
export interface InquirySubmission {
  submissionKey: string;
  requirement: string;
  name: string;
  email: string;
  company: string;
  consent: true;
  consentVersion: typeof INQUIRY_CONSENT_VERSION;
  productId?: string;
}
export interface InternalInquirySubmission {
  schemaVersion: '1';
  conversationId: string;
  submission: InquirySubmission;
}
export interface InquirySubmissionReceipt {
  schemaVersion: '1';
  conversationId: string;
  submissionKey: string;
  reference: string;
  submittedAt: string;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const key = /^[A-Za-z0-9_-]{8,128}$/;
function record(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function exact(v: Record<string, unknown>, fields: string[]) {
  return Object.keys(v).every((k) => fields.includes(k));
}
function text(v: unknown, max: number, required = false): v is string {
  return typeof v === 'string' && v.length <= max && (!required || v.trim().length > 0) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v);
}
export function isInquirySubmission(v: unknown): v is InquirySubmission {
  return record(v) && exact(v, ['submissionKey', 'requirement', 'name', 'email', 'company', 'consent', 'consentVersion', 'productId']) &&
    typeof v.submissionKey === 'string' && key.test(v.submissionKey) &&
    text(v.requirement, 4000, true) && text(v.name, 120) && text(v.company, 200) &&
    text(v.email, 254, true) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email) &&
    v.consent === true && v.consentVersion === INQUIRY_CONSENT_VERSION &&
    (v.productId === undefined || (typeof v.productId === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(v.productId)));
}
export function isInternalInquirySubmission(v: unknown): v is InternalInquirySubmission {
  return record(v) && exact(v, ['schemaVersion', 'conversationId', 'submission']) && v.schemaVersion === '1' &&
    typeof v.conversationId === 'string' && uuid.test(v.conversationId) && isInquirySubmission(v.submission);
}
export function isInquirySubmissionReceipt(v: unknown): v is InquirySubmissionReceipt {
  return record(v) && exact(v, ['schemaVersion', 'conversationId', 'submissionKey', 'reference', 'submittedAt']) &&
    v.schemaVersion === '1' && typeof v.conversationId === 'string' && uuid.test(v.conversationId) &&
    typeof v.submissionKey === 'string' && key.test(v.submissionKey) &&
    typeof v.reference === 'string' && /^ai_[a-f0-9]{64}$/.test(v.reference) &&
    typeof v.submittedAt === 'string' && /^\d{4}-\d\d-\d\dT/.test(v.submittedAt) && Number.isFinite(Date.parse(v.submittedAt));
}
