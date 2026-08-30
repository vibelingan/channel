import type { EngineCitation, EngineEvent, EngineTurn } from '@vibelingan-channel/ai-engine/port';
import { templateFor } from './commitments.ts';
import { topicForCommitments, ungroundedCommitments } from './grounding.ts';

export const CHANNEL_PUBLIC_PROFILE = Object.freeze({
  id: 'channel-public-v1',
  version: 1,
  locale: 'en',
  requiresCitations: true,
  maxContextTurns: 20,
  policy: Object.freeze({
    publicFactsOnly: true,
    refuseWithoutGrounding: true,
    neverInvent: Object.freeze(['price', 'MOQ', 'lead time', 'certification', 'customer project']),
    contactDataToModel: false,
  }),
});

const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE = /(?<!\w)(?:\+?\d[\d\s().-]{7,}\d)(?!\w)/g;

export function preparePublicTurns(turns: EngineTurn[]): EngineTurn[] {
  return turns.slice(-CHANNEL_PUBLIC_PROFILE.maxContextTurns).map((turn) => ({
    role: turn.role,
    text: redactContactData(turn.text),
  }));
}

export function redactContactData(text: string): string {
  return text.replace(EMAIL, '[email redacted]').replace(PHONE, '[phone redacted]');
}

/**
 * Which documents may be quoted to a stranger.
 *
 * The retrieval workspace is not automatically a public corpus. A probe of the
 * supplied hosted knowledge base on 2026-08-25 returned internal
 * `hermes-skills-*` documents alongside website content, which means retrieval
 * alone cannot decide what is safe to say.
 *
 * This is an ALLOW list on the document name, not a block list naming the
 * internal material we happen to know about today. A block list is wrong here
 * for the obvious reason: the next internal corpus somebody attaches has a name
 * nobody wrote down, and it would be published.
 */
export interface GroundingPolicy {
  /** Document-name prefix the approved public corpus is published under. */
  approvedSourcePrefix: string;
}

/**
 * KNOWN LIMIT, stated because the next reader will otherwise assume more.
 *
 * This matches on `sourceId`, which the adapter derives from the document name,
 * not from a vendor chunk id. It is a provenance label, not a cryptographic
 * identity. Two consequences:
 *
 *  - If the engine ever stops putting the document name in `sourceId`, every
 *    answer is refused. That is the safe direction, and readiness will keep
 *    reporting live, so the symptom is an assistant that says nothing rather
 *    than an alarm. `safeDetail: 'no publishable source'` on the event is how
 *    you tell that apart from an outage.
 *  - Anyone who can upload to the retrieval workspace can name a document with
 *    this prefix. That is acceptable only while the workspace is one we control.
 *    It is NOT acceptable on the shared hosted workspace the 2026-08-25 probe
 *    found, which is why a dedicated public workspace is a release gate (K4/K5
 *    in the review triage) and not a nicety.
 */

export const DEFAULT_GROUNDING_POLICY: GroundingPolicy = Object.freeze({
  // What scripts/ai-corpus-refresh.mjs names every document it publishes.
  approvedSourcePrefix: 'channelkb',
});

/** Citations that come from the approved public corpus, and only those. */
export function publishableCitations(
  citations: readonly EngineCitation[],
  policy: GroundingPolicy = DEFAULT_GROUNDING_POLICY,
): EngineCitation[] {
  const prefix = policy.approvedSourcePrefix;
  if (!prefix) return [];
  return citations.filter((citation) => citation.sourceId.startsWith(prefix));
}

/**
 * The answer-side gate.
 *
 * Three questions, in order, and an answer has to survive all three:
 *
 *  1. Did the model say anything, with any source at all?
 *  2. Are any of those sources ones we are allowed to quote publicly?
 *  3. Do those sources actually STATE the commercial values the answer commits
 *     us to — a price, a discount, a delivery date, a certification?
 *
 * Question 3 is the one that used to be missing, and the gap was not small.
 * "Did a citation come back" accepts "$12 each" supported by "Founded in 2012",
 * and "We hold ISO 9001" supported by "We do NOT hold ISO 9001", because a
 * substring is not a claim.
 *
 * A failure of 2 or 3 does not produce an error page. It produces the same
 * plain refusal the assistant gives when a visitor asks for a price directly —
 * the visitor gets a real answer and a route to a human, and we do not quote a
 * number nobody stands behind.
 */
export function enforceGroundedFinal(
  event: EngineEvent,
  policy: GroundingPolicy = DEFAULT_GROUNDING_POLICY,
): EngineEvent {
  if (event.type !== 'final') return event;
  if (!event.text.trim() || event.citations.length === 0) {
    return {
      type: 'error',
      category: 'knowledge_empty',
      retriable: false,
      safeDetail: 'grounded final required',
    };
  }

  const publishable = publishableCitations(event.citations, policy);
  if (publishable.length === 0) {
    // Retrieval found something; none of it is ours to publish. Answering from
    // it would be a leak stated with citations, which is worse than silence.
    return {
      type: 'error',
      category: 'knowledge_empty',
      retriable: false,
      safeDetail: 'no publishable source',
    };
  }
  if (publishable.length !== event.citations.length) {
    // A model may combine facts from every retrieved source. Removing the
    // internal citation does not remove the internal facts from its prose, so
    // a mixed evidence set must fail as a unit. Filtering only the citation
    // list would make an unsupported leak look cleanly sourced.
    return {
      type: 'error',
      category: 'knowledge_empty',
      retriable: false,
      safeDetail: 'mixed publishable and unpublishable sources',
    };
  }

  const invented = ungroundedCommitments(event.text, publishable);
  if (invented.length > 0) {
    const topic = topicForCommitments(invented);
    return { type: 'final', text: templateFor(topic), citations: publishable };
  }

  // Only the publishable sources are shown, so the visitor cannot be pointed at
  // a document that was never meant to leave the building.
  return { ...event, citations: publishable };
}

/**
 * The answer-side gates, moved here from the BFF when the runtime split the
 * engine out into the worker. They are pure functions over an answer's text
 * and its citations, so they belong with the profile rather than with any one
 * process — and the worker, which now owns generation, is where they have to
 * run.
 *
 * `enforceGroundedFinal` also calls `ungroundedCommitments`: citations must be
 * publishable and must state any commercial value the answer commits us to.
 */
export {
  commitmentValues,
  topicForCommitments,
  ungroundedCommitments,
  type CommitmentKind,
  type CommitmentValue,
} from './grounding.ts';
export { normalizeCitationUrl, normalizeCitations, type CitationPolicy } from './citations.ts';
export {
  classifyCommitmentRequest,
  templateFor,
  COMMITMENT_TOPICS,
  type CommitmentPolicy,
  type CommitmentTopic,
} from './commitments.ts';
