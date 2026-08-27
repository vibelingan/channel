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
  return citations.filter((citation) => (citation.title ?? '').startsWith(prefix));
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
 * `enforceGroundedFinal` above only asks whether ANY citation came back.
 * `ungroundedCommitments` asks the question that actually matters: do the
 * citations state the value the answer commits us to? Wiring the second into
 * the first is the next phase, and is deliberately not done in the same change
 * that moved the files.
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
