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

## 当前实证

当前部署 a489880c 上，后台第一页面真实选出的 20 件耳机，保留全部原分类，通过上述入口 20/20 发布；匿名公开详情 20/20 HTTP 200。随后实际后台分 11 件、9 件下架；数据库独立读回 20/20 published=false，128 张图片 publishedRefCount 与前值一致。基线位于 output/pricing-clock-repair-2026-10-13/p3e1/real20-20261021/before.json。界面证据 /private/tmp/channel-real20-published-20261021.png。

发布按设计生成审批/版本历史及清除 NEW；恢复不回滚审批历史、生命周期版本或 updatedAt。恢复 NEW 字段的 MCP 请求被环境的 approval policy=never 拒绝，没有执行。未宣称这些标记已经恢复。

本节点最终部署、真实错误商品重试、三件时钟重新同步仍待完成；不能用上述 a489 验收冒充新版本已完成。

## Review 与文字检查

实际审阅了 photo-preparation.ts、handler.ts、alibaba-api.ts、AlibabaPhotoIssues.tsx、AlibabaProductRefresh.tsx、AlibabaCatalogSyncPage.tsx、AlibabaConnectionPanel.tsx、DashboardShell.tsx、CollectionView.tsx、PreviewModal.tsx 和对应测试。修正了新字段影响旧状态接口、图库人工替换后旧警告残留、首次读取覆盖重试结果的风险。人工 Standards/Spec review：保留正常运营入口，复用鉴权与数据保护，不添加同步中间阶段控制台。

文字由“Open Products to review or replace them”改为逐件商品/图片原因与 Retry this product/Open product；对照后端 not-found 合并规则确认没有捏造 403 或 404。本文区分本地通过、当前旧部署实证与待部署验收。

## 本地检查结果

全量测试 photo-issues-full-final.log：7990 项，7987 通过，0 失败，3 项原有跳过。另新增实际 Chromium 组合测试 photo-issues-browser.log 1/1 通过，验证显示第 205 张规格图、来源链接、只重试对应商品、失败后的替代办法和打开准确商品。photo-issues-focused-final.log 63/63；全项目类型检查 photo-issues-types-final.log 通过。最终提交前重新检查 lint 和测试类型。
