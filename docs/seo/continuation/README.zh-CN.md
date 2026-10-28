# 公开内容自动更新与搜索收录

2026-10-29。用户把商品变更自动更新SSG、Blog正式收录及其他公开页面收录提升为最高优先级。本轮沿用feat/seo-foundation，在既有功能上补齐；暂停上一轮收尾合并，不新开分支或worktree，不动其他工作流。

## 先说核对结果

旧设计并非没有写：`execution/02-coordinator.zh-CN.md`的B2讨论公开内容版本与写入协调，`execution/05-search-events.zh-CN.md`的E1讨论成功发布后的搜索事件。这些当时标为planned，当前也没有找到接入全部商品写入方的代码。不能因为已有MIU编号，就说自动更新已经完成。

已实现并真实验收的是商品独立URL、构建时正文、浏览器实时API，以及Blog后台与Astro实时文章服务器。Blog已有`BLOG_PREVIEW_ONLY`开关与受控开放工具，尚未完成开放前后的完整核对；旧工具还把文章服务器与两个API的源码SHA要求相同，而当前服务已有独立交付版本，不能直接照旧入口盲目执行。

10月29日只读核对：首页和headphones公开页可访问、canonical指向自己；Blog及其sitemap返回noindex,nofollow；站点索引引用静态sitemap与Blog动态sitemap。商品图片走`/api/images/`，现行robots却禁止整个`/api/`，这是本轮先修的明确缺口。`/catalog/`不是本项目现有公开入口，返回404不按页面故障处理。

本轮开始核对时main=b3d63ac1、test=91443842、SEO HEAD=e82f1fdc。10月28日尝试收尾提交时，本机磁盘空间耗尽，提交和推送未成功；工作文件仍在。那轮全量本地测试也出现浏览器超时，不能标成通过。本轮不复用它作验收结果，不修改pricing测试来掩盖失败。

## 按模块交付

| 模块 | 独立交付结果 | 本轮状态 |
| --- | --- | --- |
| [01 页面收录规则与Blog开放](01-indexing.zh-CN.md) | 查清所有发现入口；公开图片可抓取；Blog正式域名开放前后均有真实核对 | IDX-01已实现，本地与三组远端检查通过；Blog内容范围待用户决定 |
| [02 商品公开变更记录](02-product-changes.zh-CN.md) | 商品公开版本和更新待办同事务提交，所有写入方有清单与测试 | 完成设计；尚未修改商品事务或创建云资源 |
| [03 商品SSG自动交付](03-product-delivery.zh-CN.md) | 合并变更、更新快照与页面、处理撤回，复用已有备份和恢复 | 完成设计；依赖02及内容专用交付包 |
| [04 搜索平台核对与变化记录](04-search-observation.zh-CN.md) | GSC/Bing真实结果、sitemap与页面一致；通知去重，失败不回退网站 | 设计与首轮平台只读核对完成；外部通知尚未实现 |

[完整工作流程](diagrams/search-continuity.html)。流程图中“待接入”是目标流程，不冒充已上线；[详细时序](diagrams/product-refresh.html)说明同一事务记录、异步更新及失败处理。

## 为什么采用这个方案

继续用Astro、React、CloudBase和已有部署锁。商品公开变更在数据库里先留下可靠待办，提交成功后尽快唤醒更新工作；短时间的连续修改合成最新版本。定时检查只负责补漏，不作为文章发布的等待条件。Blog继续实时读公开版本，不加入商品构建队列。

另一个可行选择是把商品也迁到实时服务器，但这会扩大现有渲染和部署变化，不是本轮默认方案。只定时抓全量商品并重建则无法清楚说明撤回和旧任务覆盖问题，成本也高。当前选“公开变更记录＋内容专用交付”，保留现有页面交互。

目标是提交后一分钟内尝试启动商品更新，常规小批次端到端争取八分钟内。它们是本项目拟验收目标，不是GitHub或腾讯的时效保证；当前41分32秒流程没有达到，自动更新不能直接绑在这条全站慢流程上就宣称完成。需要03的小批内容交付实测通过后启用。

## 不变的业务要求

所有当前公开商品都参与，不增加“合格商品”门槛。草稿、会员及内部字段不进公开HTML；浏览器继续取当前API。商品撤回处理公开URL与发现入口，不删除业务历史。程序恢复不回灌文章、商品或凭证。每个模块单独记录设计、代码、本地、远端、线上验收及启用状态。

## 官方依据

- [Google robots规则](https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag)：HTTP头中的noindex同样生效；不能只改HTML标签。
- [Google sitemap要求](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap)：列规范网址，lastmod来自真实内容变化；提交地图不保证收录。
- [Google canonical要求](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls)：正文、内链和地图指向一致网址。
- [GitHub事件条件](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#repository_dispatch)：外部事件入口在默认分支，执行源码仍须显式固定；不能随事件输入运行任意分支。
- [IndexNow官方FAQ](https://www.indexnow.org/faq)：可以通知新增、修改和删除，是否收录由搜索引擎决定。

本轮没有改线上配置或客户内容，没有重提地图或请求编入索引。后来复用已有登录读取了Google/Bing报告，并执行一次Google实时URL测试，结果见04的平台记录；这与已收录状态分开。

## 本轮实际交付记录

IDX-01已实现：共享HTTP/HTML收录检查、当前商品网址与地图核对、全量/抽样只读命令，以及公开图片的robots例外。13项定向测试通过；站点类型检查0错误、0警告、11条既有提示。真实站点全量读取539页（含528商品），536页通过初始HTML规则；3个Blog地址被HTTP头禁止收录，另有公开商品图的robots阻塞。再次核对当前公开API为528个商品，与地图一致，没有发现漏列或残留网址。正文是否随未来修改自动更新仍是02/03的工作，不能用本轮静态检查替代。

代码中的图片规则还没有部署，本轮没有线上写入。Blog保留内容的决定仍在等待用户回答。商品事务、云端调度、自动SSG、正式收录开关和搜索通知尚未启用。图已通过9项结构检查、四种桌面尺寸的浏览器检查，并查看1440及2048截图；图表达目标流程，不当作完成凭据。[脱敏验收记录](evidence/verification.json)、[全量HTTP/HTML检查](evidence/live-all-pages.json)、[当前商品清单核对](evidence/live-inventory-and-sample.json)。

表达核对：阅读humanizer及plain-technical-writing，审阅旧B2/E1、现有Blog middleware、独立服务发布入口、商品快照采集/复用和公开图片权限。把“商品自动更新已有MIU”改成“有旧设计，尚未接通全部写入方和自动交付”；把“539页检查通过”改成“539页已读取，列明四处阻塞”，保留实际范围与未完成项。

补充平台现场结果：Google旧覆盖报告显示3已收录（更新10月23日），地图发现10；Bing地图发现517。抽查商品Google实时抓取成功、允许收录，索引查询仍为URL unknown；另发现商品增强展示缺真实Offer等必填内容，已增加IDX-03设计。不是网站539页“已经收录”，也不是全部SEO问题只剩先前四处技术阻塞。[平台实际结果](04-search-observation.zh-CN.md#10月29日已读取的实际平台结果)。

代码提交9bf5e7cb已推送原分支，三组远端检查均成功：[发布模块与原有流程回归](https://github.com/vibelingan/channel/actions/runs/40735366612)、[文章服务器HTTP验收](https://github.com/vibelingan/channel/actions/runs/40735366650)、[Blog隔离检查](https://github.com/vibelingan/channel/actions/runs/40735366530)。本轮这些push检查不部署网站；线上图片规则仍需后续受控发布。

实施顺序：IDX-01已完成；商品线接着做CAT-01、CAT-02、SSG-01、SSG-02。Blog线在保留范围确定后做IDX-02，并接SEARCH-01的代表网址验收；SEARCH-02仅消费已经交付成功的变化。IDX-03单独处理真实报价与商品增强展示，不能为了消除搜索提示改变报价含义。各模块的代码、云端验收和正式启用分开记录，不因另一条线等待而停下清楚的工作。
