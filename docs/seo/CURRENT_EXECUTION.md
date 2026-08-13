# 当前 SEO / GEO 执行顺序

本文件是当前 SEO/GEO 序列入口。业务、品牌和平台需求不在本轮执行。

## 顺序

1. ✅ `/headphones/` canonical 尾斜杠修复已合并。
2. 🔄 OG / Twitter Card 由并发 Agent 实施；其他 MIU 不修改其共享布局文件。
3. ✅ MIU-03 已完成四个公开页 title/description/H1/索引面审计与 metadata 修正。
4. ⏭ OG/Twitter 合并后 rebase，再按当前真实内容添加 BreadcrumbList、Article、Product Schema。
5. 有可靠更新时间后添加 sitemap `lastmod`；修正图片 alt 与尺寸。
6. 接入 Google Search Console 与 Bing，提交 `sitemap-index.xml` 并记录基线。
7. 事实库稳定后再实施 GEO 问答、来源标注、`llms.txt` 和 AI 引用观测。

## 明确排除

Slogan、Hero、品牌/导航改版、新品类、物流、Facebook、Marketplace、供应商、价格、佣金、支付、消息、交易和 URL 迁移均属于后续业务工作。

CDN 压缩、HSTS 和主机名 301 需要独立的费用/拓扑/回滚批准，也不在本轮。
