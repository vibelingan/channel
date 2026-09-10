import { useEffect, useState } from 'react';
import { getImagePreview } from './api.ts';

/** One fetch per distinct image in a preview generation; blobs never enter durable/query state. */
export function useAdminImagePreviews(ids: readonly string[]) {
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify({ attempt, ids: [...new Set(ids)] });
  const [resolved, setResolved] = useState<{
    key: string;
    urls: Record<string, string>;
    failed: number;
  }>({
    key: '',
    urls: {},
    failed: 0,
  });
  useEffect(() => {
    let cancelled = false;
    const urls: Record<string, string> = {};
    const pending: string[] = JSON.parse(key).ids;
    let failed = 0;
    // Bounded concurrency: avoid opening 27 simultaneous authenticated requests.
    const worker = async () => {
      while (!cancelled && pending.length) {
        const id = pending.shift();
        if (!id) continue;
        try {
          const data = await getImagePreview(id);
          const blob = await (await fetch(data)).blob();
          if (cancelled) return;
          urls[id] = URL.createObjectURL(blob);
          setResolved({ key, urls: { ...urls }, failed });
        } catch {
          if (!cancelled) setResolved({ key, urls: { ...urls }, failed: ++failed });
        }
      }
    };
    for (let i = 0; i < 3; i++) void worker();
    return () => {
      cancelled = true;
      for (const url of Object.values(urls)) URL.revokeObjectURL(url);
    };
  }, [key]);
  return {
    urls: resolved.key === key ? resolved.urls : {},
    failed: resolved.key === key ? resolved.failed : 0,
    retry: () => {
      setResolved({ key: '', urls: {}, failed: 0 });
      setAttempt((n) => n + 1);
    },
  };
}
