# Channel Agent Instructions

These project rules apply in addition to the user's global Codex instructions.

## Engineering Craft

Reusable engineering patterns live in `docs/ENGINEERING_CRAFT.md` — 55+ rules mined
from this repo's own incident history, each citing its teaching commits. Before
touching any area below, read the matching catalog group (the doc has a trigger
index at the top of the catalog section):

| You are changing… | Read group |
|---|---|
| JWT/session verification, roles, revocation, login | Auth & Session Security |
| Public API response shapes, catalog fields | Public API Projection |
| File type checks, mimeType, SVG/image delivery headers | Content Validation |
| Upload intents, finalize, storage objects, rate caps | Upload Lifecycle & Concurrency |
| refCounts, counters, backfills, batch deletes | Counters & Data Integrity |
| tsup configs, function deps, deploy scripts, workflows, secrets | Deploy & CI/CD |
| Admin islands, previews, async list state | Frontend Islands |
| Playwright specs, e2e flags, CI smokes | E2E Testing |
| Review rounds, deferrals, client questions, hidden pages | Review Process & Knowledge |

## CloudBase SDK Contract Gate

Before designing or changing CloudBase SDK, CloudBase Storage, Cloud Functions,
or hand-written SDK type shims, follow
`docs/CLOUDBASE_SDK_CONTRACT_VERIFICATION.md`.

- Read the relevant CloudBase skill/reference first.
- Verify the exact SDK/OpenAPI contract against official CloudBase docs or MCP
  docs, and against the installed package source/types in this repo.
- If Context7 or another live library-doc tool is available, use it. If it is not
  available, record that and use the CloudBase docs/OpenAPI tool plus installed
  package inspection.
- Do not add methods to `packages/db/src/wx-server-sdk.d.ts` unless the installed
  `wx-server-sdk` runtime exposes them.
- Run `pnpm verify:cloudbase-sdk` when touching CloudBase storage/media SDK
  integration, and keep that check green in CI.
