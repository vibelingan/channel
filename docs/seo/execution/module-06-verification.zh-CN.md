# F1 静态现场验收记录

2026-10-21，日本时间。当前状态：**管理员和分支准入已解除；控制面及缓存准备已执行；专用错误页的网关 HTTP 验收失败，A→B→A 未开始，policy 保持关闭。** 存储桶配置恢复已读回，网关响应尚未跟随，不能声称恢复完成。


## 最新现场结果与停止决定

| 检查 | 实际结果 |
| --- | --- |
| 原分支与代码 | `feat/seo-foundation`，现场执行基线 `f8f16f1e64f3649fd9d9952b6100a4da38e8a201`，该 SHA 的 [CI 39550275420](https://github.com/vibelingan/channel/actions/runs/39550275420) 成功；没有新建分支或 worktree |
| 静态域名缓存 | 维护运行 [39550884603](https://github.com/vibelingan/channel/actions/runs/39550884603) 内写入 Domain 响应头 no-cache；首页、headphones、两份 sitemap 的状态为 200，正文 hash 与变更前相同。保留原证书及两条静态路由 |
| 文件范围 | 精确上传 `404.html` 及四个缺失的 hash 依赖，共 220840 bytes；八个依赖逐个 GET 200、完整 hash 相符。没有上传首页、分类或商品正文，没有删除文件 |
| 专用 404 UI | 真实 `/404.html` 的桌面及 390px 手机截图已保存；noindex、专用标记、两个导航链接正确，无横向溢出。该文件直接访问 200 正常，但不代表缺失地址应返回 200 |
| 存储桶状态码配置 | 最初管理工具未暴露 OriginalHttpStatus；[运行 39554119595](https://github.com/vibelingan/channel/actions/runs/39554119595) 归档后持锁，用官方 SDK 明确写入 Enabled 并读回。备份 SHA256 `ac22037a7eac15970a82134f92bd6da44747e744552b5cda0277c27ed27a0f74`，已下载逐字节核对 |
| 独立对照 | 使用现有授权的 SDK 在进程内签名，只读访问 COS website 源站：首页 200、hash 不变；缺失对象 404、专用正文 hash `f61e6cc6b940599a2edea1fa5f3fb278636ca31dc1d2c4bf5d22ace3e657afc5`。未记录签名 URL 或密钥 |
| 网关验收失败 | canonical 域名的旧地址及全新缺失地址均为 200，同一专用 404 正文；默认托管域名也观察到 200。因此源站正确不足以证明当前 STATIC_STORE 网关正确，不能开放 canary |
| 受控恢复 | [运行 39556389104](https://github.com/vibelingan/channel/actions/runs/39556389104) 先归档并取得共享锁，再将错误文档恢复为 `index.html`，明确保留 OriginalHttpStatus=Enabled。配置读回符合预期；紧随的网关 GET 仍为先前 404 正文和 200，外部恢复尚未确认 |
| 未执行范围 | A→B→A、激活身份、新旧浏览器恢复、恢复耗时均 not-run；函数、业务数据库、搜索通知均未执行。四个控制集合为空，policy 仍 disabled |

需要继续确认网关读取静态网站配置的生效/缓存机制。已经证明源站与网关响应不一致；尚不能区分配置传播延迟和网关处理规则，也没有经验证的配置缓存刷新接口。DIRECT 域名不能凭 CDN/EO 的刷新 API 文档就推定具备配置刷新能力。不为此改 DNS、证书、上游或部署新函数。

### 本次合同补充

- `prepareHostingConfiguration` 在错误文档已是 `404.html`、但原始状态码标志缺失或 Disabled 时，仍生成修正步骤，明确设置 Enabled。
- `assertSafeConfiguration` 和实际写入前校验同时拒绝缺失/Disabled 的原始状态码标志及公益 404 替代页。SDK 标志严格使用 Enabled/Disabled，拒绝旧测试中的 true/false 字符串。
- 仅有 SDK 保存与配置 hash 一致不能让验收通过；公开 URL 的实际 HTTP 状态、正文及缓存检查仍是独立前置条件。当前失败正是这个前置条件拦住了后续写入。

参考：[COS PUT Bucket website](https://intl.cloud.tencent.com/document/product/436/30617) 规定 OriginalHttpStatus 的枚举；安装的 Manager SDK 的声明及 putBucketWebsite 实现已核对。CloudBase 的自定义网关错误页文档仅对平台版开放，不能直接用于当前项目作为已可用修复。Context7 不可用，本次采用官方文档、已安装源码和真实 HTTP 对照。

## 前置准备历史

- 独立 `gh-channel-seo-admin` 已通过 GitHub 官方设备授权登录 vibelingan，凭证位于系统钥匙串，仓库 admin=true。原 orocsy 配置及全局 Git 配置指纹未变；未修改 pricing。
- test 环境已有精确分支规则 `feat/seo-foundation`，ID 63792559，原有三条规则保留。两个目标变量位于分页的第二页，已分页核对，不新增或覆盖现有部署变量。
- 默认分支入口注册后的原 CI [39532139829](https://github.com/vibelingan/channel/actions/runs/39532139829) 已全部成功。
- 维护运行 [39546104017](https://github.com/vibelingan/channel/actions/runs/39546104017) 先归档恢复输入，artifact 12321354000；下载字节一致。锁内创建四个空发布控制集合并设为 ADMINONLY；原始权限读回为四条 ADMINONLY，用户及平台扩展 OPA 均明确为空。接近维护窗口结束时停止并释放锁，没有修改托管配置。
- 第二窗口 [39547433988](https://github.com/vibelingan/channel/actions/runs/39547433988) 重新归档已完成控制面的准备记录。缓存请求被管理工具以 `Route[1].Path contains wildcard '*'` 拒绝，读回两条原路由均未改变，未上传 404 或商品页面，随后释放本次锁。
- 根据 [Manager SDK 域名接口](https://docs.cloudbase.net/api-reference/manager/node/domain)，将待执行缓存补丁改为 `Domain.Extension.HeadersHandler`。请求不再发送 Routes，保留原 `/`、`/*`、证书和上游。只允许恰好两条归属明确的静态路由；混入 API、冲突的路由缓存头或额外变更字段时拒绝。
- 补丁包含原有 HTTP 缓存策略的反向参数。域名级头是否在现场生效仍需普通 URL、ETag 和浏览器验收，不能用本地模拟替代。policy 仍关闭，暂无 canary 激活。

## 初次注册记录（权限解除前）


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

1. GitHub 只注册手动 workflow，并为 test 目标增加精确的 SEO 分支规则，保留原有规则。后者已完成并读回。
2. CloudBase 准备只新建 `siteReleaseTargets`、`siteReleaseScopes`、`siteReleaseRuns`、`siteReleaseSteps` 并设置 ADMINONLY，核对 OPA 与有效访问权限。不改业务集合或 schema。
3. 精确新增 404.html 及四个缺失的 hash 依赖，共五个文件、220840 bytes。其余三个依赖已在现场且 hash 相同，跳过上传。上传前仍需再次检查是否出现路径冲突；不整目录上传、不覆盖首页或商品页。
4. 仅修改现有静态专用域名的响应 Cache-Control 为 no-cache，保留其余域名、证书、上游和所有路由参数。域名必须只有原 `/`、`/*` 两条静态路由，混入 API 就拒绝。这让所有静态文件每次使用前复验，包括 hash 资源；API 路由不变。既有浏览器缓存的有效期不会被追溯清除。
5. 文件读回通过后，将 ErrorDocument 从 index.html 改为 404.html，IndexDocument 仍为 index.html。唯一可见页面变化是不存在地址使用专用 404。桌面及手机预览已发用户。
6. 准备验收后才开放受审查 policy，在独立 `__release-canary/` 目录建立 A、发布 B、人工选择明确的已验收 A 恢复。每阶段核对普通 URL、内容 hash、新旧浏览器和激活身份，保留历史，不清理业务数据或通知搜索引擎。

## 恢复与停止条件

云端准备前须重新确认账号绑定、精确目标、配置、普通页面 hash、路径所有权和共享锁持有步骤。当前归档保留原网站配置、路由、响应缓存策略、文件清单，以及正向/反向参数。等待后不能直接沿用旧快照执行。

准备阶段若产生回归，在共享锁内恢复 ErrorDocument=index.html 和此前观测的 `public, max-age=300, s-maxage=600` 静态缓存策略。反向操作恢复 HTTP 行为，不承诺删除原先不存在的头覆盖字段；新增资产和控制记录保留，不删除。演练 B 的恢复只使用明确的 accepted A，恢复产生新的 activationId，不能用“最新产物”猜来源。

锁不再持有、目标/配置漂移、现有文件同路径不同字节、控制面权限不符、普通页面内容或状态改变、404/缓存/浏览器检查失败、未决或 stalled 运行、云调用结果不明时停止后续写入。先读回和记录，不重复未知调用，不抢锁。

## 已解除的权限阻塞

此前需要仓库管理员进入 [test 环境设置](https://github.com/vibelingan/channel/settings/environments)，在 Deployment branches and tags 保留已有规则，并新增 **Branch `feat/seo-foundation`**。当前仅允许两个其他分支及一条 AI 部署 tag 规则。

规则读回确认后，先重新生成现场准备快照，在 maintenance 模式归档并取得共享锁，再逐项完成上述准备。之后固定权限审查指纹，更新原 SEO 分支 policy、推送并等待精确 SHA CI 成功，再执行 plan/execute A、plan/execute B、plan/execute restore A。不能通过移除 environment 或借用允许分支来绕过准入。

## 证据与文字核对

本地证据目录 `output/seo-module-06-2026-10-21/` 保存 GitHub 注册响应、403 响应、维护运行/归档元数据、下载记录、原配置、文件清单和普通 URL 对比。归档内容不含密钥。目录未作为生产网站上传。

本次审阅了 workflow、policy、权限适配、验收脚本、模块索引及 04/06 模块文档。将旧文档的“尚未注册入口”更新为“入口已注册、环境准入受阻”；将“静态恢复完成”的可能误解限定为“维护归档已通过、实际 A/B/A 未执行”。对照了 GitHub 精确 SHA、作业步骤、artifact、环境规则及 HTTP 响应体，而非仅凭 CI 结论。

## 本轮验证与文字复核

本轮定向测试 `node --test scripts/release*.test.mjs scripts/hosting-cache-plan.test.mjs` 共 209 项通过。新增两个回归先失败，再修正实现后通过；完整远端 CI 需以本轮推送后的精确 SHA 记录为准。lint 与 SDK 合同检查另行保留日志。本地导出目录临时诊断文件曾被 lint 扫入，已移出源码目录后重新检查；没有忽略或弱化检查。

实际复核文件：`hosting-configuration.mjs`、`hosting-provider.mjs`、`canary-provider.mjs`、`release-configuration.test.mjs`、`release-provider.test.mjs`、`release-hosting-fixtures.mjs`、manual workflow、模块 03/06 和执行索引。措辞把“配置写入成功”限定为“源配置读回成功”，将“恢复完成”纠正为“源配置已恢复，网关响应未确认”。逐项对照了请求 ID、归档 hash、源站/网关状态码和正文 hash。

现场证据在 `output/seo-module-06-2026-10-21/live/`，包含每次归档、正向及恢复结果、签名源站的脱敏诊断、缓存读回和 404 UI。没有保存签名 URL、密码或云端密钥。详细恢复动作不能以维护 workflow 绿色代替 HTTP 验收。
