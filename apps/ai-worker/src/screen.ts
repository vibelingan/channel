import type { EngineTurn } from '@vibelingan-channel/ai-engine/port';

/**
 * Messages answered from fixed text before any model call (assistant-ui
 * ROADMAP §5.3, rule layer L0). Each message is judged on its own and on the
 * conversation so far; nothing here remembers an earlier refusal, so a real
 * question always reaches the model.
 */
export type ScreenedTopic = 'greeting' | 'thanks' | 'no_content' | 'repeat';

export const FIXED_REPLIES = {
  greeting: {
    kind: 'answer',
    en: 'Hello. I can help find products, explain our OEM services, or prepare an inquiry. What are you looking for?',
    zh: '你好，我可以帮你查找产品、了解 OEM 服务，或整理询盘需求。你想采购什么？',
  },
  thanks: {
    kind: 'answer',
    en: "You're welcome. Is there anything else I can help you find?",
    zh: '不客气。还有什么需要我帮你找的吗？',
  },
  no_content: {
    kind: 'clarification',
    en: 'Please describe the product or service you are looking for, and I will help.',
    zh: '请描述你要找的产品或服务，我来帮你。',
  },
  repeat: {
    kind: 'answer',
    en: 'I have answered this above. You can ask it another way, or add details such as quantity, target market or budget, and I will look again.',
    zh: '这个问题上面已经回答过了。你可以换个问法，或补充数量、目标市场、预算等细节，我再帮你看。',
  },
} as const satisfies Record<ScreenedTopic, { kind: string; en: string; zh: string }>;

const GREETING =
  /^(hi+|hey+|hello+|helo|hallo|hullo|hiya|howdy|greetings|good (morning|afternoon|evening|day)|hola|bonjour|salut|ciao|ola|olá|merhaba|namaste|привет|здравствуйте|こんにちは|안녕하세요|مرحبا|你好|您好|嗨|哈喽|哈啰|大家好|早上好|下午好|晚上好|在吗|在不在|有人吗)( (there|team|all|everyone|guys))?$/u;
const THANKS =
  /^(thanks?( a lot| so much| very much)?|thank you( (so|very) much)?|thx|many thanks|cheers|merci|gracias|danke|谢谢(你|您)?|多谢|感谢|谢了)$/u;
// One key held down, or a run along the home or top row.
const MASHED = /^(?:(\p{L})\1{3,}|asdf[ghjkl]*|qwerty?u?i?o?p?|zxcv[bnm]*)$/u;

/** Case, width, punctuation, symbols and spacing do not make a new question. */
export function normalizeQuestion(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function screenVisitorMessage(turns: readonly EngineTurn[]): ScreenedTopic | null {
  const latest = turns.at(-1);
  if (latest?.role !== 'visitor') return null;
  const key = normalizeQuestion(latest.text);
  if (GREETING.test(key)) return 'greeting';
  if (THANKS.test(key)) return 'thanks';
  const previous = turns.at(-2);
  // "👍" or "?" can be the answer to a question the assistant just asked.
  const answeringQuestion = previous?.role === 'assistant' && /[?？]\s*$/.test(previous.text);
  if ((!/[\p{L}\p{N}]/u.test(key) || MASHED.test(key.replace(/ /g, ''))) && !answeringQuestion)
    return 'no_content';
  // The same question twice may be a retry or a fresh answer; a third time
  // after two answers will not get a better one from the model.
  let answered = 0;
  for (let i = turns.length - 2; i >= 1; i -= 2) {
    const answer = turns[i];
    const asked = turns[i - 1];
    if (answer?.role !== 'assistant' || asked?.role !== 'visitor') break;
    if (normalizeQuestion(asked.text) !== key) break;
    answered += 1;
  }
  return answered >= 2 ? 'repeat' : null;
}

export function fixedReply(topic: ScreenedTopic, latestText: string, locale: string) {
  const reply = FIXED_REPLIES[topic];
  const chinese =
    /[㐀-鿿]/.test(latestText) ||
    (!/\p{L}/u.test(latestText) && locale.toLowerCase().startsWith('zh'));
  return { text: chinese ? reply.zh : reply.en, kind: reply.kind };
}
