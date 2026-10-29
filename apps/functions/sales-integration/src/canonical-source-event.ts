import {
  hashCanonicalJson,
  validateContract,
  type InquirySubmitted,
} from '@vibelingan-channel/sales-contracts';
import type { InquiryView } from './sources.ts';

export interface InquiryOwner {
  client_id: string;
  business_line: string;
  source_installation_id: string;
}

/** Build only from a server-read, owned submission, never from model assertions. */
export function canonicalInquiryEvent(owner: InquiryOwner, view: InquiryView): InquirySubmitted {
  const scope = {
    client_id: owner.client_id,
    business_line: owner.business_line,
    source_installation_id: owner.source_installation_id,
  };
  const text = view.kind === 'oem' ? view.requirements.category : view.requirements.brief;
  const snapshot = view.product_snapshot;
  const name =
    snapshot && typeof snapshot === 'object' && 'productName' in snapshot
      ? snapshot.productName
      : undefined;
  const fallback =
    view.kind === 'oem'
      ? 'OEM inquiry'
      : typeof name === 'string' && name.trim()
        ? `Product inquiry: ${name}`
        : 'Product inquiry';
  const summary = typeof text === 'string' && text.trim() ? text.trim() : fallback;
  const quantityText = view.requirements.quantity_text;
  const quantity =
    typeof quantityText === 'string' &&
    /^[1-9][0-9]{0,9}$/.test(quantityText) &&
    Number(quantityText) <= 1000000000
      ? Number(quantityText)
      : undefined;
  return validateContract('inquiry', {
    schema_version: '1.0',
    event_id: `submission_${hashCanonicalJson({
      ...scope,
      kind: view.kind,
      id: view.source_record_id,
      revision: view.source_revision,
    })}`,
    ...scope,
    source: view.kind === 'oem' ? 'website_oem' : 'website_product',
    source_record_id: view.source_record_id,
    source_revision: view.source_revision,
    submitted_at: view.submitted_at,
    contact: view.contact,
    requirements: {
      confirmed_summary: summary,
      ...(quantity === undefined ? {} : { quantity }),
    },
    product_snapshot_refs:
      view.kind === 'product' ? [`snapshot:${hashCanonicalJson(snapshot)}`] : [],
    attachment_refs: view.assets.map((asset) => asset.ref),
  });
}
