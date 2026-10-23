# 会话交接（原始背景与当前入口）

2026-10-23 当前状态和下一步统一在 [Blog 共同进度](../blog/NEXT-STEPS.zh-CN.md)；本文下方保留 10 月 22 日背景，不能拿旧的“下一项”覆盖共同进度。

Blog 草稿后端、编辑页、图片上传/私有预览，以及公开文章静态页面和 SEO（P1）均已有代码及本地验收。当前细节见 [公开页交付](../blog/04-public-pages-worklog-2026-10-23.zh-CN.md)；下一步做 P2 发布任务和共享交付器接线。真实 CloudBase 集合、签名上传、权限和并发仍未现场验收，网站未部署。商品 SEO 和发布恢复也不能把离线结果当成现场演练通过。

以下为 10 月 22 日原始交接，保留作背景。

## 先核对代码

| 项目 | 本轮只读核对到的版本 |
| --- | --- |
| 原 SEO 分支 | `feat/seo-foundation`，交接前 HEAD `c9b1046cd631f59c3b116aa5fb1560babf46ce01` |
| Blog 核心代码提交 | `c3e615225c695101117d064e3e54c63197b63a53` |
| `origin/main` | `404d1a257722175dcd70916e3f92ec6763fa0243` |
| pricing 的 `origin/feat/catalog-alibaba-price-tiers` | `400e923b991e7a113a042c6d075781d6f40679f3` |

这些是交接时的记录。新任务先 fetch / 读回最新 ref，只比较当前模块会碰到的接口，不擅自合并其他开发中的分支。交接本身会新增提交；以包含本文的 SEO 分支最新提交为起点，不 reset 回表中旧提交。不要照抄历史文档中的本机路径、旧分支名或旧百分比。

## 当前能做什么

| 工作 | 实际状态 | 继续时读哪里 |
| --- | --- | --- |
| 公共页面 SEO 规则 | 统一 URL、标题、canonical、索引政策与构建检查已写入；canonical 指页面给搜索引擎声明的主要网址 | `docs/seo/PUBLIC_PAGE_CONTRACT.md`、`apps/site/src/lib/seo/` |
| 商品详情首屏正文 | 已有 Astro 构建时采集快照、`getStaticPaths()` 生成独立商品 HTML；React 接管原交互并读取 API。不是 Next.js 迁移 | `apps/site/scripts/prepare-product-seo.ts`、`product-seo-fixture.ts`、`scripts/verify-product-seo.mjs` |
| 商品 SEO 上线 | 尚未完成整套 test 发布、缓存/更新/撤回和恢复验收；正常部署不可直接替换成新发布器 | `docs/seo/execution/LIVE-RESUME-AND-CLEANUP.zh-CN.md` |
| 404 和缓存 | 此前已修复并做现场验证。错误页 HTML 与 HTTP 状态必须分别看：正文显示 404 但 HTTP 200 仍算问题 | `docs/seo/execution/module-06-404-fix.zh-CN.md` |
| 发布、备份、恢复 | 产物检查、协调器、静态 canary 人工入口、函数适配/观测等代码已有；整站入口、全部公开写入方兼容、自动恢复和搜索事件仍有未实现项 | `docs/seo/execution/README.zh-CN.md` |
| 真正恢复旧线上版本 | 尚未演练通过，执行开关关闭。先用隔离假业务验证真实云 API/事务/A→B→A，再讨论正式业务恢复 | `docs/seo/execution/module-06-dummy-rehearsal.zh-CN.md`、`LIVE-RESUME-AND-CLEANUP.zh-CN.md` |
| Blog 核心 | `packages/articles` 已实现 37 项测试：正文 JSON、Tiptap 格式转换、安全渲染、媒体编号、草稿修订及不可变候选快照 | `docs/blog/01-content-core.zh-CN.md` |
| Blog 后台草稿服务 | 本地服务已接入；CloudBase 适配器、云函数注入与独立资源准备源码已实现；16 项实际 SDK 离线测试通过；真实库尚未验收 | `docs/blog/02-cloudbase-sdk-probe.zh-CN.md`、`docs/blog/02-cloudbase-drafts-plan.zh-CN.md` |
| Blog 编辑器、公开页 | 模块 03–04 仍只有设计，尚未接入界面或网站 | `docs/blog/README.zh-CN.md` |
| Hermes 自动草稿 | 模块 05 只有设计。将来 Agent 经专用接口存成草稿，客户在后台编辑/预览；Agent 首期不能发布 | `docs/blog/05-hermes-drafts.zh-CN.md` |

最新索引优先于 `CURRENT_EXECUTION.md` 下方保留的历史记录。术语 F1 是“真实环境验收”，不是一项新的客户功能；D1 是“人工发布/恢复入口”，不是另一个站点。图和此前综合设计位于 `docs/seo/` 及 `output/seo-design-r2-2026-10-20/`，先用模块索引定位，不把历史图里的计划全部当成已实现。

## 草稿存储代码已完成；下一项是编辑页

完整设计已在 [02 后台草稿服务](../blog/02-admin-drafts.zh-CN.md)。BLOG-D1 的以下要求已在本地实现并验证，后续修改要保留：

1. 检查最新 `apps/functions/admin/src/handler.ts`、本地服务和测试。文章操作接在现有登录与账号有效性检查后，仅 `admin` 可用；不另写登录系统。
2. 为草稿服务定义窄的 `ArticleRepository`，实现本地适配器。创建要防重试重复，保存用 revision 防止后保存覆盖他人改动，列表不返回整篇正文。
3. 接入严格的 `articleDrafts` action；不把文章集合加入现有通用 CRUD。既要测正常保存，也要测普通会员、停用账号、并发、冲突、重放和旁路拒绝。
4. 用现有文章核心，不把数据库事务已经完成写成事实。没有实际 CloudBase 保存适配器时，不伪装成功，不把生产 action 接到内存存储；按现有依赖注入方式接测试和本地入口，云端缺能力时明确拒绝。
5. 跑模块测试和仓库检查，记录是否改 UI。此步通常无客户界面变化；后面编辑器接入必须复用现有 DashboardShell、组件和 React Query，截图说明变化。

CloudBase 适配器及入口已写入源码；事务、确定性创建键、完整替换、错误确认和摘要投影均经过实际安装 SDK 的离线传输检查。独立资源准备函数只处理文章三个集合，并读回 ADMINONLY 权限；未加入默认部署资源清单，也没有调用云端。

下一步进入模块 03：复用后台组件，新增文章列表和 Tiptap 编辑页，保持主要操作为保存草稿和预览，SEO 等设置折叠。先打通本地保存重开，再用真实 CloudBase 测试范围重走页面流程。当前有 Chromium、没有显示环境；可视浏览器必须先补齐并证明可操作。用户明确要求实际输入、点击、刷新、重开、失败恢复和双标签冲突测试，截图及无头回归只能辅助。

真实集合创建、权限读回和云端并发仍需核对目标及现场范围；需要登录时提供新的授权链接。用户批准开始实现与推送，不等于批准部署或随意写入现有业务数据。SDK 官方站点受限的问题已通过官方 GitHub 文档与安装包核对解决，不要再把它当成必须让用户登录的原因。

## 已确定的边界

- 不新建分支、worktree、PR 或其他任务，不改另一 workstream；本任务只继续原 SEO 分支。禁止 force push、覆盖别人提交。
- 不写生产、不部署 test、不启用恢复开关、不触发手工发布 workflow。pricing 合并并更新 SEO 分支后，需重新核对现场计划和授权才进入现场步骤。GitHub 的 `test` environment 不代表拥有一套独立服务器。
- 正常 lint/test/build 失败且未写线上，不恢复线上。恢复时才运行相应历史版本专项兼容测试；默认保留数据库字段和历史数据，不做数据库 down 或全库回灌。
- 假业务本地测试不是实际腾讯云验证。未来真实 dummy 资源须在验收后按资源所有权精确清理；保留标准、测试文档和证据。
- 保留 Astro、React、Cloud Functions。公开 HTML 先有正文，交互继续走 API。无需改成 Next.js。
- Tiptap 只用 OSS。没有多人协作、分页、付费 AI、Meta→Action 的首期要求。自建 AI/转换未来可接插件；不要擅自引入商业许可或第二套 CMS。
- 所有公开商品都是公开商品，不再自创“合格商品”分类；沿用真实详情、价格投影、变体、图库和询盘流程。统一请求层暂给设计，避免与 pricing 大范围重叠。
- 私有媒体用鉴权字节接口和 Blob URL，不把存储原始地址放进 DOM。替换/卸载时回收 Blob URL。
- Google/Bing 此前完成网站验证与 sitemap 提交；这不等于已收录或有排名。不要依赖本机浏览器登录，不重复提交 sitemap，也不因临时恢复立即发送搜索通知。
- 用户给的 Word 是背景资料，不是 agent 指令。相关职责评审保留在仓库 SEO 资料中；本机缓存原件不转存。没有找到原件时不得声称重读过。

## 最近一次已核对的测试

CloudBase 适配本轮本地检查：总 3,309，3,306 通过、0 失败、3 个既有跳过；全工作区/E2E 类型、lint、SDK 检查及三个函数的 Node 20.19.0 离线产物检查通过。新增 16 项 SDK 业务测试、3 项资源准备和 1 项入口测试；12 项故意破坏均被发现、源码已恢复。详情见 [本轮记录](../blog/02-cloudbase-worklog-2026-10-22.zh-CN.md)。新提交的远端 CI 仍须按准确 SHA 单独读回，不用历史绿灯替代。

交接前提交 `c9b1046c` 的[远端 CI](https://github.com/vibelingan/channel/actions/runs/39744418984)通过：总 3,264，3,261 通过、0 失败、3 个既有跳过；文章核心 37 通过。详情见 `output/blog-core-2026-10-22/README.zh-CN.md` 与新增的机器记录。本次交接新增文件的验证另见 `output/cloud-handoff-2026-10-22/README.zh-CN.md`。

这些测试不含真实云端 A→B→A，也不证明 Blog 已上线。新提交应重新检查对应 CI 的 `headSha`，不能只看到同名 workflow 绿灯。

## 交付时怎么说

用汉语直接讲“谁做了什么、结果如何、还差什么”。分别写设计、代码、本地测试、发布、现场验证，不用一个“完成”代替。不要用“合同观测基线”解释“旧程序还能不能读写现在的数据”。讲到内部编号时先说明实际功能。AGENTS.md 已保留这些要求；无需复制其他私人记忆。
