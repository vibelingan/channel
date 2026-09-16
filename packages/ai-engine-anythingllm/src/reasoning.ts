/**
 * Strips a reasoning model's internal deliberation out of a streamed answer.
 *
 * Why this exists: the configured models are reasoning models, and they emit
 * their working inside `<think>…</think>` before the real answer. Observed live
 * against the running stack, a question about minimum order quantity streamed
 * the model's private deliberation to the caller first — a visitor would have
 * watched it think, in the first person, before getting an answer.
 *
 * WHY A PARSER AND NOT A REGEX. Two earlier versions matched tags with regular
 * expressions and both leaked. The first handled only exact lowercase
 * `<think>`. The second handled case, whitespace and attributes for a WHOLE
 * tag, and handled a split tag NAME — but not the two together: fed
 * `['<think type="', 'internal">SECRET</think>Visible.']` it emitted the
 * opening tag and the secret, because once an attribute appeared the buffer no
 * longer looked like a partial tag and was released as prose. Tokens arrive in
 * fragments, so every tag can be split at every position; a matcher that works
 * on complete tags is not the same as one that works on a stream.
 *
 * This is a small state machine over the character stream. It tracks the
 * opening bracket, an optional slash, the tag name, quoted and unquoted
 * attributes, the closing bracket, and nesting — across arbitrary chunk
 * boundaries. The rule when in doubt is to withhold: anything that might still
 * become a tag is held until it is proven ordinary text.
 *
 * WHAT THIS IS NOT: a guarantee. It is a mitigation for a protocol that does
 * not separate reasoning from output. The durable fix is a vendor field that
 * keeps them apart, and if one becomes available it should replace this rather
 * than sit alongside it.
 */

/** Tag names that carry model deliberation across the supported model family. */
const REASONING_TAGS = new Set([
  'think',
  'thinking',
  'thought',
  'reasoning',
  'reflection',
  'scratchpad',
]);

type State =
  /** Ordinary answer text. */
  | 'text'
  /** Seen `<`, deciding whether a tag is starting. */
  | 'maybe-tag'
  /** Inside `<…>`, accumulating until the closing bracket. */
  | 'in-tag'
  /** Inside `<…>` and inside a quoted attribute value. */
  | 'in-tag-quoted';

export interface ReasoningFilter {
  /** Feed the next stream chunk. Returns the text safe to show right now. */
  push(chunk: string): string;
  /** Flush at end of stream. Returns any withheld text that proved harmless. */
  end(): string;
}

export function createReasoningFilter(): ReasoningFilter {
  let state: State = 'text';
  /** Raw characters of the tag being read, including the leading `<`. */
  let tagBuffer = '';
  /** Quote character that opened the current attribute value. */
  let quote = '';
  /** Nesting depth, so `<think>a<think>b</think>c</think>` does not leak `c`. */
  let depth = 0;

  /** Decide what a completed `<…>` was, and update state accordingly. */
  function closeTag(): string {
    const raw = tagBuffer;
    tagBuffer = '';
    state = 'text';

    const match = /^<\s*(\/?)\s*([a-z][a-z0-9-]*)/i.exec(raw);
    const closing = match?.[1] === '/';
    const name = match?.[2]?.toLowerCase();

    if (name && REASONING_TAGS.has(name)) {
      if (closing) {
        depth = Math.max(0, depth - 1);
      } else {
        depth += 1;
      }
      // The tag itself is never output, in either direction.
      return '';
    }

    // Ordinary markup. Outside deliberation it is part of the answer; inside,
    // it is part of the deliberation and goes with it.
    return depth === 0 ? raw : '';
  }

  function consume(chunk: string): string {
    let emitted = '';

    for (const character of chunk) {
      switch (state) {
        case 'text': {
          if (character === '<') {
            state = 'maybe-tag';
            tagBuffer = character;
          } else if (depth === 0) {
            emitted += character;
          }
          break;
        }

        case 'maybe-tag': {
          tagBuffer += character;
          if (character === '/' || /\s/.test(character)) {
            // `</think>` and `< think >` are both still possible.
            break;
          }
          if (/[a-z]/i.test(character)) {
            state = 'in-tag';
            break;
          }
          if (character === '>') {
            // `<>` — not a tag.
            if (depth === 0) emitted += tagBuffer;
            tagBuffer = '';
            state = 'text';
            break;
          }
          // A `<` that cannot begin a tag — "orders < 500". Release it rather
          // than holding ordinary prose until the stream ends.
          if (depth === 0) emitted += tagBuffer;
          tagBuffer = '';
          state = 'text';
          break;
        }

        case 'in-tag': {
          tagBuffer += character;
          if (character === '"' || character === "'") {
            quote = character;
            state = 'in-tag-quoted';
          } else if (character === '>') {
            emitted += closeTag();
          }
          break;
        }

        case 'in-tag-quoted': {
          tagBuffer += character;
          // A `>` inside a quoted attribute value does not close the tag.
          if (character === quote) {
            quote = '';
            state = 'in-tag';
          }
          break;
        }
      }
    }

    return emitted;
  }

  return {
    push(chunk: string): string {
      return consume(chunk);
    },

    end(): string {
      // Still inside deliberation at end of stream means the stream was
      // truncated mid-thought. Emitting the remainder would publish exactly
      // what this filter exists to hide.
      if (depth > 0) {
        tagBuffer = '';
        state = 'text';
        return '';
      }

      // An unterminated `<…` at end of stream. It never became a tag, so it was
      // text — but if it was the START of a reasoning tag whose stream died, it
      // is deliberation. Withhold anything that names a reasoning tag.
      const rest = tagBuffer;
      tagBuffer = '';
      state = 'text';
      if (!rest) return '';
      const name = /^<\s*\/?\s*([a-z][a-z0-9-]*)/i.exec(rest)?.[1]?.toLowerCase();
      if (name && REASONING_TAGS.has(name)) return '';
      // A partial name that could still have become one — `<thi` — is withheld
      // for the same reason.
      const partial = /^<\s*\/?\s*([a-z][a-z0-9-]*)$/i.exec(rest)?.[1]?.toLowerCase();
      if (partial && [...REASONING_TAGS].some((tag) => tag.startsWith(partial))) return '';
      return rest;
    },
  };
}
