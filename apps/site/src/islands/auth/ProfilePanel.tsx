import { useState } from 'react';
import { SessionApiError, changePassword, updateProfile } from '../../lib/session.ts';
import { useSession } from './useSession.ts';

const inputClass =
  'mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-ink shadow-sm outline-none transition focus:border-brand-600 focus:ring-2 focus:ring-brand-600/20';

/** Account settings: edit username and change password. Guests are redirected. */
export function ProfilePanel() {
  const { user, loggedIn, ready } = useSession();
  const [profileMsg, setProfileMsg] = useState('');
  const [profileErr, setProfileErr] = useState('');
  const [pwMsg, setPwMsg] = useState('');
  const [pwErr, setPwErr] = useState('');
  const [busy, setBusy] = useState(false);

  if (ready && !loggedIn) {
    if (typeof window !== 'undefined') {
      window.location.href = '/login?returnTo=/account';
    }
    return null;
  }
  if (!ready || !user) return <div className="h-40 animate-pulse rounded-xl bg-slate-100" />;

  async function saveProfile(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setBusy(true);
    setProfileMsg('');
    setProfileErr('');
    try {
      await updateProfile(String(fd.get('username')));
      setProfileMsg('Profile updated.');
    } catch (err) {
      setProfileErr(err instanceof SessionApiError ? err.message : 'Update failed.');
    } finally {
      setBusy(false);
    }
  }

  async function savePassword(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    setBusy(true);
    setPwMsg('');
    setPwErr('');
    try {
      await changePassword(String(fd.get('currentPassword')), String(fd.get('newPassword')));
      setPwMsg('Password changed.');
      form.reset();
    } catch (err) {
      setPwErr(err instanceof SessionApiError ? err.message : 'Change failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-8">
      <header>
        <h1 className="font-display text-2xl font-bold text-ink">Account settings</h1>
        <p className="mt-1 text-sm text-ink-muted">
          {user.email}
          {user.role && (
            <span className="ml-2 inline-flex rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-semibold capitalize text-brand-700">
              {user.role}
            </span>
          )}
        </p>
      </header>

      {/* Profile */}
      <form
        onSubmit={saveProfile}
        className="rounded-[var(--radius-card)] border border-slate-200 bg-white p-6 shadow-sm"
      >
        <h2 className="font-display text-lg font-semibold text-ink">Profile</h2>
        {profileMsg && <p className="mt-3 text-sm text-green-700">{profileMsg}</p>}
        {profileErr && <p className="mt-3 text-sm text-red-600">{profileErr}</p>}
        <div className="mt-4 max-w-sm">
          <label htmlFor="username" className="block text-sm font-medium text-ink">
            Username
          </label>
          <input
            id="username"
            name="username"
            type="text"
            defaultValue={user.username}
            minLength={2}
            required
            className={inputClass}
          />
        </div>
        <button
          type="submit"
          disabled={busy}
          className="mt-5 rounded-lg bg-brand-700 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-800 disabled:opacity-60"
        >
          Save profile
        </button>
      </form>

      {/* Password */}
      <form
        onSubmit={savePassword}
        className="rounded-[var(--radius-card)] border border-slate-200 bg-white p-6 shadow-sm"
      >
        <h2 className="font-display text-lg font-semibold text-ink">Change password</h2>
        {pwMsg && <p className="mt-3 text-sm text-green-700">{pwMsg}</p>}
        {pwErr && <p className="mt-3 text-sm text-red-600">{pwErr}</p>}
        <div className="mt-4 grid max-w-sm gap-4">
          <div>
            <label htmlFor="currentPassword" className="block text-sm font-medium text-ink">
              Current password
            </label>
            <input
              id="currentPassword"
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              required
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="newPassword" className="block text-sm font-medium text-ink">
              New password
            </label>
            <input
              id="newPassword"
              name="newPassword"
              type="password"
              autoComplete="new-password"
              minLength={6}
              required
              className={inputClass}
            />
          </div>
        </div>
        <button
          type="submit"
          disabled={busy}
          className="mt-5 rounded-lg bg-brand-700 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-800 disabled:opacity-60"
        >
          Change password
        </button>
      </form>
    </div>
  );
}
