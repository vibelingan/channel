import { useState } from 'react';
import { getOemFileDownloadUrl } from './api.ts';

/**
 * Admin OEM-drawing download (MIU-08 §20.10 step 3).
 *
 * Production has no public `/api/files/:id` route — OEM delivery is the
 * authenticated `getOemFileDownloadUrl` action, which mints a SHORT-lived temp
 * URL on demand. So this renders a button (not a static link): on click it fetches
 * a fresh URL (never persisted; it expires in ~60s) and opens it. Only a finalized
 * (`active`, storage-backed) OEM drawing resolves; legacy/base64 or non-active rows
 * fail closed with a clear inline message.
 */
export function FileDownloadLink({ id, name }: { id: unknown; name?: unknown }) {
  const fileId = id ? String(id) : '';
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  if (!fileId) {
    return <span className="text-slate-400">—</span>;
  }
  const label = name ? String(name) : 'Download file';

  async function download() {
    setError('');
    setLoading(true);
    try {
      const { url } = await getOemFileDownloadUrl(fileId);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Download failed.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <span className="inline-flex flex-col gap-0.5">
      <button
        type="button"
        onClick={download}
        disabled={loading}
        className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-700 hover:text-brand-900 disabled:opacity-60"
      >
        <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
          <path d="M10 2a1 1 0 0 1 1 1v8.59l2.3-2.3a1 1 0 1 1 1.4 1.42l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 1 1 1.4-1.42l2.3 2.3V3a1 1 0 0 1 1-1Z" />
          <path d="M4 15a1 1 0 0 1 1 1v1h10v-1a1 1 0 1 1 2 0v2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-2a1 1 0 0 1 1-1Z" />
        </svg>
        {loading ? 'Preparing…' : label}
      </button>
      {error && (
        <span className="text-xs text-red-600" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
