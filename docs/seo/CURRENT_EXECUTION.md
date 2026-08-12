# 当前 SEO / GEO 执行顺序

本文件是 `feat/seo-phase-2` 的当前执行入口。业务、品牌和平台需求不在本轮执行。

## 顺序

1. Review、合并并部署 `/headphones/` canonical 尾斜杠修复。
2. 线上确认页面 canonical 与 sitemap 均为 `https://supplychainsai.com/headphones/`。
3. 实现 OG / Twitter Card 默认元数据；使用获批的 1200×630 PNG。
4. 逐页审查 title、description、canonical、H1 与索引意图。
5. 按当前真实内容添加 BreadcrumbList、Article、Product Schema。
6. 有可靠更新时间后添加 sitemap `lastmod`；修正图片 alt 与尺寸。
7. 接入 Google Search Console 与 Bing，提交 `sitemap-index.xml` 并记录基线。
8. 事实库稳定后再实施 GEO 问答、来源标注、`llms.txt` 和 AI 引用观测。

## 明确排除

Slogan、Hero、品牌/导航改版、新品类、物流、Facebook、Marketplace、供应商、价格、佣金、支付、消息、交易和 URL 迁移均属于后续业务工作。

CDN 压缩、HSTS 和主机名 301 需要独立的费用/拓扑/回滚批准，也不在本轮。
