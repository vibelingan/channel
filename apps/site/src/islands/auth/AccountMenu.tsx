import { useEffect, useRef, useState } from 'react';
import { clearSession } from '../../lib/session.ts';
import { useSession } from './useSession.ts';

interface Props {
  /** When true, render light text suited to a dark background. */
  dark?: boolean;
  /** A mobile navigation panel already owns disclosure/scrolling; use direct links. */
  layout?: 'dropdown' | 'navigation';
}

/**
 * Header account control. Shows Sign in / Register links for guests, and a name
 * banner with a dropdown (Account, Admin, Sign out) for signed-in users.
 * Desktop uses a dropdown; mobile navigation uses direct, native destinations.
 */
export function AccountMenu({ dark = false, layout = 'dropdown' }: Props) {
  const { user, loggedIn, isAdminUser, ready } = useSession();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (layout !== 'dropdown') return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [layout]);

  // Avoid a hydration flash: render nothing until the session is read.
  if (!ready) return <span className="inline-block h-9 w-24" />;

  if (!loggedIn || !user) {
    const link = dark ? 'text-white/90 hover:text-white' : 'text-ink-soft hover:text-brand-700';
    return (
      <div className="flex shrink-0 flex-wrap items-center gap-1" data-account-menu>
        <a
          href="/login"
          className={`whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium transition ${link}`}
        >
          Sign in
        </a>
        <a
          href="/register"
          className="inline-flex items-center rounded-lg bg-brand-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-800"
        >
          Register
        </a>
        {layout === 'navigation' && (
          <a
            href="/admin"
            className="inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-medium text-ink-soft hover:bg-brand-50"
          >
            Admin portal
          </a>
        )}
      </div>
    );
  }

  const initial = (user.username || user.email || '?').charAt(0).toUpperCase();
  const avatar = (
    <>
      <span className="grid h-7 w-7 place-items-center rounded-full bg-brand-700 text-xs font-bold text-white">
        {initial}
      </span>
      <span className="max-w-28 truncate">{user.username || user.email}</span>
    </>
  );
  const signOut = () => {
    clearSession();
    window.location.href = '/';
  };

  if (layout === 'navigation')
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1" data-account-menu>
        <a
          href={isAdminUser ? '/admin' : '/account'}
          aria-label={isAdminUser ? 'Admin dashboard' : 'Account settings'}
          data-account-trigger
          className="inline-flex min-h-11 items-center gap-2 rounded-full border border-slate-200 bg-white py-1 pl-1 pr-3 text-sm font-medium text-ink shadow-sm hover:border-brand-300"
        >
          {avatar}
        </a>
        {isAdminUser && (
          <a
            href="/account"
            className="inline-flex min-h-11 items-center rounded-lg px-2 text-sm text-ink-soft hover:bg-brand-50"
          >
            Account settings
          </a>
        )}
        <button
          type="button"
          onClick={signOut}
          className="min-h-11 rounded-lg px-2 text-sm text-red-600 hover:bg-red-50"
        >
          Sign out
        </button>
      </div>
    );

  return (
    <div className="relative" ref={ref} data-account-menu>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-full border border-slate-200 bg-white py-1 pl-1 pr-3 text-sm font-medium text-ink shadow-sm transition hover:border-brand-300"
        aria-haspopup="menu"
        aria-expanded={open}
        data-account-trigger
      >
        {avatar}
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 w-52 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-[var(--shadow-card)]">
          <div className="border-b border-slate-100 px-4 py-2">
            <p className="truncate text-sm font-semibold text-ink">{user.username}</p>
            <p className="truncate text-xs text-ink-muted">{user.email}</p>
            {user.role && (
              <span className="mt-1 inline-flex rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-semibold capitalize text-brand-700">
                {user.role}
              </span>
            )}
          </div>
          <a href="/account" className="block px-4 py-2 text-sm text-ink-soft hover:bg-brand-50">
            Account settings
          </a>
          {isAdminUser && (
            <a href="/admin" className="block px-4 py-2 text-sm text-ink-soft hover:bg-brand-50">
              Admin dashboard
            </a>
          )}
          <button
            type="button"
            onClick={signOut}
            className="block w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-red-50"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
