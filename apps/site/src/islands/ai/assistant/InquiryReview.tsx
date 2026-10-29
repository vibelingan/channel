import { useEffect, useId, useRef } from 'react';
import type { InquiryDraft, InquiryView } from './model';
const inputClass =
  'mt-1 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-ink focus:outline-2 focus:outline-brand-600 disabled:bg-slate-100';

export function InquiryReview({
  view,
  onEdit,
  onSubmit,
  onBack,
}: {
  view: Exclude<InquiryView, { phase: 'closed' }>;
  onEdit: (patch: Partial<InquiryDraft>) => void;
  onSubmit: () => void;
  onBack: () => void;
}) {
  const id = useId();
  const form = useRef<HTMLFormElement>(null);
  const errors = view.phase === 'editing' ? view.errors : {};
  useEffect(() => {
    form.current?.querySelector<HTMLElement>('textarea:not([disabled])')?.focus();
  }, []);
  useEffect(() => {
    if (Object.keys(errors).length)
      form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [errors]);
  if (view.phase === 'saved')
    return (
      <section
        className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm"
        aria-label="Inquiry receipt"
      >
        <h3 className="font-semibold">Your inquiry is recorded</h3>
        <p className="mt-2 break-words">Reference: {view.receipt.reference}</p>
        <p className="mt-2">
          This confirms the inquiry record. Email delivery and response timing will be confirmed
          separately.
        </p>
        <button
          className="mt-3 min-h-11 rounded-lg border border-slate-300 bg-white px-3"
          type="button"
          onClick={onBack}
        >
          Back to chat
        </button>
      </section>
    );
  const editing = view.phase === 'editing';
  return (
    <form
      ref={form}
      method="post"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
      className="space-y-3 rounded-xl border border-slate-200 bg-white p-4"
      aria-label="Review your inquiry"
    >
      <h3 className="font-semibold">Review your inquiry</h3>
      <p className="text-xs text-ink-muted">
        Check the details before sharing them with our sales team.
      </p>
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
        Nothing is submitted until you confirm. Model, price and delivery terms will be confirmed
        separately.
      </p>
      {view.phase === 'saving' && (
        <output className="block text-sm text-brand-800">Saving your inquiry…</output>
      )}
      {view.phase === 'unknown' && (
        <output className="block rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
          We have not confirmed the result. Check the original submission before trying a new
          inquiry.
        </output>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="min-h-11 rounded-lg border border-slate-300 px-3 text-sm"
          onClick={onBack}
        >
          Back to chat
        </button>
        <button
          type="submit"
          disabled={view.phase === 'saving'}
          className="min-h-11 rounded-lg bg-brand-700 px-3 text-sm font-semibold text-white disabled:opacity-50"
        >
          {view.phase === 'unknown'
            ? 'Check original submission'
            : view.phase === 'saving'
              ? 'Saving…'
              : 'Confirm & submit'}
        </button>
      </div>
    </form>
  );
}
