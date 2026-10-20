# 商品页 SEO 实施状态

2026-10-20 增补：托管安全的第一步已实现并完成本地验证，尚未部署。新增专用 404、部署前缓存检查、部署后普通 URL/产物校验、显式快照采集与恢复输入 artifact。最新检查为站点测试 532 通过 / 1 个既有跳过，部署/托管测试 28 通过，类型检查 0 errors / 0 warnings / 7 hints；使用保存的 487 商品快照构建得到 503 HTML / 495 个可索引地址。详细状态、未完成的缓存配置与恢复演练见 [HOSTING_ACCEPTANCE.zh-CN.md](HOSTING_ACCEPTANCE.zh-CN.md)；公共请求层只出[设计](REQUEST_LAYER_DESIGN.zh-CN.md)。下面保留商品页实现与前一轮验收记录。

2026-10-19，日本时间。统一在原分支 `feat/seo-foundation` 开发。商品页的 5 个提交已从误建的 `feat/seo-product-pages` 快进合入至 `cf0c9bcd`，基于共享基础 `6bcdaa1a`，main 基线为 `37bcea5b38284210159e95f8d10f3a9b5cf2ee44`。实现提交 `a9e1b92e`；`0d1686fb` 对齐分页测试，`081982f` 修复发布检查对真实 manifest 格式的读取，`b43dc09` 补充浏览器 hydration 错误检查。尚未推送、创建 PR、合并 main 或部署。

## 已实现

- 通过匿名公开 API 分页读取全部商品；复核 total、ID、公开字段和详情 revision，一项失败会中止整份快照。没有管理员身份、商品业务筛选名单或数据库写入。
- 标准地址 `/products/p-<稳定商品ID>/`，使用 Astro getStaticPaths 生成；标题变化或没有 slug 都不改变身份。
- 复用 `CatalogDetailController`、CatalogDetail、Gallery、变体选择和现有询盘 transport，初始 HTML 已有商品名、规格、说明和图片。浏览器首轮使用相同 bootstrap，然后更新 API。
- 后台读取期间保留正文；暂时故障显示原有错误/重试区域，确认不存在后移除交互和报价。分页固定实际 pageSize/revision，避免混用版本。
- 为旧公开格式保留原 `SkuDetailView`，初始也输出正文；当前真实快照均为结构化详情，旧格式用专门 fixture 验证。
- 商品自己的 title、description、canonical、Product、Breadcrumb 和 sitemap；重复名称只在元数据里补 ID，可见 H1 不改。未从首批变体推导全商品最低价或新增 Offer。
- 描述图 alt 加上商品名和图序号，不编造图片内容；现有图片尺寸处理保留。
- 卡片有真实 href；普通点击沿用分类页内展开和返回，修饰键、新标签和链接复制走标准 URL。
- CI 包含标准/旧格式商品与询盘浏览器验收。部署前核对真实产物，拒绝 fixture、缺页和错误 origin；没有执行部署命令。

## 验收结果

真实公开快照：487/487 个 ID，487 个结构化详情，0 个 legacy；最大 52 个 facts、31 个变体，当前均在首批返回。快照约 5.4 MB。它记录本轮读取时的数据，不代表后续后台发布不会变化。

| 检查 | 结果 |
| --- | --- |
| 站点测试 | 532 项，531 通过、0 失败、1 个既有跳过 |
| Astro typecheck | 0 errors、0 warnings、7 个既有弃用提示 |
| 变更 TS/JS 文件 Biome、git diff --check | 通过 |
| 真实内容构建 | 502 个 HTML 页面，495 个可索引地址；其中 487 个商品页 |
| 无 JavaScript 浏览器 | 逐个检查全部 487 页的 200、可见 H1、正文和 canonical |
| 有 JavaScript 浏览器 | 首轮正文、慢 API、图库、变体 URL、刷新恢复、分类展开/返回、错误状态、404 通过；无 pageerror |
| 询盘 | 完整填写需求、联系人、国家、确认并提交；仅本地回执，product/variant/revision 正确，没有客户真实询盘 |
| 旧格式 fixture | 两个页面无 JS 正文；legacy 无 slug、故障保留正文并重试、确认撤回后移除正文通过 |
| 更新/撤回重建 | 更新正文和 revision 进入 HTML；同一输出目录重新构建后旧商品 HTML 与 sitemap 地址消失 |
| SSR 变异检查 | 将真实路由临时改为 client:only，构建因缺少初始 H1 失败；已恢复 client:load |
| 发布检查 | 真实 487 页产物通过；实际 synthetic 产物被拒绝 |

浏览器验收脚本为 `scripts/verify-product-seo.mjs`，详细原始记录在本 worktree 的 `output/product-seo/` 和 `output/playwright/product-seo/`。一项既有图库测试仍跳过，本轮新增浏览器检查实际执行了图库缩略图切换。

本轮浏览器脚本的空白字符、后台图片预取、国家选项名称和分页返回 URL 假设在运行中校正，最终检查按真实 DOM/原有行为执行。部署检查最初把 SEO manifest 当作数组，真实产物检查暴露后已改为读取 `{schemaVersion,siteOrigin,entries}`，并重新验证真实产物与测试产物。

## UI 和业务流程

没有新设计稿、CSS 文件或新的询盘字段。使用同一商品、1440×1000 对比，H1 的 x/y/宽/高均为 697.265625 / 148 / 630.734375 / 120；默认配置一致，390×844 无横向溢出。桌面与手机截图在上述证据目录。

可感知的变化：浏览器标签变为商品标题；新标签可直接打开商品标准页；打开标准页时先看到正文。卡片现在按链接语义提供浏览器菜单；普通点击仍展开原详情。API 临时故障时正文保留并提示重试，已确认撤回时禁止继续报价。

实际生产 RFQ 保存、邮件/群通知及搜索引擎收录没有在本轮发送或触发。浏览器完整提交使用本地服务回执；后端的真实存储与权限规则沿用现有实现。

## pricing 兼容性

实施中 pricing 从 `658d126a` 更新到 `9d9cfdebaf28930efe969821bc33766917a7185a`，新增提交为后台商品创建恢复。所有读取均没有修改其目录；其 session 仍在继续修改后台发布/操作恢复代码，这些未提交内容没有纳入合并快照。

共有 5 个重叠文件：Controller、详情状态、详情 transport、transport 测试和 family render 测试。最初只有一处测试文本冲突：SEO 删除旧的“小第一页无效”断言，pricing 把它改成“超大第一页无效”。SEO 补回 pageSize=51 的负向断言，保留更小第一页的正向断言。之后模拟合并无文本冲突，保留 pricing 的 gallery 回调及容量降级逻辑。

直接文本合并无冲突，但 pricing 的 `renderCard` 测试 helper 仍只匹配 button，合并后会返回空字符串。最小修正在 [pricing-card-anchor-test.patch](pricing-card-anchor-test.patch)，合并时同步应用；它要求匹配标准商品 anchor，保留全部价格和 MOQ 断言。补丁只在临时合并副本应用，没有写入 pricing worktree。

临时合并副本完整测试：1212 项，1211 通过、0 失败、1 个既有跳过；typecheck 为 0 errors、0 warnings、7 hints。真实 487 页快照构建通过，仍是 502 个 HTML／495 个可索引地址。pricing 原始 `9d9cfdeb` 对照快照完整测试为 1192 项，1191 通过、0 失败、1 跳过。

合并首轮有两个失败：上述 button 选择器，以及图片准备 source4+1 用例的 MEDIA_NOT_READY。选择器修正后，两项相关文件单独运行 14 项全过，随后完整合并套件通过。图片准备失败原因仍未确认，不能断言只是机器负载；没有修改该用例、图片实现或超时预算，首次日志保留。没有在 pricing worktree 安装依赖、运行测试或切换分支。

## 构建方式和上线边界

```sh
SITE_URL=https://supplychainsai.com SEO_CATALOG_API_ORIGIN=https://supplychainsai.com \
  pnpm --filter @vibelingan-channel/site seo:snapshot /tmp/product-seo.public.json
SITE_URL=https://supplychainsai.com SEO_CATALOG_SNAPSHOT=/tmp/product-seo.public.json \
  pnpm build
```

这两条命令采集和构建，不上传。CI 的本地 fixture 使用 `seo:fixture`，不能作为线上内容。

SEO-1 的页面实现和本地验收完成。SEO-2 的后台内容变化触发、代码/内容 generation 协调、远端旧路径精确删除、CDN 清理和线上读回仍待实施。CloudBase 上传会保留本地已不存在的旧文件，所以本地撤回验证不能替代线上撤回。完成这一交付链路后，再部署和检查搜索平台实际收录。Blog、Hermes 和海外部署仍在后续范围。

## 实际 SSG 实现

页面范围、访问过程、Controller hooks、CI/CD 应急模式、缓存、撤回和没有独立环境时的验证计划，见 [SSG_DELIVERY_DESIGN.zh-CN.md](SSG_DELIVERY_DESIGN.zh-CN.md)。该文是设计说明；其中自动发布、新鲜度事件和 skip 模式仍待实现。

项目使用 Astro + React，没有引入 Next.js，也没有修改为每次访问都执行 SSR。

1. `apps/site/scripts/prepare-product-seo.ts` 调用 `collectProductSnapshot`，通过现有匿名公开 API 采集商品清单及详情，保存带 revision 的公开 JSON 快照。
2. `apps/site/src/pages/products/[publicKey].astro` 的 `getStaticPaths()` 读取快照，为每个商品输出固定路径和 `entry` 属性。`astro build` 为这些路径逐一生成 `dist/products/p-<ID>/index.html`。
3. 路由把商品和 `bootstrap={entry.detail}` 传给现有 React 详情组件，使用 `client:load`。构建时 React 先输出正文 HTML；浏览器加载后用相同初始数据接管事件，避免先清空正文再等待 API。
4. `CatalogDetailController.tsx` 用 `initialProductDetailState(bootstrap)` 初始化，`useEffect` 再执行 `refresh`，经现有详情 API 读取当前数据。变体选择、图库与询盘沿用已有组件。

Cloud Functions 仍承担现有后端工作。浏览器 API 刷新能更新访客当前看到的数据，搜索引擎首次收到的静态正文则要在商品变化后重新构建并发布。该自动发布链路、远端旧页面删除和 CDN 缓存清理属于下一阶段，尚未完成。

## 分支与证据整理

后续 SEO 工作继续使用 `feat/seo-foundation` 和原 `seo-foundation` worktree，不再按商品页另开分支。原商品 worktree 的全部 output、已验收 dist 已复制到本 worktree，逐文件校验 SHA-256；清单为 `output/seo-consolidation-2026-10-19/preserved-files.json`。当前快照、截图、日志仍分别位于 `output/product-seo/`、`output/playwright/product-seo/`；已验收构建保存在 `output/product-seo/accepted-dist/`。

多余的 `channel-seo-products` worktree 和 `feat/seo-product-pages` 本地分支已删除；5 个提交均为当前分支祖先。其余 worktree 保持原样。
