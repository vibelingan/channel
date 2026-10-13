# P0 真实根因与 P1b 规格容量修复

2026-10-13。原 pricing checkout / feat/catalog-alibaba-price-tiers。本子单元完成本地 review、测试和组合流程；未部署，未修改云上商品。

## 已取得的事实

腾讯云管理授权 READY，绑定 diversity-123-d9grnqfux221323bb。只读取得三件商品及对应 observation、58 条媒体映射和 57 张图片状态。三件商品都是 Misc、未发布；全部映射存在，图片 active、没有 mutation owner。旧 listFunctionLogs 接口已下线，CLS searchLogs 返回 topic not exist，未取得请求日志。

用实际 observation 和网站字段调用生产 buildCatalogPreparationPlan，三件均只报 `facts: Array must contain at most 100 element(s)`。T142/T157 各 113 条来源属性，W203 121 条；完全相同 name/value 去重后数量不变。这与此前真实 prepare 400 的阶段吻合。

只读审计当前全部 1109 条 observation 的 attributes：中位数 29、P95 113、P99 120、最大 121；81 条超过旧 100 项限制。该审计是当前数据快照，不是未来输入分布保证。

## 最终修复与容量证据

保留原始 facts 的名称、值、顺序及同名多值结构，仅将 CatalogDetailHeaderSchema 的有界数量容量由 100 调整到 256。单项名称 200 / 值 2000 字符限制，以及原有配置 128 KiB、job 512 KiB 预算保持生效。256 给当前最大值留出余量；不能把提高数量上限当作绕过字节预算。

实际三件完整数据副本走生产 prepare → review → begin/page/finish → CatalogDetailPublicationSchema 读回，全部成功。T142 4 SKU、T157 2 SKU、W203 1 SKU；原分类和未发布状态保留。实际 header UTF-8 字节依次为 7668、7675、8136；审批 job 为 12005、11866、12269，远低于 512 KiB。每次 finally 删除隔离 JSON DB 和 owner marker，云上商品只读。

官网原有 catalogContentView 将同名冲突/多值放在说明区：T142/T157 各 22 个单值规格、91 条说明，W203 28 个单值规格、93 条说明。这些行不是同样数量的独立技术规格。本轮不改展示语义，不筛掉销售标签，不加入属性选择或 mapping 功能。

这批实际数据不触发 L1 分开存储。按品类配置哪些属性展示/映射，只记录为用户后续想法；不改变当前实施范围。正常列表准入、问题查看器及超容量输入的直接修复入口仍属于 P1/P2 后续，不能由本子单元宣称全部完成。

## 失败记录及 review 更正

最初尝试将同名多值拼成一个显示值。三件副本审批和新增单元测试通过，但完整浏览器回归抓到语义变化：原灯具页面应保留 30 项单值规格和 17 条多值说明，拼接后出现 35 项单值规格。该轮 20 件发布/恢复通过，整体仍判失败。没有放宽旧断言，已撤回整个分组 helper 和投影，改为保留原结构的容量修复。

最初 raw seed 写了 attribute_value，完整性断言发现真实 parser 得到空属性；按实际合约改为 value_name，未放松断言。首个隔离探针误用 review.value，第二个误读不存在 collection 的 null（4 字节不是预算证据）；已使用实际顶层响应、真实 catalogDetailApprovals 并断言 job 存在。所有失败探针均清理临时 DB。

## 最终验证

- 修订后的真实规格及边界用例在旧 100 上限下先失败；修复后候选/共享合约/正式审批/admin prepare/既有展示测试共 97 passed / 0 failed / 0 skipped。
- 数量 256 完整通过、257 拒绝；值 2000 完整通过、2001 拒绝；不截断，不丢弃重复或冲突行。临时改回 100 上限，真实样本和容量边界回归失败，finally 恢复。
- shared、catalog-import、e2e 类型检查通过。改动代码/JSON 的 Biome 通过；无新 SDK API、依赖或公开 DTO 字段。
- 生产 build + 真实 handler + 隔离 JSON DB + Chromium：public 41、catalog 90、formal 10、visibility 8、taxonomy 1，共 150 passed / 0 failed / 0 skipped，runner 确认临时 DB/服务删除。
- 原有 20 件 raw-derived lane 循环加入三件时钟全部规格，seed 比较 parser 输出和完整原属性，公开详情逐行比较所有 facts；经 Assign category → Save and publish、同 operation/revision 读回、原分类保留、共享图片 +20/恢复、Disable/公开 404。它是本地合成商品加真实规格，不冒充云端实际 20 件验收。

证据位于 /private/tmp/channel-clock-repair-2026-10-13：real-source-fact-audit.json、p1b-capacity-red.log、p1b-capacity-regression.log、p1b-capacity-mutation.log、p1b-real-clock-capacity.log、p1b-combined-e2e-r3.log。此前失败日志保留。

## Inline review 与表述检查

实际审查 detail-candidate.ts、source-observations.ts、shared/catalog/product-detail.ts、detail-approval.ts、catalog-source-staging.ts、catalog-detail-staging.ts、catalog-content-view.ts，以及 seed-raw-catalog.ts / catalog-formal-journey.spec.ts。确认正式批准沿用完整 facts，source digest 继续绑定全部来源内容，既有多值说明规则保留。

将“一百多个独立属性”澄清为“一百多条来源项，官网当前 22/28 项单值规格，其余多值进入说明”；将“grouping 已修好”更正为“完整回归否定该做法，最终保留原结构并验证容量”。比较实际记录、逐行断言、旧展示断言及字节预算，不将本地通过写成已部署。
