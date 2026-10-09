import {
  CONFIGURATION_PHOTO_LIMIT,
  type ConfigurationPhotos,
  type SupplierReview,
} from '@vibelingan-channel/shared/catalog-supplier-review';
import { useAdminImagePreviews } from './use-admin-image-previews.ts';

/**
 * Which gallery photos show each configuration (DEC-20): for listings whose
 * Alibaba data gives a colour no photo of its own, or to choose better ones.
 * Approval publishes the choices like any configuration photo.
 */
export function ConfigurationPhotosEditor({
  configurations,
  galleryIds,
  value,
  onChange,
}: {
  configurations: SupplierReview['configurations'];
  galleryIds: readonly string[];
  value: ConfigurationPhotos;
  onChange: (next: ConfigurationPhotos) => void;
}) {
  const previews = useAdminImagePreviews(galleryIds);
  if (configurations.length === 0) return null;
  // Only photos still in the gallery count; approval ignores the rest.
  const chosen = (configurationId: string) =>
    (value[configurationId] ?? []).filter((id) => galleryIds.includes(id));
  const toggle = (configurationId: string, imageId: string) => {
    const current = chosen(configurationId);
    const next = current.includes(imageId)
      ? current.filter((id) => id !== imageId)
      : [...current, imageId].slice(0, CONFIGURATION_PHOTO_LIMIT);
    onChange({ ...value, [configurationId]: next });
  };
  const chosenCount = configurations.filter((c) => chosen(c.id).length > 0).length;
  return (
    <details
      data-configuration-photos
      className="rounded-lg border border-slate-200 p-3 lg:col-span-2"
    >
      <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold text-slate-800">
        Photos for each configuration ({chosenCount} of {configurations.length} chosen)
      </summary>
      <p className="mt-2 text-sm text-slate-600">
        Choose which gallery photos show each configuration. Tapping such a photo on the product
        page selects the configuration. Without a choice, the configuration shows its Alibaba photo,
        if any.
      </p>
      <ul className="mt-3 space-y-3">
        {configurations.map((configuration) => (
          <li key={configuration.id} data-configuration={configuration.id}>
            <p className="text-sm font-medium text-slate-800">
              {configuration.label}
              {configuration.supplierImageIds && (
                <span className="ml-2 text-xs text-slate-500">Alibaba photo available</span>
              )}
            </p>
            <div className="mt-1 flex flex-wrap gap-2">
              {galleryIds.map((imageId, index) => {
                const pressed = chosen(configuration.id).includes(imageId);
                return (
                  <button
                    key={imageId}
                    type="button"
                    aria-pressed={pressed}
                    aria-label={`${configuration.label}: gallery photo ${index + 1}`}
                    onClick={() => toggle(configuration.id, imageId)}
                    className={`h-14 w-14 overflow-hidden rounded border-2 bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-600 ${pressed ? 'border-brand-600' : 'border-slate-200'}`}
                  >
                    {previews.urls[imageId] ? (
                      <img
                        src={previews.urls[imageId]}
                        alt=""
                        className="h-full w-full object-contain"
                      />
                    ) : (
                      <span className="text-xs text-slate-400">{index + 1}</span>
                    )}
                  </button>
                );
              })}
            </div>
          </li>
        ))}
      </ul>
    </details>
  );
}
