import { useState } from 'react';
import { SessionApiError, login, postLoginPath, recover, register } from '../../lib/session.ts';

type Mode = 'login' | 'register';

interface Props {
  mode: Mode;
  returnTo?: string;
}

const inputClass =
  'mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-ink shadow-sm outline-none transition focus:border-brand-600 focus:ring-2 focus:ring-brand-600/20';

/** Strava-style auth form: sign in, register, and inline password recovery. */
export function AuthForm({ mode, returnTo }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [forgot, setForgot] = useState(false);
  const [notice, setNotice] = useState('');

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }
    const fd = new FormData(form);
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (forgot) {
        const message = await recover(String(fd.get('email')));
        setNotice(message);
        setForgot(false);
      } else if (mode === 'register') {
        const user = await register(
          String(fd.get('username')),
          String(fd.get('email')),
          String(fd.get('password')),
        );
        window.location.href = postLoginPath(user, returnTo);
      } else {
        const user = await login(String(fd.get('email')), String(fd.get('password')));
        window.location.href = postLoginPath(user, returnTo);
      }
    } catch (err) {
      setError(err instanceof SessionApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  const title = forgot
    ? 'Reset your password'
    : mode === 'register'
      ? 'Create your account'
      : 'Sign in';
  const cta = forgot ? 'Send reset link' : mode === 'register' ? 'Create account' : 'Sign in';

  return (
    <form onSubmit={handleSubmit} noValidate className="w-full">
      <h1 className="font-display text-2xl font-bold text-ink">{title}</h1>

      {notice && (
        <p className="mt-4 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
          {notice}
        </p>
      )}
      {error && (
        <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <div className="mt-6 space-y-4">
        {mode === 'register' && !forgot && (
          <div>
            <label htmlFor="username" className="block text-sm font-medium text-ink">
              Username
            </label>
            <input
              id="username"
              name="username"
              type="text"
              autoComplete="username"
              required
              minLength={2}
              className={inputClass}
            />
          </div>
        )}

        <div>
          <label htmlFor="email" className="block text-sm font-medium text-ink">
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            className={inputClass}
          />
        </div>

        {!forgot && (
          <div>
            <div className="flex items-center justify-between">
              <label htmlFor="password" className="block text-sm font-medium text-ink">
                Password
              </label>
              {mode === 'login' && (
                <button
                  type="button"
                  onClick={() => {
                    setForgot(true);
                    setError('');
                    setNotice('');
                  }}
                  className="text-xs font-medium text-brand-600 hover:text-brand-700"
                >
                  Forgot password?
                </button>
              )}
            </div>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              required
              minLength={mode === 'register' ? 6 : 1}
              className={inputClass}
            />
          </div>
        )}
      </div>

      <button
        type="submit"
        disabled={busy}
        className="mt-6 w-full rounded-lg bg-brand-700 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-800 disabled:opacity-60"
      >
        {busy ? 'Please wait…' : cta}
      </button>

      <div className="mt-5 text-center text-sm text-ink-soft">
        {forgot ? (
          <button
            type="button"
            onClick={() => setForgot(false)}
            className="font-medium text-brand-600 hover:text-brand-700"
          >
            ← Back to sign in
          </button>
        ) : mode === 'login' ? (
          <>
            New here?{' '}
            <a href="/register" className="font-semibold text-brand-600 hover:text-brand-700">
              Create an account
            </a>
          </>
        ) : (
          <>
            Already have an account?{' '}
            <a href="/login" className="font-semibold text-brand-600 hover:text-brand-700">
              Sign in
            </a>
          </>
        )}
      </div>
    </form>
  );
}
