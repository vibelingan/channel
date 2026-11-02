import { useEffect, useId, useRef } from 'react';
import { INQUIRY_AUTO_CHECK_DELAYS_MS, inquiryChanges } from './inquiry';
import type { InquiryDraft, InquiryView } from './model';
const inputClass =
  'mt-1 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-ink focus:outline-2 focus:outline-brand-600 disabled:bg-slate-100';
const smallButton =
  'min-h-11 rounded-lg border border-slate-300 bg-white px-3 text-xs font-semibold text-ink';
type OpenInquiry = Extract<InquiryView, { phase: 'editing' | 'saving' | 'unknown' }>;

/**
 * The one active inquiry, as a card at the end of the conversation. Chat stays
 * usable around it; folded, it is a one-line summary. A saved inquiry leaves
 * the card and becomes a receipt message.
 */
export function InquiryCard({
  view,
  expanded,
  focusRequest,
  onToggle,
  onEdit,
  onSubmit,
  onApply,
  onKeep,
}: {
  view: OpenInquiry;
  expanded: boolean;
  focusRequest: number;
  onToggle: (expanded: boolean) => void;
  onEdit: (patch: Partial<InquiryDraft>) => void;
  onSubmit: () => void;
  onApply: () => void;
  onKeep: () => void;
}) {
  const id = useId();
  if (!expanded)
    return (
      <section
        aria-label="Your inquiry"
        className="flex items-center gap-3 rounded-xl border border-brand-200 bg-white p-3 text-sm shadow-sm"
      >
        <div className="min-w-0 flex-1">
          <p className="font-semibold">
            {view.phase === 'editing'
              ? 'Inquiry draft · not submitted'
              : view.phase === 'saving'
                ? 'Saving your inquiry…'
                : 'Checking whether your inquiry was recorded'}
          </p>
          <p className="truncate text-xs text-ink-muted">
            {view.draft.product?.name ??
              (view.draft.requirement || 'Requirement not filled in yet')}
          </p>
          {view.phase === 'editing' && view.pending && (
            <p className="mt-1 text-xs font-semibold text-amber-800">Update suggested</p>
          )}
        </div>
        <button
          type="button"
          aria-expanded={false}
          aria-controls={`${id}-form`}
          onClick={() => onToggle(true)}
          className={smallButton}
        >
          Show inquiry
        </button>
      </section>
    );
  return (
    <InquiryForm
      id={id}
      view={view}
      focusRequest={focusRequest}
      onHide={() => onToggle(false)}
      onEdit={onEdit}
      onSubmit={onSubmit}
      onApply={onApply}
      onKeep={onKeep}
    />
  );
}

function InquiryForm({
  id,
  view,
  focusRequest,
  onHide,
  onEdit,
  onSubmit,
  onApply,
  onKeep,
}: {
  id: string;
  view: OpenInquiry;
  focusRequest: number;
  onHide: () => void;
  onEdit: (patch: Partial<InquiryDraft>) => void;
  onSubmit: () => void;
  onApply: () => void;
  onKeep: () => void;
}) {
  const form = useRef<HTMLFormElement>(null);
  const errors = view.phase === 'editing' ? view.errors : {};
  const formError = view.phase === 'editing' ? view.formError : undefined;
  const pending = view.phase === 'editing' ? view.pending : undefined;
  const changes = pending ? inquiryChanges(view.draft, pending) : [];
  // Shown, or asked for again: bring the card into view. A suggestion that
  // arrives while the visitor is typing elsewhere does not move focus.
  // biome-ignore lint/correctness/useExhaustiveDependencies: each request from the visitor refocuses the card.
  useEffect(() => {
    const field = form.current?.querySelector<HTMLElement>('textarea:not([disabled])');
    if (field) field.focus();
    else form.current?.scrollIntoView?.({ block: 'nearest' });
  }, [focusRequest]);
  useEffect(() => {
    if (Object.keys(errors).length)
      form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [errors]);
  useEffect(() => {
    if (formError) form.current?.querySelector<HTMLElement>('[data-inquiry-refusal]')?.focus();
  }, [formError]);
  const editing = view.phase === 'editing';
  return (
    <form
      ref={form}
      id={`${id}-form`}
      method="post"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
      className="space-y-3 rounded-xl border border-slate-200 bg-white p-4"
      aria-label="Review your inquiry"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="font-semibold">Review your inquiry</h3>
          <p className="text-xs text-ink-muted">
            Check the details before sharing them with our sales team. You can keep chatting.
          </p>
        </div>
        <button
          type="button"
          aria-expanded={true}
          aria-controls={`${id}-form`}
          onClick={onHide}
          className={`${smallButton} shrink-0`}
        >
          Hide inquiry
        </button>
      </div>
      {changes.length > 0 && (
        <section
          aria-label="Suggested update"
          className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-950"
        >
          <h4 className="font-semibold">
            {pending?.origin === 'conversation'
              ? 'Suggested update from the conversation'
              : 'Update this inquiry?'}
          </h4>
          <dl className="mt-2 space-y-2">
            {changes.map((change) => (
              <div key={change.field}>
                <dt className="font-semibold">
                  {change.field === 'product' ? 'Product' : 'Requirement'}
                </dt>
                <dd className="mt-1 break-words">
                  <span className="text-ink-muted line-through">{change.before || 'Empty'}</span>
                  <span aria-hidden="true"> → </span>
                  <span className="sr-only"> becomes </span>
                  <span className="font-medium">{change.after}</span>
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-2">
            Using it clears your consent so you can check again. Your contact details stay.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" onClick={onApply} className={smallButton}>
              Use update
            </button>
            <button type="button" onClick={onKeep} className={smallButton}>
              Keep current
            </button>
          </div>
        </section>
      )}
      {view.draft.product && (
        <p className="text-xs text-brand-800">
          Product: {view.draft.product.name} · {view.draft.product.revision}
        </p>
      )}
      {(['requirement', 'name', 'email', 'company'] as const).map((field) => {
        const label = {
          requirement: 'Your requirement',
          name: 'Name',
          email: 'Email',
          company: 'Company',
        }[field];
        const errorId = `${id}-${field}-error`;
        return (
          <div key={field}>
            <label htmlFor={`${id}-${field}`} className="block text-xs font-semibold">
              {label}
              {field === 'email' || field === 'requirement' ? ' *' : ''}
            </label>
            {field === 'requirement' ? (
              <textarea
                id={`${id}-${field}`}
                value={view.draft[field]}
                onChange={(event) => onEdit({ [field]: event.target.value })}
                disabled={!editing}
                rows={4}
                maxLength={4000}
                className={inputClass}
                aria-invalid={Boolean(errors[field])}
                aria-describedby={errors[field] ? errorId : undefined}
              />
            ) : (
              <input
                id={`${id}-${field}`}
                value={view.draft[field]}
                type={field === 'email' ? 'email' : 'text'}
                onChange={(event) => onEdit({ [field]: event.target.value })}
                disabled={!editing}
                maxLength={field === 'email' ? 254 : field === 'name' ? 120 : 200}
                className={inputClass}
                aria-invalid={Boolean(errors[field])}
                aria-describedby={errors[field] ? errorId : undefined}
              />
            )}
            {errors[field] && (
              <p id={errorId} className="mt-1 text-xs text-red-700">
                {errors[field]}
              </p>
            )}
          </div>
        );
      })}
      <label className="flex min-h-11 items-start gap-2 text-xs leading-relaxed">
        <input
          className="mt-1 h-4 w-4 shrink-0"
          type="checkbox"
          checked={view.draft.consent}
          disabled={!editing}
          onChange={(event) => onEdit({ consent: event.target.checked })}
          aria-invalid={Boolean(errors.consent)}
          aria-describedby={errors.consent ? `${id}-consent-error` : undefined}
        />
        I agree that your team may contact me about this inquiry. This does not subscribe me to
        marketing emails.
      </label>
      {errors.consent && (
        <p id={`${id}-consent-error`} className="text-xs text-red-700">
          {errors.consent}
        </p>
      )}
      <p className="text-xs text-ink-muted">
        Nothing is submitted until you confirm; chatting alone does not create an inquiry. Model,
        price and delivery terms will be confirmed separately. How we use your details:{' '}
        <a href="/privacy/" target="_blank" rel="noopener noreferrer" className="underline">
          Privacy notice
        </a>
        .
      </p>
      {view.phase === 'saving' && (
        <output className="block text-sm text-brand-800">Saving your inquiry…</output>
      )}
      {formError && (
        <p
          data-inquiry-refusal
          tabIndex={-1}
          role="alert"
          className="rounded-lg bg-red-50 p-3 text-sm text-red-800"
        >
          {formError}
        </p>
      )}
      {view.phase === 'unknown' && (
        <output className="block rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
          {view.checks < INQUIRY_AUTO_CHECK_DELAYS_MS.length
            ? 'We could not confirm the result yet and are checking this same submission again. It will not be sent twice.'
            : 'We still cannot confirm whether this inquiry was recorded. Your details are kept unchanged; check again later. Checking never sends it twice.'}
          <span className="mt-1 block text-xs">Check code: {view.key.slice(0, 8)}</span>
        </output>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={view.phase === 'saving'}
          className="min-h-11 rounded-lg bg-brand-700 px-3 text-sm font-semibold text-white disabled:opacity-50"
        >
          {view.phase === 'unknown'
            ? 'Check again now'
            : view.phase === 'saving'
              ? 'Saving…'
              : 'Confirm & submit'}
        </button>
      </div>
    </form>
  );
}

/** A saved inquiry in the conversation: what was confirmed and its reference. */
export function InquiryReceipt({
  receipt,
}: {
  receipt: { reference: string; requirement: string; product?: string };
}) {
  return (
    <section
      className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-950"
      aria-label="Inquiry receipt"
    >
      <h3 className="font-semibold">Your inquiry is recorded</h3>
      <p className="mt-1 break-words text-xs">Reference: {receipt.reference}</p>
      {receipt.product && <p className="mt-1 text-xs">Product: {receipt.product}</p>}
      <p className="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-xs">
        {receipt.requirement}
      </p>
      <p className="mt-2 text-xs">
        This confirms the inquiry record. Email delivery and response timing will be confirmed
        separately.
      </p>
    </section>
  );
}
