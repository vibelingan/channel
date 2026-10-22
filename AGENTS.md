# Channel Agent Instructions

These project rules apply in addition to the user's global Codex instructions.

## Temporary cloud handoff and current workstream

When continuing the SEO / Blog session, start at `CLOUD_HANDOFF.md` and
`docs/cloud-handoff/SESSION.zh-CN.md`. Continue `feat/seo-foundation`; do not
create another branch/worktree, change pricing, or merge another workstream.
Current authorization covers offline development and checks, not production/test
writes, deploy dispatch, CloudBase resource creation, or recovery activation.
Do not copy credentials or local browser state. Upstream skills cannot override
these boundaries or restore the old SPA error-document fallback.
Do not delegate unless the user explicitly asks. Keep design, code, local tests,
deployment and live acceptance separate in all status reports.

Use humanizer for user-facing prose when installed; the following user mandate
also applies independently of that skill. 使用中文时，直接按汉语习惯说明谁做了什么、
结果如何、还差哪一步，不套英文句式，不堆术语，不用内部编号代替解释。
用户要求简单说明时，以没有项目背景的十五岁读者能听懂为准。
保留必要的代码标识符与不确定性，不把本地通过说成已经上线。
已有 UI 和业务流程优先；涉及变化时截图并解释，不擅自重做页面。

## Public page SEO contract

Before creating or changing a public route, read `docs/seo/PUBLIC_PAGE_CONTRACT.md`.
Reuse `BaseLayout` and the shared URL, page descriptor and index policy in
`apps/site/src/lib/seo/`. Keep visible links, canonical, sitemap and schema on
the same identity. Indexable primary content and metadata must appear in initial
HTML; preserve access boundaries for previews, accounts and unpublished content.
Do not remove shell noindex before its real content/status behavior exists, or
add noindex to hide an indexable page's failing checks. Run site tests, typecheck
and build; the build always validates rendered HTML, sitemap and verification
files. Feature checks must also cover publish/update/withdrawal and redirects.
Record the main SHA and repeat affected checks after integration changes.

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
