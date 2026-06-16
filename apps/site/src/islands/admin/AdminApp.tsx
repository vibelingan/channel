import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { DashboardShell } from './DashboardShell.tsx';
import { LoginScreen } from './LoginScreen.tsx';
import { AdminApiError, clearToken, getToken } from './api.ts';

export function AdminApp() {
  const [authed, setAuthed] = useState(false);
  const [ready, setReady] = useState(false);

  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: false, refetchOnWindowFocus: false },
        },
      }),
    [],
  );

  // React to any UNAUTHORIZED error globally: drop back to the login screen.
  useEffect(() => {
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      const error = event.query.state.error;
      if (error instanceof AdminApiError && error.isUnauthorized) {
        clearToken();
        setAuthed(false);
      }
    });
    return unsubscribe;
  }, [queryClient]);

  useEffect(() => {
    setAuthed(Boolean(getToken()));
    setReady(true);
  }, []);

  if (!ready) return null;

  return (
    <QueryClientProvider client={queryClient}>
      {authed ? (
        <DashboardShell
          onLogout={() => {
            clearToken();
            queryClient.clear();
            setAuthed(false);
          }}
        />
      ) : (
        <LoginScreen onAuthed={() => setAuthed(true)} />
      )}
    </QueryClientProvider>
  );
}
