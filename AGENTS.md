# Channel Agent Instructions

These project rules apply in addition to the user's global Codex instructions.

## AI 工作待办回顾

仅在官网助手、询盘 Sales 或 Apollo 工作中：开始前读取 `docs/ai-platform/BACKLOG.zh-CN.md`；记录新的暂缓事项时，写责任类别、重新评估条件和完成依据。阶段交付后回看哪些依赖已解除，并在交付中提出下一项建议；不得把依赖解除等同于获得实施、合并、部署、费用或真实发送授权。详细设计和旧编号保留原处，当前待办状态只在统一入口维护。此规则不启动其他工作流，也不覆盖 Agent 专属规则的适用范围。

## Temporary cloud handoff and current workstream

When continuing the SEO / Blog session, start at `CLOUD_HANDOFF.md` and
`docs/cloud-handoff/SESSION.zh-CN.md`. Continue `feat/seo-foundation`; do not
create another branch/worktree, change pricing, or merge another workstream.
The latest SEO status is `docs/delivery/README.zh-CN.md`. The user authorized integrating this SEO stream into main/test after verification, actual site deployment, and preparing a production WeCom draft connection. The GitHub `test` environment serves supplychainsai.com; it is not an isolated staging site. Before cloud mutations state exact scope, accepted recovery inputs and stop conditions. Preserve pricing/business data and the separate AI workstream. Do not send group messages or change production Hermes configuration without the identified server and the user's authorized scope; the user will initiate the WeCom group test.
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

## OOODA 与非技术客户交接

解释和汇报先给结论。按用户所称的 OOODA，依次想清事实、影响、可行办法、推荐决定、下一步由谁做什么；正文按需要展开，不机械套标题，也不编造缩写全称。默认读者没有项目背景，每个陌生概念首次出现就解释实际含义。

配置交接必须分清客户、我们和原服务商的动作：客户负责邀请和必要授权，技术配置由我们接手。账号邀请须写清自己的登录账号、准确菜单、最低所需角色及可见数据；不能把“不主动查看客户名单”当成系统隔离。域名管理员指能改网站地址记录的人，通常是原建站人员或云账号负责人，不是 Resend 官方；不知道具体是谁就先查，不能让客户凭一个术语猜要找谁。

交付一条推荐顺序，已完成的密钥交接不要求重做。区分本地通过、线上发布和实际效果；连续输出要在真实页面看到正文在完成前增长，文件下载要实际点击并读回核对。结束前检查读者是否知道现在的结果、剩余限制、自己需要做什么以及我们接手什么。所有对用户和客户的文字继续按 humanizer 检查。

本地与云端共用 `docs/delivery/README.zh-CN.md` 记录当前状态；`docs/blog/NEXT-STEPS.zh-CN.md` 指向同一入口，模块 worklog 记录检查和证据。接手前核对远端，结束时更新同一记录，不平行维护另一份完成清单。

每次交付主动给简短中文 brief：做了什么、实际怎样测试、还差什么、下一步是什么，
用简单例子解释必要的规则。完成的改动提交并推送原 SEO 分支，附提交和准确 SHA 的
CI 状态，保留可跨端继续的交接；不要等用户重复提醒。截图只作辅助，编辑页还须
真实浏览器操作与数据读回验收；分别报告本地、真实云库和部署状态。

Use the installed `.agents/skills/dev-pipeline/SKILL.md` Codex adapter proactively
for full-pipeline guidance on feature work, and read
`.agents/skills/engineering-craft/INDEX.md` plus the relevant categories before
design/review. Reuse the existing approved spec and tracked feature plan/worklog.
Apply judgment within the authorization above; do not treat upstream templates as
permission to delegate, change branches, create a PR or deploy. Setup and pinned
sources are documented in `docs/cloud-handoff/SKILLS.zh-CN.md`.

## What not to commit

- Never commit local run products: `output/`, screenshots, PDFs, zips, run
  reports, evidence JSON, `.claude/` review notes. Never use `git add -f` to get
  past `.gitignore`. CI fails when a tracked file matches `.gitignore`
  (`git ls-files -ci --exclude-standard` must print nothing).
- Scripts that produce reports write under `output/` by default; CI uploads them
  as workflow artifacts. Evidence a reviewer needs goes in the PR description
  (command, counts, result), not as files in `docs/`.
- One feature keeps one design doc and one execution record, updated in place.
  Do not add a new plan/verification/delivery file per round or per step.
- Old process files live in the tags `archive/process-evidence-2026-11-02` and
  `archive/docs-evidence-2026-11-05` (`git show <tag>:<path>`); do not restore
  them to the branch. Images a guide shows its reader stay beside that guide
  (for example `wecom/images/`), not in an `evidence/` folder.

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

## Deployed website and article delivery

- Product detail pages use Astro SSG plus a fresh public API read in the browser. A browser refresh updates its display, not the stored static HTML. Product-change rebuild automation and emergency build skipping are separate unfinished work.
- Blog uses the independent CloudRun **container** `blog-pages`; admin/public-api and article-import are Event Functions. Daily article publish/update/withdrawal commits current public content and does not start GitHub or a timer.
- Code recovery restores program/static artifacts, never an old database snapshot. Keep current published content, withdrawn state and media access rules. Unsupported new content formats require compatibility work before restoring an older renderer.
- Normal Deploy Test updates the three manifest functions and static site. It preserves the independently deployed blog-pages and article-import programs. If their source changes, use their reviewed package/deploy/backup procedures and verify the actual running version; do not assume a frontend deploy updates them.
- Keep the complete admin workspace in customer builds. PUBLIC_BLOG_WORKSPACE=1 is only an isolated local editor fixture.

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
