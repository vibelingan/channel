import { useEffect, useState } from 'react';
import { SessionApiError, resetPassword } from '../../lib/session.ts';

const inputClass =
  'mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-ink shadow-sm outline-none transition focus:border-brand-600 focus:ring-2 focus:ring-brand-600/20';

/** Consume a single-use reset token (from `?token=`) and set a new password. */
export function ResetForm() {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    // The reset token arrives in the query string of the emailed link.
    setToken(new URLSearchParams(window.location.search).get('token') ?? '');
  }, []);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }
    const newPassword = String(new FormData(form).get('newPassword'));
    setBusy(true);
    setError('');
    try {
      await resetPassword(token, newPassword);
      setDone(true);
    } catch (err) {
      setError(err instanceof SessionApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="w-full">
        <h1 className="font-display text-2xl font-bold text-ink">Password reset</h1>
        <p className="mt-4 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
          Your password has been reset. You can now sign in with your new password.
        </p>
        <a
          href="/login"
          className="mt-6 block w-full rounded-lg bg-brand-700 px-4 py-2.5 text-center text-sm font-semibold text-white transition hover:bg-brand-800"
        >
          Go to sign in
        </a>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="w-full">
      <h1 className="font-display text-2xl font-bold text-ink">Choose a new password</h1>

      {!token && (
        <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
          This reset link is missing its token. Request a new link from the sign-in page.
        </p>
      )}
      {error && (
        <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <div className="mt-6">
        <label htmlFor="newPassword" className="block text-sm font-medium text-ink">
          New password
        </label>
        <input
          id="newPassword"
          name="newPassword"
          type="password"
          autoComplete="new-password"
          required
          minLength={6}
          className={inputClass}
        />
      </div>

      <button
        type="submit"
        disabled={busy || !token}
        className="mt-6 w-full rounded-lg bg-brand-700 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-800 disabled:opacity-60"
      >
        {busy ? 'Please wait…' : 'Reset password'}
      </button>

      <div className="mt-5 text-center text-sm text-ink-soft">
        <a href="/login" className="font-medium text-brand-600 hover:text-brand-700">
          ← Back to sign in
        </a>
      </div>
    </form>
  );
}
