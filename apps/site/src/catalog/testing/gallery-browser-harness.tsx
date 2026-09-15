/** Test-only mount, loaded explicitly through local Vite; never imported by an app route. */
import { type ComponentProps, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Gallery } from '../../islands/shop/Gallery.tsx';
import { ProductMedia } from '../../islands/shop/ProductMedia.tsx';

export function mountGalleryHarness(container: HTMLElement) {
  const root = createRoot(container);
  return {
    gallery: (props: ComponentProps<typeof Gallery>) => root.render(createElement(Gallery, props)),
    media: (props: ComponentProps<typeof ProductMedia>) =>
      root.render(createElement(ProductMedia, props)),
    unmount: () => root.unmount(),
  };
}
