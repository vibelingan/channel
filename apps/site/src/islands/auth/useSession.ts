import { useEffect, useState } from 'react';
import {
  type SessionUser,
  canAccessAdmin,
  canSeeVipPricing,
  getUser,
  isLoggedIn,
  onAuthChange,
} from '../../lib/session.ts';

export interface SessionState {
  user: SessionUser | null;
  loggedIn: boolean;
  canSeeVip: boolean;
  isAdminUser: boolean;
  /** True once the initial localStorage read has happened (avoids SSR flash). */
  ready: boolean;
}

/** React hook exposing the current session, kept in sync across tabs/islands. */
export function useSession(): SessionState {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const sync = () => setUser(getUser());
    sync();
    setReady(true);
    return onAuthChange(sync);
  }, []);

  return {
    user,
    loggedIn: ready ? isLoggedIn() : false,
    canSeeVip: canSeeVipPricing(user?.role ?? ''),
    isAdminUser: canAccessAdmin(user?.role ?? ''),
    ready,
  };
}
