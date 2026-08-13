# 当前 SEO / GEO 执行顺序

本文件是当前 SEO/GEO 序列入口。业务、品牌和平台需求不在本轮执行。

## 顺序

1. ✅ `/headphones/` canonical 尾斜杠修复已合并。
2. ✅ MIU-03 已完成四个公开页 title/description/H1/索引面审计与 metadata 修正。
3. ✅ MIU-04A 与 MIU-04B-1 至 MIU-04B-5 已完成图片 intrinsic dimensions：生产构建中
	process、factory、team、quality、certificates、client logos 共 44 张业务图片全部输出真实
	`width` / `height`；全站 10 条构建 route 的所有 `<img>` 均有 alt 与 numeric dimensions。
4. 🔄 OG / Twitter Card 仍由并发 Agent 实施；截至 2026-08-13 最新远端 refs 未见其分支或落地
	commit，本分支未修改共享 `BaseLayout`。
5. ⏭ OG/Twitter 合并后 rebase，再按当前真实内容添加 BreadcrumbList、Article、Product Schema。
6. ⏸ sitemap `lastmod` 等待可靠的内容更新时间字段与 owner；当前代码无该数据源，不编造日期。
7. ⏸ Google Search Console 与 Bing 需要站长账户权限；获权后提交 `sitemap-index.xml` 并记录
	收录、查询与 Core Web Vitals 基线。
8. 事实库稳定后再实施 GEO 问答、来源标注、`llms.txt` 和 AI 引用观测。

## 当前验证

- Site tests：132 passed，0 failed。
- Workspace TypeScript / Astro：0 errors；E2E TypeScript passed。
- Biome：280 files passed。
- Production-origin build：10 pages built；全站 `<img>` 缺 alt/width/height 数量为 0。
- MIU-04B assembly：44/44 业务图片输出实测 numeric dimensions。

## 明确排除

Slogan、Hero、品牌/导航改版、新品类、物流、Facebook、Marketplace、供应商、价格、佣金、支付、消息、交易和 URL 迁移均属于后续业务工作。

CDN 压缩、HSTS 和主机名 301 需要独立的费用/拓扑/回滚批准，也不在本轮。
