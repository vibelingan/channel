import { type ComponentProps, createElement } from 'react';
import { flushSync } from 'react-dom';
import { type Root, createRoot } from 'react-dom/client';
import { Gallery } from '../../islands/shop/Gallery.tsx';
import {
  CatalogVariantGallery,
  type CatalogVariantGalleryProps,
} from '../presentation/CatalogVariantGallery.tsx';
import '../../styles/global.css';

let root: Root | undefined;

function galleryRoot(): Root {
  const container = document.getElementById('gallery-test-root');
  if (!container) throw new Error('Missing gallery test root');
  root ??= createRoot(container);
  return root;
}

export function renderVariant(props: CatalogVariantGalleryProps): void {
  const target = galleryRoot();
  flushSync(() =>
    target.render(
      <div className="mx-auto grid min-w-0 max-w-6xl gap-6 px-4 lg:grid-cols-2">
        <div className="min-w-0">
          <CatalogVariantGallery {...props} />
        </div>
        <output data-gallery-selected-id>
          {props.selection.status === 'selected'
            ? props.selection.variant.id
            : props.selection.status}
        </output>
      </div>,
    ),
  );
}

export function renderLegacy(props: ComponentProps<typeof Gallery>): void {
  const target = galleryRoot();
  flushSync(() => target.render(createElement(Gallery, props)));
}
