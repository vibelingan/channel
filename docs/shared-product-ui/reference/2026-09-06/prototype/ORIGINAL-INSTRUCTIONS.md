# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

## Approved design direction

- Recreate the second Product Design concept: image-led variant selection with a contextual RFQ bottom sheet.
- The same prototype must be fully responsive; mobile uses horizontal thumbnail scrolling, a sticky quote CTA, and a touch-friendly bottom sheet.
- Empty import fields remain supported but secondary, using `Available on request` rather than broken blanks.
- Imported descriptions render through conservative grouped specifications with unmatched supplier text preserved in a disclosure.
- This is an isolated client-discussion prototype, not a production route or integration.
- Product facts must come from the supplied XLSX or a visibly labeled conservative transformation. Marketing copy and unsupported field names must not be invented.
- Parent-gallery images must not be mapped to variants while the XLSX `变种图片` cells are empty.
- Quote and customization are separate buyer intents: one requests price/availability for the selected SKU; the other starts a product-change consultation.
- The prototype includes clearly labeled current, partial-missing, and main-media-missing simulations for client review.
