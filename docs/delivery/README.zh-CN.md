# SEO / Blog：当前进度与执行入口

11 月 21 日，官网已为 74 张商品照片补齐合适的网页尺寸。独立读回 30 个商品页、108 处图库位置；手机点击和键盘换图均通过。选三页在日本同一手机慢网条件下前后各测三次，五张可见小图由两页超过观察上限 40 秒、另一页 31.75 秒，分别降到 8.08、11.37、4.68 秒。528 件商品的业务内容和三篇公开文章未改，六张历史故障图片均可完整打开，本次临时函数均已清理。Google 复查尚没有通过结果。 [官网交付](https://github.com/vibelingan/channel/actions/runs/44810600669) · [真实浏览器对照](../seo/continuation/next-phase-design-2026-11-05/06-page-performance.zh-CN.md#11-月-21-日重图库的小图正式上线)

11 月 21 日，线上网页已覆盖 13 个商品页和 40 张已有商品图的小尺寸。后续分类请求去重也已发布，官网首次开目录、翻页和返回均从五次分类读取减到四次，第二页可见 12 件商品，代表商品可切换照片。两次发布均确认临时资源已清理。这次分类发布的商品快照与发布前逐字节相同，三篇文章的版本、正文摘要和发布时间也已核对。Google 仍在复查五张历史 4xx 图片，官网从这五个原地址取回的图片均为 200。生产包、发布耗时、排除地址和 Alibaba 图片的细节见复查记录。 [发布、生产文件和搜索复查](../seo/continuation/next-phase-design-2026-11-05/RELEASE-PACKAGE-SEARCH-2026-11-20.zh-CN.md#11-月-21-日补查发布来源生产文件和图片域名) · [分类请求交付](https://github.com/vibelingan/channel/actions/runs/44793279279)

11 月 20 日晚，公开图片接口上线了小原图的短时复用。耳机分类同一张首图，在直接请求的 6 次正式验证中有 4 次省掉腾讯对象存储读图，函数处理时间中位数 174.8→47.7 毫秒。整页四次测量中 LCP 2.714→2.676 秒，首次内容显示 2.188→2.312 秒。官网读回 528 件商品公开版本、三篇文章、地图和历史五张图片保持一致。[发布回执](https://github.com/vibelingan/channel/actions/runs/44715810485) · [详细数据与当前性能范围](../seo/continuation/next-phase-design-2026-11-05/REVIEW-2026-11-20.zh-CN.md#这轮跟进的耳机分类小图)


[11 月 20 日官网 SEO 与性能复查](../seo/continuation/next-phase-design-2026-11-05/REVIEW-2026-11-20.zh-CN.md)汇总本阶段交付、Google 八类报告、文章 17.31→4.54 秒的诊断和后续验收。Google 已收录 529 个网址，五张历史 4xx 图已在线读回、仍等 Google 完成复查。


11 月 20 日（东京时间），耳机分类试发时让首图更早发出请求，但整页首图显示在四次对四次的官网测量里中位数 4.23 → 4.48 秒，同一时段交替测试也有六对中的四对更慢。已通过同一发布队列恢复原分类写法，首页上轮提速保持。手机、电脑打开商品和询盘通过，528 件商品公开修订、三篇文章和五张历史故障图逐项读回，临时发布函数已清理。恢复后四次手机 LCP 中位数 4.83 秒，分类速度仍待改善。 [试发与恢复证据](../seo/continuation/next-phase-design-2026-11-05/06-page-performance.zh-CN.md#官网试发结果与恢复决定) · [恢复回执](https://github.com/vibelingan/channel/actions/runs/44653668498)

11 月 20 日（东京时间），首页样式已随官网 HTML 一次交付。发布前后按同一日本慢网手机配置各四次，首屏主要内容中位数 3.48 → 2.91 秒。收到网页第一批字节到看到文字由 1.87 → 1.12 秒；首字节等待仍约 1.75 秒。手机和电脑菜单、询盘入口、助手按钮通过。528 件商品修订、三篇文章正文和五张历史故障图逐项读回，两只本次辅助函数已确认清理。 [官网发布](https://github.com/vibelingan/channel/actions/runs/44580509731) · [前后数据和美日诊断](../seo/continuation/next-phase-design-2026-11-05/06-page-performance.zh-CN.md#正式首页少等一次样式后的实测)

11 月 20 日（东京时间），官网图片接口已支持短时复用校验过的商品小图，每次仍核对当前公开引用。相同两图前后各合计 12 次，函数内处理时间中位数 210.4 → 42.4 毫秒，新版 9 次省去存储读取。528 件商品修订、三篇文章、两份地图和五张历史故障图通过现场比对。Google 仍待复查五张图，搜索报告仍到 11 月 17 日。 [正式发布](https://github.com/vibelingan/channel/actions/runs/44574716950) · [性能与访问保护验证](../seo/continuation/next-phase-design-2026-11-05/06-page-performance.zh-CN.md#11-月-20-日商品多尺寸图片短时复用)

11 月 20 日（东京时间），代表商品的四张图库小图已交付官网。手机、桌面实收共 9,748 字节，之前四张合计 819,151 字节，点开仍用清楚的大图。切规格和询盘打开均通过。528 件商品的公开版本、三篇文章正文与两份地图已读回比对，两只临时发布函数确认清理。三次手机复测里还观察到一次 12.96 秒的慢加载，主图的腾讯存储读取其中用了 5.17 秒。六次单独复测未重现，整站速度还不能结案。 [正式发布](https://github.com/vibelingan/channel/actions/runs/44564948867) · [复盘与下一段排查](../seo/continuation/next-phase-design-2026-11-05/BRIEFING-2026-11-19.zh-CN.md)

11 月 20 日（东京时间），工厂观看页已交付精简样式和按需加载的商品菜单。官网样式从 102,058 降到 27,021 字节，访客首次打开网页时少发四个分类请求。五次对五次的手机慢网实测，内容首次显示中位数 5.22→3.91 秒，海报显示中位数 6.06→5.31 秒。手机、电脑的菜单和视频跳到第 80 秒均实测通过。528 件商品公开版本、三篇文章正文及五张历史故障图已独立比对。Google 对历史 4xx 的复查仍显示已开始、5 项。 [正式发布回执](https://github.com/vibelingan/channel/actions/runs/44554929661/attempts/2) · [性能证据](../seo/continuation/next-phase-design-2026-11-05/06-page-performance.zh-CN.md#工厂观看页先下载自己需要的样式和数据) · [搜索复查](../seo/continuation/next-phase-design-2026-11-05/08-search-and-outcomes.zh-CN.md)

11 月 19 日晚间，官网地图已改为使用工厂观看页实际播放的首选视频地址，按范围读取 1,024 字节返回 206。手机与电脑实际播放、跳到第 80 秒和首选出错时使用后备地址均已验证。独立核对 528 件商品版本、三篇文章正文和五张历史故障图，本次临时函数均已清理。Google 视频报告仍有待复查。观看页的手机慢网首屏为 6.16–7.89 秒，已用 Chrome 找到网页、海报、样式等待，并在本机隔离对照中测出压缩样式的收益。官网侧压缩还没有启用。 [官网发布回执](https://github.com/vibelingan/channel/actions/runs/44543334463) · [视频交付与索引状态](../seo/continuation/next-phase-design-2026-11-05/05-video-and-content.zh-CN.md#视频地图与播放器共用正式地址) · [性能证据](../seo/continuation/next-phase-design-2026-11-05/06-page-performance.zh-CN.md#11-月-19-日观看页首屏在等什么)

11月19日SEO复查与性能复盘见[同一份执行记录](../seo/continuation/next-phase-design-2026-11-05/EXECUTION.zh-CN.md)。官网五张历史4xx图片再次完整读取成功，Google旧记录仍在复查；主域HTTP永久跳转、视频正式索引和整体手机性能尚未完成。文章首图的减重和优先加载已用历史Lighthouse与新增同条件Chrome对照分别验证；本轮六张商品图候选还在本地，未交付官网。

11月18日当前交付：官网网页程序 `37945593` 已成功发布，当前登记 `site-44302615483-1`，50步成功/49次写入核验，528份商品HTML与本次候选一致；配置专属照片在最初HTML中已有正确尺寸。三件代表商品在手机/桌面的图库、规格和询盘操作通过。528条商品公开版本、6条文章发布登记逐项不变，两只本次临时函数确认删除；没有创建测试商品，也没有重发业务函数、Blog服务或Sales程序。实际后台私有大图上传和清理已通过，浏览器Retry没有触发。本轮为正常网页发布，没有再做一次旧程序恢复。main/test分支未合并，现场发布来自原SEO分支。

代码`37945593`的20组远端检查及两项文章检查通过。三轮美国测量共72份报告完成。相对最初2adb，804e手机图片约305→96KB，LCP5.02→3.96秒，桌面2.67→1.81秒；ffc8手机5.02→6.94秒、桌面1.87→3.47秒，反而变慢。公共CSS误扫依赖的27,647字节已修复并真实交付；原图/业务内容保留，整站性能仍未达标。慢样本中同一16KB主图从请求到读完仍约1.9–2.8秒，下一段先测商品图片接口内部耗时，再决定优化。详细实际结果见[图片](../seo/continuation/next-phase-design-2026-11-05/01-images.zh-CN.md)及[完整前后性能数据](../seo/continuation/next-phase-design-2026-11-05/06-page-performance.zh-CN.md)。下方日期记录保留历史，不代替当前状态。

2026-11-17本轮收尾：图片接口的分段耗时记录已由正常Test44062775662交付，源码10f04fc3，三项专项CI及现场验收均成功。两图六次完整读取正常，内部处理中位数986ms，83.1%的内部等待在公开状态核对；尚未将测量冒称提速。528商品公开版本、3篇文章内容/修订/时间、独立文章服务和既有Sales开关均保留，本次临时函数已清理。[实际性能与交付证据](../seo/continuation/next-phase-design-2026-11-05/06-page-performance.zh-CN.md)。Google最新528已收录；5个历史图片错误仍待平台复查，现场五图均200。完整CSV截至11月15日为80展示/3点击，未证明稳定获客；[平台日期与结果](../seo/continuation/next-phase-design-2026-11-05/08-search-and-outcomes.zh-CN.md)。

2026-11-17文章性能续作：源码ca4fadf6的三项专项CI和[正常Test发布44041810162](https://github.com/vibelingan/channel/actions/runs/44041810162)通过，528商品和3篇文章内容/版本/时间保留，本次辅助函数清理，商品自动更新与Sales开关保留。图片直达接口和切回旧方式均真实通过，但18份美国样本未证明提速，最终保留旧转发方式；手机直达4.882→4.908秒、桌面2.406→2.728秒，变化与不同节点均如实保留。[三轮数据、恢复和下一段诊断](../seo/continuation/next-phase-design-2026-11-05/06-page-performance.zh-CN.md)。收尾已吸收同分支联系人提交20bfbe40，不干预其发布。

2026-11-17联系方式已上线：电话 +852 9545 3560、邮箱 sales@supplychainsai.com。官网PR #92已合入main（e698674f）；在现站ca4fadf6上仅同步本次联系方式及必要CI兼容修复，正式发布来源20bfbe40。网站Deploy Test 44049939166成功，528商品页面交付已接受；独立文章更新44051478271后，blog-pages-020为100%流量，健康入口返回20bfbe40，现有图片处理设置proxy保留。8类页面在390/1440宽度共16项真实浏览器检查通过，新电话、链接和结构化信息一致，旧电话未出现。diversity-public公开库6中4篇资料已更新、1篇未变，公开只读入口读回5篇；新会话使用普通中文问法，直接回答正确电话和邮箱并显示来源入口。发布锁已释放，本轮临时函数已独立确认清理。详见[本轮记录](public-contact-20261117/WORKLOG.zh-CN.md)。

2026-11-17只读补查：销售分支合入test后的Deploy Test43863127289成功。admin/public-api运行9eba4074，同步函数保持66c915dc；商品变化记录、HTML页面准备和定时更新仍开启，既有Sales开关保留。本次只读核对7次，没有云端写入。下文11月16日记录保留当时验收版本及性能数据。

2026-11-16最终现场更新：现有PR71已合入main，test以`66c915dc`正常部署成功（43774312394第2次），网站登记`site-43774312394-2`；528商品和3篇公开文章版本/内容/时间未退回，两个本次辅助函数确认清理，商品记录与自动更新配置保持开启。Blog图片显示已启用，旧GET、原图和新副本均通过，关闭后再开启也不改文章。文章两图减少94.54%字节，选定7张商品图减少90.57%。[24份美国After](https://github.com/vibelingan/channel/actions/runs/43779782125)全部有效：手机文章LCP17.306→4.539秒，804e商品5.973→4.662秒，ffc8商品7.198→4.291秒；对照和未改善项也保留。仍不能称全站CWV达标。查看[完整前后数据与边界](../seo/continuation/next-phase-design-2026-11-05/06-page-performance.zh-CN.md)。主域HTTP301、自动准备新图片、真实尺寸、报价增强/视频与其他模块仍有后续工作；CDN后置，发布提速归其他工作流。

2026-11-16 现有 Sales 询盘部署与真实验收已按用户要求恢复推进，当前记录见 [官网询盘到 Sales 修复记录](../sales-agent/verification/LIVE-SCF-WIRING-20261116.zh-CN.md)。该记录更新本页下面 11 月 10 日“仅设计”的旧范围；不改变 SEO／Blog 的交付状态。代码、本机检查与线上完整验收分别记录，尚未把新询盘流程写成验收通过。

> 2026-11-16：客户要求的受限直接发布接口已部署，内容/发布两机新工具已加载；真实图文保存、公开、重试、撤回通过，测试文档301已撤回，客户现有公开文章未变。[发布实测](../blog/agent-design/formal-use/PUBLICATION-EXECUTION.zh-CN.md)区分原私有稿297和已公开修正版300，以及尚待核对的反向改稿协作。Google列出的5个图片400已修复：最终运行 `43752358379` 使用包含现站Sales接线的 `ec0c3adf`，18张公开图真实200、1张无公开引用保持404；首次候选遗漏Sales后已精确恢复并重新整合发布，过程和改进见[修复记录](../seo/continuation/next-phase-design-2026-11-05/FIX-4XX-20261116.zh-CN.md)。Google截至11月9日的报告记录已收录527个地址，完整导出与美国线路Before见[11月16日实测](../seo/continuation/next-phase-design-2026-11-05/BEFORE-20261116.zh-CN.md)；这些数字不代表全站SEO已验收完成。

2026-11-16商品自动更新已恢复并真实验收：此前常规部署关闭了记录/页面准备配置；本次先恢复记录、重新等待1,020秒，交付528商品及46分类页，再补全部528项来源复核，最后启用定时检查。专用GitHub App实际自动启动43769627109，成功登记 `site-43769627109-1`；商品公开版本和交付产物与复核前一致，两个辅助函数由回执及独立目录确认已清理，业务函数代码、商品/Blog内容未回退。GitHub test三个SEO配置也已保存，后续缺配置会在写入前停止。当前地图583地址是可抓取入口数，不是即时索引数；本轮没有实际修改商品正文或撤回商品来演练。详见[实际恢复与验收](../seo/continuation/next-phase-design-2026-11-05/EXECUTION.zh-CN.md#商品自动更新2026-11-16恢复与验收)。


2026-11-12评审修订：已同步原SEO分支的CloudCall/Claude批注，逐条回应并更新[执行顺序与模块设计](../seo/continuation/next-phase-design-2026-11-05/EXECUTION.zh-CN.md)。先留当前性能/搜索记录，再盘点修图、清理无效Product、做分类路径分页；请求重构暂缓。缓存五分钟及新大图暂不激活为待确认建议，尚未部署。独立SDK测试15/15通过，完整门禁未重跑。只更新设计、图源和核验记录，没有新建分支、合并main或改线上；下方同日较早记录中的顺序以新计划为准。

2026-11-12：按本轮“先设计、不实施优化”要求，已补[七个模块的高层/底层设计、22个可验收小任务和执行计划](../seo/continuation/next-phase-design-2026-11-05/EXECUTION.zh-CN.md)。[案例页现场核对](../seo/continuation/next-phase-design-2026-11-05/PORTFOLIO-CHECK.zh-CN.md)确认portfolio正常200、初始HTML与无JS手机/电脑均有完整两项案例，未复现截图所说缺陷，无代码热修。三张商品图仍400，修复尚未实施；原图校验正常不等于网站已修。CDN延后，发布提速交其他工作流，本次不改其代码或CI。已同步原SEO分支a298f1ef，未合并其他工作流。

2026-11-06 页脚合作方已上线并线上验收：main 源码 `16c86ed5`；网站发布源码 test `ca348d93`，Deploy Test `42203918830` 第3次运行成功；文章发布源码 feat/seo-foundation `cdd7225f`，完整 CI、Blog HTTP 及服务更新 `42218313506` 成功，正式健康检查返回同一提交，服务正常并承接100%流量。手机与电脑共14组页面检查通过，保留现站功能。用户另行授权的14份既有文件格式修正已提交，13份 JSON 数据核对不变。最终证据和历史见[页脚工作记录](footer-manufacturing-partner/WORKLOG.zh-CN.md)。

2026-11-05 当前入口：[实际搜索效果](../seo/continuation/effect-review-2026-11-05/README.zh-CN.md)、[平台逐项核查](../seo/continuation/audit-2026-11-05/README.zh-CN.md)、[下一阶段九模块高层设计](../seo/continuation/next-phase-design-2026-11-05/README.zh-CN.md)。商品自动更新已于11月4日启用并真实验收；www 301已上线，主域HTTP 301仍待完成；美国与本机各54次优化前基准完成，性能和海外CDN尚未实施。三张原图正常、网站传输超限；先前Blog分类400诊断依据不足，已在新设计更正。下方保留历史记录，不能把其中的“当前”当作今日状态。

AI／Sales／Apollo本轮仅做规整与设计评审，入口为[统一评审稿](../ai-platform/review-20261110/README.zh-CN.md)。交付分支统一为`release/assistant-seo-20261104`；不因此发布官网或修改本页其他交付状态。

2026-11-09 官网旧版聊天回复修复：代码 `0b9a78f6` 已经正常发布到 supplychainsai.com，[42582880958](https://github.com/vibelingan/channel/actions/runs/42582880958) 的部署、托管读回和后台冒烟作业成功，受控交付 `site-42582880958-1` 已接受。根因是后台只返回最终正文时，旧组件没有显示它，留下省略号；本次补齐最终正文、空答案提示和立即显示的 Thinking。官网真实桌面／手机尺寸五项问答均收到回复（3.4–10.1 秒），用户原 Chrome 标签页也已复测；未使用本地 API 或数据库替代线上。为保留既有入口，`PUBLIC_AI_CHAT_V2` 从待发布的 `1` 改为 `0`；询盘和 Sales 开关保留原值，没有启用整套新 UI、重启 AI／Hermes Agent 或发邮件。新卡片、询盘交互及完整 Sales 流程仍须分别验收。详见[修复及真实官网结果](../ai-platform/assistant-ui/README.md#已发布与真实官网复验)。下方 11 月 7 日及更早状态保留作历史记录，不能覆盖本次上线结果。

2026-11-07 AI 发布：继续沿用 Claude 整合的发布分支，业务源码 `25f2ddfe`。AI BFF／worker 的 [42274705769](https://github.com/vibelingan/channel/actions/runs/42274705769) 已成功，两项服务版本 014 正常，真实库、模型和 VibeKB 问答已验收。网站发布 [42278206855](https://github.com/vibelingan/channel/actions/runs/42278206855) 的完整 CI 通过，但创建临时区域函数被腾讯云以“账户余额不足”拒绝，尚未上传新版网页；原网站保持现状。负责人充值后，核对最新改动并只重跑失败的发布任务。新界面在本机接真实后端的八项检查通过；手机刷新后卡片图片及正式域名下的新界面仍待验收。Hermes Sales 的 `6d9793a` 已推远端，真实 MySQL／容器／缺陷注入 CI 成功，但实际中枢的合法 SSH 入口未核实，未安装或重启生产 Agent。Resend 仅验证未发送草稿，未发邮件。当前结果、恢复材料、两项外部条件及下一步统一见[助手发布记录 §7.1](../ai-platform/assistant-ui/ROADMAP.md#71-现在本轮按顺序不需要再决定)。

2026-11-06 页脚合作方发布：main 已有代码提交 `16c86ed5` 和交接记录 `8d3dca6b`。用户确认允许只将页脚补丁同步到现用发布版本，保留现站助手、隐私页及其他行为。本次在 `test=fa8c8cd1` 上仅增加 Contact Us 下的 Manufacturing partner 说明与 Channel Technology Limited 官网链接，既有 Privacy 入口保留；34 项相关测试通过。准备经正常 Deploy Test 运行完整检查和发布，文章服务另走既有独立发布入口；此时尚未上线。恢复来源是本次写入前对 fa8c8cd1 的备份及现用 Blog 镜像，不回灌数据库。详见[工作记录](footer-manufacturing-partner/WORKLOG.zh-CN.md)。

2026-11-06 最终测试发布：release/assistant-seo-20261104 在 a7ee7b90 之后又合入 #72（docs 证据归档到标签 archive/docs-evidence-2026-11-05）、#73–#76（部署提速）、#77（函数备份名带重跑次数）、#78（CloudBase 项目技能 .claude/skills/cloudbase-engineering）、#79（Codex 在 #71 的三条发现：BFF 暴露 Retry-After、worker 自身超时会终止运行、刷新保留可续接的回答；外加 sales-integration 冻结时钟导致的 CI 偶发失败）。test 快进到 3984f6b5，Deploy Test 42101386132 一次通过，总用时 31.4 分钟（11月4日含重跑为 127.6 分钟）：CloudBase 步骤 4.8 分钟，网页送达 4.3 分钟；网页产物与上一版相同（52a8a8b2…），因此仍是 0 页上传，大量页面变化时的耗时尚未实测。线上读回：三个函数 deployedReleaseId 均为 3984f6b5（代码未变，releaseId 保持 f2226549）；11 个页面及 sitemap/robots 为 200；首页新主体名 15 处、旧名 0 处；区域临时函数两次清理均已确认；函数备份名为 function-backup-before-3984f6b5…-42101386132-1。AI 新聊天仍关闭，BFF/worker 的修复需新 DATABASE_URL 后经 ai-cloudrun-deploy 标签单独发布。经验已提交 engineering-craft #4、#5（待 Nina 审核）。回滚点不变：标签 rollback/test-live-before-20261105 → 91443842。

2026-11-05 发布：release/assistant-seo-20261104 汇合了 main（含 #70 公司主体名称）、test、feat/seo-foundation 和 Codex 的逐句流式回答修复，test 快进到 a7ee7b90，Deploy Test 41850270700 第2次运行通过（第1次在 alibaba-catalog-sync 私有压缩包上传失败，admin/public-api 已先更新，重跑失败步骤后通过）。线上读回：public-api health 为 a7ee7b90；首页显示 Diversity Innovations Limited 共15处、旧名0处；首页、/headphones/、/blog/、/privacy/、/oem/、/portfolio/、/admin/ 均为200。AI 新聊天仍关闭（PUBLIC_AI_CHAT_V2 未设，PUBLIC_AI_INQUIRIES=0）；PostgreSQL 已过期，AI BFF 需新 DATABASE_URL 后再经 ai-cloudrun-deploy 标签单独发布。回滚点：标签 rollback/test-live-before-20261105 → 91443842；函数恢复用第1次运行的 function-backup-before-a7ee7b90…-41850270700（第2次运行的同名备份已含新版 admin/public-api），网页用同次运行的 hosting-backup / site-recovery 产物。第1次失败原因是超时：该函数带 sharp 原生解码库，压缩包约9 MB，从 GitHub 机器传到上海通常要4–5分钟，旧上限300秒且不重试；已改为600秒，失败信息写明用时。本次尚未合入 main。

2026-11-04 当前状态以[本轮逐项验收](../seo/continuation/review-2026-11-04/README.zh-CN.md)为准：www 301已上线；主域HTTP 301未完成，试改已恢复；商品自动通知等待GitHub App授权；美国与本机各54次性能基准完成，性能优化尚未实施。下方保留此前阶段记录，不能把其中的“当前”当作今日状态。

## 此前阶段记录


<!-- formal-blog-latest -->
10月29日续作：[白话说明与四模块摘要](../seo/continuation/EXPLAIN.zh-CN.md)已补齐。Blog正式域名已开放收录、临时地址仍排除；列表和两篇文章通过Google实时测试，三个重抓请求均已接受。静态网站已通过受控发布40819519497，源代码08923537，公开图片抓取规则已生效。商品变化自动更新仍未启用，按02/03继续实现。最新验收与剩余工作统一看[模块总表](../seo/continuation/README.zh-CN.md)。
商品自动更新续作：实际保存、审批、同步与分类入口已接线，请求消费、增量快照和分批保护已写代码。10月30日第二轮10项真实CloudBase检查通过，含137批准变体跨页；本轮临时资源已自动清理并独立读回。539个正式公开网址只读复查通过。记录开关仍关闭，长期程序归档、可靠唤醒和实际自动页面交付尚未完成；目前线上保存商品仍不会因此自动刷新HTML。见[最新模块总表](../seo/continuation/README.zh-CN.md)。

最新状态：内容机→VibeKB工作区2→发布机→网站私有草稿已经接通，文档201、202的真实保存与重投通过；正式凭证已实际轮换，每小时维护已启用。群内模型任务仍待用户验收。见[正式接入结果](2026-10-27/wecom/FORMAL-USE-STATUS.zh-CN.md)。

图片专项已完成真实私有草稿验收：203原稿的两张现有图片已上传、排版并保存alt，版本2；重复交接不增图，旧版本插图被拒绝，刷新和预览正常。没有公开文章。见[实际验收](../blog/agent-design/formal-use/IMAGE-ACCEPTANCE.zh-CN.md)、[完整图片流程图](../blog/agent-design/formal-use/diagrams/image-draft.html)。下一步是用户在群里真实@内容助手验收，不需要重新安装。

10月29日优先级调整：先补商品变更自动更新SSG与正式搜索收录，[按模块实施计划](../seo/continuation/README.zh-CN.md)为当前入口。上轮收尾合并没有执行，原分支继续开发。

预览交互已修复并上线：点击后直接打开弹窗，长文滚动时关闭按钮仍可见；真实后台的两图、Esc、关闭与重开通过。见[修复与验收记录](2026-10-28/BLOG-PREVIEW-FIX.zh-CN.md)。

2026-10-28。本页是当前进度入口，后续会话先读这里，再看工作记录。沿用原 `feat/seo-foundation`，pricing 已合入 main 的内容已整合，未创建新分支或 worktree。

两个助手已安装正式工具，实际服务器已完成文档201、202保存和重投；自动凭证维护已启用。最新结果见[正式接入验收](2026-10-27/wecom/FORMAL-USE-STATUS.zh-CN.md)。早期[安装记录](2026-10-27/wecom/INSTALLATION-RESULT.zh-CN.md)保留作历史查证，不能用它覆盖本页的新状态。本轮没有发群消息或代替人公开文章。

## 目前有什么结果

| 模块 | 实际结果 | 还要做什么 |
| --- | --- | --- |
| 共享 SEO、商品独立地址与 SSG 正文 | 已部署并通过现场验收；最近一次完整采集 528 个公开商品，浏览器继续读取实时 API | 商品变化的自动触发、应急跳过及后续收录观察仍需独立完成 |
| 文章后台与直接发布 | 真实后台的编辑、图片、私有预览、发布、更新、撤回及重新发布已通过；正文、图片、列表和 sitemap 已接通 | 正式域名已开放收录，临时地址与私有预览排除；两篇公开内容按用户确认保留，搜索平台实际索引仍需跟进 |
| 静态网站交付 | 最新前端已接受；新增 Insights 入口和指定草稿直达，商品/分类/询盘实际检查通过；此前写入失败后的自动恢复也有现场记录 | 速度仍明显超过八分钟目标，下一阶段按实际耗时调优 |
| 文章服务器恢复 | 已完成真实 A→B→A；从已归档镜像恢复 A 后，正文、图片、404 和配置检查通过，普通网站正文保持一致 | 这是文章服务器的受控人工恢复；不代表全部业务后端已开放自动恢复 |
| 测试函数与数据恢复 | 真实 A→A、发布 B、B→A 均已通过；新字段、新记录、删除标记保留，旧程序修改与重复请求通过 | 本轮临时函数、三条记录、空测试集合及测试页已清理；不代表任意生产旧函数已获准恢复 |
| 内容助手 | 正式内容机到发布机再到网站的私有草稿保存、连续两篇及重投通过，自动凭证维护已启用 | 两机原生工具及企业微信连接已确认；图片文件交接、受限上传和后台排版已通过真实验收。群内图文任务待用户测试，正式多客户身份隔离仍单独交付 |
| 海外部署与整体提速 | 目标、问题与实测记录保留 | 按用户顺序后置，不为提速删功能或检查 |

test分支仍为91443842；当前静态网站已通过10月29日受控入口40819519497更新至08923537，已接受版本site-40819519497-1，商品快照为528个；前版site-40617257076-1的恢复包保留。此次只发布前端，业务云函数未重发；admin/public-api/alibaba-catalog-sync上次health读回为91443842，文章容器本轮实际更新并验收为71fb996b，正式收录开关已打开。独立article-import于10月27日经受控入口40510651334更新为7c99e891，图片能力与既有凭证保留；发布机工具为d68d3b82，内容机工具为6e0b6fd4。本次尚未合并剩余修复到main，test分支也未改；下次从main/test发布前须先吸收本分支经验证的修复，避免旧前端覆盖现站。每个程序记录自己的实际版本，不能把Git分支最新提交当作所有服务都已运行的版本。

## 平时到底由谁执行

- **改网站代码**：开发者推送后，GitHub 检查、打包，再经受控入口部署。商品 SSG 的快照随这次构建生成。
- **后台发文章**：管理员点击发布，CloudBase 保存公开版本。Astro 为访客返回当前文章 HTML；不启动 GitHub，不等定时任务。本文引用的 GitHub 文章验收任务只是自动化模拟管理员点击，客户平时发文不用运行它。
- **恢复网站程序**：开发者或 agent 在 GitHub 人工入口明确选择已验收的版本。写入后的失败可以走已有恢复流程；lint、测试或构建失败而没碰线上时，无需恢复。恢复代码不会倒退数据库。
- **助手写文章**：助手经受限接口存草稿，返回后台编辑链接；人审核后发布。两机正式工具已安装并绑定diversity工作区2，真实保存和重投通过；群内模型任务仍单独验收。

## 文章为什么不用等构建

管理员点击发布后，后台把指定保存版本确认为公开版本。访客打开页面时，Astro 读取这个公开版本并返回含正文的 HTML；列表、图片和 sitemap 读取同一状态。日常发文章不调用 GitHub，也没有五分钟定时等待。GitHub 中的文章验收任务是在替人操作页面并检查结果。

商品继续使用 SSG：构建时生成正文，浏览器加载后读取实时 API。浏览器请求会更新当前页面显示，不会反过来修改服务器上的静态文件。

恢复程序不回灌数据库，不删除新字段、客户文章或历史资源。业务后端的一般恢复仍须完成实际写入方、数据格式和客户端兼容检查；无害演练不能替任意旧程序作保证。

## 现在可以怎样看效果

用现有管理员账号打开 [本轮助手草稿](https://supplychainsai.com/admin/?section=articles&article=article-79b0419f77127ad6382dcab4bfe2b5ba58f152b3b8b7d89e93e5f1550c02a683)，可查看第 3 版正文和私有预览。测试文章已发布验收后撤回，故它的公开地址现在返回 404；草稿仍在。公开效果保留了[桌面截图](https://github.com/vibelingan/channel/blob/archive/docs-evidence-2026-11-05/docs/delivery/2026-10-26/evidence/assistant-public-desktop.png)、[手机截图](https://github.com/vibelingan/channel/blob/archive/docs-evidence-2026-11-05/docs/delivery/2026-10-26/evidence/assistant-public-mobile.png)和[后台截图](https://github.com/vibelingan/channel/blob/archive/docs-evidence-2026-11-05/docs/delivery/2026-10-26/evidence/assistant-private-preview.png)。此前的[手工验收文章](https://supplychainsai.com/blog/oem-project-brief-acceptance-40249243887/)仍可查看。

客户日常流程是保存草稿、Preview、确认后 Save and publish。保存草稿不改变公开文章；更新公开内容仍须点击发布。Withdraw article 撤回后保留草稿，公开页面返回 404，列表与 sitemap 移除。这里的“人工操作验收”由自动化浏览器模拟管理员完成，不表示客户本人已验收。

既有71c17172的完整CI及文章HTTP检查通过；正常网站部署来源91443842的完整CI、文章HTTP、离线检查和Deploy Test也已通过。之前商品准备状态测试曾失败后同提交重跑通过，未确认根因的记录保留；本轮未改pricing或放宽断言。新的发布助手工具修正与安装包检查另记，正式微信群仍待接线验收。

## 从这里查看

- [Blog 实例计费与续费核对](2026-10-26/BLOG-COST.zh-CN.md)、[正常部署分支收敛](2026-10-26/PROMOTION.zh-CN.md)。
- [图文群测入口](2026-10-26/wecom/START-HERE.html)、[WeCom 群测配置与图文示例](2026-10-26/wecom/GUIDE.zh-CN.md)、[可直接发送的测试任务](2026-10-26/wecom/TEST-PROMPT.zh-CN.md)。
- [完整总图](2026-10-26/diagrams/complete-delivery.html)、[文章发布时序](2026-10-26/diagrams/article-publication.html)、[助手草稿时序](2026-10-26/diagrams/assistant-draft.html)。
- [按模块实施](2026-10-26/EXECUTION.zh-CN.md)、[当前工作记录](2026-10-26/WORKLOG.zh-CN.md)、[无害恢复演练范围](2026-10-26/DUMMY-LIVE-DRILL.zh-CN.md)。
- [线上桌面文章](https://github.com/vibelingan/channel/blob/archive/docs-evidence-2026-11-05/docs/delivery/2026-10-26/evidence/live-blog-public-desktop.png)、[线上手机文章](https://github.com/vibelingan/channel/blob/archive/docs-evidence-2026-11-05/docs/delivery/2026-10-26/evidence/live-blog-public-mobile.png)、[实际私有预览](https://github.com/vibelingan/channel/blob/archive/docs-evidence-2026-11-05/docs/delivery/2026-10-26/evidence/live-blog-admin-preview.png)。
- [商品前端交付结果](https://github.com/vibelingan/channel/blob/archive/docs-evidence-2026-11-05/docs/delivery/2026-10-26/evidence/site-20-accepted.json)、[文章真实发布结果](https://github.com/vibelingan/channel/blob/archive/docs-evidence-2026-11-05/docs/delivery/2026-10-26/evidence/blog-server-republish.json)、[文章服务器 A→B→A](https://github.com/vibelingan/channel/blob/archive/docs-evidence-2026-11-05/docs/delivery/2026-10-26/evidence/blog-server-aba.json)、[测试函数 A→A](https://github.com/vibelingan/channel/blob/archive/docs-evidence-2026-11-05/docs/delivery/2026-10-26/evidence/dummy-AA.json)、[测试函数 B→A](https://github.com/vibelingan/channel/blob/archive/docs-evidence-2026-11-05/docs/delivery/2026-10-26/evidence/dummy-BA.json)。
- [助手整体验收](https://github.com/vibelingan/channel/blob/archive/docs-evidence-2026-11-05/docs/delivery/2026-10-26/evidence/assistant-acceptance.json)、[本轮测试资源清理](https://github.com/vibelingan/channel/blob/archive/docs-evidence-2026-11-05/docs/delivery/2026-10-26/evidence/dummy-cleanup.json)。
- [内容助手设计](../blog/agent-design/HIGH-LEVEL.zh-CN.md)、[CloudBase 故障调查](2026-10-25/CLOUDBASE-FINDINGS.zh-CN.md)。

Google/Bing 此前完成过网站验证和 sitemap 提交。本轮未重新读取收录数据；提交成功、页面可访问与搜索引擎已经收录是不同结果。
