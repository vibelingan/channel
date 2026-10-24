# Admin Table Modernization Options

Status: Proposed separate enhancement. This is not part of the Product Category and Headphones G3 scope unless explicitly combined later.

Last verified: 2026-07-29

## Decision

Keep `@tanstack/react-table` 8.21.3 as the table engine and replace only the admin presentation layer around it.

The first release should fix the current operator problem directly:

- cap normal rows at a 56px target and 64px hard acceptance limit;
- give every column an explicit content-aware width policy;
- clamp identity text to two lines and all other long text to one line;
- reveal complete values only when measured overflow exists;
- move row commands into one compact, accessible actions menu;
- put horizontal overflow inside the table region;
- keep the identity and actions columns visible while the center columns scroll.

Do not migrate to Ant Design, AG Grid, MUI X, React Data Grid, or React Aria Table to solve this issue. The existing engine already models the required state. An engine replacement would rewrite working sorting, filtering, pagination, selection, inline editing, mutations, and dynamic-column behavior while still requiring the same width and content rules.

Use the shadcn Data Table documentation as a composition reference, not as a package or a visual system. Its official guidance intentionally builds a project-specific table from TanStack Table because data tables differ in data source, sorting, filtering, and behavior.

## Observed Root Cause

The current failure is a rendering-policy failure in `apps/site/src/islands/admin/CollectionView.tsx`, not a missing-grid-capability failure:

- the table uses browser auto layout across a full-width dynamic column set;
- columns have no explicit `size`, `minSize`, or `maxSize` contract;
- generic cell content is allowed to wrap and increase row height;
- the outer table region clips overflow instead of owning horizontal scroll;
- row commands occupy one wide, non-wrapping action cell;
- the admin shell does not consistently give the table flex child `min-width: 0`.

The same file already has the correct TanStack row/column state and server behaviors. `apps/site/src/islands/admin/sections.ts` is the appropriate owner for admin-only presentation overrides. `packages/shared/src/collections.ts` must remain business/schema metadata because it also drives backend validation, forms, and filtering.

## Required Architecture

### Ownership

```text
CollectionDef (business/schema metadata)
          +
DashboardSection.table (admin presentation overrides)
          |
          v
tablePresentation resolver (type defaults + section overrides)
          |
          v
TanStack controlled table state
          |
          v
AdminDataTable (semantic HTML table + local UI primitives)
```

`CollectionView` should continue to own queries, mutations, pagination, filters, forms, and selection effects. `AdminDataTable` should own only table markup, sizing, pinning styles, cell presentation, and table-local controls. This introduces no API, database, CloudBase, or authorization change.

### Presentation Metadata

Add an optional admin-only table contract to `DashboardSection`, with per-field overrides for:

- semantic display kind: `identity`, `text`, `number`, `date`, `email`, `file`, `image`, `status`, or `control`;
- initial width, minimum width, and maximum width;
- one-line or two-line clamp;
- alignment;
- hideability and responsive priority;
- pinning eligibility.

Derive defaults from the existing field type. Do not infer money, percentage, identity, or priority from field-name substrings. Each section must explicitly name its one identity field and any specialized number formatter.

Recommended initial widths:

| Content kind | Initial width | Clamp/alignment |
|---|---:|---|
| Selection | 44px | fixed, centered |
| Image | 64px | fixed 40x40 media |
| Identity | 240px | two lines |
| Number | 112px | one line, right, tabular numerals |
| Date | 144px | one line |
| Status/select | 144px | fixed-height control, one line |
| Email/file | 220px | one line |
| Generic text | 160px | one line |
| Actions | 48px | fixed, centered |

These are starting values, not a universal schema. Section overrides should express real operator tasks, such as giving a product name more room than an internal ID.

### Layout And Row Policy

- Render a semantic `<table>` with fixed layout inside an `overflow-x-auto` region.
- Give the inner table surface a minimum width equal to TanStack's total column size and a visual width of at least 100%.
- Apply the resolved width to both headers and cells. Prefer table-level CSS variables so column sizes are calculated once.
- Use 8px vertical cell padding, 40px thumbnails, compact controls, and an approximately 18px line height.
- Target 56px rows. Long fixtures at supported viewports must never exceed 64px.
- Keep all cell branches bounded. A clamp on generic strings is insufficient if links, selects, image labels, or custom cells can still wrap.
- Pin the identity column on the left and actions on the right. Desktop may also pin selection; mobile should minimize pinned width.
- Give sticky cells opaque backgrounds, deliberate z-indexes, and a boundary shadow so scrolled content does not show through.
- Set `min-width: 0` on the admin shell's table content region. Horizontal scrolling belongs to the table, never the document.

### Cell Content Rules

- Identity: two-line clamp, full accessible text retained.
- Generic text: one-line ellipsis.
- Numbers: format with explicit `Intl.NumberFormat` options; right-align with tabular numerals.
- Email and file: retain the real link and visible focus treatment; ellipsize only the label.
- Date: one-line localized display with the complete value available to assistive technology.
- Image: fixed 40x40 geometry with `object-fit: cover`; use empty alt text when adjacent identity text names the same entity.
- Status/select: fixed-height, no-wrap controls with row-specific accessible labels.
- Selection: row-specific checkbox labels; the header checkbox must describe page selection behavior.
- Actions: one 40-44px icon trigger labelled `Actions for {identity}`, with text menu items for Preview, Edit, and Delete. Preserve the existing delete confirmation and restore focus to the trigger when the menu closes.

### Overflow Disclosure

Do not show a tooltip for every string and do not use character count as an overflow proxy.

An `OverflowTooltip` primitive should compare `scrollWidth` with `clientWidth` and `scrollHeight` with `clientHeight`, then re-measure after content, container, or column-size changes. Only an actually clipped value gets a tooltip and keyboard focus target. The full value remains in the DOM.

The accessible interaction contract is:

- opens on pointer hover and keyboard focus;
- trigger references `role="tooltip"` content through `aria-describedby`;
- focus remains on the trigger;
- Escape dismisses it;
- it does not contain interactive content.

The native `title` attribute may be a supplementary fallback, but it is not the sole full-value interaction because its timing, keyboard behavior, styling, and touch availability are browser-controlled.

### Overlay Primitive Decision

Use focused local wrappers around Radix Tooltip 1.2.16 and Dropdown Menu 2.1.24 if the implementation phase includes both overflow disclosure and a row-actions menu. Both are MIT licensed and declare React 19 support. They supply portal positioning, collision handling, managed focus, keyboard navigation, Escape handling, and focus restoration that should not be reimplemented inside the table.

This is a deliberate admin-only cost, not a free dependency: a clean tree-shaken probe measured the two packages together at approximately 34.2KB gzip excluding React and React DOM. Keep them behind the existing admin React island, expose only `OverflowTooltip` and `RowActionsMenu`, and verify the built admin chunk. Do not install a full shadcn component set.

If Phase 1 chooses not to add this dependency, it must keep the current action buttons and use no custom tooltip; a native `title`-only release is not equivalent to the accessibility contract above. Dependency-free custom menu/tooltip behavior should not be improvised as part of the row-height fix.

## Candidate Comparison

Scores are 1-5. Weighted total uses architecture fit 30%, required capability 25%, accessibility/control 15%, bundle/style fit 15%, license/stability 10%, and future headroom 5%.

| Candidate | Fit | Capability | A11y/control | Bundle/style | License/stability | Headroom | Score |
|---|---:|---:|---:|---:|---:|---:|---:|
| Existing TanStack + local renderer | 5 | 5 | 4 | 5 | 5 | 4 | 96/100 |
| TanStack + copied shadcn recipe | 4 | 4 | 5 | 4 | 5 | 4 | 85/100 |
| React Aria Table replacement | 3 | 4 | 5 | 4 | 5 | 4 | 79/100 |
| AG Grid Community | 2 | 5 | 4 | 2 | 4 | 5 | 68/100 |
| React Data Grid beta | 2 | 4 | 4 | 3 | 3 | 4 | 63/100 |
| Ant Design Table | 2 | 4 | 3 | 1 | 5 | 4 | 58/100 |
| MUI X Community | 2 | 3 | 4 | 1 | 4 | 4 | 54/100 |
| Glide Data Grid | 1 | 3 | 2 | 3 | 3 | 5 | 47/100 |
| Handsontable | 1 | 3 | 3 | 1 | 1 | 5 | 40/100 |

### Bundle Probe

The following local esbuild probe is directional, not an application bundle forecast. It used minified ESM, externalized React/React DOM, and did not include separately imported product CSS. Measurements are gzip bytes rounded to 0.1KB.

| Probe | Version | Minimal imported surface | Gzip |
|---|---|---|---:|
| TanStack Table | 8.21.3 | `useReactTable`, `getCoreRowModel`, `flexRender` | 13.3KB |
| React Data Grid | 7.0.0-beta.61 | named `DataGrid` export | 14.2KB, CSS excluded |
| React Aria Components | 1.19.0 | semantic table composition | 55.7KB |
| Ant Design | 6.5.0 | Table, Tooltip, Dropdown | 194.6KB |
| AG Grid | 36.0.2 | React grid plus selected community modules | 206.8KB, CSS excluded |
| MUI X Data Grid | 8.11.0 | community DataGrid plus Material/Emotion | 207.5KB |

Bundle size is not the primary reason to retain TanStack. The stronger reason is that changing engines provides no product benefit for this defect. The measurements show the migration would also add material transfer, parsing, styling, and maintenance cost in most alternatives.

### Why Each Alternative Loses

- **shadcn Data Table:** the closest reference, but it is a TanStack composition guide rather than a separate engine. Copy ideas selectively instead of importing an unrelated visual system.
- **React Aria Table:** strongest replacement for accessibility primitives, but duplicates working TanStack state and requires a renderer rewrite.
- **React Data Grid:** compact and capable, but the current package is still a 7.0 beta and requires its own CSS/layout migration for little gain.
- **AG Grid Community:** excellent for dense analytical grids and much larger datasets, but excessive for server-paginated 20-row CRUD screens. Advanced features also cross Community/Enterprise product boundaries.
- **Ant Design Table:** mature and familiar, but introduces a large visual system whose defaults conflict with the existing Tailwind admin. It is justified only if the project deliberately standardizes the broader admin on Ant, not for this table defect.
- **MUI X:** similar ecosystem and styling cost; some desirable grid features live in paid tiers.
- **Glide Data Grid:** canvas-scale rendering is the wrong interaction and accessibility tradeoff for editable semantic CRUD rows.
- **Handsontable:** optimized for spreadsheet workflows and commercial licensing, neither of which is required here.

## Staged Delivery

This enhancement must run as its own pipeline after the current Headphones architecture gate. Each implementation phase touches no more than five files and waits for approval before the next phase.

### Phase 0: Mandatory Cleanup

`CollectionView.tsx` is over 300 lines. Before structural work, remove only verified dead props, unused imports/exports, and debug logs, validate, and commit that cleanup separately. Do not mix behavior changes into Step 0.

### Phase 1: Row-Height Root Fix

Write failing browser coverage with genuinely long identity, company, email, and file values. Then introduce the presentation resolver and table renderer:

- explicit widths and fixed layout;
- bounded cell branches;
- table-owned horizontal scrolling;
- sticky identity/actions;
- compact existing actions or the approved row-actions primitive;
- shell `min-width: 0` repair.

This is the first production release boundary. It solves the reported problem without exposing user-configurable layout state.

### Phase 2: Overflow And Actions Primitives

If approved with Phase 1, add the focused Tooltip/Dropdown Menu dependencies and local wrappers. Verify hover, focus, Escape, arrow navigation, collision behavior, delete confirmation, and focus return. This phase may be combined with Phase 1 only if the five-file limit and test-first order still hold.

### Phase 3: Optional Operator Layout Controls

Only after operator demand is demonstrated, add:

- column resizing, defaulting to TanStack's `onEnd` mode;
- visibility checkboxes;
- Move Left/Move Right commands rather than drag-only ordering;
- a Reset Layout command;
- versioned, collection-scoped persistence for sizing, visibility, order, and pinning only.

Reconcile persisted state against added and removed columns. Do not persist filters, selection, server data, or authorization-derived state.

### Deferred: Virtualization

Keep server pagination and semantic rows. The current 20-row page does not justify virtualization. Re-evaluate TanStack Virtual only when a supported mode renders roughly 200 or more rows, around 5,000 or more cells, or profiling shows table commits above 100ms or sustained scroll below 50fps. These are review triggers, not promises that virtualization will be required.

## Acceptance Tests

- Long fixtures keep every body row at or below 64px at 375, 768, 1024, and 1440 CSS-pixel widths.
- The table region owns horizontal overflow; the document never scrolls horizontally.
- Identity and actions remain visible through horizontal table scroll without transparent-cell bleed.
- A tooltip appears only when the rendered value is actually clipped.
- Tooltip hover, focus, blur, and Escape behavior follows the documented contract.
- Sorting exposes `aria-sort` and remains correct after column sizing/pinning.
- Row actions support keyboard open, arrow navigation, Escape, activation, and trigger-focus return.
- Checkboxes, inline selects, links, Preview, Edit, Delete, confirmation, selection, filtering, and server pagination retain existing behavior.
- If Phase 3 ships, size/visibility/order preferences survive reload, obsolete columns are discarded safely, new columns appear by policy, and Reset Layout restores defaults.
- No API, authorization, publication, storage, or database behavior changes.

## Evidence And Limits

Primary sources checked on 2026-07-29:

- shadcn Data Table guide: <https://ui.shadcn.com/docs/components/data-table>
- TanStack column sizing: <https://tanstack.com/table/latest/docs/guide/column-sizing>
- TanStack column pinning: <https://tanstack.com/table/latest/docs/guide/column-pinning>
- TanStack column visibility: <https://tanstack.com/table/latest/docs/guide/column-visibility>
- WAI-ARIA tooltip pattern: <https://www.w3.org/WAI/ARIA/apg/patterns/tooltip/>

Package versions, peer ranges, licenses, and the bundle probe were checked against npm package metadata and clean temporary installs. React Data Grid's first probe incorrectly used a default export and produced no bundle; the recorded 14.2KB result is from the corrected named `DataGrid` export. A failed lookup for `@lucide/react` was also discarded; the correct package is `lucide-react`.

The strongest objection is that a one-file CSS patch would be faster. That objection is valid against prematurely shipping column persistence or engine replacement. It does not invalidate the local renderer and presentation contract: every dynamic cell branch must be bounded, the shell must own overflow, and the policy must remain consistent across collections. Phase 1 is therefore the smallest durable fix; Phase 3 remains deferred.