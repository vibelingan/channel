# Policy And Transport

## Decision Rule

Choose upload transport in this order:

1. Purpose: what business object is this file for?
2. Type: which MIME/extension classes are valid for that purpose?
3. Size: is the selected transport allowed for this byte range?
4. Security: which actor can upload, finalize, read, publish, or delete it?

Size alone must not choose base64. A 20 KB catalog photo is still a catalog
image and should follow the same storage lifecycle as a 5 MiB catalog photo. A
ZIP/PDF/CAD OEM attachment is not an image workaround; it is a private business
file and should not be tunneled through JSON.

## Common Classes

| Purpose | Valid examples | Default transport | Notes |
| --- | --- | --- | --- |
| `catalog-image` | jpeg, png, webp source image | Storage direct upload | Public only after linked/published. Keep one metadata lifecycle for all new catalog writes. |
| `catalog-thumbnail` | generated jpeg/png/webp variant | Storage generated path | Derived from source; do not introduce a separate base64 path unless it is legacy read-only. |
| `oem-drawing` | pdf, zip, rar, cad, drawing image | Storage direct upload | Private admin-only lifecycle. Large/scanned/resumable path can move to CloudRun or another media gateway later. |
| `marketing-media` | image/video approved for site use | Storage or static hosting | Needs its own publishing/cache policy. |
| `inline-small` | svg icon, swatch, tiny admin fixture | Static asset or explicit base64 | Only through a named action and small raw-byte cap, commonly 20-50 KiB. |
| `legacy-migration` | old DB base64 record | Read-only or migration job | Keep compatibility while moving durable objects to storage. |

## Transport Options

Direct-to-storage:

- Server validates metadata and actor, chooses the storage path, and mints a
  short-lived upload credential.
- Browser sends bytes directly to object storage.
- Server finalizes by verifying the uploaded object and activating metadata.
- Best for product images, OEM files, and anything that exceeds small JSON
  limits.

Server upload:

- Browser sends multipart bytes to an app server or function route.
- Use only when the app route and runtime can safely carry the target size.
- Useful when the server must transform or scan bytes synchronously, but often
  conflicts with serverless request limits.

Inline/base64:

- Only for explicit tiny inline assets or legacy compatibility.
- Validate raw bytes, MIME, and purpose server-side.
- Do not expose generic CRUD paths that can write arbitrary `data` fields.

Media gateway:

- Use a container or dedicated service for larger files, resumable uploads,
  antivirus scanning, conversion, previews, or long-running transformations.
- Keep the same metadata lifecycle and finalization semantics.

## Required Rejections

Reject or redesign when any of these appear:

- Product/OEM bytes go through JSON/base64 because the file is currently small.
- Browser fabricates storage URLs or durable object keys.
- New writes store temporary download URLs in the database.
- One upload action accepts every purpose and type with ad hoc branching.
- The selected route has not been checked against deployed body limits.
