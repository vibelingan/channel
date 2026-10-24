# SEO 交付、自动恢复与兼容性：当前方案入口

2026-10-22 进度补充：部署/SSG 的剩余接线、真实腾讯云假业务演练与清理见[下一次现场窗口计划](execution/LIVE-RESUME-AND-CLEANUP.zh-CN.md)；等 pricing 合并 main 并更新 SEO 后执行。Blog 已开始[分模块实现](../blog/README.zh-CN.md)，先做文章核心。下文保留 10 月 20 日设计背景，不作为全部代码已完成的证明。

2026-10-20，第二轮设计收口。当前分支 `feat/seo-foundation`；本轮代码审阅基线 `b3c5f3a89b44b6ff6f99e62a24fbfa413bfd9e8c`。本轮更新设计和图文交付，没有执行部署、数据库迁移、缓存修改或恢复演练，没有修改 pricing。

## 已确定的实施方向

保留 Astro、React 和 Cloud Functions。商品标准 URL 在构建时生成 HTML，React 接管后请求当前公开 API，现有分类页内展开和询盘交互继续使用。没有迁移 Next.js。React Query 与公共业务请求层仍按既有设计后续整合，本轮不碰并行分支的调用方。

采用有条件的自动恢复，并保留技术平台中的手动恢复入口。正常发布、自动恢复和手动恢复共用一个目标协调器；恢复不放进客户应用后台。

- 尚未改变线上时，lint/test/采集/build/备份失败就停止，修复原因，不恢复。
- 已发生线上写入，且归属、产物、内容世代、数据库/API 兼容证据全部通过时，在原锁内自动恢复一次。
- 状态未知、新版本已接管、不兼容或恢复失败时停止，留下人工接手证据，不递归恢复。
- 恢复成功仍记原发布失败。保留当前业务数据和兼容 schema，不自动执行数据库 down 或整库覆盖。

完整实现合同和所有 P1 审查项的落点见 [发布与自动恢复设计](AUTOMATED_RECOVERY_DESIGN.zh-CN.md)。

## 数据库与组件恢复范围

商品主库使用 CloudBase 文档数据库；独立 AI store 使用 `pg` 与自写迁移，本轮未发现 Prisma。现有 AI migrateDown 会逆序执行 down 脚本，其中含删表，不能接入自动恢复。

新增可空字段通常可以留在数据库里，旧代码不必读取它。但新约束可能阻止旧写入，旧代码整份替换记录可能删掉新字段，删除/重命名/改语义也会使回退不兼容。因此采用扩展、兼容读写、回填和验证，默认保留旧字段；删除不是迁移的必经步骤，本期没有删列/删表任务。恢复资格既检查读也检查写。

| 对象 | 当前能力 | 目标设计 |
| --- | --- | --- |
| 静态前端与商品 SEO | 有备份、计划与执行内核，完整云端入口待接入 | 可信固定产物、联合校验 HTML/sitemap/manifest、同锁恢复并读回 |
| Cloud Functions/API | 现有正常发布会更新；静态备份不含完整函数恢复输入 | 封存成功函数包和运行合同；仅在新旧客户端及当前数据库均兼容时恢复代码 |
| 网关/触发器/缓存等配置 | 有读回和部分反向参数，尚未证明逐字段恢复 | 只逆转本次明确修改且可恢复的配置，不回放整份历史设置 |
| 业务数据/schema | 不在静态备份内 | 默认保留当前状态；必要记录单独条件补偿；全库恢复用独立目标核验 |
| 外部图片/视频/AI 服务 | 各自独立链路 | 不随代码版本盲目倒退 |

这仍不能称为已完成的全站一键回滚。目标能力必须按组件逐项实现并演练；缺一个必要组件的恢复计划，就不能自动把本次发布当成可完整恢复。

## 搜索引擎更新策略

恢复后 sitemap 必须与实际可访问页面一致；这与主动向平台发通知是两件事。稳定 sitemap 地址不必每次发布重新登记。Google 将 sitemap 视为提示，提交不等于抓取或收录；`lastmod` 使用真实的显著内容变化时间，不使用每次 build 时间。[Google sitemap 指南](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap)。

只有验收后真实公开内容变化才产生待通知事件；按 URL 合并，等待约 30 分钟可调稳定窗，发送前再检查 active release 和内容世代。A→B→A 若回到最后通知状态，且 B 尚未发送，就不再推送；后续稳定 B 再更新。未来如接 IndexNow，遵循实际变化才通知的原则，本轮不假定已接入。[IndexNow FAQ](https://www.indexnow.org/faq)。

爬虫仍可随时自主访问，延迟通知无法阻止抓取，也不能撤销已收到的 B。技术恢复不调用紧急移除、不临时加 noindex/robots 屏蔽；真实业务撤回则及时移除并返回正确状态。当前 Google/Bing 实时控制台未重新读取，历史 sitemap Success 不等于已经收录。

## 两张完整大图

这次每张 HTML 的主体都是一张完整 SVG，分别呈现完整流程与完整时序；不是把六张旧图装进 iframe 或分章阅读。它们描述目标设计，不是生产执行记录。

- [完整流程大图](../../output/seo-design-r2-2026-10-20/DELIVERY-COMPLETE-FLOW.html)：从 CI、快照、构建和备份，到接口/静态发布、验收、失败分类、一次自动恢复、人工处理、数据修复和搜索时机。
- [端到端完整时序大图](../../output/seo-design-r2-2026-10-20/DELIVERY-COMPLETE-SEQUENCE.html)：操作人、Actions、可信产物、数据库、API、托管、访客与搜索之间的交互。末尾恢复消息属于条件分支；访客可在任意时间访问。
- 图源：`docs/seo/diagrams/delivery-complete.workflow.json`、`delivery-complete.sequence.json`。结构、浏览器和图像审阅收据随新交付目录保存。

旧 `output/seo-final-2026-10-20/SEO-DELIVERY-ATLAS.html` 是历史多图合集，手动恢复策略已被本轮设计取代，不作为当前综合大图或政策入口。

## 下一步与演练

具体执行顺序、low-level design 和 MIU 已按六个模块整理在 [模块交付计划](execution/README.zh-CN.md)。每个模块有自己的接口、写入范围和验收条件，计划完成不代表运行代码已实现。

先实现恢复内核确定性缺口、可信产物、持久日志与目标归属；补函数/配置恢复合同和适配器；再接自动恢复。公开内容写入方尚未遵守协调合同时，不启用可能覆盖撤回/新版本的恢复。

按 [受控演练计划](RECOVERY_DRILL_PLAN.zh-CN.md)，先走一次正常发布、备份、人工恢复，再验证一次只影响 canary 的自动恢复。静态/API 标记回 A；数据库当前数据保留，测试记录按条件补偿；新增 fixture C 必须还在。保留三组低成本本地安全检查，不扩成大规模线上故障注入。恢复耗时待实际测量。

原审阅 [FINAL_REVIEW](FINAL_REVIEW.zh-CN.md) 保留反例和历史 41/41 结果，本轮未用设计更新冒充缺口已经修复。商品 SSG 和访问细节仍见 [SSG_DELIVERY_DESIGN](SSG_DELIVERY_DESIGN.zh-CN.md)，公共调用设计见 [REQUEST_LAYER_DESIGN](REQUEST_LAYER_DESIGN.zh-CN.md)。Blog、Hermes 草稿接口和海外交付继续留在后续范围。

第二轮图文存档位于 `output/seo-design-r2-2026-10-20/SEO-DESIGN-R2-DELIVERABLES.zip`，保留其原始字节用于追溯。最新模块实施计划包位于 `output/seo-execution-plan-2026-10-20/EXECUTION-PLAN.zip`，含当前六模块文档与修订后的原则。两者均不包含凭证、线上备份字节或客户数据。
