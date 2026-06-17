import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { canAccessAdmin, clearSession, getUser, isLoggedIn } from '../../lib/session.ts';
import { useSession } from '../auth/useSession.ts';
import { DashboardShell } from './DashboardShell.tsx';
import { AdminApiError } from './api.ts';

/** Redirect helper preserving the intended destination. */
function gotoLogin() {
  if (typeof window !== 'undefined') {
    window.location.href = '/login?returnTo=/admin';
  }
}

export function AdminApp() {
  const { ready } = useSession();
  const [denied, setDenied] = useState(false);

  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
      }),
    [],
  );

  // Any UNAUTHORIZED response (expired token) bounces back to login.
  useEffect(() => {
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      const error = event.query.state.error;
      if (error instanceof AdminApiError && error.isUnauthorized) {
        clearSession();
        gotoLogin();
      }
    });
    return unsubscribe;
  }, [queryClient]);

  // Guard: must be signed in AND have an admin/contributor role.
  useEffect(() => {
    if (!ready) return;
    if (!isLoggedIn()) {
      gotoLogin();
      return;
    }
    const user = getUser();
    if (!user || !canAccessAdmin(user.role)) {
      setDenied(true);
    }
  }, [ready]);

  if (!ready) return null;

  if (denied) {
    return (
      <main className="flex min-h-screen items-center justify-center px-4">
        <div className="max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
          <h1 className="font-display text-xl font-semibold text-ink">Access denied</h1>
          <p className="mt-2 text-sm text-ink-soft">
            Your account does not have permission to view the admin dashboard.
          </p>
          <a
            href="/"
            className="mt-6 inline-flex rounded-lg bg-brand-700 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-800"
          >
            Back to site
          </a>
        </div>
      </main>
    );
  }

  if (!isLoggedIn()) return null;

  return (
    <QueryClientProvider client={queryClient}>
      <DashboardShell
        onLogout={() => {
          clearSession();
          queryClient.clear();
          window.location.href = '/';
        }}
      />
    </QueryClientProvider>
  );
}
