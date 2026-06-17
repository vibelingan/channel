import { useEffect, useRef, useState } from 'react';
import type { CategoryOption } from '../../i18n/headphones.ts';

interface Props {
  label: string;
  allLabel: string;
  options: CategoryOption[];
  selected: string[];
  onChange: (next: string[]) => void;
}

/** Multi-select category dropdown. All options selected by default. */
export function CategoryFilter({ label, allLabel, options, selected, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const allSelected = selected.length === options.length;

  function toggle(key: string) {
    onChange(selected.includes(key) ? selected.filter((k) => k !== key) : [...selected, key]);
  }

  function toggleAll() {
    onChange(allSelected ? [] : options.map((o) => o.key));
  }

  const summary = allSelected
    ? allLabel
    : selected.length === 0
      ? 'None'
      : `${selected.length} selected`;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="inline-flex min-w-56 items-center justify-between gap-3 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-ink shadow-sm transition hover:border-brand-400"
      >
        <span className="text-ink-muted">
          {label}: <span className="font-semibold text-ink">{summary}</span>
        </span>
        <svg
          className={`h-4 w-4 text-ink-muted transition ${open ? 'rotate-180' : ''}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div className="absolute z-20 mt-2 w-64 rounded-xl border border-slate-200 bg-white p-2 shadow-[var(--shadow-card)]">
          <label className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 hover:bg-brand-50">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={toggleAll}
              className="h-4 w-4 rounded border-slate-300 text-brand-700 focus:ring-brand-600"
            />
            <span className="text-sm font-semibold text-ink">{allLabel}</span>
          </label>
          <div className="my-1 border-t border-slate-100" />
          {options.map((option) => (
            <label
              key={option.key}
              className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 hover:bg-brand-50"
            >
              <input
                type="checkbox"
                checked={selected.includes(option.key)}
                onChange={() => toggle(option.key)}
                className="h-4 w-4 rounded border-slate-300 text-brand-700 focus:ring-brand-600"
              />
              <span className="text-sm text-ink-soft">{option.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
