import type { EngineCitation } from '@vibelingan-channel/ai-engine/port';
import { enforceGroundedFinal } from '@vibelingan-channel/ai-policy';

/** Applies the publication gate before each sentence, not after it is visible. */
export class GroundedAnswerStream {
  delivered = '';
  private blocked = false;
  constructor(private readonly prefix: string) {}
  accept(delta: string, citations: EngineCitation[]): string | undefined {
    if (this.blocked || !delta) return undefined;
    const text = this.delivered + delta;
    const checked = enforceGroundedFinal(
      { type: 'final', text, citations },
      { approvedSourcePrefix: this.prefix },
    );
    if (checked.type !== 'final' || checked.text !== text) {
      this.blocked = true;
      return undefined;
    }
    this.delivered = text;
    return delta;
  }
}
