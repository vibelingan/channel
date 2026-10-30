import { createHash } from 'node:crypto';
import {
  type InquirySubmissionReceipt,
  type InternalInquirySubmission,
  isInternalInquirySubmission,
} from '@vibelingan-channel/ai-contracts/inquiry';
import { hashCanonicalJson } from '@vibelingan-channel/sales-contracts';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import type { NodeSdkDatabase } from './cloudbase-adapter.ts';
import {
  type SalesCaptureScope,
  parseSalesCaptureScope,
  saveFinalizedOemInCloud,
} from './sales-inquiry-submission.ts';

export { AssistantInquiryConflict } from './sales-inquiry-submission.ts';
import { normalizeSalesSdkDocument } from './sales-inquiry-read.ts';
import { AssistantInquiryConflict, assertSalesInstallation } from './sales-inquiry-submission.ts';
export interface InquiryProductEvidence {
  productId: string;
  productName: string;
  revision: string;
}
export interface AssistantInquiryStore {
  submit(input: InternalInquirySubmission): Promise<InquirySubmissionReceipt>;
}
/** No email, model, raw DB credentials or caller-selected customer crosses this port. */
export function createAssistantInquiryStore(
  db: NodeSdkDatabase,
  scopeValue: SalesCaptureScope,
  readProduct: (id: string) => Promise<InquiryProductEvidence | null>,
  now = () => Math.floor(Date.now() / 1000),
): AssistantInquiryStore {
  const scope = parseSalesCaptureScope(scopeValue);
  return {
    async submit(input) {
      if (!isInternalInquirySubmission(input)) throw new Error('Invalid confirmed inquiry');
      const fingerprint = hashCanonicalJson(input);
      const projectId = `ai_${createHash('sha256')
        .update(
          JSON.stringify([
            scope.client_id,
            scope.business_line,
            scope.source_installation_id,
            scope.environment,
            input.conversationId,
            input.submission.submissionKey,
          ]),
        )
        .digest('hex')}`;
      // Recover a committed result before a current catalog lookup. An outage or
      // withdrawal after commit must not prevent returning the original receipt.
      const prior = await db.runTransaction(async (tx) => {
        const install = normalizeSalesSdkDocument(
          await tx.collection('channelSalesInstallations').doc(scope.source_installation_id).get(),
          scope.source_installation_id,
        );
        assertSalesInstallation(install?.record, scope);
        return normalizeSalesSdkDocument(
          await tx.collection('oemProjects').doc(projectId).get(),
          projectId,
        );
      });
      if (prior) return receipt(prior, input, scope, fingerprint);
      const at = new Date(now() * 1000).toISOString();
      const product = input.submission.productId
        ? await readProduct(input.submission.productId)
        : undefined;
      if (
        product &&
        (product.productId !== input.submission.productId ||
          !product.productName ||
          product.productName.length > 500 ||
          !product.revision ||
          product.revision.length > 200)
      )
        throw new Error('Invalid public product evidence');
      const s = input.submission;
      const row = await saveFinalizedOemInCloud(
        db,
        {
          projectId,
          assistantFingerprint: fingerprint,
          projectData: {
            company: s.company,
            contact: s.name,
            email: s.email,
            category: 'Other',
            status: 'new',
            assistantSubmission: {
              fingerprint,
              conversationId: input.conversationId,
              submissionKey: s.submissionKey,
              requirement: s.requirement,
              consentVersion: s.consentVersion,
              consentedAt: at,
              ...(s.productId
                ? {
                    productReference: {
                      requestedId: s.productId,
                      queriedAt: at,
                      current: product ?? null,
                    },
                  }
                : {}),
            },
          },
        },
        scope,
        now(),
      );
      return receipt(row, input, scope, fingerprint);
    },
  };
}
function receipt(
  row: CollectionDoc,
  input: InternalInquirySubmission,
  scope: SalesCaptureScope,
  fingerprint: string,
): InquirySubmissionReceipt {
  const meta = row.assistantSubmission as Record<string, unknown> | undefined;
  if (
    row.client_id !== scope.client_id ||
    row.business_line !== scope.business_line ||
    row.source_installation_id !== scope.source_installation_id ||
    meta?.fingerprint !== fingerprint ||
    meta.conversationId !== input.conversationId ||
    meta.submissionKey !== input.submission.submissionKey ||
    row.salesSubmissionState !== 'finalized' ||
    typeof row.createdAt !== 'string'
  )
    throw new AssistantInquiryConflict('Submission changed');
  return {
    schemaVersion: '1',
    conversationId: input.conversationId,
    submissionKey: input.submission.submissionKey,
    reference: row._id,
    submittedAt: row.createdAt,
  };
}
