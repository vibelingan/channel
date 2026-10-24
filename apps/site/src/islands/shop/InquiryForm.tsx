import { useState } from 'react';
import type { InquiryStrings } from './types.ts';

export interface InquiryItem {
  id?: string;
  name: string;
}

interface Props {
  items: InquiryItem[];
  content: InquiryStrings;
  onClose: () => void;
  /** Called after a successful submission (e.g. to clear the batch cart). */
  onSubmitted?: () => void;
}

/** Price-inquiry modal: capture lead details + catalog/quote intent. */
export function InquiryForm({ items, content, onClose, onSubmitted }: Props) {
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }
    setBusy(true);
    // No backend yet — simulate the request. A future `inquiries` collection
    // (via the serverless API) will persist this.
    await new Promise((r) => setTimeout(r, 600));
    setBusy(false);
    setDone(true);
    onSubmitted?.();
  }

  const summary =
    items.length === 1 ? items[0]?.name : `${items.length} items selected for inquiry`;

  const fieldClass =
    'mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-ink shadow-sm outline-none transition focus:border-brand-600 focus:ring-2 focus:ring-brand-600/20';

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/50 p-4"
      // biome-ignore lint/a11y/useSemanticElements: custom modal overlay needs backdrop-click handling
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md overflow-hidden rounded-[var(--radius-card)] bg-white shadow-xl">
        {done ? (
          <div className="p-8 text-center">
            <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-green-100 text-green-600">
              <svg
                className="h-7 w-7"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M5 13l4 4L19 7" />
              </svg>
            </span>
            <h3 className="mt-5 font-display text-xl font-semibold text-ink">
              {content.successTitle}
            </h3>
            <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-ink-soft">
              {content.successBody}
            </p>
            <button
              type="button"
              onClick={onClose}
              className="mt-6 inline-flex items-center justify-center rounded-lg bg-brand-700 px-6 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-800"
            >
              Close
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} noValidate>
            <div className="flex items-start justify-between border-b border-slate-100 p-6">
              <div>
                <h3 className="font-display text-lg font-semibold text-ink">{content.title}</h3>
                <p className="mt-1 text-sm text-ink-muted">{summary}</p>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="rounded-lg p-1.5 text-ink-muted transition hover:bg-slate-100"
              >
                <svg
                  className="h-5 w-5"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden="true"
                >
                  <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>

            <div className="space-y-4 p-6">
              <p className="text-sm text-ink-soft">{content.intro}</p>

              {items.length > 1 && (
                <ul className="max-h-32 space-y-1 overflow-auto rounded-lg border border-slate-200 bg-surface-alt p-3 text-sm text-ink-soft">
                  {items.map((item, i) => (
                    <li key={item.id ?? `${item.name}-${i}`} className="flex items-center gap-2">
                      <span className="inline-block h-1.5 w-1.5 rounded-full bg-brand-400" />
                      {item.name}
                    </li>
                  ))}
                </ul>
              )}

              <div>
                <label htmlFor="iq-email" className="block text-sm font-medium text-ink">
                  {content.emailLabel} <span className="text-red-500">*</span>
                </label>
                <input id="iq-email" name="email" type="email" required className={fieldClass} />
              </div>
              <div>
                <label htmlFor="iq-company" className="block text-sm font-medium text-ink">
                  {content.companyLabel} <span className="text-red-500">*</span>
                </label>
                <input id="iq-company" name="company" type="text" required className={fieldClass} />
              </div>
              <div>
                <label htmlFor="iq-country" className="block text-sm font-medium text-ink">
                  {content.countryLabel} <span className="text-red-500">*</span>
                </label>
                <input id="iq-country" name="country" type="text" required className={fieldClass} />
              </div>

              <div className="space-y-2 pt-1">
                <label className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    name="downloadCatalog"
                    defaultChecked
                    className="h-4 w-4 rounded border-slate-300 text-brand-700 focus:ring-brand-600"
                  />
                  <span className="text-sm text-ink-soft">{content.downloadCatalog}</span>
                </label>
                <label className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    name="requestQuote"
                    defaultChecked
                    className="h-4 w-4 rounded border-slate-300 text-brand-700 focus:ring-brand-600"
                  />
                  <span className="text-sm text-ink-soft">{content.requestQuote}</span>
                </label>
              </div>

              <p className="text-xs text-ink-muted">{content.disclaimer}</p>
            </div>

            <div className="flex justify-end gap-3 border-t border-slate-100 p-6">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-slate-300 px-5 py-2.5 text-sm font-medium text-ink-soft transition hover:bg-slate-50"
              >
                {content.cancelLabel}
              </button>
              <button
                type="submit"
                disabled={busy}
                className="rounded-lg bg-brand-700 px-6 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-800 disabled:opacity-60"
              >
                {busy ? '…' : content.submitLabel}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
