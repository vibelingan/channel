import type { PublicSseEvent } from '@vibelingan-channel/ai-contracts';

export interface ChatMessage {
  id: string;
  role: 'visitor' | 'assistant' | 'status';
  text: string;
  citations?: Array<{ title: string; url?: string }>;
  /** On an answer: the `messageId` of the question it answers. */
  replyTo?: string;
}

const NOT_GROUNDED = 'I could not ground an answer. Please ask our team.';

/**
 * Whether an event belongs to the answer to the question `messageId`.
 *
 * The event stream is the whole conversation, not one answer. When the visitor
 * changed page, reloaded or closed the panel before an answer finished, that
 * answer's events were still waiting after the saved cursor, and reading them
 * as the reply to the next question put every later answer one question late.
 * An event without `replyTo` (a conversation-level event, or one from a BFF
 * that predates the field) still counts as this answer's, as it always did.
 */
export function isReplyTo(event: PublicSseEvent, messageId: string): boolean {
  const replyTo = replyToOf(event);
  return replyTo === undefined || replyTo === messageId;
}

/**
 * Put one event into the answer it belongs to: the answer to `messageId`, or,
 * for an earlier question, that question's answer if it is still on screen.
 * An answer to a question asked on another page has no bubble here and is
 * dropped rather than shown under the wrong question.
 */
export function withEvent(
  messages: ChatMessage[],
  event: PublicSseEvent,
  messageId: string,
  origin: string,
): ChatMessage[] {
  const target = isReplyTo(event, messageId) ? messageId : replyToOf(event);
  return messages.map((message) =>
    message.role !== 'visitor' && message.replyTo === target
      ? applyEvent(message, event, origin)
      : message,
  );
}

function applyEvent(message: ChatMessage, event: PublicSseEvent, origin: string): ChatMessage {
  switch (event.type) {
    case 'token':
      return { ...message, text: message.text + event.text };
    case 'citation': {
      const url = safeCitationUrl(event.url, origin);
      return {
        ...message,
        citations: [...(message.citations ?? []), { title: event.title, ...(url ? { url } : {}) }],
      };
    }
    case 'error':
    case 'run.failed':
      return { ...message, role: 'status', text: NOT_GROUNDED };
    default:
      return message;
  }
}

function replyToOf(event: PublicSseEvent): string | undefined {
  return 'replyTo' in event ? event.replyTo : undefined;
}

export function safeCitationUrl(value: string | undefined, origin: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value, origin);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}
