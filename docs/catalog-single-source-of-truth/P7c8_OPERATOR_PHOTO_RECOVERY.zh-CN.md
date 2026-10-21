# P7c8：运营图片问题与定向恢复

用户要求：在原 pricing 分支完成真实后台选品，保留原分类，通过 Assign category → Keep existing classifications → Save and publish 发布 20 件，再恢复未发布；明确显示哪件阿里商品的哪张图片出错以及处理办法。

## 实现与边界

- 原同步页面增加受管理员鉴权保护的问题清单：商品名、来源商品 ID、图库/详情/规格图片序号、来源图片链接、已记录的失败原因。
- 旧媒体记录把 403/404/410 合并为 not-found，因此界面如实解释“拒绝访问或图片已不存在”，不伪造精确状态码。
- 单件重试串联已有幂等 selected sync 和按 productId 精确过滤的照片准备。复用现有人工修改保护、产品版本检查与图片锁，不修改分类，不发布。
- 商品预览中可 Refresh from Alibaba，供正常运营定向重新读取来源；已发布或归档商品不显示此操作。预览没有未保存的编辑表单，避免重同步覆盖用户正在输入的内容。
- 旧状态接口保留三计数结构；只有请求 includeIssues 时额外读取问题详情。后台自动任务不新增这些查询。问题最多显示 20 件，每件最多 200 个失败来源，明确提示截断。来源绑定分批读取，205 张规格图最后一张失败的测试覆盖避免漏尾。
- 人工替换图库/详情图后旧自动图片告警消除。规格图依然按来源观察保留完整信息。
- 初次读取和重试的响应按代次隔离；旧读取不会覆盖新重试结果。重试校验返回的产品 ID，拒绝错误来源链接。

## 早期验收（a489880c）

当前部署 a489880c 上，后台第一页面真实选出的 20 件耳机，保留全部原分类，通过上述入口 20/20 发布；匿名公开详情 20/20 HTTP 200。随后实际后台分 11 件、9 件下架；数据库独立读回 20/20 published=false，128 张图片 publishedRefCount 与前值一致。基线位于 output/pricing-clock-repair-2026-10-13/p3e1/real20-20261021/before.json。界面证据 /private/tmp/channel-real20-published-20261021.png。

发布按设计生成审批/版本历史及清除 NEW；恢复不回滚审批历史、生命周期版本或 updatedAt。恢复 NEW 字段的 MCP 请求被环境的 approval policy=never 拒绝，没有执行。未宣称这些标记已经恢复。

该阶段尚未完成本节点部署、真实错误商品重试和三件时钟重新同步；后续已执行结果见下文，不能用 a489 验收冒充新版本验收。

## Review 与文字检查

实际审阅了 photo-preparation.ts、handler.ts、alibaba-api.ts、AlibabaPhotoIssues.tsx、AlibabaProductRefresh.tsx、AlibabaCatalogSyncPage.tsx、AlibabaConnectionPanel.tsx、DashboardShell.tsx、CollectionView.tsx、PreviewModal.tsx 和对应测试。修正了新字段影响旧状态接口、图库人工替换后旧警告残留、首次读取覆盖重试结果的风险。人工 Standards/Spec review：保留正常运营入口，复用鉴权与数据保护，不添加同步中间阶段控制台。

文字由“Open Products to review or replace them”改为逐件商品/图片原因与 Retry this product/Open product；对照后端 not-found 合并规则确认没有捏造 403 或 404。本文区分本地通过、当前旧部署实证与待部署验收。

## 本地检查结果

全量测试 photo-issues-full-final.log：7990 项，7987 通过，0 失败，3 项原有跳过。另新增实际 Chromium 组合测试 photo-issues-browser.log 1/1 通过，验证显示第 205 张规格图、来源链接、只重试对应商品、失败后的替代办法和打开准确商品。photo-issues-focused-final.log 63/63；全项目类型检查 photo-issues-types-final.log 通过。最终提交前重新检查 lint 和测试类型。


## 2026-10-21 已补齐的真实验收

d0556537 已完成部署及实际代码下载比对。三件时钟分别在 09:02:45、09:05:18、09:07:42 UTC 从正常预览里的 Refresh from Alibaba 定向重同步，sourceLastSynced 更新；完整规格、价格和图库可正常加载，原分类及人工编辑保留。W203 正常编辑器勾选 Published 并保存后公开详情 HTTP 200，随后下架恢复。该次单件审批仍用时 17.934 秒，不能认定性能目标已完成。

此前无法写回 NEW 标记的环境限制已经解除，测试商品标记已通过 updatedAt/published 条件写回并独立读回。后续用户明确确认，运营在 07:44–07:48 UTC 正式发布的 22 件耳机必须保留；这些新发布优先于旧测试快照，不得再按旧快照下架。

三件报错商品都实际点击 Retry this product。耳机共用源图返回 404；时钟图库第 6 张、规格第 3 张分别返回 403。普通 GET 与加浏览器 UA/Alibaba Referer 都得到同样结果，详见 supplier-images-http-recheck.json；当前重试保留明确提示，未虚报修复。规格图人工替代告警与实时数量修复见 P7c10。临时选择已恢复。

509 件正式公开商品内容在 10:57:03 UTC 重新遍历比对：460 耳机、12 AI Gadgets、5 Toys、32 Misc，missing/extra/changed 均为空。自建样本仅作为历史本地集成证据，不能代替真实后台验收；其 20 件已归档且未发布，9 张图片计数回到原值。临时打包函数 catalog-package-99aeb8f-20261020 及 5 个临时验收托管文件已删除，核对见 acceptance-cleanup-final.json。
