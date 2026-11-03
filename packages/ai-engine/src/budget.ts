/**
 * A deliberately high estimate of input tokens, used only to decide what to
 * leave out of a model request (assistant-ui ROUND2-DESIGN §7.2, MIU 19).
 * Billing uses the usage the provider returns, never this.
 *
 * One token per CJK character and one per three other characters: real
 * tokenizers usually come in under both, so trimming errs towards sending less.
 */
const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;

export function estimateTokens(text: string): number {
  const wide = text.match(WIDE)?.length ?? 0;
  // UTF-16 length: a rare astral character counts twice, which only adds margin.
  return wide + Math.ceil(Math.max(0, text.length - wide) / 3);
}

/** A chat message also costs a few tokens of framing. */
export const MESSAGE_OVERHEAD_TOKENS = 4;

export function estimateMessages(messages: ReadonlyArray<{ content: string }>): number {
  return messages.reduce(
    (total, message) => total + MESSAGE_OVERHEAD_TOKENS + estimateTokens(message.content),
    0,
  );
}
