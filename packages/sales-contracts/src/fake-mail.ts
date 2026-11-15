import { hashCanonicalJson } from './canonical.ts';
import { validateContract } from './index.ts';
import type { MailSnapshot } from './types.generated.ts';

export interface SimulatedMailReceipt {
  mode: 'fake';
  status: 'simulated_accepted';
  simulated_id: string;
}
export interface FakeMailPort {
  stageDraft(snapshot: MailSnapshot): Promise<{ mode: 'fake'; draft_id: string }>;
  submit(snapshot: MailSnapshot, idempotencyKey: string): Promise<SimulatedMailReceipt>;
}
export type FakeOutcome = 'accepted' | 'fail_before_accept' | 'timeout_after_accept';
export class FakeMailFailure extends Error {
  constructor(readonly disposition: 'not_accepted' | 'outcome_unknown') {
    super(`Simulated mail failure: ${disposition}`);
  }
}

export class FakeMailProvider implements FakeMailPort {
  private readonly drafts = new Map<string, MailSnapshot>();
  private readonly submissions = new Map<
    string,
    { hash: string; receipt: SimulatedMailReceipt; snapshot: MailSnapshot }
  >();
  private readonly outcomes: FakeOutcome[];
  constructor(outcomes: FakeOutcome[] = []) {
    this.outcomes = [...outcomes];
  }

  async stageDraft(snapshot: MailSnapshot): Promise<{ mode: 'fake'; draft_id: string }> {
    const copy = validateContract('mail-snapshot', snapshot);
    const draft_id = `fake_draft_${hashCanonicalJson(copy)}`;
    this.drafts.set(draft_id, copy);
    return { mode: 'fake', draft_id };
  }

  getDraft(draftId: string): MailSnapshot | undefined {
    const draft = this.drafts.get(draftId);
    return draft ? structuredClone(draft) : undefined;
  }

  async submit(snapshot: MailSnapshot, idempotencyKey: string): Promise<SimulatedMailReceipt> {
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(idempotencyKey))
      throw new Error('Invalid simulated operation key');
    const copy = validateContract('mail-snapshot', snapshot);
    const hash = hashCanonicalJson(copy);
    const previous = this.submissions.get(idempotencyKey);
    if (previous) {
      if (previous.hash !== hash) throw new Error('Simulated idempotency payload conflict');
      return structuredClone(previous.receipt);
    }
    const outcome = this.outcomes.shift() ?? 'accepted';
    if (outcome === 'fail_before_accept') throw new FakeMailFailure('not_accepted');
    const receipt: SimulatedMailReceipt = {
      mode: 'fake',
      status: 'simulated_accepted',
      simulated_id: `fake_mail_${hashCanonicalJson({ idempotencyKey, hash })}`,
    };
    this.submissions.set(idempotencyKey, { hash, receipt, snapshot: copy });
    if (outcome === 'timeout_after_accept') throw new FakeMailFailure('outcome_unknown');
    return structuredClone(receipt);
  }

  get acceptedSubmissions(): readonly MailSnapshot[] {
    return Array.from(this.submissions.values(), ({ snapshot }) => structuredClone(snapshot));
  }
}
