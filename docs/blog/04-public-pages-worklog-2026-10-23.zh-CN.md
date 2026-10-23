# 公开文章页面与 SEO：本轮交付

原 SEO 分支 `feat/seo-foundation`，起点 `03ecde5f2669a34599e8d4e4a31a28c7dda8f409`。本轮读回远端 SEO 仍为该提交，main 为 `404d1a257722175dcd70916e3f92ec6763fa0243`；没有合并 main 或 pricing，没有新分支/worktree，没有部署或写云资源。

## 做到哪里

BLOG-P1 的代码和本地验收已完成：构建接收明确的公开文章导出，生成 `/blog/`、`/blog/<slug>/` 和文章图片。列表、正文、作者、日期、表格、图片及真实链接都在首次 HTML 中，文章页不加载编辑器。全站菜单、商品交互和现有部署入口保持原样。

这不等于后台文章能发布了。现在后台仍然保存草稿、预览；发布/更新/撤回任务及真实媒体公开引用由 P2 接着实现。真实 CloudBase 现场验收也还没执行。默认构建未配置 Blog 快照时不输出 Blog 页面，不会出现本地示例文章。

## 代码怎样分工

| 文件 | 负责什么 |
| --- | --- |
| `packages/articles/src/publication.ts` | 只接受严格的已验收版本：完整公开内容、指定修订、正文 hash、固定日期、媒体清单。草稿/候选、内部字段、缺图、错误 hash、日期倒序被拒绝 |
| `packages/articles/src/drafts.ts` | 把原有发布内容检查和内容 hash 提成共用函数；现有草稿行为不变，避免公开页另写一套正文规则 |
| `apps/site/src/lib/blog/snapshot.ts` | 检查站点 origin、总数、重复身份、媒体归属、文件边界和大小；无网络或数据库回退。文件或媒体出错就使这次构建失败 |
| `apps/site/src/lib/blog/page.ts` | 渲染受限正文，形成独立标题/描述、canonical、Article、Breadcrumb；日期取版本记录，不取构建时间 |
| `apps/site/src/pages/blog/[...slug].astro` | 同一 Astro 静态路由生成列表和详情，复用 SiteHeader、SiteFooter、PageHero、品牌色及 article-body |
| `apps/site/src/pages/media/articles/[...asset].ts` | 从已校验字节输出包含 SHA-256 的静态图片地址；不输出私有 CloudBase 地址 |
| `apps/site/src/lib/blog/output.ts` | 接在现有 SEO 构建检查后，核对地址清单、版本、正文图片和实际图片产物；输入与生成结果不一致就失败 |
| `scripts/run-blog-public-local-e2e.mjs` | 构建初始/更新/撤回/未启用四种本地状态，可选实际浏览器；只操作自己创建的临时目录和子进程 |

`SEO_BLOG_SNAPSHOT` 是构建环境中的显式文件路径。快照 JSON 上限 8 MiB、最多 1,000 篇；每篇最多 20 个不同图片编号，单张不超过 3 MiB，总媒体上限 64 MiB。只允许 JPEG/PNG/WebP，核对实际格式、像素尺寸、页数和 SHA-256。这里读取图片信息及真实字节；浏览器另外实际解码图片，不把只读图片头当成完整解码。

资产目录固定为快照旁 `assets/`，其内路径与公开地址一致。图片使用 `/media/articles/<mediaId>/<sha256>.<ext>`，不接收自填的原始或签名 URL。移除引用不触发删除存储文件。

P1 的 JSON 校验不能证明某份文件真的经过线上验收；真实导出服务尚未写。P2 必须从服务器持有的任务和公开记录生成输入，并给首次发布补独立的内部候选构建入口。不能提前登记 accepted。正常部署以后也必须防止遗漏已公开 Blog 的快照；本轮没有接线正常 Deploy Test。

## 实际检查结果

| 检查 | 结果 |
| --- | --- |
| 全仓 `pnpm test` | 3,337 项：3,334 通过，0 失败，3 个既有跳过；比上轮新增 12 项 |
| 工作区及 E2E 类型 | 通过；Astro 保留 8 项既有提示 |
| 公开页实际 Chromium | 3 项通过、0 跳过：无 JS 阅读、真实图片字节、桌面/390px、键盘链接、实际 404、sitemap |
| 原编辑页及图片回归 | 9 项通过、0 跳过；实际登录、接口、文件存储、保存重开、冲突、失败重试、图片与私有预览，22.3 秒 |
| 构建状态 | 初始 21 HTML/13 个可索引地址；撤回一篇后 20/12；未启用 Blog 为 18/10。各阶段仍生成两个商品标准页 |
| 更新与撤回 | 更新使用新正文和内容 hash，首次公开日期保留；撤回产物与 sitemap 不再包含目标文章。这里只证明本地新产物，不证明托管旧文件和 CDN 已处理 |
| 保护是否有效 | 分别故意允许非 accepted 状态、跳过正文 hash、允许正式域名使用 fixture、允许资产越界。四次均被测试发现，源码逐字节恢复 |
| 格式、SDK 及工程检查 | lint 941 文件通过；SDK 离线总检查通过；工程脚本执行错误 0、新增发现 0，仍有原基线 12 项，两个检查项不适用。机器记录保留完整结果 |

正文校验和构建检查均先见到缺实现或被破坏时失败，再通过。原来的全路由 SEO 清单最初也拒绝新 Blog 路由；已为 Blog 显式登记，并增加 BaseLayout 绑定检查。没有从公共路由清单中排除 Blog 来绕过检查。

本轮也修复了验收脚本的构建目录冲突：Astro 6.4.6 的 `getOutDirWithinCwd()` 在输出目录位于工作目录外时会退回共用 `.astro`，两个构建会共用 `.prerender`。全仓测试中的现有“站点启动失败清理”用例也会先构建，和最初的 Blog 检查并行时曾出现缺少 prerender-entry。Blog 脚本现在把自己的输出放在站点内独立的 `.astro/blog-public-*/site`，不动其他构建目录；同一并行场景复验成功，结束精确清理自己的目录。

截图首次发现滚动动画让整页截图的固定 Header 位置不准确；改用 reduced-motion 并等 scrollY=0 后重拍，另外断言面包屑位于 Header 下方。没有为截图修改全站 Header。截图中的文字、作者和配图均是本地样本，未发布客户文章。

离线 CI 增加 `--build-only` 的四状态检查；只读权限、无 secrets、没有部署目标，原部署触发条件未改。原 CI 安全测试仍逐条限定命令，新命令单独登记；注入凭证、部署或扩大触发分支仍应失败。提交和准确 SHA 的远端 CI 在本轮最终回报中核对。

## 验收和重跑

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm verify:cloudbase-sdk
node scripts/run-blog-public-local-e2e.mjs --build-only
E2E_BLOG_PUBLIC_SCREENSHOTS=1 node scripts/run-blog-public-local-e2e.mjs --headed
node scripts/run-catalog-admin-local-e2e.mjs --articles-only --headed
```

运行要求与原项目相同：Node 22、锁文件中的 pnpm 11.5.0；浏览器需安装 Chromium。脚本创建并核对自己的 loopback 站点；不会向已有客户站点发保存、发布或存储请求。公开页与编辑页脚本分开运行，避免旧编辑页脚本的共用预渲染目录与其他构建冲突。

Astro 的路由和静态资源方式已对照安装包及 [Astro 6 路由文档](https://v6.docs.astro.build/en/guides/routing/)、[静态端点文档](https://docs.astro.build/en/guides/endpoints/)；没有引入实验 API 或新增依赖。Context7 未提供。本轮未改变 CloudBase SDK 调用。

## 复核、表达和下一步

复核了 `AGENTS.md`、模块 04、共享 SEO 合同、现有 Portfolio/Header/Footer/排版、草稿核心、媒体归属、构建门禁、离线 CI 限制及工程规范的公开投影/E2E/部署组。`humanizer` 实际对照其 SKILL 和 plain-technical-writing，以及本轮计划、共同记录和本交付记录：把“公开版本投影完成”改成“构建已能把明确的公开文章导出生成列表和正文，后台尚不能发布”，避免混淆写代码和上线。数量、字段、日期来源、无云写入边界均和代码及执行结果核对。

后续先实现 P2 的离线任务逻辑：冻结指定修订与图片清单、固定拟公开时间、幂等重试、旧任务不能覆盖新结果；补受控的内部候选构建输入，再接共享锁、备份和交付验收。文章只有在交付验收成功后才能登记公开。更新/撤回不能删除存储原件，恢复不能复活已撤回页面。真实写入前仍需单独确认目标、范围、A→B→A 和停止条件；P1 的本地结果不提供这项授权。

当前进度只更新 [共同记录](NEXT-STEPS.zh-CN.md)。[截图和机器记录](../../output/blog-public-2026-10-23/README.zh-CN.md) 可直接交给云端继续使用。
