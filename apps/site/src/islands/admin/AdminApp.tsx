import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

function isInvalidSessionPreflight(error: unknown): boolean {
  return error instanceof AdminApiError && (error.isUnauthorized || error.code === 'NOT_FOUND');
}

export function AdminApp() {
  const { ready } = useSession();
  const [gate, setGate] = useState<GateState>('checking');
  const [gateError, setGateError] = useState('');
  const redirectingRef = useRef(false);

  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
      }),
    [],
  );

  const redirectToLogin = useCallback(() => {
    if (redirectingRef.current) return;
    redirectingRef.current = true;
    clearSession();
    queryClient.clear();
    gotoLogin();
  }, [queryClient]);

  // Any UNAUTHORIZED response (expired token) bounces back to login.
  useEffect(() => {
    const unsubscribeQueries = queryClient.getQueryCache().subscribe((event) => {
      const error = event.query.state.error;
      if (isUnauthorized(error)) redirectToLogin();
    });
    const unsubscribeMutations = queryClient.getMutationCache().subscribe((event) => {
      const error = event.mutation?.state.error;
      if (isUnauthorized(error)) redirectToLogin();
    });
    return () => {
      unsubscribeQueries();
      unsubscribeMutations();
    };
  }, [queryClient, redirectToLogin]);

  // Guard: a stored token must still be accepted by the API before the dashboard mounts.
  useEffect(() => {
    if (!ready) return;
    if (!isLoggedIn()) {
      redirectToLogin();
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
        if (isInvalidSessionPreflight(error)) {
          redirectToLogin();
          return;
        }
        const message = error instanceof Error ? error.message : 'Unable to verify your session.';
        setGateError(message);
        setGate('error');
      });

    return () => {
      active = false;
    };
  }, [ready, redirectToLogin]);

  if (!ready || gate === 'checking') {
    return (
      <main className="flex min-h-screen items-center justify-center px-4">
        <output
          className="flex items-center gap-3 text-sm font-medium text-ink-soft"
          aria-live="polite"
        >
          <span
            className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-brand-700"
            aria-hidden="true"
          />
          Verifying session...
        </output>
      </main>
    );
  }

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
