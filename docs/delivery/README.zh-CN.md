# SEO / Blog：当前进度与执行入口

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
