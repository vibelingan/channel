# Engineering Craft

Reusable implementation lessons that should survive beyond a single incident log.

## Private Media Preview Pattern

When previewing private or unpublished media in a browser:

- Keep durable media access behind an application route that performs auth and
  visibility checks before reading storage bytes.
- Do not expose raw storage/COS URLs in the DOM unless the design explicitly
  chooses a public or short-lived signed URL contract.
- For admin or authenticated previews, fetch the bytes through the app route,
  build a `Blob`, and render it with `URL.createObjectURL(blob)`.
- Treat `blob:<origin>/<uuid>` entries in browser DevTools as local browser
  object URLs, not extra CloudBase or COS network requests.
- Revoke object URLs with `URL.revokeObjectURL(url)` when the preview is replaced,
  removed, or the component unmounts.
- Keep public catalog delivery separate from admin preview delivery. Public
  routes should remain publish/ref-count gated; admin preview routes should be
  authenticated and should not weaken public visibility rules.

This pattern is preferred for private product images because it preserves the
storage privacy boundary while still giving the UI efficient image previews.
