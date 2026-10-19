# 共享 SEO 基础实施结果

2026-10-19，本地实现已完成并提交；未推送、未部署。独立目录 `$SEO_WORKTREE`，分支 `feat/seo-foundation`，实现提交 `2ae08f98248ac1f72549c40cbb292dbf2769e719`，从最新 main `37bcea5b38284210159e95f8d10f3a9b5cf2ee44` 开始。

## 已交付

统一了规范 URL、索引意图、公开页面描述与来源/revision。现有页面继续使用原布局和 props，新商品/文章可通过 `page` 接入。主布局输出与 sitemap 由同一索引策略约束，每次 Astro 构建都检查实际 HTML，并产生 `seo-manifest.json`。共享合同见 [PUBLIC_PAGE_CONTRACT.md](PUBLIC_PAGE_CONTRACT.md)，根 AGENTS.md 已加入贡献规则。

构建会检查 canonical、title/description、初始 H1/正文、社交 URL、WebPage，以及商品/文章的 Product/Article 和 Breadcrumb；sitemap 必须精确对应可索引页面。两个已验证的 Google/Bing 根文件随产物保存。旧案例跳转统一到 `/portfolio/`，原商品查询壳仍保持 noindex,follow。

## 本分支验证

| 检查 | 结果 |
| --- | --- |
| 全站测试及测试类型检查 | 519 项：518 通过、0 失败、1 个既有跳过 |
| Astro typecheck | 0 errors、0 warnings、7 个既有弃用提示 |
| 本轮变更文件 Biome | 通过 |
| 正式仓库 pnpm build 入口，指定正式 SITE_URL | 通过：15 个页面，8 个可索引 canonical |
| 临时商品/文章真实 Astro 模板 | 通过；初始正文、schema、Breadcrumb、文章 OG 均正确 |
| 从布局删除 canonical 的真实构建变异 | 如期失败；恢复后构建通过，临时路由已删除 |
| 独立 Chromium，禁用 JS | 8 个公开路由正文/H1/标题/canonical 通过；旧查询壳 noindex 保持 |
| 验证文件 | 与此前正式站已验证字节相同，Google 53 bytes、Bing 85 bytes |

HTML 检查是结构检查，不能替代业务字段真实性、浏览器可见性和发布/撤回验收。构建日志有两个既有 Admin 动态/静态 import 的分包提示；本轮未改相关模块。

## pricing 兼容检查

检查的是本地 `feat/catalog-alibaba-price-tiers` 的 `658d126afd30a84e39ec778d8d7c82415c4e908d`，并非较旧的远端提交。核对时其已跟踪代码无未提交改动；没有改动该 worktree。

SEO 的 15 个变更文件和 pricing 相对 main 的 586 个变更文件没有交集。`git merge-tree --write-tree` 模拟合并退出码 0，合并树 `0bd4423b60d74c5df6fbdf4b15be25397e936b73`，没有文本冲突。临时合并快照的站点构建和 typecheck 通过。

组合测试首轮 1176 项：1172 通过、3 失败、1 跳过。三个失败出现在 pricing 的图片准备/发布集成用例，分别是 source4+1 准备、丢失 start 回执恢复、0-SKU 发布协调。这三条失败保留为首轮证据。未修改这些测试、图片逻辑、发布逻辑或超时参数。

后续对照结果：原 pricing 快照执行相同命令，1169 项中 1168 通过、0 失败、1 跳过。停止并行构建/类型检查后，原样单独重跑合并快照，1176 项中 1175 通过、0 失败、1 跳过。

因此，当前快照已验证可以无文本冲突合并，并通过站点构建、类型检查和完整站点测试。首轮失败根因未确定，不能断言只是机器负载；保留为运行条件下的偶发失败，供后续发布链路的稳定性核对。没有通过跳过或修改测试取得通过结果。

## 后续商品页的接口交界

当前共享基础与 pricing 分开开发合适。商品页阶段需要按当时最新代码对齐以下接口，不以简单覆盖文件解决：

- `CatalogDetailController.tsx`：SEO bootstrap 从 ready 初始渲染；保留 pricing 已加的 gallery 选择和完整变体约束。
- 公开详情 DTO/API：复用当时的公开投影、`resolvePublicVersion`、revision 与受限分页协议，不写固定 50 的假设；价格摘要和 Offer 对照真实公开价格。
- 发布/撤回：内容生成与缓存更新跟随公开版本，而非每次草稿保存；撤回还需清理旧 HTML、索引入口与缓存。不能只构建一次后永不更新。

商品分支后续消费共享基础；pricing 合入 main 后，更新适配层并重新验收。当前没有实现新的商品路由/正文，没有改变价格/报价/后台发布，没有实施 Blog 或 Hermes 草稿接口。商品正文和在线发布链路完成后才放开对应标准页索引。

原始本地证据在本 worktree 的 `output/seo-foundation/`；本次没有远端 PR/CI 或线上部署结果。
