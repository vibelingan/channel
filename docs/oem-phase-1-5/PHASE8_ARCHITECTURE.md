# OEM Phase 8 — 要做什么、怎么做

状态：G3/G4 已批准；MIU 1–6 已实现并通过本地 G5，等待 review、推送和 live acceptance
日期：2026-07-23
需求来源：客户原始 PPT Slides 4–5、11、16

## 这是针对哪个 feature

这是 **OEM Phase 1.5 的最后一组页面修改（Phase 8）**，不是新功能，也不是重新设计网站。

客户 PPT 要求处理三件事：

1. Slide 16：删除 Teardown 列表页顶部的 `3 / 66.99% / 20+` 统计栏。
2. Slide 16：删除 Blue Ocean 列表页顶部的 `3 / 69.2% / 2,000` 统计栏。
3. Slides 4–5、11：统一现有页面中冲突的年限和回复时间，使用 `20+` 与 `within 24 hours`。

## 用户最终会看到什么变化

- `/teardown-lab`：Hero 下面不再显示三项统计，直接进入原有介绍和三张 report cards。
- `/blue-ocean`：Hero 下面不再显示三项统计，直接进入原有介绍和三张 concept cards。
- `/oem`：唯一剩余的 `15+ Years of Experience` 改成 `20+ Years of Experience`。
- 首页/OEM 表单提交成功提示、提交结果页和确认邮件：旧的 `within one business day` 改成 `within 24 hours`。

## 什么绝对不改

- 不删除或改写任何 report / concept card。
- 不删除六个详情页。
- 不改详情页中的 BOM、margin、MOQ 或产品资料。
- 不改导航、CTA 目的地、表单字段、上传或提交功能。
- 不改 API、数据库、登录权限、CloudBase SDK 或环境变量。
- 不新增 UI 组件、依赖或后端服务。
- 不做 Slide 1 AI 客服；它继续单独延期。

## 为什么需要检查邮件部署包

网站提交 OEM 询价后会发送确认邮件。邮件文字写在 `packages/email`，部署时会被打包进现有 admin CloudBase function。

所以这里只是改一行确认邮件文案，并检查打包后的文件确实包含 `within 24 hours`。这**不是**新增或重做后端，也不会改变邮件发送方式。

## 正确交付流程

1. 在当前 OEM 分支完成修改和测试。
2. Review 并确认最终 commit SHA。
3. 先推送 `dev/albertli/oem-phase1-5-adjustments`。
4. 确认远端 OEM 分支就是已 review 的 SHA。
5. 将同一 SHA fast-forward 到 `test`，触发 CloudBase test 部署。
6. 等 CI 和 Deploy Test 完成。
7. 最后用 `https://supplychainsai.com` 验收页面和文案。

不推 main，不做 production deployment。

## 为什么采用这个做法

最小做法就是在原位置删除两段 HTML、替换几处文案。新增组件或统一常量反而会让 Markdown、页面和邮件之间产生不必要的依赖。数据和详情页仍被 cards 使用，因此不碰数据文件或类型。

以下内容是供实现和 review 使用的技术附录。

## Technical Boundaries

| Boundary | Changed producers | Preserved consumers/contracts |
|---|---|---|
| Listing presentation | `apps/site/src/pages/teardown-lab/index.astro`, `apps/site/src/pages/blue-ocean/index.astro` | `PageHero`, eyebrow/intro, cards, datasets, detail templates, routes, CTA targets |
| Experience/shared SLA | `apps/site/src/i18n/content/oem/en-US.md`, `apps/site/src/pages/oem_submit_result.astro` | `OemContent`, `ReasonList`, homepage/OEM `ProjectForm`, existing form behavior |
| Dormant SLA sources | `apps/site/src/i18n/content/headphones/en-US.md`, `apps/site/src/i18n/content/overstock/en-US.md` | Typed loaders and underscore-prefixed retained sources; no route restoration |
| Email carrier | `packages/email/src/index.ts` | Admin handler, SMTP/env behavior, tsup packaging contract |
| Verification | Existing site source-contract tests and `tests/e2e/public.spec.ts` | Existing test runners and Playwright config |

## Data and Build Flows

### Listing removal

`teardownReports.ts` / `blueOceanProducts.ts` → page-local list arrays → card map → three generated detail routes per family.

Delete only aggregate calculations used by the stats bands and the bands themselves. The list arrays remain the input to cards and `getStaticPaths()` detail generation.

### Experience claim

`content/oem/en-US.md` `whyUs.reasons[].stat` → `OemContent` → `oem.astro` → `ReasonList` → `dist/oem/index.html` → CloudBase static hosting.

Change only `15+` to exact `20+`.

### Response-time claim

1. OEM `submit.successBody` → homepage/OEM consumers → `ProjectForm` rendered success state.
2. Result-page literal → `dist/oem_submit_result/index.html`.
3. Hidden Markdown → typed headphones/overstock loaders; source parity only.
4. `packages/email/src/index.ts` text/HTML → admin function dependency → tsup `noExternal` bundle → `scripts/package-functions.mjs` → ignored `.cloudbase-artifacts/functions/admin/index.js` → CloudBase admin runtime.

Every stale producer changes to lowercase exact `within 24 hours`; punctuation remains sentence-owned.

## Cloud Pattern Audit

Selected pattern: **Static Content Hosting**. Astro compiles deterministic HTML at existing paths and CloudBase overwrites those paths. The hard constraint is edge freshness, satisfied by release-keyed post-deploy requests. No remote prune is required because Phase 8 retires no route or object.

Retry, Saga, Compensating Transaction, CQRS, Materialized View, Cache-Aside, messaging patterns, gateway/BFF patterns, External Configuration Store, Quarantine, Valet Key, and Event Sourcing are rejected as unnecessary. Phase 8 introduces no new dependency call, distributed mutation, read model, cache, queue, topology, secret, upload, or persisted state.

ADR: `.claude/docs/adr-phase8-oem-claim-parity.md`

## Cross-File Seams

| Seam | Required guard |
|---|---|
| Dataset → listings → detail routes | Assert three cards per listing, all six detail routes, and retained BOM/margin/MOQ. |
| OEM Markdown → both ProjectForms | Assert the shared success producer reaches both existing consumers. |
| Hidden Markdown → dormant loaders | Assert source parity without claiming retired routes are public. |
| Email source → admin bundle → packaged artifact | Build functions, package, cold-start smoke, require new phrase present and old phrase absent. |
| Ignored generated output | Inspect `dist/` and `.cloudbase-artifacts/`, then prove neither is staged. |
| Reviewed OEM SHA → `test` → CloudBase | Push OEM first, verify exact remote SHA, require `test` ancestry, then fast-forward and monitor deployment. |

## Trade-Offs

- Do not add a shared SLA constant. Markdown, Astro, plain-text email, HTML email, and serverless packaging cross different build boundaries; a new import would add coupling without removing the need for parity tests.
- Do not change datasets/types to remove stats. The aggregate display is obsolete, while the same data remains required by cards and detail economics.
- Use existing source-contract tests plus packaged-artifact inspection instead of creating an email-builder abstraction or a new verification framework.

## Level-1 Product Tasks

1. Remove listing summary bands while preserving the complete Teardown and Blue Ocean browse/detail experience.
2. Standardize approved experience and response-time claims across every active and dormant carrier.
3. Prove generated site/email output and deliver the approved revision to the test environment only.

## Validation and Runtime Impact

- Focused source tests first; no stale case-insensitive `15+` or `business day` in active claim sources.
- Direct workspace/app TypeScript checks, E2E TypeScript, Biome, all tests, site build with intended `SITE_URL`, function builds, packaging, and bare-artifact cold-start smoke.
- Browser matrix: 390 / 768 / 1024 / 1440, with settled reveal state. Verify 1 / 2 / 3 / 3 listing columns, no stats labels, three cards per listing, heading flow, no extra hero gap or horizontal overflow, exact claims, and six detail routes.
- Generated outputs remain ignored and uncommitted.
- Delivery: reviewed OEM branch → guarded `test` fast-forward → CI/Deploy Test → cache-busted `supplychainsai.com` acceptance. No main/production update.

## Third-Party Surfaces Verified

N/A. No third-party API, method, option, return shape, event, or configuration changes. Existing Astro, tsup, Nodemailer, and CloudBase behavior is consumed unchanged; Context7 or SDK probing would not verify any new surface.

## Diagrams

- `.claude/diagrams/hld-context-oem-phase8.excalidraw`
- `.claude/diagrams/hld-services-oem-phase8.excalidraw`
- `.claude/diagrams/hld-deployment-oem-phase8.excalidraw`

## Open Questions and G3 Verdict

Open architecture questions: none. Slide 1 AI customer service remains outside Phase 8.

**G3 APPROVED.** The first architecture presentation was too abstract for the user to judge; the user approved the plain-language execution plan and confirmed OEM branch → guarded `test` fast-forward → `supplychainsai.com` acceptance. Product code remains blocked until G4.