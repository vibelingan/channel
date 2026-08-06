# Third-Party Contract Probe

> Rule 22 evidence for architecture dependencies. Probed 2026-07-28. No package was installed into the workspace.

## Probe Table

| Surface | Installed / inspected version | Documentation evidence | Package/source evidence | Result |
|---|---|---|---|---|
| Astro framework component default rendering | `astro@6.4.6` (lockfile) | Context7 `/withastro/docs`: framework components render static HTML/CSS by default. | Published `dist/runtime/server/render/component.js` renders when `metadata.hydrate !== "only"`. | Verified |
| Astro `client:load` | `astro@6.4.6` | Context7 official docs: static/server markup is hydrated immediately on page load. | Published `dist/runtime/client/load.js` exists; server renderer does not take the `only` branch. | Verified |
| Astro `client:only="react"` | `astro@6.4.6` | Context7 official directives: skips server-side/build rendering. | Published server renderer has the explicit `metadata.hydrate === "only"` path. | Verified |
| Astro React integration | `@astrojs/react@5.0.7`, `react@19.2.7`, `react-dom@19.2.7` (lockfile) | Official Astro framework-component guidance. | Published integration peer ranges include React and React DOM `^19.0.0`. | Verified |
| Radix Select form props | Published `@radix-ui/react-select@2.3.7`; not installed | Official/Context7 Select docs expose controlled selection, keyboard/typeahead, focus management, `name`, `required` and `form`. | Published types declare `name?: string`, `required?: boolean`, `form?: string`. | Verified |
| Radix native form bridge | Published `2.3.7`; not installed | Official docs describe form compatibility. | Published runtime renders `SelectBubbleInput`: a visually hidden native `<select aria-hidden tabIndex={-1}>` with `required`, `name`, `form`, options, change bubbling and form reset sync. | Verified |
| Radix no-JavaScript fallback | Published `2.3.7`; not installed | No official contract promises a visible native fallback before hydration. | Runtime bridge is part of the React render and is visually hidden; it does not supply an independently visible pre-hydration control. | Not provided; architecture rejects Radix here |
| Customizable native select | Browser platform; no package | MDN documents `appearance: base-select`, `::picker(select)`, `:open`, `::picker-icon`, `::checkmark`, anchor positioning and classic-select progressive fallback. | Chrome/Edge 135+ support; Firefox has no stable support and Safari remains preview as of the probe date. | Use progressively; classic fallback is required |
| Headless UI Listbox | Published `@headlessui/react@2.2.10`; not installed | Official docs provide accessible React Listbox behavior and Tailwind styling; no visible no-JavaScript fallback/native-required contract was found. | React 19 peer support; minimal Listbox import measured 34.7KB gzip excluding React. | Reject for this control |
| React Aria Components Select | Published `react-aria-components@1.19.0`; not installed | Official docs provide hidden native select submission/autofill/mobile navigation and native/ARIA validation modes. | Minimal Select composition measured 55.1KB gzip excluding React; visible no-JavaScript fallback is not provided by React rendering. | Reject as disproportionate here |
| `@cloudbase/node-sdk@3.17.2` `getUploadMetadata` | Installed `3.17.2` (resolved via Node from `packages/media-storage`) | Context7 CloudBase storage docs: server mints a scoped upload credential; the SDK's own sender performs the transfer. | `types/index.d.ts:360-369` declares `IGetUploadMetadataResult = { data: { url, token, authorization, fileId, cosFileId, download_url } }`. **Wire effect** read from `dist/storage/index.js` `uploadFile()` body: `method: 'put'`, credential carried as HEADERS, no multipart form. | Verified — consumption reads `data.*` (not top-level) and clients PUT with headers |
| `wx-server-sdk@4.0.2` `database().collection().doc().get()` | Installed `4.0.2` | Official wx-server-sdk docs: `throwOnNotFound` governs missing-document behaviour. | Installed bundle `index.js` defaults `throwOnNotFound = true` and honours a database-config override; adapter passes `{ throwOnNotFound: false }` so a missing doc RESOLVES `{ data: null }` instead of rejecting. | Verified — asserted by `scripts/verify-cloudbase-sdk-contract.mjs` |

## Commands And Sources

- Context7 library: `/withastro/docs`, official Astro documentation repository.
- Radix package inspection: `npm pack @radix-ui/react-select@2.3.7` in a temporary directory; inspected `dist/index.d.mts` and `dist/index.mjs`; directory deleted after inspection.
- Candidate bundle probe: exact package versions bundled through esbuild with React/React DOM external. Gzip results: Radix Select 31.4KB; Headless UI Listbox 34.7KB; React Aria Select composition 55.1KB; Headless native Select wrapper 9.0KB. These understate cost on static pages because React hydration/runtime is additional.
- MDN platform probe: customizable select documentation and compatibility tables, last reviewed 2026-07-28.
- Astro package inspection: `npm pack astro@6.4.6` and `npm pack @astrojs/react@5.0.7` in a temporary directory; inspected published runtime/package metadata; directory deleted after inspection.
- Workspace versions were read from `pnpm-lock.yaml`, not inferred from manifest ranges.

## Architecture Consequence

Astro `client:load` is safe for the Headphones shell because browser-only session and network access run in effects. Radix, Headless UI, and React Aria are technically viable React options, but each would introduce hydration to otherwise-static form consumers and none supplies the required visible pre-hydration control by itself. The current delivery therefore uses a progressively customizable native select and adds no dependency. This preserves no-JavaScript control visibility, not no-JavaScript submission of the existing JSON/upload form.

## Re-Probe History

- **2026-08-06 — CloudBase SDK majors.** The 2026-08-05 upgrade (`wx-server-sdk` 3.0.4 -> 4.0.2,
  `@cloudbase/node-sdk` 2.10.0 -> 3.17.2) matched this document's own Re-Probe Trigger and was
  NOT re-probed at the time. The consequence was a production upload outage: node-sdk 3.x signs
  and sends the object with `PUT` + credential headers, where 2.10.0 built a multipart `POST`
  with credential form fields, while `getUploadMetadata`'s signature and return shape stayed
  byte-identical — so types and unit tests were structurally blind to the change. The rows above
  now record the WIRE EFFECT (verb, credential placement, body encoding) read out of the SDK's
  own sender body, not just the declared shape, because the declared shape is exactly what did
  not move.

## Re-Probe Trigger

Re-run this probe if any of the following change:

- `wx-server-sdk` or `@cloudbase/node-sdk` version change (ANY segment) — re-read the sender
  body, not only the declared types; a protocol change leaves the type surface untouched
- Astro or `@astrojs/react` major/minor version
- React major version
- Product Category requires pixel-identical custom popup rendering
- Radix Select is proposed as a shared site dependency