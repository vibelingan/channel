import { useEffect, useRef, useState } from 'react';
import type { NavItem } from '../../i18n/site.ts';

interface Props {
  items: NavItem[];
}

/**
 * Responsive "More" dropdown for primary navigation.
 * Shows a button that opens a dropdown panel with overflow nav items.
 * Mirrors the AccountMenu pattern: React state + useRef for outside-click.
 */
export function NavOverflowMenu({ items }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  if (items.length === 0) return null;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 whitespace-nowrap rounded-lg px-2 py-2 text-sm font-semibold text-ink-soft transition hover:bg-brand-50 hover:text-brand-700 lg:px-3 lg:text-base"
        aria-expanded={open}
        aria-haspopup="true"
      >
        More
        <svg
          className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth="2.5"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 min-w-[11rem] rounded-lg border border-slate-200 bg-white py-1.5 shadow-lg">
          {items.map((item) => (
            <a
              key={item.href}
              href={item.href}
              onClick={() => setOpen(false)}
              className="block px-4 py-2 text-sm font-medium text-ink-soft transition hover:bg-brand-50 hover:text-brand-700"
            >
              {item.label}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
