# SupplyChainsAI SEO / GEO 基线与实施计划

- **站点：** `https://supplychainsai.com`
- **状态：** 当前权威 SEO/GEO 文档
- **基线日期：** 2026-08-12
- **范围：** 搜索抓取、索引、元数据、结构化数据、搜索平台接入、生成式搜索可引用性
- **不包含：** 品牌文案定稿、Marketplace 产品功能、物流交易功能、供应商入驻、价格与佣金规则

## 1. 文档边界

本文件只回答两件事：搜索引擎现在能正确看到什么，以及下一步还需要补什么。

产品需求、Slogan、Hero、页面信息架构、产品品类、物流服务与未来交易平台由后续业务工作单独管理和排期，不是本分支的依赖。客户原方案中的 SEO/GEO 内容以本文件为准；客户文档不是当前 SEO 执行清单。

## 2. 结论

原客户方案中的 SEO 诊断已经过时，其中多项“完全缺失”已经实现；`/headphones` “完全由 JavaScript 渲染、AI 爬虫不可见”的结论也不成立。当前优先级不是重做已完成的基础设施，而是：

1. 将本分支的 Headphones canonical 修复合并并部署。
2. 补齐 Open Graph / Twitter 分享元数据和可验证的默认分享图。
3. 为明确页面补充真实、页面级结构化数据，不编造产品、FAQ 或企业事实。
4. 优化过长 title/description，并建立上线回归检查。
5. 接入 Google Search Console 与 Bing Webmaster Tools，用真实覆盖率和查询数据替代第三方百分比分数。
6. 在有可引用事实和来源后推进 GEO 内容；`llms.txt` 只能作为辅助发现文件，不承诺排名或引用提升。

CDN 压缩暂不实施：当前域名使用 CloudBase DIRECT 路由，压缩依赖启用计费 CDN 并调整域名拓扑。未获费用和迁移批准前，不改云资源。

## 3. 当前 SEO-only 执行顺序

本轮不实施 Slogan、Hero、品牌切换、产品品类、物流、Facebook、Marketplace 或 URL 信息架构变更。执行顺序如下：

1. **交付当前 canonical 修复**
	- Review 并合并 `feat/seo-phase-2` 的 `/headphones/` 尾斜杠修复和回归测试。
	- 部署后确认页面 canonical 与 sitemap 都是 `https://supplychainsai.com/headphones/`。
2. **补分享元数据**
	- 在布局层增加 OG / Twitter Card 默认能力。
	- 需要一张经批准的 1200×630 PNG；素材未提供时不编造或临时上线低质量图片。
3. **逐页修正搜索元数据**
	- 检查公开页 title、description、canonical、唯一 H1 与可索引意图。
	- 文案只描述页面当前真实内容；不等待或提前实现业务改版。
4. **补真实页面级结构化数据**
	- 层级页补 `BreadcrumbList`。
	- 拆解文章在作者、日期、主图真实存在时补 `Article`。
	- 商品页只有在页面展示真实商品/Offer 字段时补 `Product`；不虚构价格、库存、评分。
5. **完善 sitemap 与图片语义**
	- 有可靠内容更新时间时补 `lastmod`。
	- 内容图补真实 alt 和尺寸；装饰图用空 alt。
6. **接入搜索平台并建立基线**
	- 验证 Google Search Console 与 Bing Webmaster Tools。
	- 提交 `sitemap-index.xml`，记录覆盖率、错误、查询与点击基线。
7. **GEO 内容阶段**
	- 在事实有 owner、证据和复核日期后，再做可提取问答、来源标注和 `llms.txt`。
	- 用固定问题集记录 AI 引用正确性，不承诺第三方工具的固定提升百分比。

每一步独立验证后再进入下一步。业务页面未来上线时，另开业务 MIU，并在该 MIU 中补对应 SEO 验收；不并入本轮。

## 4. 已验证基线

| 能力 | 当前状态 | 证据与说明 |
|---|---|---|
| 主域 | 已配置 | `supplychainsai.com` 为 canonical origin |
| Canonical | 已覆盖公开页 | Headphones 尾斜杠缺陷已在 `feat/seo-phase-2` 修复，待合并部署 |
| 私有页 noindex | 已实现 | 登录、注册、账户、后台、重置、表单结果页均不应索引 |
| Sitemap | 已生成并过滤 | 只包含公开营销页；当前不含 `lastmod` |
| Robots | 已上线 | 声明 sitemap，并阻止私有/API 路径抓取 |
| 全局 JSON-LD | 已实现 | `Organization`、`WebSite`、`WebPage`；私有页不输出 |
| HTML `lang` 与 viewport | 已实现 | 原“完全缺失”诊断已失效 |
| Meta description | 已存在 | 需要逐页质量与长度优化，不是“完全缺失” |
| `/headphones` 可抓取正文 | 已实现 | 生产 HTML 已包含商品、MOQ、Bluetooth、Inquiry 等正文；原 CSR 不可见诊断失效 |
| OG / Twitter | 未完成 | 需要默认值和页面覆盖策略 |
| 页面级 Schema | 部分缺失 | Breadcrumb、Article、Product 仅在页面内容与字段真实时添加 |
| 搜索平台数据 | 未验证 | 本次没有 Search Console/Bing 权限，不能声称收录率或排名变化 |
| 文本压缩 | 未启用 | DIRECT 入口不返回 gzip/brotli；CDN 激活已延期 |
| HTTP 301 | 未实现 | `/success-stories` 当前是 HTTP 200 + meta refresh，不是真正 301 |

## 5. 原客户方案勘误

| 原结论 | 当前判定 | 修订口径 |
|---|---|---|
| JSON-LD 完全缺失 | 已失效 | 全站已有基础图谱；只补真实的页面级类型 |
| Canonical 完全缺失 | 已失效 | 公开页已有 canonical；Headphones 局部修复待部署 |
| Sitemap 完全缺失 | 已失效 | sitemap 已上线并过滤私有页 |
| Robots 未确认/缺失 | 已失效 | robots 已上线 |
| `lang`、viewport、H1 全部缺失 | 已失效 | 不能再作为全站修复项；仅逐页回归检查 |
| `/headphones` CSR 导致正文不可见 | 错误 | 当前生产 HTML 可直接读取核心正文 |
| 每项 GEO 可固定增加若干百分点 | 无证据 | 删除预测百分比；以搜索平台与目标查询样本衡量 |
| 建 Wikidata 即可触发 Knowledge Panel | 不成立 | 不应为 SEO 自建宣传条目；需满足平台收录政策和独立可靠来源 |
| Product Schema 全目录铺设 | 有条件 | 仅在页面展示真实商品字段且满足类型要求时添加 |
| `priority` 是 sitemap 必需字段 | 不成立 | 不作为验收条件；关注 canonical、可索引 URL 和可维护更新时间 |

## 6. 实施清单

### P0：当前分支交付

| 项目 | 状态 | 验收 |
|---|---|---|
| `/headphones/` canonical 与 sitemap 一致 | 已实现，待部署 | 构建产物 canonical 与 sitemap 均为 `/headphones/` |
| 现有 SEO 回归不退化 | 已验证 | 站点测试 124/124、类型检查、Biome、生产构建均通过 |

### P1：分享、搜索结果与页面语义

| 项目 | 前置条件 | 验收 |
|---|---|---|
| OG / Twitter 默认元数据 | 提供可公开使用的 1200×630 位图 | 每个公开页输出绝对 URL、title、description、image；私有页不追求分享卡片 |
| Title/description 精炼 | 产品文案确认 | 公开页无重复；长度按实际 SERP 预览人工审阅，不用单一字符数代替质量 |
| BreadcrumbList | 页面存在真实层级 | 详情页 breadcrumb 与可见导航一致，Rich Results Test 无错误 |
| Article | 拆解内容具备作者、日期、主图 | 可见字段与 JSON-LD 完全一致 |
| Product | 商品页展示真实商品/报价状态 | 不虚构价格、库存、评价或品牌；Rich Results Test 无错误 |
| Sitemap `lastmod` | 有可靠更新时间来源 | 只输出真实内容更新时间，不在每次构建时伪造“刚更新” |
| Search Console / Bing | 域名所有权账户 | 验证域名、提交 sitemap、保存首轮覆盖率基线 |

### P2：GEO 内容与可引用性

| 项目 | 前置条件 | 验收 |
|---|---|---|
| 事实库 | 业务签核成立年份、MOQ、专线、覆盖国家、认证等 | 每条公开数字可追溯到责任人和证据，不同页面不冲突 |
| 可提取问答 | 销售确认高频买家问题 | 页面正文直接回答，Schema 只映射页面可见内容 |
| 来源与更新机制 | 指定内容 owner 和复核日期 | 过期事实可下线，不形成无人负责的“永久承诺” |
| `llms.txt` | 核心公开页和事实已稳定 | 文件可访问、只列公开权威页面；不把它当作排名保证 |
| AI 引用观测 | 确定目标问题集 | 固定问题、地区、语言、日期记录，关注引用正确性而非单一百分比 |

## 7. 新公开页面的 SEO/GEO 准入条件

任何后续获批的公开业务页面进入开发时，必须在各自业务 MIU 内同时满足：

1. 先决定 URL，再发布内容；首发后避免无必要改路由。
2. 明确页面是 `index` 还是 `noindex`，不要默认把筛选、搜索结果、账户页面放进 sitemap。
3. canonical、内部链接、sitemap、breadcrumb 和结构化数据使用同一 URL 契约。
4. URL 迁移必须提供真实 HTTP 301/308、更新内部链接和 sitemap，并保留迁移映射与回滚计划。
5. 供应商内容需要审核、去重、来源和更新时间；薄内容、重复筛选页不得批量索引。
6. Product/Offer 结构化数据只能反映页面上用户实际可见的价格、币种、库存与卖方关系。
7. 业务功能、外部工具、价格和交易规则由业务范围决定，不因“利于 SEO”提前上线。
8. 外部页面不加入本站 sitemap、canonical 或结构化数据；外链必须使用获批 HTTPS URL，并清楚说明会离开本站。

## 8. URL 与环境配置边界

`SITE_URL` 和 `PUBLIC_API_BASE_URL` 是部署环境不同的公开 origin，放在 GitHub **Environment variables**；密钥、令牌、云凭据才放 GitHub **Secrets**。

`/portfolio`、`/headphones` 等第一方路径不是环境配置，也不是秘密。它们应集中到 source-controlled、typed `SITE_ROUTES` 注册表，由导航、canonical、redirect 和测试共同引用。不要创建 `process.env.PORTFOLIO` 或每个路由一个 GitHub variable：环境变量无法约束 Astro 文件路由，反而会让页面、sitemap 和链接分别漂移。

## 9. 不在本阶段实施

- CDN 激活、域名切换、压缩与 HSTS。
- 现有公开 URL 的迁移。
- Slogan、Hero、品牌/导航改版、产品品类、物流、Facebook 外链、Marketplace、供应商、价格、佣金、消息与交易功能。
- 未经业务证据确认的 `50 years`、`50 units`、`14 lanes`、覆盖国家数或认证数量。
- 为获取 Knowledge Panel 而创建不满足收录政策的 Wikidata 条目。

## 10. 状态更新规则

每个状态必须标注为以下之一：`未开始`、`实施中`、`已在源码实现/待部署`、`已部署/已实测`、`阻塞`、`延期`。只有生产探测或搜索平台数据可以支撑“已上线/已收录”；代码存在不能替代部署验证。
