import type { CollectionDoc } from '@vibelingan-channel/shared';
import { useEffect, useRef, useState } from 'react';
import { getRecord } from '../api.ts';
import { prepareAlibabaPhotos, syncProduct } from './alibaba-api.ts';

export function AlibabaProductRefresh({
  product,
  onRefreshed,
}: { product: CollectionDoc; onRefreshed: (product: CollectionDoc) => void }) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const running = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  if (
    product.published === true ||
    product.archived === true ||
    typeof product.alibabaSourceProductId !== 'string' ||
    !product.alibabaSourceProductId
  )
    return null;
  const refresh = async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setNotice('Refreshing this product from Alibaba…');
    try {
      const result = await syncProduct(String(product.alibabaSourceProductId));
      if (result.productId !== product._id)
        throw Error(
          'The source linked to a different product. Open Products and review the source link.',
        );
      await prepareAlibabaPhotos(undefined, { productId: product._id, retryUnavailable: true });
      const next = await getRecord('products', product._id);
      if (mounted.current) {
        onRefreshed(next);
        setNotice(
          'Refreshed from Alibaba. Website categories and manual edits were kept. Review the product and any unavailable photos before publishing.',
        );
      }
    } catch (error) {
      if (mounted.current)
        setNotice(
          error instanceof Error
            ? error.message
            : 'The refresh could not be confirmed. Close and reopen the product to check its current state.',
        );
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <div className="mr-auto max-w-xl space-y-1">
      <button
        type="button"
        disabled={busy}
        onClick={() => void refresh()}
        className="min-h-11 rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 disabled:opacity-50"
      >
        {busy ? 'Refreshing…' : 'Refresh from Alibaba'}
      </button>
      {notice && <output className="block text-sm text-slate-600">{notice}</output>}
    </div>
  );
}
