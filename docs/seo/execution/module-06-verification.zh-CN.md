# F1 静态现场验收记录

2026-10-21，日本时间。状态：**入口与准备记录归档已验证；CloudBase 写入和 A→B→A 尚未执行，等待管理员增加环境分支准入规则。** 本记录不代表整站、API、数据库或自动恢复已验收。

## 实际执行结果

| 项目 | 结果与证据 |
| --- | --- |
| 原 SEO 分支 | `feat/seo-foundation`；执行代码 `384e0d0b96e7dd757b8fb1099cc8d1201edc791c`，未创建分支或 worktree |
| 精确代码 CI | [39529727857](https://github.com/vibelingan/channel/actions/runs/39529727857) success；此前本地 3048 项，3045 通过、3 个既有跳过、0 失败；lint、SDK 检查通过 |
| 手动入口注册 | 默认分支提交 `404d1a257722175dcd70916e3f92ec6763fa0243` 只新增 `.github/workflows/seo-static-canary.yml`；workflow ID `391216861`，active。未合并其他 SEO 代码 |
| 环境准入 | `orocsy` 的仓库权限为 push=true、admin=false。新增 `feat/seo-foundation` 的 test deployment branch policy 返回 HTTP 403：`Must have admin rights to Repository.`；现有三条准入规则未改 |
| 维护模式 | [39532206490](https://github.com/vibelingan/channel/actions/runs/39532206490) 实际归档成功并进入共享锁持有步骤；无环境凭证、无云端调用。等待管理员期间已主动取消本次维护运行，读回 completed/cancelled；未取消其他任务 |
| 备份归档 | artifact `12315378091`，`f1-maintenance-backup-39532206490-1`，保留 90 天。已下载并核对 JSON 与本地准备记录一致，归档文件 SHA256 `1c3cc9d48c9787e1037c0516274298e3f4eac654d7e3565b98618ac5ef7f6cb2` |
| 站点目标 | MCP READY，`diversity-123-d9grnqfux221323bb`、ap-shanghai、`https://supplychainsai.com`；DIRECT，两条 STATIC_STORE 路由 `/`、`/*` |
| 404 与缓存现场 | ErrorDocument 仍为 index.html；缺失路径 HTTP 404 但正文为首页。静态响应 `public, max-age=300, s-maxage=600`，路由没有缓存头覆盖。修复尚未执行 |
| 演练路径与控制面 | `__release-canary/` 清单为空；四个发布控制集合不存在。未创建集合、写入记录或修改权限 |
| 普通页面保留 | 注册后重新读取首页、headphones、sitemap-index、sitemap-0，HTTP 200，完整响应体 SHA256 与注册前相同 |
| A→B→A、浏览器缓存、恢复耗时 | not-run；没有 activationId，没有恢复耗时，不能用准备任务绿色替代验收 |
| API / 业务数据 / 搜索通知 | 函数及业务数据恢复 not-run；本次没有调用搜索通知，没有上传生产 sitemap |

默认分支注册提交会运行原有普通 CI；其结果需与当前 SEO 精确 SHA 的独立 CI 分开查看。注册只有手动触发器，不启动网站部署。

## 已向用户说明的写入范围

1. GitHub 只注册手动 workflow，并为 test 目标增加精确的 SEO 分支规则，保留原有规则。后者尚未获平台权限。
2. CloudBase 准备只新建 `siteReleaseTargets`、`siteReleaseScopes`、`siteReleaseRuns`、`siteReleaseSteps` 并设置 ADMINONLY，核对 OPA 与有效访问权限。不改业务集合或 schema。
3. 精确新增 404.html 及四个缺失的 hash 依赖，共五个文件、220840 bytes。其余三个依赖已在现场且 hash 相同，跳过上传。上传前仍需再次检查是否出现路径冲突；不整目录上传、不覆盖首页或商品页。
4. 仅修改现有静态 `/`、`/*` 路由的 Cache-Control 为 no-cache，保留其余域名、证书、上游和路由参数。这让所有静态文件每次使用前复验，包括 hash 资源；API 路由不变。既有浏览器缓存的有效期不会被追溯清除。
5. 文件读回通过后，将 ErrorDocument 从 index.html 改为 404.html，IndexDocument 仍为 index.html。唯一可见页面变化是不存在地址使用专用 404。桌面及手机预览已发用户。
6. 准备验收后才开放受审查 policy，在独立 `__release-canary/` 目录建立 A、发布 B、人工选择明确的已验收 A 恢复。每阶段核对普通 URL、内容 hash、新旧浏览器和激活身份，保留历史，不清理业务数据或通知搜索引擎。

## 恢复与停止条件

云端准备前须重新确认账号绑定、精确目标、配置、普通页面 hash、路径所有权和共享锁持有步骤。当前归档保留原网站配置、路由、响应缓存策略、文件清单，以及正向/反向参数。等待后不能直接沿用旧快照执行。

准备阶段若产生回归，在共享锁内恢复 ErrorDocument=index.html 和此前观测的 `public, max-age=300, s-maxage=600` 静态缓存策略。反向操作恢复 HTTP 行为，不承诺删除原先不存在的头覆盖字段；新增资产和控制记录保留，不删除。演练 B 的恢复只使用明确的 accepted A，恢复产生新的 activationId，不能用“最新产物”猜来源。

锁不再持有、目标/配置漂移、现有文件同路径不同字节、控制面权限不符、普通页面内容或状态改变、404/缓存/浏览器检查失败、未决或 stalled 运行、云调用结果不明时停止后续写入。先读回和记录，不重复未知调用，不抢锁。

## 继续执行的唯一当前阻塞

仓库管理员进入 [test 环境设置](https://github.com/vibelingan/channel/settings/environments)，在 Deployment branches and tags 保留已有规则，并新增 **Branch `feat/seo-foundation`**。当前仅允许两个其他分支及一条 AI 部署 tag 规则。

规则读回确认后，先重新生成现场准备快照，在 maintenance 模式归档并取得共享锁，再逐项完成上述准备。之后固定权限审查指纹，更新原 SEO 分支 policy、推送并等待精确 SHA CI 成功，再执行 plan/execute A、plan/execute B、plan/execute restore A。不能通过移除 environment 或借用允许分支来绕过准入。

## 证据与文字核对

本地证据目录 `output/seo-module-06-2026-10-21/` 保存 GitHub 注册响应、403 响应、维护运行/归档元数据、下载记录、原配置、文件清单和普通 URL 对比。归档内容不含密钥。目录未作为生产网站上传。

本次审阅了 workflow、policy、权限适配、验收脚本、模块索引及 04/06 模块文档。将旧文档的“尚未注册入口”更新为“入口已注册、环境准入受阻”；将“静态恢复完成”的可能误解限定为“维护归档已通过、实际 A/B/A 未执行”。对照了 GitHub 精确 SHA、作业步骤、artifact、环境规则及 HTTP 响应体，而非仅凭 CI 结论。
