/**
 * Admin OEM-drawing download contract (MIU-08 §20.10 step 3).
 *
 * The authenticated `getOemFileDownloadUrl` action mints a short-TTL COS temp
 * URL. That URL is a RAW presigned link: it carries no `Content-Disposition`
 * header (CloudBase `getTempFileURL` cannot set one), so navigating to it
 * (`window.open`) would inline-render image/PDF drawings in a tab and drop the
 * real filename — and an async popup can be silently blocked. Instead we FETCH
 * the bytes and save them as a named attachment via an object-URL `<a download>`
 * (never popup-blocked). Any failure (non-OK response, CORS, network) rejects so
 * the caller surfaces it, rather than silently doing nothing.
 *
 * The orchestration is dependency-injected so the filename contract and the
 * failure path can be unit-tested without a DOM (see `oem-download.test.ts`).
 * Fetching the temp URL cross-origin requires the COS bucket to allow GET from
 * the site origin (bucket CORS / security-domain — an ops prerequisite, same as
 * the browser upload POST).
 */
import type { OemFileDownload } from './api.ts';

/** Injected seams for {@link downloadOemFile}. */
export interface OemDownloadDeps {
  /** Mint the short-TTL temp URL + download contract (filename, mime). */
  getDownloadUrl: (fileId: string) => Promise<OemFileDownload>;
  /** Fetch the temp URL's bytes; MUST reject on non-OK / CORS / network. */
  fetchBytes: (url: string) => Promise<Blob>;
  /** Force an attachment download of `blob` under `fileName`. */
  saveBlob: (blob: Blob, fileName: string) => void;
}

/** Safe filename when the contract omits one (never used for a valid finalized row). */
const FALLBACK_FILE_NAME = 'oem-drawing';

/**
 * Download a finalized OEM drawing using the RETURNED filename contract.
 *
 * Order matters: mint → fetch → save. If minting fails we never fetch; if the
 * fetch fails we never save. Failures propagate so the caller can surface them.
 */
export async function downloadOemFile(fileId: string, deps: OemDownloadDeps): Promise<void> {
  const { url, fileName } = await deps.getDownloadUrl(fileId);
  const blob = await deps.fetchBytes(url);
  deps.saveBlob(blob, fileName || FALLBACK_FILE_NAME);
}

/** Browser {@link OemDownloadDeps.fetchBytes}: reject on any non-OK/CORS/network error. */
export async function fetchBytes(url: string): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Download failed (${res.status})`);
  }
  return res.blob();
}

/** Browser {@link OemDownloadDeps.saveBlob}: object-URL `<a download>` attachment (not popup-blocked). */
export function saveBlob(blob: Blob, fileName: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoke on the next tick: an immediate revoke can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}

/** Default browser deps wired to the real API + DOM. */
export const browserOemDownloadDeps: Omit<OemDownloadDeps, 'getDownloadUrl'> = {
  fetchBytes,
  saveBlob,
};
