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

## 继续实施：实际线上备份、缓存参数与恢复基础

本段接续 `bf8434e0`。重新 fetch 后 main/test 仍为本文件上面的 SHA；只读 pricing worktree 的 HEAD 已到 `3f025b0d`，`d0863eb3..3f025b0d` 没有改动本轮 scripts、workflow、SEO 或商品标准路由范围。远端 pricing 引用停留在更早提交，不能拿远端引用冒充该 worktree 的当前状态。本轮没有切换/修改/运行 pricing，也没有新建分支或 worktree。

使用 archify 生成 workflow v2 图，源文件 `docs/seo/diagrams/hosting-delivery.workflow.json`。第一份图生成后按代码实际进展更新：加入线上备份前置步骤，去掉重复验收行以修复桌面纵向溢出；保留缓存及恢复的未验收状态。当前 deliver、浏览器 receipt、截图和规格/HTML SHA-256 均在 `output/hosting-2026-10-20/`，以最后一份 receipt 为准。

再次只读确认 CloudBase 登录 READY，环境为 `diversity-123-d9grnqfux221323bb`、ap-shanghai。GET 不跟随重定向，未知路径 HTTP 404、无 Location，正文 SHA 与已下载首页一致。完整下载托管目录后发现 SDK 回执 success 但漏了两个文件，精确补取；这成为 capture 脚本必须覆盖的回归场景。两次清单/配置一致：1,062 项含 30 目录标记、1,032 文件，总 77,019,288 bytes。普通文件 MD5 与 ETag、长度一致；3 个 multipart ETag 不被当作 MD5，额外独立 HTTP 读取视频并比较 ETag/长度/SHA-256。最终每个文件写入 SHA-256 manifest。

新增 `capture-hosting-backup.mjs`，接入原 Deploy Test 的凭证检查之后、部署之前；必须保存单独 backup artifact（含隐藏文件，30 天）才能继续。同一共享锁、原分支条件、完整 CI 均保留，未新增 workflow。`hosting-cache-plan.mjs` 从真实配置生成只改 STATIC_STORE 响应头的增量参数和恢复旧 HTTP 策略的反向参数；没有执行云写入。官方 `ModifyHTTPServiceRoute` 的增量修改、HTTPServiceExtension/Header 数据结构与安装 MCP 的 downloadDirectory/downloadFile 分支已核对；当前没有 Context7，没有新增 SDK 方法或 shim。

新增 `hosting-recovery.mjs` 的输入核验、计划与有序执行内核，以及 `prepare-hosting-recovery.mjs` 只读命令。拒绝错误环境、路径穿越、符号链接、损坏/缺失文件、备份期间内容变化；上传/读回失败不能推进到 HTML、清理或配置；恢复已撤回商品时拒绝整份旧产物；保留旧 hash 资源、平台路径和搜索验证文件。实际备份在临时目录完成 1,025 文件恢复/逐项 hash、1 个刻意创建的退役页删除、旧资源与平台文件保留。临时目录已清理，真实备份保留。没有云端恢复适配器或锁内恢复 job；没有把示例空列表视为未来发布时的实时撤回/所有权证明。

本轮新增测试 17 项通过。包含既有部署脚本在内，全套 `scripts/*.test.mjs` 为 458/458，通过日志 `recovery-deploy-tests-unsandboxed.log`。第一次在无 `.git` 的导出副本和受限沙盒运行失败于既有 Git 清单检查、本地端口 EPERM；没有改测试，重跑时让 Git 只读指向真实 index，并在可绑定本地端口的执行权限下通过。源码复制 SHA 保存在 `recovery-validation-source-hashes.json`。Biome 对 8 个改动 JS 文件检查通过；安全路径检查用字符码识别控制字符，没有禁用 lint 规则。站点 UI、组件和数据请求代码本轮未改，未重复旧的全站构建验证，也没有新增 UI 截图冒充产品变更。

实际复核文件：本段提到的 8 个脚本及测试、deploy-test.yml、hosting-contract/integrity/smoke-http、CloudBase SDK gate、Engineering Craft 的部署/E2E 组、HOSTING_ACCEPTANCE/SSG_DELIVERY_DESIGN、archify schema/common/example/delivery contract 和 humanizer plain-technical-writing。具体措辞修正：“恢复入口完成”限定为“只读计划命令和执行内核已有，云端适配与锁内验收未完成”；“反向操作恢复配置”改为“恢复旧 HTTP 策略，显式覆盖字段仍会保留”。分别对照可执行入口、参数和实测日志，防止扩大完成范围。

最后加入隐藏文件归档断言和缺失目录创建后，定向 40/40 通过（`recovery-focused-tests.log`），8 文件 Biome 无改动通过。Archify 最终规格 `171d780be66fd8c2283a2cfb6410948bdc0fbd589628664de7f9e4638a0cb98b`，HTML `acb4114530acd224f9bd70d83ec90b5f50377ad683c753da24e50a10e98b6557`：9/9 showcase、0 errors/0 warnings；1440×900、1600×1000、1920×1080、2048×1320 浏览器测量均无溢出。已用图像工具查看最终 1440 浅色、2048 深色截图，文字/节点/路径未见遮挡；独立 handoff receipt 标记 browser_evidence/visual_review 均 passed，没有修改自动 receipt 的 visualReview: pending。规格最后仅按仓库格式规则压缩一行 JSON 数组，随后重新 validate/deliver；HTML 字节与上述已检查版本完全相同，artifact-bound 浏览器证据仍匹配。最终规格冻结。
