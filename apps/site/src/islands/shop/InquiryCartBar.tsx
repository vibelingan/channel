import { useState } from 'react';
import { apiMediaUrl } from '../../lib/api-url.ts';
import { InquiryForm } from './InquiryForm.tsx';
import { useInquiryCart } from './inquiryCart.ts';
import type { InquiryStrings } from './types.ts';

interface Props {
  inquiry: InquiryStrings;
}

/**
 * Floating batch-inquiry cart. Lets customers collect multiple overstock items
 * and request one combined quote. Renders nothing while the cart is empty.
 */
export function InquiryCartBar({ inquiry }: Props) {
  const { items, remove, clear } = useInquiryCart();
  const [open, setOpen] = useState(false);
  const [showForm, setShowForm] = useState(false);

  if (items.length === 0) return null;

  return (
    <>
      {/* Expandable panel */}
      {open && (
        <div className="fixed bottom-24 right-4 z-40 w-80 overflow-hidden rounded-[var(--radius-card)] border border-slate-200 bg-white shadow-[var(--shadow-card)] sm:right-6">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
            <p className="font-display text-sm font-semibold text-ink">
              Inquiry list ({items.length})
            </p>
            <button
              type="button"
              onClick={clear}
              className="text-xs font-medium text-ink-muted transition hover:text-red-600"
            >
              Clear all
            </button>
          </div>
          <ul className="max-h-72 divide-y divide-slate-100 overflow-auto">
            {items.map((item) => (
              <li key={item.id} className="flex items-center gap-3 px-4 py-2.5">
                <img
                  src={apiMediaUrl(item.image ?? '/api/images/_placeholder')}
                  alt=""
                  className="h-10 w-10 shrink-0 rounded-md border border-slate-200 object-cover"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink">{item.name}</p>
                  {item.code && <p className="text-xs text-ink-muted">{item.code}</p>}
                </div>
                <button
                  type="button"
                  onClick={() => remove(item.id)}
                  aria-label={`Remove ${item.name}`}
                  className="rounded-md p-1 text-ink-muted transition hover:bg-slate-100 hover:text-red-600"
                >
                  <svg
                    className="h-4 w-4"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    aria-hidden="true"
                  >
                    <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
              </li>
            ))}
          </ul>
          <div className="border-t border-slate-100 p-3">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setShowForm(true);
              }}
              className="w-full rounded-lg bg-accent-500 px-4 py-2.5 text-sm font-semibold text-brand-950 transition hover:bg-accent-400"
            >
              Request batch quote
            </button>
          </div>
        </div>
      )}

      {/* Floating toggle button */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="fixed bottom-6 right-4 z-40 inline-flex items-center gap-2 rounded-full bg-brand-700 px-5 py-3 font-semibold text-white shadow-lg transition hover:bg-brand-800 sm:right-6"
      >
        <svg
          className="h-5 w-5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M3 3h2l2.4 12.3a2 2 0 0 0 2 1.7h7.7a2 2 0 0 0 2-1.6L23 6H6"
          />
          <circle cx="9" cy="20" r="1.5" />
          <circle cx="18" cy="20" r="1.5" />
        </svg>
        Inquiry
        <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-accent-500 px-1.5 text-xs font-bold text-brand-950">
          {items.length}
        </span>
      </button>

      {showForm && (
        <InquiryForm
          items={items.map((i) => ({ id: i.id, name: i.name }))}
          content={inquiry}
          onClose={() => setShowForm(false)}
          onSubmitted={clear}
        />
      )}
    </>
  );
}
