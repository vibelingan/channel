# Dianxiaomi import + Catalog UI technology choices

Date: 2026-09-02  
Status: approved design gate; dependency installation and implementation have not started

## 0. Decision

Keep Astro as the route/page and island boundary. Do not introduce a second application framework or a new site-wide data layer.

Use mature libraries for generic infrastructure, and keep custom code only where it expresses Channel's domain:

| Capability | Decision | Scope |
| --- | --- | --- |
| XLSX parsing | Keep the approved SheetJS `xlsx@0.20.3` wrapper and import safety gate | `@vibelingan-channel/catalog-import` only |
| Supplier HTML sanitization | Replace the hand-written tokenizer/sanitizer with `sanitize-html` behind one narrow wrapper | server/import package only |
| HTML-to-text projection | Use `html-to-text`, compiled once with explicit input/depth/node limits | server/import package only |
| RFQ field/form state | Use `react-hook-form` with `@hookform/resolvers/zod` and the shared strict Zod contract | Catalog quote island only |
| Admin remote state | Reuse the existing `@tanstack/react-query` provider | Admin import island only |
| Admin review table | Reuse existing `@tanstack/react-table` | Admin import review only |
| Dialog / bottom sheet | Wrap native `<dialog>`/`showModal()`; no headless UI dependency | shared Catalog presentation module |
| Accordion | Use native `<details><summary>`; no animated-height state machine | specifications and SKU disclosure |
| Variant selection/media semantics | Keep custom pure modules | Channel catalog domain |

This adds no Router, global store, state-machine framework, component system, carousel or upload framework.

## 1. Evidence from the existing codebase

### Reuse instead of replacement

- `AdminApp.tsx` already provides one `QueryClientProvider`; `CollectionView.tsx` already uses queries, mutations and invalidation.
- `CollectionView.tsx` already uses TanStack Table for manual server pagination/sorting and row selection.
- `CertificateGallery.astro` and `RecordForm.tsx` already use native `<dialog>`; `SiteHeader.astro` already uses native `<details><summary>`.
- the shared `Select` is an established, tested module with a native pre-hydration fallback. This feature reuses it for category mapping and does not copy or replace it.
- the public Catalog route is not currently inside a Query provider. Adding a public global provider only for product detail would be a new architecture and is rejected.

### Generic infrastructure that should not remain hand-written

The import branch's `packages/catalog-import/src/descriptions.ts` currently implements a complete HTML tag scanner, stack balancer, dropped-element traversal, entity decoder, sanitizer and text projector. The allowlist and placeholder policy are Channel decisions; parsing malformed/untrusted HTML is not. That parser is the primary correction from this gate.

The RFQ prototype also needs multi-step field registration, touched/dirty/error state, focus-to-error and cross-field validation. Those are generic form concerns and should not be duplicated in a component reducer.

## 2. Chosen library boundaries

### 2.1 `sanitize-html` + `html-to-text`

Target versions at this review: `sanitize-html@2.17.7`, `@types/sanitize-html@2.16.1`, `html-to-text@10.0.1`. Pin the versions selected by the implementation PR and commit the lockfile.

The repository requires Node `>=22.12.0`; both runtime packages support that range. `sanitize-html` is the security boundary. `html-to-text` receives only the already-sanitized output and is a formatting dependency, not a second sanitizer. Its maintainer explicitly describes it as a best-effort community project, so it must remain replaceable behind this interface. The sanitizer's TypeScript declarations are also community-maintained; their types must not leak into import contracts.

The package exports one deep interface; no caller imports either library:

```ts
export interface NormalizedSourceDescription {
  sanitizedHtml?: string; // private evidence only; never direct public rendering
  text?: string;
  placeholder: boolean;
  sanitized: boolean;
}

export function normalizeSourceDescription(
  raw: string | null | undefined,
): NormalizedSourceDescription;
```

Ownership split:

- `sanitize-html` owns tolerant HTML parsing, tag balancing, entity handling and allowlist enforcement;
- `html-to-text` owns structural plain-text projection for paragraphs, lists and tables;
- Channel code owns allowed tags/zero attributes, dropped non-text elements, filler recognition, hard input bounds, source-reference retention and conservative fact promotion;
- public UI renders approved text/structured blocks, never `dangerouslySetInnerHTML` on supplier data.

Configure the text converter once with explicit maximum input length, DOM depth/node count and selectors that skip scripts, styles, forms, links and images. Keep the current hostile/malformed HTML regression corpus and add result compatibility fixtures before deleting the tokenizer.

Official references: [sanitize-html in the maintained Apostrophe monorepo](https://github.com/apostrophecms/apostrophe/tree/main/packages/sanitize-html) and [html-to-text](https://github.com/html-to-text/node-html-to-text/tree/master/packages/html-to-text).

### 2.2 React Hook Form + Zod resolver

Target versions at this review: `react-hook-form@7.87.0` and `@hookform/resolvers@5.9.1`. Add a direct site dependency on the same Zod 3 line owned by `@vibelingan-channel/shared`; do not rely on Astro's transitive Zod 4 installation.

The selected React Hook Form version declares React 19 support. The resolver supports React Hook Form 7.55+ and Zod 3.25+/4; the current lock resolves shared Zod to 3.25.76, so the feature can use the shared contract without a schema-version bridge.

Boundary:

- React Hook Form owns field registration, touched/dirty state, synchronous error display and focus-to-first-error;
- the shared Zod schema owns input shape, bounds and quote/customization cross-field rules;
- `catalog-quote-state.ts` owns only intent, product/variant identity, current step, stable idempotency key, submit generation and durable receipt;
- React Query is not added to the public Catalog solely for quote submission. The existing narrow gateway/effect remains the network owner.

The resolver's official integration supports Zod-backed inferred input/output types: [React Hook Form resolvers](https://github.com/react-hook-form/resolvers).

### 2.3 Existing TanStack modules in Admin only

The Admin import workspace mounts below the existing `QueryClientProvider`.

- Query keys include job id, revision, cursor and filters.
- Job polling uses `refetchInterval`, returning `false` for terminal states.
- Mutations invalidate exact job/plan/item key families after server success.
- `catalog-import-workspace-state.ts` keeps only ephemeral UI selection, drawer state, upload transfer phase and the currently reviewed `jobId + revision + planDigest` identity.
- TanStack Table owns column, sort and row-selection mechanics; the API/query layer owns server paging/filtering.

This removes the proposed second hand-written remote-state reducer without changing the public Catalog architecture. Official references: [TanStack Query polling](https://tanstack.com/query/latest/docs/framework/react/guides/polling) and [query keys](https://tanstack.com/query/latest/docs/framework/react/guides/query-keys).

### 2.4 Native accessible primitives

Use a small `ModalDialog` presentation module around `HTMLDialogElement.showModal()`. The browser provides top-layer modality, outside-document inertness, Escape handling and focus management; Channel code owns labels, close/backdrop policy, mobile sheet styling and focus restoration tests. See [MDN `<dialog>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/dialog) and [`showModal()`](https://developer.mozilla.org/en-US/docs/Web/API/HTMLDialogElement/showModal).

Use `<details><summary>` for lower-priority specifications and all-SKU disclosure. Closed content is actually absent from layout/accessibility exposure, so the previous clipped-content “leak” cannot recur. See [MDN `<details>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/details) and [`<summary>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/summary).

## 3. Deliberately custom modules

These are business policy, not replaceable infrastructure:

- variant option matrix and deterministic selection of real SKUs;
- ambiguous image-to-variant handling and parent/variant media precedence;
- conservative field promotion, conflict quarantine and source provenance;
- category mapping, import revision/digest approval and idempotent apply semantics;
- quote intent, immutable server-derived product snapshot and idempotency boundary;
- strict public summary/detail projection and private/public media lifecycle.

The implementation may use library primitives internally, but no dependency may become the owner of those decisions.

## 4. Rejected additions

| Candidate | Why rejected for this workstream |
| --- | --- |
| Public/global TanStack Query provider | changes the refactor's explicit Catalog gateway/application-state architecture for one detail route |
| TanStack Router/Start or another SPA framework | duplicates Astro routing/island ownership and expands the migration surface |
| XState | introduces a second state model where a pure domain reducer plus existing Admin Query is sufficient |
| Radix/Headless UI | duplicates native dialog/disclosure patterns already in the repository for two primitives |
| Swiper/carousel | nine bounded images do not justify another interaction/runtime owner |
| Uppy/tus | the backend exposes signed single PUT, not a resumable upload protocol; a library cannot create absent server semantics |
| Axios | native `fetch` already meets gateway needs; use a tiny XHR transfer adapter only if byte progress is an approved requirement |
| DOMPurify + server DOM emulator | adds a DOM emulation runtime for an import-only Node path when a tolerant server HTML sanitizer is the direct fit |
| New select/combobox package | existing tested shared `Select` is already a refactor seam; replacing it is unrelated scope |

## 5. Dependency and release gates

Dependency installation is part of the relevant behavior MIU, not a free-standing “package update”:

1. pin exact resolved versions in `pnpm-lock.yaml`;
2. record licenses and supported Node/React/Zod ranges;
3. run `pnpm audit --prod` after the lockfile exists and manually review any transitive finding in the used runtime path;
4. retain hostile HTML tests and compare normalized outputs on the real customer workbook before replacing the old parser;
5. run site bundle output comparison; the two HTML packages must remain server/import-only and must not enter browser chunks;
6. confirm RFQ imports are isolated to its lazy/hydrated Catalog island and do not hydrate list-only pages;
7. run typecheck, unit tests, build and Chromium/WebKit accessibility/geometry E2E.

No dependency is approved merely because it is popular. A library is retained only if the locked implementation passes these gates and leaves one narrow replaceable interface.

## 6. Changes to the earlier MIU plan

- Add DXUI-00: replace the generic hand-written HTML parser while preserving Channel's current normalization contract and test corpus.
- DXUI-02 becomes purely the domain evidence extractor and depends on DXUI-00.
- DXUI-15 no longer owns field errors or field validation; React Hook Form + the shared Zod schema do.
- DXUI-16 installs/uses React Hook Form and renders through a native `<dialog>` module.
- DXUI-19 becomes Admin Query policy plus small local workspace state; it does not duplicate server cache, polling, mutation or stale-request control.
- DXUI-21 explicitly uses the existing TanStack Table module with server-side pagination/filtering.
- DXUI-10 uses native details/summary instead of a custom animated accordion.

## 7. Go/no-go conclusion

There is no technology-selection reason to postpone implementation after the refactor ownership gates are satisfied. The corrected plan is intentionally conservative: three runtime packages are added (`sanitize-html`, `html-to-text`, `react-hook-form`) plus the Zod resolver and sanitizer types; existing TanStack and browser primitives cover the rest.

The strongest surviving risk is dependency duplication: `sanitize-html` and `html-to-text` currently depend on different `htmlparser2` major lines. This is acceptable only because the packages are server/import-only and small relative to the workbook pipeline; DXUI-00 must record installed size, cold import time and real-workbook runtime. If that measured cost is disproportionate, keep `sanitize-html` and replace only the text conversion with a direct parser-backed adapter—do not restore a string-scanning HTML parser.
