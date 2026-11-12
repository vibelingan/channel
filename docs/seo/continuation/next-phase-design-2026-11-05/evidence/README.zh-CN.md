# 本次设计核验的证据

11月12日新一轮证据在 [2026-11-12](2026-11-12/)：案例页原始HTML、真实无JS电脑/手机截图、robots/map和三张图片的当前失败回执。旧证据保留原日期；本次没有重采全量Google/Bing效果或性能After。

全部为 2026-11-05 只读查询或已有测量记录复核，没有上传图片、改文章、切换云环境或部署网站。

| 文件 | 内容及边界 |
|---|---|
| [source-and-taxonomy-probes.json](source-and-taxonomy-probes.json) | 三张来源 PNG 的完整 GET、摘要、尺寸；三张网站图片的 400 错误正文；分类有参/无参及空分类对照。耗时是单次 Mac 网络观察，不是性能基准 |
| [product-image-source-map.json](product-image-source-map.json) | 三件批准商品、图像 ID、Alibaba 来源与原图摘要的允许字段；不是私有数据库完整导出 |
| [taxonomy-trace-review.json](taxonomy-trace-review.json) | 54 份美国 Lighthouse 报告中全部 222 次分类请求均 200 |
| [taxonomy-local-review.json](taxonomy-local-review.json) | 本机 54 样本中 12 个 Blog 样本的失败请求、页面错误及采集脚本的查询串省略边界 |
| [cloudbase-response-limit.md](cloudbase-response-limit.md) | 经官方文档 MCP 读取的 6MB 响应限制摘要；网页工具未能打开同页，不假称已通过该路径读取 |

美国原报告在 [2026-11-04 性能证据](../../evidence/2026-11-04-performance/)；原测量任务为 [41763932713](https://github.com/vibelingan/channel/actions/runs/41763932713)。本机原始数据为同目录 `baseline.json.gz`，它与美国条件不同，不能合并计算优化收益。

分类诊断更正依据：采集脚本 `scripts/performance/baseline.mjs` 第 15、137、183 行只保留 origin 和 pathname；导航调用 `apps/site/src/islands/shop/catalog-taxonomy.ts` 实际附带 family。无参人工 GET 的 400 是接口参数校验，不能当成已证实的 Blog 页面请求故障。保留完整参数的美国记录提供了独立核对。

本次读到的 CloudBase 版本与接口：MCP 2.37.4，官方 docs 的 searchDocs/readDoc；本仓库已安装 `@cloudbase/node-sdk@3.17.2`、`wx-server-sdk@4.0.2`。没有增加 SDK 类型或调用方法。Context7 当前不可用；实施媒体链路前继续按仓库契约文档核对实际运行时。

技能使用：humanizer 与 plain-technical-writing 用于事实和措辞复核；core-web-vitals/performance 用于区分真实用户和实验室数据；CloudBase/cloud-functions 用于契约边界；archify 用于高层模块图和交付时序。没有因为“用了技能”就把未实施的优化计为完成。
