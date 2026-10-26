import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type SessionUser,
  canAccessAdmin,
  clearSession,
  getToken,
  getUser,
  isLoggedIn,
  onAuthChange,
  setSession,
} from '../../lib/session.ts';
import { useSession } from '../auth/useSession.ts';
import { AdminSessionRecovery } from './AdminSessionRecovery.tsx';
import { DashboardShell } from './DashboardShell.tsx';
import { reconnectAdminForms } from './admin-draft-recovery.ts';
import { installAdminSessionGuard, isCurrentAdminError } from './admin-session-guard.ts';
import { AdminApiError, fetchCurrentUser } from './api.ts';
import { articleLocationPath, readArticleLocation } from './articles/draft-location.ts';

type LogoutDestination = 'login' | 'site';
type GateState =
  | { kind: 'checking' | 'authorized' | 'denied' }
  | { kind: 'error'; message: string; retryLogout?: LogoutDestination };

/** Redirect helper preserving the intended destination. */
function gotoLogin() {
  if (typeof window !== 'undefined') {
    const articleId = readArticleLocation(window.location.search);
    const returnTo = articleId ? articleLocationPath(articleId) : '/admin';
    window.location.href = `/login?${new URLSearchParams({ returnTo })}`;
  }
}

function isUnauthorized(error: unknown): error is AdminApiError {
  return error instanceof AdminApiError && error.isUnauthorized;
}

function isInvalidSessionPreflight(error: unknown): boolean {
  return error instanceof AdminApiError && (error.isUnauthorized || error.code === 'NOT_FOUND');
}

export function AdminApp() {
  const { ready } = useSession();
  const [gate, setGate] = useState<GateState>({ kind: 'checking' });
  const redirectingRef = useRef(false);
  const logoutDestination = useRef<LogoutDestination | null>(null);
  const [verification, recheck] = useState(0);
  const verified = useRef<{ token: string; user: SessionUser } | null>(null);
  const sessionGuard = useRef<ReturnType<typeof installAdminSessionGuard> | null>(null);
  const [paused, setPaused] = useState(false);

  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
      }),
    [],
  );

  const finishSession = useCallback(
    (destination: LogoutDestination) => {
      if (redirectingRef.current) return;
      redirectingRef.current = true;
      logoutDestination.current = destination;
      sessionGuard.current?.release();
      try {
        clearSession();
        queryClient.clear();
        if (destination === 'login') gotoLogin();
        else window.location.href = '/';
      } catch (error) {
        queryClient.clear();
        setGate({
          kind: 'error',
          message:
            error instanceof Error ? error.message : 'Sign out could not be confirmed. Try again.',
          retryLogout: destination,
        });
        redirectingRef.current = false;
      }
    },
    [queryClient],
  );
  const redirectToLogin = useCallback(() => {
    if (logoutDestination.current) return;
    if (verified.current) sessionGuard.current?.pause();
    else finishSession('login');
  }, [finishSession]);

  // Keep a verified workspace mounted; a late response from an old token cannot pause its successor.
  useEffect(() => {
    const unsubscribeQueries = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated' || event.action.type !== 'error') return;
      const error = event.query.state.error;
      if (isUnauthorized(error) && isCurrentAdminError(error)) redirectToLogin();
    });
    const unsubscribeMutations = queryClient.getMutationCache().subscribe((event) => {
      if (event.type !== 'updated' || event.action.type !== 'error') return;
      const error = event.mutation?.state.error;
      if (isUnauthorized(error) && isCurrentAdminError(error)) redirectToLogin();
    });
    return () => {
      unsubscribeQueries();
      unsubscribeMutations();
    };
  }, [queryClient, redirectToLogin]);
  useEffect(() => {
    const unsubscribe = onAuthChange(() => {
      const original = verified.current;
      if (logoutDestination.current || !original) return;
      if (getToken() !== original.token || getUser()?.id !== original.user.id)
        sessionGuard.current?.pause();
    });
    return () => {
      unsubscribe();
      sessionGuard.current?.release();
    };
  }, []);

  // Guard: a stored token must still be accepted by the API before the dashboard mounts.
  useEffect(() => {
    if (!ready || logoutDestination.current) return;
    if (!isLoggedIn()) {
      redirectToLogin();
      return;
    }

    let active = true;
    const checkedToken = getToken();
    const checkedActor = getUser()?.id ?? null;
    const stale = () => {
      if (!active) return true;
      if (getToken() === checkedToken && (getUser()?.id ?? null) === checkedActor) return false;
      if (!getToken()) redirectToLogin();
      else recheck(verification + 1);
      return true;
    };
    queryClient.clear();
    setGate({ kind: 'checking' });
    fetchCurrentUser()
      .then(({ user }) => {
        if (stale()) return;
        if (canAccessAdmin(user.role)) {
          verified.current = { token: checkedToken, user };
          sessionGuard.current = installAdminSessionGuard(
            { token: checkedToken, actorId: user.id },
            () => {
              setPaused(true);
              void queryClient.cancelQueries();
            },
          );
        }
        setSession(checkedToken, user);
        setGate({ kind: canAccessAdmin(user.role) ? 'authorized' : 'denied' });
      })
      .catch((error: unknown) => {
        if (stale()) return;
        if (isInvalidSessionPreflight(error)) {
          redirectToLogin();
          return;
        }
        const message = error instanceof Error ? error.message : 'Unable to verify your session.';
        setGate({ kind: 'error', message });
      });

    return () => {
      active = false;
    };
  }, [ready, verification, queryClient, redirectToLogin]);

  if (!ready || gate.kind === 'checking') {
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

  if (gate.kind === 'denied') {
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

  if (gate.kind === 'error') {
    return (
      <main className="flex min-h-screen items-center justify-center px-4">
        <div className="max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
          <h1 className="font-display text-xl font-semibold text-ink">Session check failed</h1>
          <p className="mt-2 text-sm text-ink-soft">{gate.message}</p>
          <button
            type="button"
            onClick={() => {
              const destination = gate.retryLogout;
              if (destination) finishSession(destination);
              else window.location.reload();
            }}
            className="mt-6 inline-flex rounded-lg bg-brand-700 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-800"
          >
            {gate.retryLogout ? 'Try signing out again' : 'Try again'}
          </button>
        </div>
      </main>
    );
  }

  async function reconnect() {
    const original = verified.current;
    const token = getToken();
    if (!original || !token || getUser()?.id !== original.user.id)
      throw Error('Sign in with the original account, then try again.');
    const { user } = await fetchCurrentUser();
    const unchanged = () => getToken() === token && getUser()?.id === original.user.id;
    if (
      !unchanged() ||
      user.id !== original.user.id ||
      user.role !== original.user.role ||
      !canAccessAdmin(user.role)
    )
      throw Error(
        'The original account and permissions could not be confirmed. Keep this page open or download your edits.',
      );
    verified.current = { token, user };
    setSession(token, user);
    await reconnectAdminForms();
    if (!unchanged()) throw Error('Your account changed during verification. Try again.');
    sessionGuard.current?.resume({ token, actorId: user.id });
    setPaused(false);
    void queryClient.invalidateQueries();
  }

  return (
    <QueryClientProvider client={queryClient}>
      <DashboardShell
        verifiedUser={verified.current?.user}
        onLogout={() => {
          finishSession('site');
        }}
      />
      {paused && (
        <AdminSessionRecovery reconnect={reconnect} leave={() => finishSession('login')} />
      )}
    </QueryClientProvider>
  );
}
