# P7c10：手动替换规格图后的同步告警

## 修复范围

已观察到：同步状态仍使用源图准备时记录的失败数量；运营在商品编辑器里选择有效替代规格图后，旧警告不会消失。本次只调整同步状态读取，不改同步导入、审批、发布写入、定价或分类规则。

状态读取复用 `sourceVariantIds` 与 `ConfigurationPhotosSchema`。替代图必须属于当前商品图库且图片记录为 active。同一失败源图被多个规格使用时，所有相关规格都已选择有效替代图才能消除这张源图的告警。其他规格缺少源图绑定时仍告警，不能因为部分替换而隐藏。读取不修改来源数据、运营编辑或图片计数。

## 检查

- 修复前新增行为测试中，有效替换和共享源图替换两项失败，记录在 photo-replacement-red.log。
- 同步函数完整回归 365/365 通过，包括缺失、停用、非图库、其他规格图片以及部分替换缺绑定的边界。
- 同步函数类型检查通过；全仓 lint 和 SDK 合约检查结果以 output/pricing-clock-repair-2026-10-13/p3e1/photo-replacement-*.log 为准。
- 已按 Standards 和 Spec 检查三个源码/配置文件，确认状态读取保持只读，批量发布和导入路径不变。部署与真实后台手动替换结果记录在下文。

## 写作检查

核对了 photo-preparation.ts、photo-preparation.test.ts、admin/package.json。将“替换后全部图片恢复正常”改为“有效替代图消除对应警告”；供应商 403/404 的源图仍可能不可用，不把人工替换等同于供应商修复。


## 真实验收与顶部数量

11135f6b 同步函数已部署，健康接口返回同一提交；下载线上代码逐文件比对 129/129 SHA-256 一致。后台实际打开来源 AAEUBBhgAOVTpOKZBnRf1UNY，选择与黑色规格对应的已有图库第 5 张图并保存：商品保持未发布，未产生详情审批；问题清单由 3 件变为 2 件。随后在编辑器撤回该临时选择并保存。

同时发现顶部数字仍使用原同步任务历史计数。本次让已加载的实时检查数量回传顶部显示，并以 runId 隔离状态；初始请求仍保留原挂载/请求代次检查，旧任务响应不能覆盖新任务。全部照片处理后提示“Reported photo issues have been resolved. Retry sync to check for other updates.”，不把图片问题已处理夸大为整个同步已重新验收通过。

两个实际 Chromium 流程与 4 项同步状态测试全部通过：验证历史 3 件、实时 1 件和重试后 0 件时顶部与清单一致；一键同步关闭页面后继续完成、零强加分类、原手工商品不变的集成浏览器测试仍通过。photo-count-ui-tests.log 6/6。未调用额外源数据写入来更新顶部数字。

4f0fc708 前端已部署；实际域名 6 个变化文件的 SHA-256/MIME 均匹配。新版重新通过真实编辑器为该黑色规格选择已有图库第 5 张图后，顶部与清单同时由 3 件变为 2 件，截图 /private/tmp/channel-current-photo-count-2-4f0fc708.png。随后在正常编辑器撤回并保存，条件清除空配置，保留原内容与未发布状态。全同步前端测试 photo-count-all-sync-tests.log 38/38；240 文件类型检查零错误/警告，全仓 lint 通过。

恢复审计发现早期清理使用了错误的字段名 alibabaReviewedBy，真实字段为 alibabaReviewedByUserId。已对四组测试前快照去重后的 40 件商品核对，全部基线均无该字段；仅在未发布、pending=true、当前 updatedAt 和审核人值匹配时清除，matched=40/modified=40。再次独立读取 40 件：published=false、alibabaReviewPending=true、alibabaReviewedAt 和 alibabaReviewedByUserId 均不存在。22 件用户确认正式上架的耳机不在清理范围。详见 review-author-restoration.json 与 all-own-test-product-restoration-final.json。
