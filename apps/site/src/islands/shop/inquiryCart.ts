/**
 * Batch inquiry cart — lets customers collect multiple overstock items and
 * request a single combined quote. Persists in localStorage and broadcasts
 * changes via a custom event so every island stays in sync (same pattern as
 * the registration session).
 */
import { useCallback, useEffect, useState } from 'react';

export interface CartItem {
  id: string;
  name: string;
  image?: string;
  code?: string;
}

const KEY = 'channel.inquiryCart';
const EVENT = 'channel:inquiry-cart';

function read(): CartItem[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as CartItem[]) : [];
  } catch {
    return [];
  }
}

function write(items: CartItem[]): void {
  localStorage.setItem(KEY, JSON.stringify(items));
  window.dispatchEvent(new Event(EVENT));
}

export function useInquiryCart() {
  const [items, setItems] = useState<CartItem[]>([]);

  useEffect(() => {
    const sync = () => setItems(read());
    sync();
    window.addEventListener(EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const add = useCallback((item: CartItem) => {
    const current = read();
    if (current.some((i) => i.id === item.id)) return;
    write([...current, item]);
  }, []);

  const remove = useCallback((id: string) => {
    write(read().filter((i) => i.id !== id));
  }, []);

  const clear = useCallback(() => write([]), []);

  const has = useCallback((id: string) => items.some((i) => i.id === id), [items]);

  return { items, add, remove, clear, has };
}
