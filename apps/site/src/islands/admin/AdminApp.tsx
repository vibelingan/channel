import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import {
  canAccessAdmin,
  clearSession,
  getToken,
  isLoggedIn,
  setSession,
} from '../../lib/session.ts';
import { useSession } from '../auth/useSession.ts';
import { DashboardShell } from './DashboardShell.tsx';
import { AdminApiError, fetchCurrentUser } from './api.ts';

type GateState = 'checking' | 'authorized' | 'denied' | 'error';

/** Redirect helper preserving the intended destination. */
function gotoLogin() {
  if (typeof window !== 'undefined') {
    window.location.href = '/login?returnTo=/admin';
  }
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof AdminApiError && error.isUnauthorized;
}

function redirectToLogin(queryClient: QueryClient) {
  clearSession();
  queryClient.clear();
  gotoLogin();
}

export function AdminApp() {
  const { ready } = useSession();
  const [gate, setGate] = useState<GateState>('checking');
  const [gateError, setGateError] = useState('');

  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
      }),
    [],
  );

  // Any UNAUTHORIZED response (expired token) bounces back to login.
  useEffect(() => {
    const unsubscribeQueries = queryClient.getQueryCache().subscribe((event) => {
      const error = event.query.state.error;
      if (isUnauthorized(error)) redirectToLogin(queryClient);
    });
    const unsubscribeMutations = queryClient.getMutationCache().subscribe((event) => {
      const error = event.mutation?.state.error;
      if (isUnauthorized(error)) redirectToLogin(queryClient);
    });
    return () => {
      unsubscribeQueries();
      unsubscribeMutations();
    };
  }, [queryClient]);

  // Guard: a stored token must still be accepted by the API before the dashboard mounts.
  useEffect(() => {
    if (!ready) return;
    if (!isLoggedIn()) {
      gotoLogin();
      return;
    }

    let active = true;
    setGate('checking');
    setGateError('');
    fetchCurrentUser()
      .then(({ user }) => {
        if (!active) return;
        const token = getToken();
        if (token) setSession(token, user);
        setGate(canAccessAdmin(user.role) ? 'authorized' : 'denied');
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (isUnauthorized(error)) {
          redirectToLogin(queryClient);
          return;
        }
        const message = error instanceof Error ? error.message : 'Unable to verify your session.';
        setGateError(message);
        setGate('error');
      });

    return () => {
      active = false;
    };
  }, [ready, queryClient]);

  if (!ready || gate === 'checking') return null;

  if (gate === 'denied') {
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

  if (gate === 'error') {
    return (
      <main className="flex min-h-screen items-center justify-center px-4">
        <div className="max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
          <h1 className="font-display text-xl font-semibold text-ink">Session check failed</h1>
          <p className="mt-2 text-sm text-ink-soft">{gateError}</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-6 inline-flex rounded-lg bg-brand-700 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-800"
          >
            Try again
          </button>
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
