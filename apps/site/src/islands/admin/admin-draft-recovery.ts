import { useEffect, useRef } from 'react';

const forms = new Map<symbol, { label: () => string; read: () => unknown }>();
const reconnectors = new Set<() => Promise<void>>();

/** Private edits stay in memory. Export reads the current form, including pending async fields. */
export function useAdminDraftExport(label: string, read: () => unknown) {
  const latest = useRef({ label, read });
  latest.current = { label, read };
  useEffect(() => {
    const key = Symbol();
    forms.set(key, { label: () => latest.current.label, read: () => latest.current.read() });
    return () => {
      forms.delete(key);
    };
  }, []);
}
export function useAdminSessionReconnector(reconnect: () => Promise<void>) {
  const latest = useRef(reconnect);
  latest.current = reconnect;
  useEffect(() => {
    const run = () => latest.current();
    reconnectors.add(run);
    return () => {
      reconnectors.delete(run);
    };
  }, []);
}
export function readAdminDrafts() {
  return [...forms.values()].map((form) => ({ form: form.label(), values: form.read() }));
}
export async function reconnectAdminForms() {
  for (const reconnect of reconnectors) await reconnect();
}
