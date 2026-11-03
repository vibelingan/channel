import type { EngineTurn } from '@vibelingan-channel/ai-engine/port';
import type { RawSuggestion } from '@vibelingan-channel/ai-policy';

/**
 * Messages answered from fixed text before any model call (assistant-ui
 * ROADMAP §5.3, rule layer L0).
 *
 * The boundary: a message that is ONLY small talk ("hi", "who are you?",
 * "thanks", "???") is always answered here, warmly the first time and more
 * briefly after that, at any count and never by the model. Anything with a
 * question in it ("Hi, do you make earbuds?") goes to the model. So a visitor
 * who opens with "hello" always gets a friendly answer and a way in, and
 * someone repeating small talk costs no model calls at all. The BFF bounds how
 * many messages anyone can send (ROADMAP §5.6).
 */
export type ScreenedTopic =
  | 'greeting'
  | 'status'
  | 'identity'
  | 'capability'
  | 'thanks'
  | 'farewell'
  | 'ack'
  | 'no_content'
  | 'repeat';

type Reply = { en: string; zh: string };
type FixedReply = {
  kind: 'answer' | 'clarification';
  /** The first reply in a run of small talk, then the second. */
  replies: [Reply, Reply];
  /** Whether the reply offers ways to start. */
  starters: boolean;
};

export const FIXED_REPLIES: Record<ScreenedTopic, FixedReply> = {
  greeting: {
    kind: 'answer',
    replies: [
      {
        en: 'Hello! I can find products in our catalog, explain OEM and ODM customization, or prepare an inquiry for our sales team. What are you looking for?',
        zh: '你好！我可以帮你查找产品、介绍 OEM／ODM 定制，或整理询盘交给销售团队。你想找什么产品？',
      },
      {
        en: 'Hi again. Tell me the product you have in mind, or pick one of the options below to start.',
        zh: '又见面啦。告诉我你想找的产品，或者选下面的一个选项开始。',
      },
    ],
    starters: true,
  },
  status: {
    kind: 'answer',
    replies: [
      {
        en: "I'm doing well, thanks for asking. I'm here to help with products, OEM customization and inquiries. What can I find for you?",
        zh: '我很好，谢谢关心。我可以帮你查产品、了解 OEM 定制和整理询盘。想找点什么？',
      },
      {
        en: 'All good here. Tell me what you are looking for and I will check our catalog.',
        zh: '一切都好。告诉我你在找什么，我来查一下产品目录。',
      },
    ],
    starters: true,
  },
  identity: {
    kind: 'answer',
    replies: [
      {
        en: "I'm the website's AI assistant. I answer from our public product catalog and company information. For prices, samples or anything to confirm, our sales team follows up after you send an inquiry.",
        zh: '我是官网的 AI 助手，回答依据公开的产品目录和公司资料。价格、打样等需要确认的内容，你发送询盘后由销售团队跟进。',
      },
      {
        en: "I'm an AI assistant, and our sales team handles anything that needs a person. What can I help you find?",
        zh: '我是 AI 助手；需要人工处理的事情由销售团队跟进。你想找什么？',
      },
    ],
    starters: true,
  },
  capability: {
    kind: 'answer',
    replies: [
      {
        en: 'I can find products in our public catalog and compare them, explain OEM and ODM customization such as logo and packaging, and prepare an inquiry for our sales team. Where would you like to start?',
        zh: '我可以在公开产品目录里查找和比较产品，介绍 logo、包装等 OEM／ODM 定制，并整理询盘交给销售团队。你想从哪里开始？',
      },
      {
        en: 'Products, OEM customization and inquiries are what I can help with. Pick an option below or describe what you need.',
        zh: '我能帮你查产品、了解 OEM 定制和整理询盘。选下面的选项，或直接描述你的需求。',
      },
    ],
    starters: true,
  },
  thanks: {
    kind: 'answer',
    replies: [
      {
        en: "You're welcome. If anything else comes up, just ask here.",
        zh: '不客气。还有其他问题随时在这里问我。',
      },
      { en: 'Happy to help.', zh: '很高兴能帮上忙。' },
    ],
    starters: false,
  },
  farewell: {
    kind: 'answer',
    replies: [
      {
        en: 'Thanks for stopping by. If you need anything later, ask here or send an inquiry to our team.',
        zh: '感谢光临。之后有需要，可以在这里问我，或给团队发送询盘。',
      },
      { en: 'Goodbye, and thanks for visiting.', zh: '再见，感谢访问。' },
    ],
    starters: false,
  },
  ack: {
    kind: 'answer',
    replies: [
      {
        en: 'Okay. Ask me about products or OEM services whenever you are ready.',
        zh: '好的。需要时随时问我产品或 OEM 服务的问题。',
      },
      { en: 'Okay.', zh: '好的。' },
    ],
    starters: false,
  },
  no_content: {
    kind: 'clarification',
    replies: [
      {
        en: "I didn't catch that. Tell me the product or service you are looking for, or pick an option below.",
        zh: '我没看明白。请告诉我你要找的产品或服务，或者选下面的一个选项。',
      },
      {
        en: 'Please describe the product or service you need, and I will help.',
        zh: '请描述你需要的产品或服务，我来帮你。',
      },
    ],
    starters: true,
  },
  repeat: {
    kind: 'answer',
    replies: [
      {
        en: 'I have answered this above. You can ask it another way, or add details such as quantity, target market or budget, and I will look again.',
        zh: '这个问题上面已经回答过了。你可以换个问法，或补充数量、目标市场、预算等细节，我再帮你看。',
      },
      {
        en: 'This is the same question as above. Add a detail such as quantity, market or budget and I will look again.',
        zh: '这和上面的问题相同。补充数量、市场或预算等细节，我再帮你看。',
      },
    ],
    starters: false,
  },
};

/** From the third small-talk message in a row: one steady line, still with a way in. */
export const SCOPE_REMINDER: Reply = {
  en: "I'm here to help with our products, OEM customization and inquiries. Tell me what you need, or pick an option below.",
  zh: '我在这里帮你查产品、了解 OEM 定制和整理询盘。告诉我你的需求，或选下面的一个选项开始。',
};

const STARTERS: Record<'en' | 'zh', RawSuggestion[]> = {
  en: [
    { label: 'Browse products', utterance: 'What products do you offer?', kind: 'ask' },
    { label: 'OEM customization', utterance: 'How does OEM customization work?', kind: 'ask' },
    {
      label: 'Send a requirement',
      utterance: 'I want to send my requirement to your team.',
      kind: 'ask',
    },
  ],
  zh: [
    { label: '看看产品', utterance: '你们有哪些产品？', kind: 'ask' },
    { label: 'OEM 定制', utterance: 'OEM 定制是怎么做的？', kind: 'ask' },
    { label: '提交需求', utterance: '我想把需求发给你们的团队。', kind: 'ask' },
  ],
};

const GREETING_WORDS =
  'hi+|hey+|hello+|helo|hallo|hullo|hiya|howdy|greetings|good (?:morning|afternoon|evening|day)|hola|bonjour|salut|ciao|ola|olá|merhaba|namaste|привет|здравствуйте|こんにちは|안녕하세요|مرحبا|你好|您好|嗨|哈喽|哈啰|大家好|早上好|下午好|晚上好|早安|晚安';
const GREETING = new RegExp(
  `^(?:${GREETING_WORDS}|在吗|在不在|有人吗|有人在吗|anyone there|anybody there|is anyone there|is anybody there)(?: (?:there|team|all|everyone|guys))?$`,
  'u',
);
const LEADING_GREETING = new RegExp(`^(?:${GREETING_WORDS})(?: there)? ?`, 'u');
const STATUS =
  /^(?:how are (?:you|u|things)(?: doing| today)?|how r u|how is it going|how's it going|hows it going|what's up|whats up|wassup|sup|你好吗|最近好吗|还好吗|最近怎么样)$/u;
const IDENTITY =
  /^(?:who are (?:you|u)|what are you|what is your name|what's your name|whats your name|are (?:you|u) (?:a )?(?:bot|robot|human|real|real person|person|ai|an ai|machine|chatbot)|is this (?:a )?(?:bot|robot|ai|human|real person|chatbot)|你是谁|你叫什么|你叫什么名字|你是机器人吗|你是真人吗|你是人工智能吗|你是ai吗|是机器人吗|是真人吗)$/u;
const CAPABILITY =
  /^(?:help|menu|what can (?:you|u) do|what do (?:you|u) do|how can (?:you|u) help(?: me)?|what can i ask(?: you)?|你能做什么|你可以做什么|你会什么|你能帮我做什么|能帮我做什么|帮助|帮忙)$/u;
const THANKS =
  /^(?:thanks?(?: a lot| so much| very much)?|thank (?:you|u)(?: (?:so|very) much)?|thx|ty|many thanks|cheers|merci|gracias|danke|谢谢(?:你|您)?|多谢|感谢|谢了)$/u;
const FAREWELL =
  /^(?:bye|goodbye|good bye|bye bye|byebye|see you|see ya|see you later|再见|拜拜|回头见)$/u;
const ACK =
  /^(?:ok|okay|k|kk|okk|sure|alright|all right|got it|i see|noted|cool|great|nice|好的|好|嗯|嗯嗯|哦|知道了|明白|明白了|收到|行)$/u;
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

function smallTalk(key: string): ScreenedTopic | null {
  if (GREETING.test(key)) return 'greeting';
  // "Hi, who are you?" is the question after the greeting.
  const rest = key.replace(LEADING_GREETING, '').trim();
  for (const [pattern, topic] of [
    [STATUS, 'status'],
    [IDENTITY, 'identity'],
    [CAPABILITY, 'capability'],
    [THANKS, 'thanks'],
    [FAREWELL, 'farewell'],
  ] as const)
    if (pattern.test(key) || (rest && pattern.test(rest))) return topic;
  return null;
}

export function screenVisitorMessage(turns: readonly EngineTurn[]): ScreenedTopic | null {
  const latest = turns.at(-1);
  if (latest?.role !== 'visitor') return null;
  const key = normalizeQuestion(latest.text);
  const topic = smallTalk(key);
  if (topic) return topic;
  const previous = turns.at(-2);
  // "ok", "👍" or "?" can be the answer to a question the assistant just asked.
  const answeringQuestion = previous?.role === 'assistant' && /[?？]\s*$/.test(previous.text);
  if (answeringQuestion) return null;
  if (ACK.test(key)) return 'ack';
  if (!/[\p{L}\p{N}]/u.test(key) || MASHED.test(key.replace(/ /g, ''))) return 'no_content';
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

/**
 * Which message in an unbroken run of fixed replies this one is, counting
 * itself: 1 for the first. Any answer from the model ends the run.
 */
export function smallTalkStreak(turns: ReadonlyArray<EngineTurn & { screened?: boolean }>): number {
  let streak = 1;
  for (let i = turns.length - 2; i >= 0; i--) {
    const turn = turns[i];
    if (turn?.role === 'visitor') continue;
    if (!turn?.screened) break;
    streak += 1;
  }
  return streak;
}

export function fixedReply(topic: ScreenedTopic, latestText: string, locale: string, streak = 1) {
  const reply = FIXED_REPLIES[topic];
  const chinese =
    /[㐀-鿿]/.test(latestText) ||
    (!/\p{L}/u.test(latestText) && locale.toLowerCase().startsWith('zh'));
  const language = chinese ? 'zh' : 'en';
  const text = streak >= 3 ? SCOPE_REMINDER : (reply.replies[streak - 1] ?? reply.replies[1]);
  return {
    text: text[language],
    kind: reply.kind,
    suggestions: reply.starters || streak >= 3 ? STARTERS[language] : [],
  };
}
