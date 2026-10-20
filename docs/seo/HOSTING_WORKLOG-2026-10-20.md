# 2026-10-20 托管与请求层核对记录

## 范围与分支

继续原 `feat/seo-foundation`，起点 `f5150e5489164cb35ea5a7b31e3314c02481f319`。没有新建分支/worktree，没有修改、安装依赖或在 pricing worktree 执行测试。临时验证目录是 Git archive 导出的文件副本，没有 `.git`，不是新分支或 worktree。

重新 fetch 后：`origin/main=37bcea5b38284210159e95f8d10f3a9b5cf2ee44`；`origin/test=fdf39d99ad8f12231baede9e8c95734aa036e08d`。pricing 从 `3d157ac4` 推进到 `d0863eb3ceba9de263e44db0213b3d4eb670e443`；新增已提交改动没有涉及本轮公共 catalog/shop/lib 请求文件或部署入口，未提交内容未纳入兼容性结论。

## 实施和修正

1. 新增专用 404，沿用 BaseLayout/SiteHeader/SiteFooter，noindex,follow，排除 sitemap；部署前检查 404 产物，错误文档配置改为下一次部署使用 404.html。
2. 新增只读托管检查：普通请求/重新校验请求、真实 HTTP 状态、MIME、错误正文、缓存、artifact hash。正式交付还读取真实商品、sitemap 分片和 manifest；完整输出通过本地文件 adapter 检查 18 次，不能当作 CloudBase 验收。
3. 云写入前增加缓存 preflight；显式采集快照后从文件构建；上传前保留完整站点/快照恢复输入，上传后强制托管检查并保存报告。
4. 请求层设计完成，公共 transport、domain API、queryOptions、业务 hooks 的迁移待 pricing 接口边界稳定后实施。没有替换 Controller 请求方式或修改 UI 交互。

第一次完整站点测试发现新 `404.astro` 没有加入 noindex 页面测试清单，修正清单并补 sitemap 排除断言后全套通过。没有删除失败测试或放宽公开页 metadata 的要求。

## 实际验证

| 验证 | 结果 |
| --- | --- |
| Node 22.13.0，站点 test typecheck | 通过 |
| 站点全部单元测试 | 533 项：532 通过，0 失败，1 个既有跳过 |
| hosting-contract/deploy-ci-gate/hosting-integrity/smoke-http | 28 项全部通过；包含旧错误正文、soft 404、正 TTL、过期普通响应、断网等负向场景 |
| Astro check | 0 errors、0 warnings、7 hints |
| 保存的真实公开快照构建 | 487 个商品；503 HTML，495 个可索引 canonical；sitemap 与所有权文件 gate 通过 |
| 发布前产物检查 | public product gate 接受 487 商品；404/商品/发现文件 hash 可生成；18 次文件 adapter 读取通过 |
| Biome | 8 个改动 JS/TS 文件通过 |
| git diff --check | 已修改范围通过 |
| UI | 1440×1000 与 390×844 截图已检查；手机 scrollWidth=390，无横向溢出；两个主要链接为 `/` 和 `/headphones/` |
| 真实站点 | 只读 8 次检查完成，新要求 0/8：缓存策略和错误正文待交付，HTTP 状态本身正确 |

证据在 `output/hosting-2026-10-20/`，截图在 `output/playwright/hosting-2026-10-20/`。没有运行云端部署、修改响应头、触发真实客户询盘或声称恢复演练成功。

截图使用纯静态预览，没有启动 API。共享导航请求的 4 个 `/api/catalog-taxonomy` 返回 404，已检查控制台记录；本次截图只证明错误页布局与 metadata，不作为导航数据、商品或询盘的全流程验收。

本 worktree 部分文件（包括 `.git` 指针）带 macOS dataless 标记，直接读取发生长时间等待。因此验证在当前 HEAD 的临时导出副本完成，覆盖本轮改动；只借用已安装依赖，root/site/shared/ai-contracts 的 lockfile importer 已对照一致，没有复制 pricing 源码。首次用 pnpm 时其依赖状态检查试图安装并因无 TTY 中止；没有因此修改 pricing 依赖。随后使用仓库 Node 22.13.0 直接执行相同 Astro/TS/tsx 入口。10 个改动的代码/workflow 文件已与验证副本逐项 SHA-256 对照，记录于 `validation-source-hashes.json`；不能把导出副本叫成已部署环境。

普通 Git commit 及限定 pathspec 的 commit 都在刷新未改动的离线 diagram 文件时阻塞，lsof 已确认读取位置。已停止这两个自有进程，保留原 index；清理仅限其遗留且无进程持有的零字节 index.lock。提交改用原 index 的临时副本，保持暂存树一致、避开无关文件刷新，继续执行原有 hooks，不使用 no-verify；不会设置原 index 的 assume-unchanged 标记或改写离线 diagram。

## 文档与事实核对

实际阅读：deploy-test/ci/e2e workflows、部署脚本、hosting-integrity、smoke-http、product-seo-release、SEO page/route/output gates；AdminApp/admin API、inquiry API、Alibaba API、shop API、session、api-url/envelope、CatalogDetailController、ProductLanding、detail transport/state/pages、public-quote transport；Engineering Craft 的 Deploy/Frontend/E2E 分组与 CloudBase SDK gate。CloudBase 官方管理 API、HTTPService 数据结构、缓存说明与本机 CLI 3.5.9 bundle 分别检查；TanStack Query v5 的取消、initialData、默认刷新、queryOptions 文档已核对。

措辞修正：“缺失 URL 是否返回真实 404”改为“HTTP 404 已确认，正文错误”；“保存 artifact 就能回滚”改为“保存恢复输入，恢复入口和耗时未验证”；“没有公共层”改为“有 URL/envelope 复用，完整请求生命周期未统一”。读回数据、源码和 workflow 分别支持这些结论；没有根据 SDK 新文档推断旧运行时已具备 safe/prune。
