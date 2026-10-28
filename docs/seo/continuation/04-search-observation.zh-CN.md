# 04 搜索平台核对与变化记录

## 需求

把“技术上能被收录”与“Google/Bing实际收录”分开，覆盖营销页、分类、商品及正式Blog。保留已有验证文件和稳定sitemap；不为每次代码发布重复提交整站，也不把通用Google Indexing API当普通商品/文章的快速收录入口。

## MIU SEARCH-01：读回平台状态并建立对照

先运行01的只读检查：地图全部URL合法、当前公开商品数量一致、页面初始正文与规范网址正确、私有页面不在地图、错误返回404/503、公开图片允许抓取。抽样与全量分开。Google/Bing以前验站和提交成功是历史记录，仍需从客户既有账号核对当前站点、地图处理情况及覆盖报告。

GSC先查少量代表URL：首页、一个分类、一个商品、已确认保留的Blog及一个已撤回URL。记录用户声明canonical、Google选择canonical、最近抓取、是否允许收录、具体排除原因；Bing记录相应地图与URL结果。未登录或权限不够时保留unknown，不从site:搜索估计收录总数。请求重新抓取仅在页面验收后，针对必要代表URL；大批页面依靠稳定地图和真实lastmod。

结果形状：`{url, checkedAt, technicalReady, platform:'google'|'bing', indexing:'indexed'|'excluded'|'unknown', lastCrawlAt?, reason?, evidenceRef}`。平台原始账号资料不进公开仓库；交付脱敏结果和观察日期。后续观察窗口按真实抓取频率调整，不能承诺一天内收录。

## MIU SEARCH-02：只记录已上线的有效变化

继承原SEO-REL-E1，输入只来自已经接受的公开内容版本，不消费尚未交付的dist。Blog使用公开事务版本，商品使用03的验收版本。数据库或私有草稿变化不通知搜索引擎。

按规范URL保留最新变化：`{url, source:'product'|'article', sequence, semanticHash, state:'present'|'withdrawn', acceptedAt, notBefore, lastDeliveredHash?}`。页面、地图和真实404立即对应当前公开状态，不能为通知稳定窗保留撤回URL。通知可以合并约30分钟的短暂变化；该窗口是项目选择，并非Google规定。

A→B→A只有确认A已通知且B尚未发送时可消去重复通知。没有已送达依据则保留当前状态。B已发出不能撤销，按A当前状态后续纠正。通知失败或超时只改通知结果，不回退网站；外部服务已收请求但回复丢失时记unknown，保留尝试编号并做受限重试，不伪造sent。

先交事件记录与预览，默认发送器disabled。后续可接IndexNow：只发同站规范公开URL及已确认撤回URL；密钥按官方同站验证文件方式管理，与网站登录/CloudBase密钥无关。Google仍依靠地图与GSC，不把IndexNow写成Google接口。

测试：相同内容不重复、不同激活的旧事件被覆盖、A→B→A合并、有无已送达依据、disabled不算sent、超时不回退网站、草稿与私有图不入队、代码更新但语义相同不发通知。恢复演练不反复对真实搜索平台制造无意义测试提交。

### 拟实现的验证入口

SEARCH-01：`scripts/search-observation.test.mjs`，验证indexed/excluded/unknown的转换、证据时间与缺权限；SEARCH-02沿用原计划`node --test scripts/search-release-events.test.mjs`。平台真实结果另留带日期的脱敏回执。上述新文件仍未实现，现有IDX-01只交付技术就绪检查，不能冒充平台收录查询。

## 10月29日已读取的实际平台结果

本机常用Chrome仍保留客户站长平台登录，本轮直接复用了原标签，没有开新浏览器或重新要求登录。Google地图报告成功，发现10个网址；Blog地图最后读取10月27日（2网址），静态地图最后读取10月22日（8网址）。覆盖报告更新到10月23日，显示已收录3、未收录7；后者包含重定向1、正确canonical替代页1、已发现未收录5。它们是平台显示的旧报告，不当作今天全站计数。

Bing地图报告成功，发现517个网址，最后抓取10月26日；本轮没有读到Bing实际已索引总数，不把517写成已收录。两者与本站当前地图539网址不一致，需在页面规则修复后核对重新读取，不能把历史验站成功当作收录完成。

另抽查一个真实商品：Google索引查询显示URL尚不为其所知；实时URL测试于页面显示的10月29日02:30成功抓取，并给出“Page can be indexed”。Breadcrumb有一个有效项目。Product snippets因缺offers、review或aggregateRating显示一个无效项目。这证明基础可抓取与商品增强展示是两个验收层次；不把一次实时测试说成已经收录，也不把此样本推广为所有商品均有相同平台结果。

本轮没有重提地图、请求编入索引或申请移除。真实截图保存在本机私有证据目录；[脱敏平台记录](evidence/platform-observation.json)随代码交付。下一步先修01发现的图片规则、确认Blog内容范围，再处理地图重新读取和代表URL请求；旧重定向/替代页先核对当前URL行为，不一律当成缺陷。
