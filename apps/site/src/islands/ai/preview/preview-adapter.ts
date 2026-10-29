/** Development-only IO. Never imported by the public widget or an Astro page. */
import type {
  AssistantAdapter,
  InquiryDraft,
  InquiryReceipt,
  TurnEvent,
  TurnRequest,
} from '../assistant/model';
import { products, sampleHistory } from './scenarios';

function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Cancelled', 'AbortError'));
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException('Cancelled', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
type EventPayload<T = TurnEvent> = T extends TurnEvent
  ? Omit<T, 'conversationKey' | 'turnKey'>
  : never;
interface Ledger {
  runs: Array<{ turnKey: string; idempotencyKey: string; cursor: number }>;
  stops: string[];
  submissions: Array<{ key: string; fingerprint: string }>;
  records: number;
}
export function createPreviewAdapter(scenario: string) {
  const ledger: Ledger = { runs: [], stops: [], submissions: [], records: 0 };
  const records = new Map<string, { fingerprint: string; receipt: InquiryReceipt }>();
  const listeners = new Set<() => void>();
  let snapshot = structuredClone(ledger);
  const notify = () => {
    snapshot = structuredClone(ledger);
    for (const listener of listeners) listener();
  };
  let lastEmitter: ((event: TurnEvent) => void) | undefined;
  let lastRequest: TurnRequest | undefined;
  let restoreAttempts = 0;
  const adapter: AssistantAdapter = {
    async run(request, cursor, emit, signal) {
      ledger.runs.push({
        turnKey: request.turnKey,
        idempotencyKey: request.idempotencyKey,
        cursor,
      });
      notify();
      lastEmitter = emit;
      lastRequest = request;
      const base = { conversationKey: request.conversationKey, turnKey: request.turnKey };
      const push = (event: EventPayload) => emit({ ...base, ...event } as TurnEvent);
      if (scenario === 'queued') await wait(1500, signal);
      push({ type: 'reading', sequence: 1 });
      await wait(180, signal);
      if (
        ['stop_requested', 'stop_unconfirmed', 'stopped', 'retry_after_stop'].includes(scenario)
      ) {
        push({ type: 'token', sequence: 2, text: 'I am checking the options for your brief. ' });
        await wait(60000, signal);
        return;
      }
      if (scenario === 'rate_limit' && ledger.runs.length === 1) {
        push({ type: 'rate_limited', sequence: 2, retryAt: Date.now() + 1000 });
        return;
      }
      if (['network_failure', 'reconnecting'].includes(scenario)) {
        push({ type: 'token', sequence: 2, text: 'Here is ' });
        if (ledger.runs.length === 1) throw new Error('Synthetic interrupted connection');
        push({ type: 'token', sequence: 3, text: 'your answer from approved sources.' });
        push({ type: 'finished', sequence: 4 });
        return;
      }
      const alternate =
        scenario === 'out_of_scope'
          ? {
              text: 'I cannot verify that topic here. I can help with our products and OEM needs.',
              kind: 'unsupported' as const,
            }
          : scenario === 'no_match'
            ? {
                text: 'I have not found an approved product match. We can still prepare your requirement for our team.',
                kind: 'no_match' as const,
              }
            : scenario === 'clarification'
              ? {
                  text: 'What is your destination and preferred delivery date? A model is not required to prepare an inquiry.',
                  kind: 'clarification' as const,
                }
              : scenario === 'handoff'
                ? {
                    text: 'Our team can follow up after you check and submit your inquiry.',
                    kind: 'team_followup' as const,
                  }
                : null;
      if (alternate) {
        push({ type: 'finished', sequence: 2, ...alternate });
        return;
      }
      push({ type: 'tool', sequence: 2, label: 'Checked the approved product catalog' });
      push({ type: 'token', sequence: 3, text: 'Here are two sample product directions ' });
      await wait(220, signal);
      push({
        type: 'token',
        sequence: 4,
        text: 'for your company event. Which style suits your brief?',
      });
      push({ type: 'products', sequence: 5, products });
      push({ type: 'finished', sequence: 6 });
      // A terminal event may arrive before its HTTP reader closes.
      if (scenario === 'streaming') await wait(3000, signal);
    },
    async stop(request, signal) {
      ledger.stops.push(request.turnKey);
      notify();
      await wait(scenario === 'stop_requested' ? 800 : 180, signal);
      if (scenario === 'stop_unconfirmed' && ledger.stops.length === 1) return 'unknown';
      const oldRequest = lastRequest;
      const oldEmitter = lastEmitter;
      if (oldRequest && oldEmitter)
        setTimeout(
          () =>
            oldEmitter({
              ...oldRequest,
              type: 'token',
              sequence: 999,
              text: 'LATE RESPONSE MUST NOT APPEAR',
            }),
          30,
        );
      return 'stopped';
    },
    async restore(signal) {
      restoreAttempts += 1;
      await wait(250, signal);
      if (scenario === 'history_restoring' && restoreAttempts === 1)
        throw new Error('Synthetic temporary history failure');
      return scenario === 'history_expired'
        ? null
        : { conversationKey: 'restored-preview', messages: sampleHistory() };
    },
    async submitInquiry(draft: InquiryDraft, key, signal) {
      const bytes = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(JSON.stringify(draft)),
      );
      const fingerprint = Array.from(new Uint8Array(bytes), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('');
      ledger.submissions.push({ key, fingerprint });
      notify();
      await wait(scenario === 'inquiry_submitting' ? 1500 : 180, signal);
      const existing = records.get(key);
      if (existing && existing.fingerprint !== fingerprint)
        throw new Error('Changed synthetic submission');
      const receipt = existing?.receipt ?? {
        reference: `PREVIEW-${String(records.size + 1).padStart(3, '0')}`,
      };
      if (!existing) {
        records.set(key, { fingerprint, receipt });
        ledger.records = records.size;
        notify();
      }
      if (scenario === 'inquiry_unknown' && ledger.submissions.length === 1) return null;
      return receipt;
    },
  };
  return {
    ...adapter,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
  };
}
