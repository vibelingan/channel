# 01 页面收录规则与Blog正式开放

## 先看摘要

这一块解决“页面已经能看，搜索引擎却仍被明确挡住”的问题。我们会同时核对HTTP头、HTML正文、标准网址、地图和图片，不能只看页面返回200。用户已确认两篇现有公开文章可保留；本轮读过正文，没有发现虚构公司能力或报价。正式网站的Blog列表和公开文章应允许收录，临时服务地址、草稿、健康检查和错误页继续排除。客户仍照常审核、预览、发布，不增加构建操作。解释见[先读说明](EXPLAIN.zh-CN.md)。

## 10月29日的实际交付

Blog程序已更新为`71fb996b`，正式收录开关经受控入口`40819158070`打开并验收；临时地址、健康检查和404仍noindex。网站`40819519497`已完成发布并接受为`site-40819519497-1`，源代码`08923537`；公开图片robots例外已在线上读回，其他API仍禁止抓取。未修改两篇文章、价格、询盘业务或Cloud Functions。

Google对列表及两篇文章的实时测试均允许收录，三个重新收录请求已被接受；不能写成已经索引。最后对地图中539个公开页面逐一复测，全部通过技术收录条件，528商品与公开API清单一致。[真实交付回执](evidence/live-indexing-acceptance.json)。

已有文章程序更新入口只在首次创建时设预览限制；更新时不替换serverConfig，保留本次收录配置。常规静态前端发布也不更新文章服务器，本次已实际验证。

恢复操作的约束也要保留：正式开放后的目标程序必须支持正式/临时主机区别，并在恢复后重新验收这两条规则。`71fb996b`是本轮实际验收的程序；更早、不含主机规则的镜像仍保留历史，不能因以前在预览状态下能运行，就当成现在正式开放后的直接恢复目标。这是操作和兼容要求，不宣称可以阻止管理员绕过工具手动部署任意镜像。

## 需求和完成条件

公开营销页、分类页、商品页与人工发布的Blog都能被正确发现；私有页面、草稿、临时服务地址、缺失与错误页面不混入地图。不能把“HTTP200”或“地图提交成功”写成“Google已收录”。

Blog当前两篇公开内容分别是Preparing an OEM headphone project brief，以及How to Inspect Your First OEM Headphone Sample。用户于10月29日确认可以保留并开放收录。本轮读过两篇正文，前者较短但有实际清单，后者内容完整；不因来自测试自动撤回，不改正文和发布时间。

## MIU IDX-01：把HTTP、HTML和发现入口一起检查

### 现状与风险

修复前，`apps/site/src/lib/seo/output-gate.ts::inspectPage`在构建时检查正文、H1、标题、description、canonical和结构化数据，但看不到线上HTTP头。Blog的middleware在`BLOG_PREVIEW_ONLY=1`时增加noindex，HTML本身仍可通过构建检查。robots.txt的`Disallow: /api/`还挡住公开商品图。

### 接口和边界

新增`assertIndexingResponse({path,origin,status,headers,html,robots})`，复用inspectPage，不再写第二套页面SEO规则。`projectRobotsAllows`只解释本项目已知的单一通配User-agent组和字面路径前缀；遇到新语法报错，不猜成允许。这是项目配置检查器，不对外宣称通用robots解释器。

`inspectSitemap`复用现有Astro解析器，要求单根、同站规范URL、无重复与额外loc，拒绝DOCTYPE和ENTITY。它验证本项目输出合同，不冒充通用XML标准验证器。

命令：`apps/site/node_modules/.bin/tsx apps/site/scripts/check-index-readiness.ts https://supplychainsai.com <新报告路径> [--all-products]`。只GET本站公开地址，不带登录凭证，不调管理API，不提交搜索或改配置。遍历站点地图，并用现有公开商品API核对当前网址清单，报告缺失的新商品和残留的撤回商品。默认覆盖所有非商品页及均匀抽取12个商品；报告明确allPagesChecked，不能用抽样冒充全量。完整验收另运行--all-products，最大50000URL、20份地图、三路并发，单响应2MB和15秒上限。

### 实现与取舍

仅在robots里增加`Allow: /api/images/`，保留管理与其他API的Disallow。公开图是否可读继续由后端published引用检查控制；不放开存储桶，不把私人图片变公开。页面不改UI，不改商品价格接口。

### 验证

`index-readiness.test.ts`：公开商品图允许、管理API仍禁止；noindex/none头、错误状态、错MIME、错canonical、无正文、重复/外站地图、未知robots语法均拒绝。先在旧robots下复现失败，再改规则。与现有output-gate.test.ts一起执行。线上修复前工具应如实报Blog仍noindex、商品图片仍被挡住；这不是工具“全绿”的目标。

## MIU IDX-02：受控开放Blog

先确认保留内容，归档当前Blog服务配置、容器版本和域名路由。核对`BLOG_PREVIEW_ONLY`、`BLOG_API_ORIGIN`及真实HTTP结果，不要求独立部署的API与文章服务器SHA相同，改为各自通过已验收的接口合同和health身份检查。

实际读回发现旧blog-pages只有全局noindex开关，不能区分正式域名与临时地址。因此本轮先交付一个小的主机规则补丁，保留原内容和实例配置；随后真正切换收录时只补丁更新BLOG_PREVIEW_ONLY，不重发其他函数、不改变实例数或收费配置。正式域名、列表、逐篇文章、公开图和sitemap需通过IDX-01。默认服务地址仍应noindex，不能因为一个全局开关同时放开临时地址；实施前先现场确认网关传递的实际Host/转发头，不能臆测信任任意X-Forwarded-Host。

撤回文章保留草稿与图片历史；原URL404、列表与地图移除。服务异常返回503与Retry-After，不伪装成永久删除。私有预览仍要求管理员授权、Blob显示；助手无公开权限。

停止条件：配置或版本与归档不一致、未知路由、私有内容意外出现在公开入口、HTML/地图/图片验收失败。没有写入时直接停止；若只改收录开关则补丁恢复原值并读回。不要借恢复覆盖文章内容。未知写入先读回，不重复提交。

本地先测正式/临时Host、开关、404/503、公开与私有图；线上先只读核对，再说明实际变更和恢复输入，执行一次开关变更并全量检查。只有这些通过后，04再请求搜索平台重新读取，不能先通知再补页面。

开放前也核对文章实际语言与页面lang。目前保留候选两篇均为英文；如果客户后续发布其他语言，须把语言字段与页面lang作为独立小项补齐，不凭空生成不存在的翻译页面或hreflang。

## MIU IDX-03：真实价格与商品增强展示

Google对本轮抽查商品的实时测试已确认基础页面可收录，但Product snippets提示缺offers、review或aggregateRating。当前product-page.ts故意没有从第一页变体推导整商品Offer；这条限制应保留，不能为了消除提示编造金额或评分。

新主线已有`CatalogPriceSummarySchema`与批准时生成的priceSummary（packages/shared/src/catalog/price-summary.ts），但摘要可能来自website、一个指定sku或product，也可能只有MOQ而没有金额。它不自动等于整个商品适用的固定报价。

拟新增纯函数`productSearchOffer(approvedSummary, visibleOffer)`，输入只取同一公开版本、页面确实可见的报价及其适用范围。第一段只处理有真实金额与币种、适用范围明确的固定网站报价；MOQ与单位沿用原业务数据，不改报价行为。sku来源不得冒充全商品价，阶梯与范围价必须在真实报价模型和Google支持形式之间明确映射后再接入。缺少真实报价的商品继续保留事实性商品信息与Breadcrumb，并明确不具备商品增强展示资格；不增加虚假评论，不承诺全部商品都有富结果。

拟在`product-page.test.ts`补真实固定报价、无金额、SKU来源、MOQ、区间/阶梯、货币与单位边界，命令使用现有site工作区tsx。页面可收录、基础JSON-LD自洽与Google富结果资格分开报告。代码上线后用Google实时测试复核代表商品；当前只完成问题确认和设计，没有改schema或价格逻辑。

官方依据：[Google Product snippet必填要求](https://developers.google.com/search/docs/appearance/structured-data/product-snippet)。普通商品收录不以富结果资格为必要条件。
