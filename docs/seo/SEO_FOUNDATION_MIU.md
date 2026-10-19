# SEO-0：共享页面合同与构建验收

状态：本地实现和验收完成，未推送或部署。基线 `origin/main`：`37bcea5b38284210159e95f8d10f3a9b5cf2ee44`，核对日期 2026-10-19。独立分支 `feat/seo-foundation`；本轮只交付共享基础，商品正文、发布器、Blog 和 Hermes 接口后续独立实施。

## Runtime problem

当前 `BaseLayout.astro` 用 `new URL(canonicalPath ?? Astro.url.pathname, siteOrigin)` 生成地址，`astro.config.ts` 另维护 noindex 排除列表。单元测试检查源码，但没有在每次真实构建后验证 HTML、sitemap 和正文是否相符。新 feature 可以绕过布局、漏 canonical，或把只含浏览器加载壳的页面放入 sitemap，而构建仍成功。

```ts
// 现有入口
const canonicalUrl = new URL(canonicalPath ?? Astro.url.pathname, siteOrigin);
// 配置里独立决定 sitemap，未检查最终 HTML。
```

## Data shape

| 数据 | 例子 | 生命周期和范围 |
| --- | --- | --- |
| PageDescriptor | kind、canonicalPath、robots、title、description、content.source/revision/updatedAt、schemaNodes | 一个页面的一次构建；只容纳公开元数据 |
| canonical identity | `/products/example/` | 内容身份；追踪/交互参数不改变它 |
| site origin | 显式 SITE_URL；本地 fallback 为 localhost | 一次构建；不从请求 Host 推断生产域名 |
| SEO manifest | 所有构建 HTML 的描述及 canonical | 构建产物；不包含数据库原始文档或凭证 |
| 验证文件 | Google HTML、Bing XML 的固定公开字节 | 随静态产物保留；不是索引或排名证明 |

## Technology constraint

Astro 静态构建已负责输出页面；本轮不增加运行时 adapter。`astro:build:done` 可以读取完整输出，`@astrojs/sitemap` 在它的同名 hook 写 sitemap，检查 integration 必须排在 sitemap 后。官方合同与安装包源码均核对；不新增第三方包。客户端 island 的序列化 props 不等于可见正文，因此检查只读取 HTML 文本节点，并排除 script/style/template 与 hidden/aria-hidden 内容。

## Design / flow

`页面/公开 adapter → PageDescriptor → BaseLayout → HTML → sitemap 一致性检查 → seo-manifest.json`。

保留旧页面 props，布局通过一个转换入口消费合同；新 product/article 页面必须显式提供公开内容来源与 revision。索引策略共享给布局和 sitemap。检查自动扫描整个输出，不把现有八页写成永远不变的清单。私有页面及旧商品查询壳保持 noindex；标准商品页不在本轮放开。

## Best-practice fix

```ts
const page = createPageDescriptor({ path, title, description, content, schemaNodes });
// 构建完成后，检查实际输出，而非只匹配源码字符串。
await validateSiteOutput(outputDir, siteOrigin);
```

对可索引页验证唯一 title/description/canonical、同源规范地址、初始 H1 和正文、WebPage/社交 URL 一致性，商品/文章再要求相应 schema 与 Breadcrumb。sitemap 必须与扫描得到的可索引身份精确一致；遗漏、新增、重复、私有地址均失败。构建时间不能作为 lastmod；缺少真实内容更新时间时留空。

## Alternatives rejected

- 仅加 AGENTS 规则：不能阻止遗漏，所以同时提供构建必跑检查。
- 为检查失败统一加 noindex：会吞掉合法公开页面；新增不参与索引的路由须声明原因，并通过布局/sitemap 的一致性验证。
- 重写 catalog adapter、报价、后台发布：属于 pricing/商品 SEO 交界，本轮不进入。
- 新建第二套 sitemap：继续使用现有 integration，以实际页面合同验收其输出。

## Code translation

`canonicalPath()` 统一身份，拒绝跨域与歧义路径；`indexPolicy()` 维护私有前缀/旧壳规则；`createPageDescriptor()` 验证元数据和内容来源；布局输出安全 JSON 描述；`inspectPage()` 检查实际 HTML；`validateManifest()` 对比 sitemap，最后才写 manifest。验证文件独立检查字节，避免被当作普通页面。

## Risk / test

新增测试先失败：`page.test.ts` 与 `output-gate.test.ts` 因实现模块尚不存在而失败。后续执行站点完整 tests/typecheck/build，变更文件 lint。负向用例删除 canonical、加入 noindex、改错 origin、删除可见正文、遗漏/泄露 sitemap 地址，要求检查失败。实际构建再做这些变异，证明检查已接入 Astro，不仅是 helper 测试。

SEO-0 不证明 Google 已收录，也不证明产品更新/撤回上线完成。后续商品 SEO 依赖 pricing 的公开 DTO、revision 和 ready 初始状态接口；到那一步重新读取 pricing/main，不能复制过期实现。


## 验收结果（2026-10-19）

- 站点测试：519 项，518 通过、0 失败、1 个既有浏览器控件测试跳过。
- Astro typecheck：0 errors、0 warnings、7 个既有弃用提示；新增 JSON script 已显式 is:inline。
- 变更文件 Biome：通过。未新增依赖或修改锁文件。
- 仓库 `pnpm build`：通过；以 `SITE_URL=https://supplychainsai.com` 在本地输出 15 个受检查页面、8 个可索引标准地址。
- 临时 product/article Astro 模板：通过真实布局生成，初始正文、Product/Article、Breadcrumb 和 article OG 类型均正确；完成后删除模板并重建原页面集合。
- 临时删除布局 canonical：整个 Astro build 如期失败，恢复后通过；日志在本 worktree 的 `output/seo-foundation/`。
- 独立 headless Chromium，禁用 JS：逐页检查全部 8 个公开路由的 200、可见 H1、正文、标题/canonical；旧查询商品壳仍 noindex,follow。

实际构建先暴露了两个检查入口问题，均已修复：页面 bundle 中不能用基于源码 import.meta.url 的 fs 路径读取内容，现已改用既有 Vite 内容模块；旧跳转目标 `/portfolio` 与标准 `/portfolio/` 不一致，已统一。旧测试对 NOINDEX_PATHS 内部实现的断言改为共享路由策略的行为验证，保留了旧地址不进 sitemap 的要求。

自查结论：公开字段仅投影 source/revision/updatedAt，JSON 中的 `<` 被转义；metadata、正文和 sitemap 的检查不会改变 Catalog 发布权限或公开价格。剩余限制是商品/文章真实内容 adapter、在线更新/撤回和 Google 实际收录尚未交付，不能以本轮成功替代它们。
