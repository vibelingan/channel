import { setRegistered } from './session.ts';

interface Props {
  registered: boolean;
}

/**
 * Demo-only control to simulate a registered (signed-in) user so VIP pricing
 * and price inquiry can be previewed without real customer auth. Remove this
 * once customer authentication is wired up.
 */
export function RegisteredToggle({ registered }: Props) {
  return (
    <button
      type="button"
      onClick={() => setRegistered(!registered)}
      title="Demo: simulate a signed-in user"
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition ${
        registered
          ? 'border-accent-300 bg-accent-50 text-accent-700'
          : 'border-slate-300 bg-white text-ink-muted hover:border-slate-400'
      }`}
    >
      <span
        className={`inline-block h-2 w-2 rounded-full ${
          registered ? 'bg-accent-500' : 'bg-slate-400'
        }`}
      />
      {registered ? 'Signed in (demo)' : 'View as guest'}
    </button>
  );
}
