import { isOperationKey, isPublicProductCard, isUuid } from '@vibelingan-channel/ai-contracts';
import type { InquiryDraft, TurnRequest } from './model';

/**
 * What one browser tab keeps so a refresh or same-tab navigation can continue
 * the same conversation. Message text stays on the server; this holds only the
 * credential, the in-flight question and what the visitor has not submitted.
 * A new tab has its own sessionStorage and therefore starts a new conversation.
 */
export interface PersistedAssistant {
  version: 1;
  conversationId: string;
  credential: string;
  expiresAt: string;
  conversationKey: string;
  open: boolean;
  /** A question whose answer may still be running; resumed with the same key. */
  turn?: Omit<TurnRequest, 'conversationKey'>;
  /** Unsent or uncertain inquiry; `saving` is stored as `unknown`. */
  inquiry?: PersistedInquiry;
  /** Frozen request bodies by submission key, so a recheck resends identical content. */
  submissions?: Array<{ key: string; body: string }>;
  /** The product card the visitor left from (MIU 18). */
  anchor?: AssistantAnchor;
}
/**
 * Where the visitor left the conversation for a product page. `arriving` is set
 * by the click and cleared by the page that opens next, which decides whether
 * the panel starts expanded; Back then restores the state the visitor left.
 */
export interface AssistantAnchor {
  messageId: string;
  productId?: string;
  arriving?: true;
}
export type PersistedInquiry =
  | { phase: 'editing'; key: string; draft: InquiryDraft }
  | { phase: 'unknown'; key: string; draft: InquiryDraft; checks: number }
  | { phase: 'saved'; key: string; draft: InquiryDraft; reference: string };
export interface AssistantPersistence {
  load(): PersistedAssistant | null;
  save(record: PersistedAssistant): void;
  /** Merge into the current record; a no-op when none is stored. */
  update(patch: Partial<Omit<PersistedAssistant, 'version'>>): void;
  clear(): void;
}
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
/** Reading `sessionStorage` itself throws when site data is blocked. */
function tabStorage(): StorageLike | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

/** `scope` partitions by site and business, e.g. `supplychainsai.com:website_sales`. */
export function sessionAssistantPersistence(
  scope: string,
  storage: StorageLike | undefined = tabStorage(),
): AssistantPersistence {
  const key = `channel.ai.v2.${scope}`;
  const read = (): PersistedAssistant | null => {
    try {
      const raw = storage?.getItem(key);
      if (!raw) return null;
      const value: unknown = JSON.parse(raw);
      if (!isPersistedAssistant(value) || Date.parse(value.expiresAt) <= Date.now()) {
        storage?.removeItem(key);
        return null;
      }
      return value;
    } catch {
      return null;
    }
  };
  const write = (record: PersistedAssistant) => {
    try {
      storage?.setItem(key, JSON.stringify(record));
    } catch {
      // Private mode or quota: the conversation continues in memory only.
    }
  };
  return {
    load: read,
    save: write,
    update(patch) {
      const current = read();
      if (!current) return;
      const next: Record<string, unknown> = { ...current, ...patch };
      for (const field of Object.keys(next)) if (next[field] === undefined) delete next[field];
      if (isPersistedAssistant(next)) write(next);
    },
    clear() {
      try {
        storage?.removeItem(key);
      } catch {
        // Nothing to clear when storage is blocked.
      }
    },
  };
}

const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const only = (v: Record<string, unknown>, fields: string[]) =>
  Object.keys(v).every((field) => fields.includes(field));
const text = (v: unknown, max: number, required = false): v is string =>
  typeof v === 'string' && v.length <= max && (!required || v.trim().length > 0);

function isDraft(v: unknown): v is InquiryDraft {
  return (
    record(v) &&
    // Drafts saved before the consent box was removed still carry `consent`.
    only(v, ['requirement', 'name', 'email', 'company', 'consent', 'product']) &&
    text(v.requirement, 4000) &&
    text(v.name, 120) &&
    text(v.email, 254) &&
    text(v.company, 200) &&
    (v.consent === undefined || typeof v.consent === 'boolean') &&
    (v.product === undefined || isPublicProductCard(v.product))
  );
}
function isInquiry(v: unknown): v is PersistedInquiry {
  if (!record(v) || !isOperationKey(v.key) || !isDraft(v.draft)) return false;
  switch (v.phase) {
    case 'editing':
      return only(v, ['phase', 'key', 'draft']);
    case 'unknown':
      return (
        only(v, ['phase', 'key', 'draft', 'checks']) &&
        Number.isSafeInteger(v.checks) &&
        (v.checks as number) >= 0
      );
    case 'saved':
      return (
        only(v, ['phase', 'key', 'draft', 'reference']) &&
        /^ai_[a-f0-9]{64}$/.test(`${v.reference}`)
      );
    default:
      return false;
  }
}
function isTurn(v: unknown): v is PersistedAssistant['turn'] {
  return (
    record(v) &&
    only(v, ['turnKey', 'idempotencyKey', 'message', 'catalogAction']) &&
    isOperationKey(v.turnKey) &&
    isOperationKey(v.idempotencyKey) &&
    text(v.message, 8000, true) &&
    (v.catalogAction === undefined || record(v.catalogAction))
  );
}
function isAnchor(v: unknown): v is AssistantAnchor {
  return (
    record(v) &&
    only(v, ['messageId', 'productId', 'arriving']) &&
    text(v.messageId, 300, true) &&
    (v.productId === undefined || (text(v.productId, 128, true) && /^[\w-]+$/.test(v.productId))) &&
    (v.arriving === undefined || v.arriving === true)
  );
}
function isPersistedAssistant(v: unknown): v is PersistedAssistant {
  return (
    record(v) &&
    only(v, [
      'version',
      'conversationId',
      'credential',
      'expiresAt',
      'conversationKey',
      'open',
      'turn',
      'inquiry',
      'submissions',
      'anchor',
    ]) &&
    v.version === 1 &&
    isUuid(v.conversationId) &&
    text(v.credential, 128) &&
    (v.credential as string).length >= 32 &&
    typeof v.expiresAt === 'string' &&
    Number.isFinite(Date.parse(v.expiresAt)) &&
    text(v.conversationKey, 128, true) &&
    typeof v.open === 'boolean' &&
    (v.turn === undefined || isTurn(v.turn)) &&
    (v.inquiry === undefined || isInquiry(v.inquiry)) &&
    (v.submissions === undefined ||
      (Array.isArray(v.submissions) &&
        v.submissions.length <= 4 &&
        v.submissions.every(
          (s) =>
            record(s) && only(s, ['key', 'body']) && isOperationKey(s.key) && text(s.body, 20000),
        ))) &&
    (v.anchor === undefined || isAnchor(v.anchor))
  );
}
