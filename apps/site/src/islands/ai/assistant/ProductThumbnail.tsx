import { useState } from 'react';
/** Public API images may be withdrawn while a conversation remains open. */
export function ProductThumbnail({ url }: { url?: string }) {
  const [failedUrl, setFailedUrl] = useState<string>();
  return (
    <div
      className="flex h-20 items-center justify-center bg-brand-50 text-brand-900"
      aria-hidden="true"
    >
      {url && failedUrl !== url ? (
        <img
          src={url}
          alt=""
          loading="lazy"
          className="h-full w-full object-contain"
          onError={() => setFailedUrl(url)}
        />
      ) : (
        <svg
          role="presentation"
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="h-10 w-10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
        >
          <path d="m12 3 9 5-9 5-9-5 9-5Zm-9 5v10l9 4 9-4V8M12 13v9" />
        </svg>
      )}
    </div>
  );
}
