import type { InquiryRejectionReason } from '@vibelingan-channel/ai-contracts/inquiry';
export class AssistantTransportError extends Error {
  constructor(
    message: string,
    readonly retryAt?: number,
    readonly expired = false,
  ) {
    super(message);
  }
}
/** The service refused the inquiry before saving anything; the visitor may correct it. */
export class InquiryRejectedError extends Error {
  readonly reason: InquiryRejectionReason;
  constructor(reason: InquiryRejectionReason) {
    super(`Inquiry not submitted: ${reason}`);
    this.reason = reason;
  }
}
