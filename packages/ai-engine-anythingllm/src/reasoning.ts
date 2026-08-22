/**
 * Strips a reasoning model's internal deliberation out of a streamed answer.
 *
 * Why this exists: the configured models are reasoning models, and they emit
 * their working inside `<think>…</think>` before the real answer. Observed live
 * against the running stack, a question about minimum order quantity streamed
 * the model's private deliberation to the caller first — a visitor would have
 * watched it think, in the first person, before getting an answer.
 *
 * Doing this with a regex over the finished text is not enough: tokens arrive
 * in fragments, so the tags routinely straddle chunk boundaries, and anything
 * that inspects one chunk at a time never sees `<think>` at all.
 *
 * The rule when in doubt is to withhold. A fragment that might still turn into
 * an opening tag is held back until it is proven ordinary text — releasing it
 * early is what leaks half a tag onto the page.
 *
 * WHAT THIS IS NOT: a guarantee. It is a mitigation for a protocol that does
 * not separate reasoning from output. The durable fix is a vendor field that
 * keeps them apart, and if one becomes available it should replace this rather
 * than sit alongside it.
 */

/** Tag names that carry model deliberation across the supported model family. */
const REASONING_TAGS = ['think', 'thinking', 'thought', 'reasoning', 'reflection', 'scratchpad'];

/**
 * A complete tag at the start of the buffer.
 *
 * Case-insensitive, tolerant of whitespace inside the brackets, and tolerant of
 * attributes — `<Think>`, `< think >` and `<think type="internal">` are all the
 * same tag. Matching only exact lowercase `<think>` meant a model that
 * capitalised or annotated its tag streamed its reasoning straight through.
 */
const TAG_AT_START = new RegExp(`^<\\s*(/?)\\s*(${REASONING_TAGS.join('|')})\\b[^>]*>`, 'i');

/** Any tag at all, so non-reasoning markup is skipped rather than held back. */
const ANY_TAG_AT_START = /^<\s*\/?\s*[a-z][^>]*>/i;

/**
 * Text that is not yet a tag but could still become one.
 *
 * Deliberately narrow: `<thi` qualifies, `< 500 units` does not. A looser rule
 * would hold back every `<` in ordinary prose — "orders < 500" — until the
 * stream ended.
 */
const PARTIAL_TAG = /^<\s*\/?\s*[a-z]*$/i;

export interface ReasoningFilter {
  /** Feed the next stream chunk. Returns the text safe to show right now. */
  push(chunk: string): string;
  /** Flush at end of stream. Returns any withheld text that proved harmless. */
  end(): string;
}

export function createReasoningFilter(): ReasoningFilter {
  let buffer = '';
  /** Nesting depth, so `<think>a<think>b</think>c</think>` does not leak `c`. */
  let depth = 0;

  /** Consume from the buffer until nothing more can be decided. */
  function drain(): string {
    let emitted = '';

    for (;;) {
      if (buffer.length === 0) return emitted;

      const next = buffer.indexOf('<');

      if (depth > 0) {
        // Inside deliberation: discard everything up to the next tag, and hold
        // only what might still complete one.
        if (next === -1) {
          buffer = PARTIAL_TAG.test(buffer) ? buffer : '';
          return emitted;
        }
        buffer = buffer.slice(next);
      } else {
        if (next === -1) {
          // No tag anywhere: all of it is answer text.
          emitted += buffer;
          buffer = '';
          return emitted;
        }
        emitted += buffer.slice(0, next);
        buffer = buffer.slice(next);
      }

      const tag = TAG_AT_START.exec(buffer);
      if (tag) {
        depth += tag[1] === '/' ? -1 : 1;
        if (depth < 0) depth = 0; // A stray closing tag closes nothing.
        buffer = buffer.slice(tag[0].length);
        continue;
      }

      const other = ANY_TAG_AT_START.exec(buffer);
      if (other) {
        // Ordinary markup. Outside deliberation it is content; inside, it is
        // still deliberation and gets dropped with everything else.
        if (depth === 0) emitted += other[0];
        buffer = buffer.slice(other[0].length);
        continue;
      }

      if (PARTIAL_TAG.test(buffer)) {
        // Might still become a tag once more arrives. Hold it.
        return emitted;
      }

      // A `<` that cannot begin a tag — "orders < 500". Emit it and move on,
      // rather than holding ordinary prose hostage until the stream ends.
      if (depth === 0) emitted += buffer[0];
      buffer = buffer.slice(1);
    }
  }

  return {
    push(chunk: string): string {
      buffer += chunk;
      return drain();
    },

    end(): string {
      // Still inside deliberation at end of stream means the stream was
      // truncated mid-thought. Emitting the remainder would publish exactly
      // what this filter exists to hide, so it is discarded.
      if (depth > 0) {
        buffer = '';
        return '';
      }
      const rest = buffer;
      buffer = '';
      // A held-back fragment that never became a tag is real text.
      return PARTIAL_TAG.test(rest) || !rest.startsWith('<') ? rest : rest;
    },
  };
}
