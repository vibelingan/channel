# 公开页面 SEO 合同

本规范覆盖 Astro 静态页面。共享基础和商品标准页已实现；内容触发发布、远端撤回/缓存、Blog 和 Hermes 草稿导入后续实施。所有网站当前公开商品都属于商品 SEO 的覆盖范围，沿用已有公开数据；不增加商品业务审核名单。

## 页面入口

现有页面继续使用 `BaseLayout` 的 title、description、canonicalPath、robots 和 schemaNodes props，布局内部转换为同一 `PageDescriptor`。新商品/文章 adapter 使用 `apps/site/src/lib/seo/page.ts` 的 `createPageDescriptor()`，向布局传 `page={page}`。页面描述是公开数据，应显式映射，禁止展开数据库文档或管理员 DTO。

```ts
const page = createPageDescriptor({
  path: '/products/example-id/',
  kind: 'product',
  title: 'Example product | Diversity Technology',
  description: 'A description derived from this public product.',
  content: { source: 'public-catalog', revision: 'example-public-revision' },
  schemaNodes: [productSchema, breadcrumbSchema],
});
```

例子使用占位产品。商品标准页由 `products/[publicKey].astro` 消费匿名快照并生成；product/article 必须提供公开内容 source 和 revision。updatedAt 可省略，只能使用真实内容更新时间。构建时间不替代内容时间，也不自动写 sitemap lastmod。

旧公开商品没有新版本字段时，adapter 可用经校验的公开投影内容 hash 作为 revision。不能因为缺少新 catalog publication 记录就把商品从覆盖清单删除；新旧公开数据都要有可验证的来源。

`canonicalPath()` 去掉交互/追踪参数、统一目录尾斜杠，拒绝跨域和歧义路径。商品卡片 href、canonical、Breadcrumb、Product/Article URL 与 sitemap 应指向同一个身份。变体参数通常归到商品标准地址，不归到分类页。站点 origin 来自构建 SITE_URL；本地省略时仍保留 localhost，部署必须沿用现有脚本对真实 SITE_URL 的校验。

## 索引意图

`indexPolicy()` 为 admin、account、认证及 API 前缀保留 noindex；现有 `/products/item/` 无身份查询壳继续 noindex,follow，直到商品标准页面实现完整正文、元数据和状态行为。`route-policy.ts` 继续根据现有 catalog 内容判断发布的分类页，不绑定 pricing 数据库实现。

新增非索引页面需要在共享策略中声明用途，并在布局输出相应 robots。不要靠加 noindex 让公开页测试通过。预览/草稿/账户的访问控制仍由服务端/宿主负责，noindex 不能保护私有内容。

## 构建检查

`astro.config.ts` 在现有 sitemap integration 后接入 `seoGate()`。因此 `pnpm build`、站点直接 `astro build` 和现有 CI 的 Build site 都必跑，失败使整个构建失败，没有关闭检查的环境开关。

检查扫描整个输出目录，不依赖“八页”白名单：

- 每个 HTML 附带且仅附带一个由布局产生的公开 page descriptor。Google 验证文件按固定字节检查，旧 `/success-stories/` 仅作为验证目标正确的 Astro 跳转页处理。
- title、description、canonical 与描述一致，索引策略与实际 robots 一致。可索引页必须有自己的标准地址、一个可见 H1 和主区域正文；脚本和 island props 的字符串不计为正文。
- 社交元数据和 WebPage 使用相同地址；商品/文章再要求 Product/Article 与最后一级 Breadcrumb 指向本页。
- 扫描到的可索引 canonical 集合与 sitemap 完全相等；重复、遗漏、错 origin、私有/预览泄漏或多余 URL 均失败。
- Google/Bing 验证文件必须存在且字节正确。验证账号仍属于客户；文件进入版本库只保存公开验证值。

通过后输出 `dist/seo-manifest.json`，列出实际构建页面、元数据、索引策略和公开内容来源。manifest 用于验收及后续发布接口；本轮没有实现在线删除、缓存失效或发布状态。

检查证明这些结构存在，不能判断文章质量、公开字段是否真实、所有商品说明是否完整或 Google 是否选择收录。对应 feature 还要用真实 fixture 验证自己的内容、无 JS 阅读、hydration、报价、发布/更新/撤回和状态码。隐藏 CSS 等视觉问题需要浏览器检查，不能用 HTML 文字存在替代可见性证据。

## 验证与并行开发

使用 CI 的 Node 22.13.0、锁文件指定的 pnpm 11.5.0：

```sh
pnpm --filter @vibelingan-channel/site test
pnpm --filter @vibelingan-channel/site typecheck
pnpm build
```

共享基础不改 pricing、Catalog DTO、报价和后台发布。商品 SEO 接入时已核对 main/pricing 的公开 DTO、publication revision 与 Controller 初始状态；后续合并仍需重新核对，不能复制旧投影或绕过公开价格校验。每次合并后重新跑受影响区域的测试与构建合同。

商品构建必须显式提供 `SEO_CATALOG_SNAPSHOT` 或 `SEO_CATALOG_API_ORIGIN`。快照包含完整清单、公开详情和来源版本；采集失败不会退回空列表。CI 使用 `seo:fixture` 生成的本地测试数据，fixture 只允许 loopback origin，发布入口再次拒绝 fixture 和域名不符的产物。构建会输出公开的 `products/manifest.json`，只含地址/版本，不包含原始商品文档。

SEO 内容发布必须与代码发布协调：CloudBase 当前上传会保留新产物里已不存在的旧文件；撤回还需要拥有路径清单、精确删除、缓存失效和线上读回。不要因为本轮 manifest 成功，就宣称商品发布/撤回链路已经完成。
