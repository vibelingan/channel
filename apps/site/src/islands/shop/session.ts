/**
 * Lightweight client-side "registered user" session.
 *
 * VIP pricing and price inquiry are gated on this. Today it simply reads a flag
 * from localStorage; when real customer auth lands, swap the implementation here
 * (e.g. validate a JWT) without touching the components that use the hook.
 */
import { useEffect, useState } from 'react';

const KEY = 'channel.userRegistered';

function read(): boolean {
  if (typeof localStorage === 'undefined') return false;
  return localStorage.getItem(KEY) === '1';
}

export function setRegistered(value: boolean): void {
  if (typeof localStorage === 'undefined') return;
  if (value) localStorage.setItem(KEY, '1');
  else localStorage.removeItem(KEY);
  window.dispatchEvent(new Event('channel:auth'));
}

/** React hook returning whether the visitor is a registered (signed-in) user. */
export function useRegistered(): boolean {
  const [registered, setRegisteredState] = useState(false);

  useEffect(() => {
    const sync = () => setRegisteredState(read());
    sync();
    window.addEventListener('channel:auth', sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener('channel:auth', sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  return registered;
}
