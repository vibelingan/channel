import { useState } from 'react';
import { readAdminDrafts } from './admin-draft-recovery.ts';
import { useModalDialog } from './use-modal-dialog.ts';

/** A second native modal protects existing dialogs without unmounting their private state. */
export function AdminSessionRecovery({
  reconnect,
  leave,
}: {
  reconnect: () => Promise<void>;
  leave: () => void;
}) {
  const dialog = useModalDialog();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [downloaded, setDownloaded] = useState<string>();
  function download() {
    try {
      const payload = JSON.stringify(readAdminDrafts(), null, 2);
      const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
      const link = document.createElement('a');
      try {
        link.href = url;
        link.download = 'admin-edits.json';
        document.body.appendChild(link);
        link.click();
        setDownloaded(payload);
      } finally {
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch {
      setError('Your edits could not be downloaded. Keep this page open and try again.');
    }
  }
  return (
    <dialog
      ref={dialog}
      aria-labelledby="admin-reconnect-title"
      onCancel={(event) => event.preventDefault()}
      className="m-auto max-h-[90dvh] w-[calc(100%-2rem)] max-w-lg overflow-auto rounded-2xl bg-white p-6 text-ink shadow-xl backdrop:bg-black/40"
    >
      <h2 id="admin-reconnect-title" className="font-display text-xl font-semibold">
        Reconnect your account
      </h2>
      <p className="mt-3 text-sm">
        Your session needs verification. Your open forms and edits are still here. Requests are
        paused.
      </p>
      <p className="mt-2 text-sm">
        Sign in with the original account in another tab, then return here to reconnect.
      </p>
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {error}
        </p>
      )}
      <div className="mt-4 flex flex-wrap gap-3">
        <a
          href="/login?returnTo=/admin"
          target="_blank"
          rel="noopener noreferrer"
          className="min-h-11 rounded-lg border px-3 py-2"
        >
          Sign in in another tab
        </a>
        <button
          type="button"
          disabled={busy}
          className="min-h-11 rounded-lg bg-brand-700 px-3 py-2 text-white disabled:opacity-50"
          onClick={() => {
            if (busy) return;
            setBusy(true);
            setError('');
            void reconnect()
              .catch((cause: unknown) =>
                setError(
                  cause instanceof Error
                    ? cause.message
                    : 'This account could not be verified. Try again.',
                ),
              )
              .finally(() => setBusy(false));
          }}
        >
          {busy ? 'Verifying account...' : 'Verify original account'}
        </button>
        <button type="button" className="min-h-11 rounded-lg border px-3 py-2" onClick={download}>
          Download current edits
        </button>
        <button
          type="button"
          disabled={busy}
          className="min-h-11 rounded-lg border px-3 py-2 disabled:opacity-50"
          onClick={() => {
            if (
              readAdminDrafts().length &&
              downloaded !== JSON.stringify(readAdminDrafts(), null, 2)
            ) {
              setError('Download your current edits before leaving this workspace.');
              return;
            }
            leave();
          }}
        >
          Leave this workspace
        </button>
      </div>
    </dialog>
  );
}
