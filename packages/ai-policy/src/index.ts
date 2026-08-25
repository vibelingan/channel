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
