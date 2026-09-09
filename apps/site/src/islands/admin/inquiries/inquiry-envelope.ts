import { InquiryEnvelopeSchema } from '@vibelingan-channel/shared/catalog-inquiry';

/** Inquiry domain errors intentionally extend, rather than loosen, the generic API contract. */
export async function readInquiryEnvelope(response: Response) {
  try {
    const input: unknown = await response.json();
    const parsed = InquiryEnvelopeSchema.safeParse(input);
    if (!parsed.success || (parsed.data.ok && !response.ok)) return null;
    return parsed.data;
  } catch {
    return null;
  }
}
