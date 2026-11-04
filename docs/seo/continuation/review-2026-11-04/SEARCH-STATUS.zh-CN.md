# Google、Bing 本次复查

观察日期：2026-11-04。以下来自现有登录会话的实际界面；没有重新登录或换浏览器。平台汇总、单网址历史结果和实时测试分开记录。原始摘要见[platform-observation.json](https://github.com/vibelingan/channel/blob/archive/docs-evidence-2026-11-05/docs/seo/continuation/evidence/2026-11-04-performance/platform-observation.json)。

## 当前结论

|检查|实际看到什么|说明与后续|
|---|---|---|
|Google sitemap|Success，539个网址，最近读取11月1日|地图可读且已被发现，不等于539页全部进索引|
|Google汇总|仍显示3收录、7未收录，但数据日期停在10月23日|不能当成11月4日网站覆盖率；单网址结果比这份旧汇总更新|
|Google代表商品|URL is on Google；11月4日抓取成功，允许收录，Google canonical为检查地址|这件商品已有真实收录结果；不推广为528件商品全部收录|
|Google代表文章|历史结果仍是10月29日noindex；本次实时检查允许收录|旧抓取记录待更新；本站现在允许，不代表Google已经重新抓取|
|Google文章重抓请求|普通尝试及刷新后再试均失败；页面提示无法连接reCAPTCHA服务|没有收到提交成功回执。未绕验证码、未连续刷请求，也没有因此改网站robots|
|Bing sitemap|Success，539网址，0错误0警告，最近抓取10月30日|地图正常|
|Bing代表商品|已发现，尚未抓取；实时检查可收录|本次点击请求收录，收到Indexing requested回执。请求已接受，实际收录仍待Bing处理|
|Google Core Web Vitals|报告更新11月2日；手机与桌面都显示最近90天使用数据不足|没有真实用户达标结果；本轮用54次美国实验室测量补诊断，不能代替CrUX|
|Google视频|报告更新11月2日；1个未收录、0个已收录，原因Video isn't on a watch page|对应首页的工厂介绍视频，最后抓取10月31日；不是视频文件报404|

代表商品：/products/p-003a6310-5244-4766-adfa-eb1002ad0fb4/。
代表文章：/blog/oem-headphone-sample-inspection-wecom-20261027/。

## 视频为什么不能只补一个字段

这段视频附在公司首页，首页的主要目的不是观看这一段视频。Google当前给出的就是“不是观看页面”。如果业务希望争取视频搜索展示，后续应设计真实的视频介绍页：视频是主要内容，有可见播放入口、准确介绍、稳定缩略图及符合实际的VideoObject。不能把首页伪装成观看页或只加schema后就说已解决。[Google视频要求](https://developers.google.com/search/docs/appearance/video)。

## 仍需处理的问题

商品检查同时显示Product snippets一个无效项、Breadcrumbs一个有效项。商品能够进入普通网页索引，与是否具备价格等增强展示资格是两件事。没有可公开真实报价、评价时，不编造Offer、评分或客户评价来消警告。应单独审查真实公开价格条件与结构化数据输出，不能宣布该警告已修复。

Bing实时检查提示标题长度、简介长度及6处图片alt。需对照实际HTML逐个确认：图库装饰性缩略图可能使用空alt并由按钮提供名称，不能把所有空alt批量替换为堆关键词的文字。本轮记录了提示，尚未做这部分页面变更。Bing的markup面板本次加载失败，不能据此判断schema通过或失败。

“重抓已提交”和“已收录”须分别验收。Google说明请求不保证立即甚至最终收录，重复请求不会加速；本站负责内容可读、规则正确、网址稳定和地图准确，平台何时抓取仍由其调度。[Google重抓说明](https://developers.google.com/search/docs/crawling-indexing/ask-google-to-recrawl)。

## 下一次复查

先解决Google页面的reCAPTCHA连接问题，再对少量重要文章重试一次；需要人完成验证码时交由账号持有人操作。保留sitemap固定地址，不反复提交500多次请求。后续按URL检查实际抓取日期、Google选定canonical和索引状态；记录新旧结果，不把旧汇总当新验收。
