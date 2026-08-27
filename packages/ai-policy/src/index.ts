import type { EngineEvent, EngineTurn } from '@vibelingan-channel/ai-engine/port';

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

export function enforceGroundedFinal(event: EngineEvent): EngineEvent {
  if (event.type !== 'final') return event;
  if (!event.text.trim() || event.citations.length === 0) {
    return {
      type: 'error',
      category: 'knowledge_empty',
      retriable: false,
      safeDetail: 'grounded final required',
    };
  }
  return event;
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
