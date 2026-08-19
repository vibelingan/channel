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
 */

const OPEN_TAGS = ['<think>', '<reasoning>'] as const;
const CLOSE_TAGS = ['</think>', '</reasoning>'] as const;

/** Longest prefix of `text` that is also a proper prefix of any tag in `tags`. */
function heldBackSuffixLength(text: string, tags: readonly string[]): number {
  const longest = Math.max(...tags.map((t) => t.length));
  for (let take = Math.min(longest - 1, text.length); take > 0; take--) {
    const tail = text.slice(text.length - take);
    if (tags.some((tag) => tag.startsWith(tail))) return take;
  }
  return 0;
}

function firstIndexOfAny(text: string, tags: readonly string[]): { index: number; tag: string } {
  let best = { index: -1, tag: '' };
  for (const tag of tags) {
    const at = text.indexOf(tag);
    if (at !== -1 && (best.index === -1 || at < best.index)) best = { index: at, tag };
  }
  return best;
}

export interface ReasoningFilter {
  /** Feed the next stream chunk. Returns the text safe to show right now. */
  push(chunk: string): string;
  /** Flush at end of stream. Returns any withheld text that proved harmless. */
  end(): string;
}

export function createReasoningFilter(): ReasoningFilter {
  let buffer = '';
  let insideReasoning = false;

  return {
    push(chunk: string): string {
      buffer += chunk;
      let emitted = '';

      for (;;) {
        if (insideReasoning) {
          const close = firstIndexOfAny(buffer, CLOSE_TAGS);
          if (close.index === -1) {
            // Keep only what could still complete a closing tag; the rest is
            // deliberation and is dropped rather than buffered forever.
            const keep = heldBackSuffixLength(buffer, CLOSE_TAGS);
            buffer = keep > 0 ? buffer.slice(buffer.length - keep) : '';
            return emitted;
          }
          buffer = buffer.slice(close.index + close.tag.length);
          insideReasoning = false;
          continue;
        }

        const open = firstIndexOfAny(buffer, OPEN_TAGS);
        if (open.index === -1) {
          const keep = heldBackSuffixLength(buffer, OPEN_TAGS);
          emitted += buffer.slice(0, buffer.length - keep);
          buffer = keep > 0 ? buffer.slice(buffer.length - keep) : '';
          return emitted;
        }
        emitted += buffer.slice(0, open.index);
        buffer = buffer.slice(open.index + open.tag.length);
        insideReasoning = true;
      }
    },

    end(): string {
      // Inside a block at end of stream means the stream was truncated mid
      // thought. Emitting the remainder would publish exactly what this filter
      // exists to hide, so it is discarded.
      if (insideReasoning) {
        buffer = '';
        return '';
      }
      const rest = buffer;
      buffer = '';
      return rest;
    },
  };
}
