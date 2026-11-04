# 本轮交付：自动更新、入口跳转、收录复查与性能基准

本轮沿用 feat/seo-foundation。性能只采集优化前数据、诊断和设计，等待用户审阅后再改性能代码。原有 main/test、sales agent、pricing 不在写入范围。

|模块|完成标准|当前事实|
|---|---|---|
|商品自动更新|专用 GitHub App 仓库范围验证；开启唯一每分钟触发器；真实待办启动并验收 HTML；失败补漏|完整 HTML 交付及 B→A→B 已验收；App 私钥文件、环境变量与 secret 尚缺，等待账号持有人创建并安装|
|HTTP、www 跳转|保留路径/查询参数、无循环；HTTPS 正文和 API 不受影响；新配置纳入可恢复版本|已读取两域名完整配置；HTTP 强制 HTTPS 的恢复点兼容代码已补，尚未现场写入；www 方案仍需受控实施|
|Google/Bing|地图、汇总日期、代表 URL、实时抓取及具体问题分别记录|Google 代表商品已入索引；文章实时允许但历史 noindex 待重抓；Bing 发现539，代表商品实时允许但未抓取|
|性能优化前基准|各类页面、手机/桌面、三次冷启动；保存原始样本和失败；美国出口单独验证|本机54次与美国Lighthouse54次均已完成；美国只读工作流41763932713成功。没有实施性能优化|
|静态 CDN|明确存量资源、源站、缓存范围、失效、计费和回退；冷/热缓存同条件对照|主域/www为DIRECT；当前账号未找到本站EdgeOne站点；尚未开通套餐、修改DNS或迁移后端|

证据目录：../evidence/2026-11-04-performance/。性能测量代码 scripts/performance/。美国测量没有部署步骤、CloudBase密钥或环境写权限；不占用网站发布队列。

## 已验证与未验证的边界

11月3日 A2/B2 成功证明程序版本可切换、当前528商品版本及两篇文章保持，且运行临时函数清理完成。它不证明自动唤醒已授权，也不代表各类页面Core Web Vitals达标。旧文档的11月1日中间状态不能覆盖11月3日运行回执。

浏览器GPS设成美国不会改变网络路由。本机采集只标为Mac当前出口；美国任务必须先读取出口country=US才接受，记录测试工具、CPU/网络模拟和实际URL。美国实验仍不能代表Googlebot所有抓取请求。

## 审查入口

- [优化前数据与前后对照](BEFORE-AFTER.zh-CN.md)
- [优化设计](PERFORMANCE-DESIGN.zh-CN.md)
- [静态CDN试验与回退](STATIC-CDN.zh-CN.md)
- [跳转执行范围与停止条件](REDIRECT.zh-CN.md)
- [平台实际观察](../evidence/2026-11-04-performance/platform-observation.json)
