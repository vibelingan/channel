# 方法、技能与来源

## 实际使用了什么

- humanizer及plain-technical-writing：先用汉语说明实际问题，再保留可核对的字段。本轮把“7个noindex问题”纠正为“3个已收录、2个正式网址待收录、2个正常合并的参数地址”，保留文章另有历史noindex的例外。
- Addy Osmani `seo`与`web-quality-audit`：使用GitHub固定提交 `afa8da942115f2961fdbfa80807ea0b232ff6c00` 的检查表，全文存于本目录references。用于逐项检查抓取、HTML、链接、分页、元数据、结构化信息、移动性能和证据边界；不把技能例子当本站已实现功能。
- 本地`core-web-vitals`、`performance`及`performance/references/MEASUREMENT.md`：区分实验室与真实用户，复用11月4日原始基准，设计等条件前后比较。没有为这次审查再启动一套全站性能或CI跑分。
- CloudBase主技能及cloud-functions：核对事件型函数的真实响应方式；读取仓库SDK契约规范、ENGINEERING_CRAFT的Content Validation；通过官方文档MCP核实6MB限制。没有改管理环境、函数或存储权限。
- Archify：生成总流程图、结构与排版检查、桌面浏览器容纳检查，截图人工查看。图示是实施顺序，不是说各模块已完成。

技能只是检查方法。实际结论来自Google Console逐页检查、匿名HTTP读取、已有实测原件、项目当前源码及官方文档，不能拿一个SEO技能或Lighthouse总分证明已收录。

## 原始资料

| 来源 | 用来判断什么 |
|---|---|
| [Google页面索引报告](https://support.google.com/webmasters/answer/7440203?hl=en) | 各种排除与未收录原因、正常重复页 |
| [网址检查](https://support.google.com/webmasters/answer/9012289?hl=en) | 当前索引和实时检查的区别 |
| [JavaScript SEO](https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics) | Google能运行脚本，初始HTML与渲染的关系 |
| [可抓取链接](https://developers.google.com/search/docs/crawling-indexing/links-crawlable) | 普通链接及href，避免依赖点击按钮发现页面 |
| [分页](https://developers.google.com/search/docs/specialty/ecommerce/pagination-and-incremental-page-loading) | 后续页、逐页canonical和内容一致性 |
| [商品摘要](https://developers.google.com/search/docs/appearance/structured-data/product-snippet) | 报价/评论/评分要求，AggregateOffer与变体范围 |
| [视频](https://developers.google.com/search/docs/appearance/video) | 独立观看页、封面、素材和视频sitemap |
| [重抓请求](https://developers.google.com/search/docs/crawling-indexing/ask-google-to-recrawl) | 申请不保证索引，重复提交不加快抓取 |
| [抓取统计](https://support.google.com/webmasters/answer/9679690?hl=en) | 主机、响应和资源类型的不同统计范围 |
| [AI搜索基础](https://developers.google.com/search/docs/appearance/ai-features) | 常规SEO要求继续适用，不承诺额外AI引用 |
| [Web Vitals](https://web.dev/articles/vitals) | 实际用户LCP/INP/CLS阈值 |
| [CloudBase响应上限](https://docs.cloudbase.net/error-code/EXCEED_MAX_RESPONSE_SIZE) | 官方6MB响应限制；与实际错误、仓库Base64响应实现交叉确认 |

查阅日期均为2026-11-05。CloudBase错误响应指向的英文错误说明链接在Web读取器中无法打开；使用官方文档MCP读取中文错误页及上限页，没有将打不开直接说成腾讯服务故障。无Context7工具，未声称用过它。

GitHub技能源：[seo](https://github.com/addyosmani/web-quality-skills/blob/afa8da942115f2961fdbfa80807ea0b232ff6c00/skills/seo/SKILL.md)、[web-quality-audit](https://github.com/addyosmani/web-quality-skills/blob/afa8da942115f2961fdbfa80807ea0b232ff6c00/skills/web-quality-audit/SKILL.md)。references文件的SHA-256列入证据清单；后续升级技能时重看变化，不以旧检查表代替最新官方规则。
