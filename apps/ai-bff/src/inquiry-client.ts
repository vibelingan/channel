import {
  type InquiryRejectionReason,
  type InquirySubmissionReceipt,
  type InternalInquirySubmission,
  isInquiryRejectionReason,
  isInquirySubmissionReceipt,
} from '@vibelingan-channel/ai-contracts/inquiry';
export class InquirySubmissionChanged extends Error {}
/** The intake refused before saving anything; every other failure is unknown. */
export class InquiryRejected extends Error {
  readonly reason: InquiryRejectionReason;
  constructor(reason: InquiryRejectionReason) {
    super(`Inquiry rejected before saving: ${reason}`);
    this.reason = reason;
  }
}
export interface InquiryClient {
  submit(input: InternalInquirySubmission): Promise<InquirySubmissionReceipt>;
}
/** Fixed server destination and credential; no caller-selected host or identity. */
export function createInquiryClient(
  base: string,
  token: string,
  requestFetch: typeof fetch = fetch,
  localTest = false,
): InquiryClient {
  const url = new URL(base);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    (url.protocol !== 'https:' &&
      !(
        localTest &&
        url.protocol === 'http:' &&
        ['127.0.0.1', 'localhost'].includes(url.hostname)
      )) ||
    !/^[A-Za-z0-9_-]{32,512}$/.test(token)
  )
    throw new Error('Invalid inquiry connection');
  url.pathname = '/api/integrations/sales/assistant-inquiries';
  return {
    async submit(input) {
      const response = await requestFetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
      });
      if (response.status === 400 || response.status === 422) {
        // Only an explicit, well-formed "not_started" may say nothing was saved.
        const refusal = await readJson(response).catch(() => undefined);
        if (
          refusal &&
          typeof refusal === 'object' &&
          Reflect.get(refusal, 'outcome') === 'not_started' &&
          isInquiryRejectionReason(Reflect.get(refusal, 'reason'))
        )
          throw new InquiryRejected(Reflect.get(refusal, 'reason'));
        throw new Error('Inquiry result unavailable');
      }
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 409) throw new InquirySubmissionChanged();
        throw new Error('Inquiry result unavailable');
      }
      const result = await readJson(response);
      if (
        !isInquirySubmissionReceipt(result) ||
        result.conversationId !== input.conversationId ||
        result.submissionKey !== input.submission.submissionKey
      )
        throw new Error('Inquiry response identity mismatch');
      return result;
    },
  };
}
async function readJson(response: Response): Promise<unknown> {
  if (
    !response.body ||
    response.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json'
  ) {
    await response.body?.cancel();
    throw new Error('Invalid inquiry response');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 4096) throw new Error('Inquiry response too large');
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
}
