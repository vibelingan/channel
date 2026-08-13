# 当前 SEO / GEO 执行顺序

本文件是当前 SEO/GEO 序列入口。业务、品牌和平台需求不在本轮执行。

## Delivery preflight

- Branch: `feat/seo-phase-3-metadata`
- Original MIU implementation range: `origin/test..677564f`, audited on 2026-08-13.
- Final delivery range: `origin/test..HEAD`; it includes the tracked delivery record and PR review
	hardening documented below.
- Included checkpoints: MIU-03, MIU-04A, and MIU-04B-1 through MIU-04B-5
- Result: all included checkpoints are implemented and locally validated; no blocker prevents delivery to
	`test`.

## 顺序

1. ✅ `/headphones/` canonical 尾斜杠修复已合并。
2. ✅ MIU-03 已完成四个公开页 title/description/H1/索引面审计与 metadata 修正。
3. ✅ MIU-04A 与 MIU-04B-1 至 MIU-04B-5 已完成图片 intrinsic dimensions：生产构建中
	process、factory、team、quality、certificates、client logos 共 44 张业务图片全部输出真实
	`width` / `height`；全站 10 条构建 route 的所有 `<img>` 均有 alt 与 numeric dimensions。
4. 🔄 OG / Twitter Card 仍由并发 Agent 实施；截至 2026-08-13 最新远端 refs 未见其分支或落地
	commit，本分支未修改共享 `BaseLayout`。
5. ⏭ OG/Twitter 合并后 rebase，再按当前真实内容添加 BreadcrumbList、Article、Product Schema。
6. ⏸ sitemap `lastmod` 等待可靠的内容更新时间字段与 owner；当前代码无该数据源，不编造日期。
7. ⏸ Google Search Console 与 Bing 需要站长账户权限；获权后提交 `sitemap-index.xml` 并记录
	收录、查询与 Core Web Vitals 基线。
8. 事实库稳定后再实施 GEO 问答、来源标注、`llms.txt` 和 AI 引用观测。

## 当前验证

- Site tests：132 passed，0 failed。
- Workspace TypeScript / Astro：0 errors；E2E TypeScript passed。
- Biome：280 files passed。
- Production-origin build：10 pages built；全站 `<img>` 缺 alt/width/height 数量为 0。
- MIU-04B assembly：44/44 业务图片输出实测 numeric dimensions。

## Per-MIU execution record

### MIU-03: Public page search metadata

- **What:** Added dedicated home-page SEO title and description values, tightened the Headphones
	metadata, and kept OEM and Portfolio unchanged after their existing values passed the audit.
- **Why:** The four indexable pages needed unique search metadata inside the 60-character title and
	160-character description review limits without changing visible Hero copy or the concurrent shared
	layout surface.
- **Tests written:** `public-metadata.test.ts` enumerates the four routable public pages, parses the
	actual YAML and TypeScript metadata sources, enforces non-empty title/description limits, rejects
	duplicates, and uses the Astro AST to verify each page passes those values into `BaseLayout`.
- **Validation:** The site suite passed as part of the 132-test branch run. The production-origin build
	independently confirmed one visible H1 per page and unique rendered metadata for `/`, `/oem/`,
	`/portfolio/`, and `/headphones/`.
- **Result:** Implemented in `69fcb7e`; the four public pages satisfy the audited metadata contract.
- **Engineering rationale:** Page-local SEO values preserve visible copy and avoid changing
	`BaseLayout` while the OG/Twitter work owns that shared layout. Parsing the real YAML and TypeScript
	sources is stricter than maintaining a second hand-copied metadata table. The existing `WebPage`
	JSON-LD consumes the same page metadata, so its rendered `name` / `description` values change even
	though no shared Schema implementation file is edited.

### MIU-04A: OEM factory poster dimensions

- **What:** Forwarded the existing `posterWidth` and `posterHeight` values to the fallback `<img>` inside
	the OEM `<video>` path.
- **Why:** The poster-only branch reserved the reviewed `1228x718` dimensions, but the same image lost
	them when a video source was configured.
- **Tests written:** `media-video-seo.test.ts` requires both image branches in `MediaVideo.astro` and the
	OEM content model to retain the numeric poster contract.
- **Validation:** The site suite passed, and the production-origin `/oem/` build rendered the fallback
	image with `width="1228"` and `height="718"`.
- **Result:** Implemented in `a7293ca`; both poster rendering paths now reserve the same intrinsic size.
- **Engineering rationale:** Reusing the content model's reviewed dimensions keeps one source of truth;
	hard-coding a second pair in the component would allow the two branches to drift.

### MIU-04B-1: OEM process image dimensions

- **What:** Added required `imageWidth` and `imageHeight` fields to all ten process steps and rendered
	them on the mapped images.
- **Why:** The ten assets have different aspect ratios, so a shared placeholder size would publish false
	image metadata.
- **Tests written:** `media-assets.test.ts` parses the YAML frontmatter, pins every process path, alt
	prefix, order, and measured dimension, and verifies the renderer consumes both fields.
- **Validation:** The site suite passed, and the production-origin build confirmed all ten process
	images with complete alt text and numeric dimensions.
- **Result:** Implemented in `47321a8`; 10/10 process images expose their measured intrinsic sizes.
- **Engineering rationale:** Dimensions live with the content entries because the renderer is
	data-driven and each asset differs; deriving one display size from CSS would not describe the source
	image.

### MIU-04B-2: Factory gallery image dimensions

- **What:** Added measured dimensions to the ten-photo factory registry, rendered them on the gallery
	images, and moved the exact factory data contract into the media-assets test.
- **Why:** The gallery assets vary in aspect ratio and needed exact source-to-renderer coverage without
	duplicating the same registry assertion in an unrelated brand-logo test.
- **Tests written:** `media-assets.test.ts` uses the TypeScript AST to pin every factory path, alt value,
	order, and dimension, then checks the mapped renderer bindings.
- **Validation:** The site suite passed, and the production-origin build confirmed all ten factory
	images in the retained order with complete alt text and numeric dimensions.
- **Result:** Implemented in `4c877c1`; 10/10 factory images expose their measured intrinsic sizes.
- **Engineering rationale:** A single media-specific contract avoids two tests disagreeing about the
	same registry. AST extraction prevents comments or whitespace from satisfying a source regex.

### MIU-04B-3: Team gallery image dimensions

- **What:** Added measured dimensions to the six-photo team registry, rendered them on the gallery
	images, and introduced the official Astro compiler parser for renderer-contract tests.
- **Why:** Exact registry data was not enough to prove that the values reached the real mapped `<img>`;
	source regexes could match a comment, the wrong image, or detached attributes.
- **Tests written:** `media-assets.test.ts` pins all six team entries with the TypeScript AST and uses the
	Astro AST to require one directly mapped image template with the exact `src`, `alt`, `width`, and
	`height` bindings. The same helper strengthens the preceding factory test.
- **Validation:** The pinned `@astrojs/compiler@4.0.0` dev dependency installed through the workspace
	lockfile; the site suite, workspace type checks, E2E type check, Biome, and production-origin build
	all passed.
- **Result:** Implemented in `12cba23`; 6/6 team images expose their measured intrinsic sizes, and the
	renderer checks no longer rely on regex-only template matching.
- **Engineering rationale:** The official Astro parser is the smallest reliable way to inspect Astro
	node ownership. A hand-written parser or more permissive regex would recreate compiler behavior and
	preserve the false-pass risk.

### MIU-04B-4: Quality image dimensions

- **What:** Added measured dimensions to the eight quality-test entries and rendered them on the mapped
	images.
- **Why:** The source images vary substantially in aspect ratio, so shared dimensions would be false.
- **Tests written:** `media-assets.test.ts` pins path, label, order, and dimensions with the TypeScript
	AST, then uses the Astro AST to verify the exact image bindings and same-map caption relationship.
- **Validation:** The site suite passed, and the production-origin build confirmed all eight quality
	images with their labels as alt text and numeric dimensions.
- **Result:** Implemented in `bb6f327`; 8/8 quality images expose their measured intrinsic sizes.
- **Engineering rationale:** Reusing the proven registry and renderer helpers keeps the stronger node-
	ownership check consistent instead of adding a section-specific regex.

### MIU-04B-5: Certification and client image dimensions

- **What:** Added measured dimensions to four certificate entries and six client-logo entries, then
	rendered each family's values through its own mapped image template.
- **Why:** Certificates and client logos have very different aspect ratios and could be cross-wired if
	tested only as one flat image list.
- **Tests written:** `media-assets.test.ts` pins both registries' paths, names/descriptions, order,
	dimensions, alt templates, section ownership, and exact renderer bindings. It also requires exactly
	two image templates.
- **Validation:** The site suite passed. The production homepage build confirmed all certificate and
	client images, and the aggregate check found all 44 MIU-04B images with numeric dimensions.
- **Result:** Implemented in `3fb0ca8`; 4/4 certificates and 6/6 client logos expose their measured
	intrinsic sizes, completing the 44-image series.
- **Engineering rationale:** Separate registry-to-template checks prevent a certificate dimension from
	being accepted on a client logo or vice versa while retaining one reusable parser-backed contract.

### PR review hardening

- `media-assets.test.ts` now opens all 44 target image files with Sharp and compares EXIF-oriented
	width / height from the source bytes to the declared registry/content values.
- The process renderer now uses the same Astro-AST binding checks as the component-local galleries;
	commented or detached attribute text cannot satisfy it.
- `sharp` and `yaml` are direct site test dependencies rather than relying on workspace hoisting.
- Registry extraction compares property sets, and map extraction follows TypeScript AST semantics, so
	harmless property reordering or callback-parameter renaming does not fail the contract.

## Deviations

- **MIU-04B-3 renderer verification:** The initial MIU-04B testing approach used source regexes for
	template bindings. It could not prove that attributes belonged to the real mapped image node.
	The conservative choice was to pin the official `@astrojs/compiler@4.0.0` as a test-only dependency
	and parse the Astro AST; the bolder alternative was a hand-written parser or continued regex matching,
	both of which retained false-pass risk. This affects dependency installation and site-test execution,
	not the production bundle or runtime. The lockfile install, site tests, type checks, Biome, and
	production-origin build covered the affected contexts.

No other material behavior, scope, or implementation deviation was found in the original MIU range
`origin/test..677564f` or its delivery/review follow-ups. The branch-point merge `7978369` contributes
no file delta over `origin/test`, and `566f218` only refreshes an accepted gate finding after a
line-number shift.

## Remaining blockers

- **Current delivery:** none.
- **OG/Twitter:** owned by a concurrent agent; no corresponding remote branch or landed commit was
	visible after the 2026-08-13 fetch. This branch intentionally does not modify `BaseLayout`.
- **Sitemap `lastmod`:** blocked on a trustworthy content-update field and owner; the current content
	model exposes neither.
- **Search Console and Bing:** blocked on external webmaster-account access.
- **Page-specific structured data:** sequence-blocked until OG/Twitter lands and this branch rebases
	against the resulting shared-layout contract.

## 明确排除

Slogan、Hero、品牌/导航改版、新品类、物流、Facebook、Marketplace、供应商、价格、佣金、支付、消息、交易和 URL 迁移均属于后续业务工作。

CDN 压缩、HSTS 和主机名 301 需要独立的费用/拓扑/回滚批准，也不在本轮。
