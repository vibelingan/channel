import { MESSAGE_OVERHEAD_TOKENS, estimateTokens } from '@vibelingan-channel/ai-engine/budget';
import type { EngineTurn } from '@vibelingan-channel/ai-engine/port';
import { type NeedState, needMemory } from './need.ts';

export { estimateTokens } from '@vibelingan-channel/ai-engine/budget';

/** A stored turn, plus whether its answer was a fixed small-talk reply. */
export type ContextTurn = EngineTurn & { screened?: boolean };

export const DEFAULT_HISTORY_TOKENS = 6_000;
export const MAX_CONTEXT_TURNS = 20;

function turnTokens(turn: EngineTurn): number {
  return (
    MESSAGE_OVERHEAD_TOKENS +
    estimateTokens(turn.text) +
    (turn.publicCatalog ? estimateTokens(JSON.stringify(turn.publicCatalog)) : 0)
  );
}

/**
 * What one model request reads, in priority order (ROUND2-DESIGN §7.2): the
 * rules are the engine's; then the current message, which is always sent
 * whole; then the requirement summary; then as much recent dialogue as fits
 * `historyTokens`, newest first and without gaps. Small-talk exchanges are
 * skipped, because they carry nothing a later answer needs. Retrieved
 * evidence is trimmed later by the engine, so it can never push out any of
 * these.
 */
export function buildContext(input: {
  turns: readonly ContextTurn[];
  need: NeedState;
  historyTokens?: number;
  maxTurns?: number;
}): { turns: EngineTurn[]; memory?: string; droppedTurns: number } {
  const strip = ({ screened: _screened, ...turn }: ContextTurn): EngineTurn => turn;
  const current = input.turns.at(-1);
  const memory = needMemory(input.need);
  if (!current) return { turns: [], ...(memory ? { memory } : {}), droppedTurns: 0 };
  const budget = input.historyTokens ?? DEFAULT_HISTORY_TOKENS;
  const maxTurns = input.maxTurns ?? MAX_CONTEXT_TURNS;
  const kept: EngineTurn[] = [];
  let used = 0;
  let index = input.turns.length - 2;
  for (; index >= 0 && kept.length + 1 < maxTurns; index--) {
    const turn = input.turns[index];
    if (!turn) break;
    if (turn.role === 'assistant' && turn.screened) {
      // Drop the fixed reply and the small talk it answered.
      if (input.turns[index - 1]?.role === 'visitor') index--;
      continue;
    }
    const cost = turnTokens(turn);
    if (used + cost > budget) break;
    used += cost;
    kept.unshift(strip(turn));
  }
  return {
    turns: [...kept, strip(current)],
    ...(memory ? { memory } : {}),
    droppedTurns: Math.max(0, index + 1),
  };
}
