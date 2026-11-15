# 11月12日只读核验

本轮没有写CloudBase、商品、文章、图片或网关；没有开通服务，没有发送企业微信消息。当前CloudBase MCP只确认环境级权限绑定本站上海环境，未更换环境或申请更大权限。

- `portfolio-initial.html.gz`：正式案例页完整HTML，原始字节摘要见 `portfolio-browser.json`。gzip只是保存原文，不修改页面。
- `portfolio-entry-and-crawling.json`：不带斜杠入口、robots、sitemap索引及子地图。主页面有完整案例，不能用网页工具一次打不开推断本站404。
- `portfolio-browser.json`：Playwright真实浏览器、禁用JS电脑/手机的测量；两项案例各4段正文，均未隐藏、无横向溢出。
- `portfolio-nojs-1440.png`、`portfolio-nojs-390.png`：上述真实页面截图，不是设计稿。
- `image-status.json`：三张网站图现在仍400，保留平台错误与requestId。上次原图SHA对照是11月5日证据，本轮没有重新下载三张原件，也没有宣称修复完成。

工具边界：Stealth浏览器启动失败，改用Playwright MCP；没有改浏览器用户配置或复制登录态。官方文档工具读回6MB限制；`pnpm verify:cloudbase-sdk`在既有子测试超时，整项未通过，详见执行计划。未调用模型、未新增UI设计，因此不使用图像生成模型。

本轮实际复核的关键文件包括：`pages/portfolio.astro`、`components/CaseShowcase.astro`、`styles/global.css`、`layouts/BaseLayout.astro`、公开图片handler、`media-storage/src/pixels.ts`与包依赖、公开分类与商品组件、商品snapshot/page、Blog的server-client与媒体路由。把图中“Blog直读COS”修正为“Blog调用公开API”；把“原图问题已解决”修正为“来源已核对，网站超限仍未修”。
