# P3e7d6 保留现有分类后发布

本 MIU 本地验收通过；完整交付尚未完成，未部署到 test。

原分类弹窗只有 replace/append/clear，同一批商品会采用统一主分类和子分类。用户要求选满 20 件已有分类的草稿，保留各自分类，经 Assign category 发布；旧入口无法表达这个操作。

在既有 Assignment mode 中增加 Keep existing classifications。选择后逐件预览原分类，停用分类编辑和单独保存分类。已有分类名称加载失败时保留原值、展示说明并允许重试名称。状态数量明确标为 At selection，避免把原选品时的草稿数量当作发布后的状态。

本地提交形状为 `{kind:'keep', products:[{productId,expectedUpdatedAt}], includeSavedRevision:true}`。复用分类 DTO 的 1–20 件、唯一 ID、有效时间戳检查，但此形状不发送给 assignment API。它既不写分类，也不构造虚假的 saved 分类回执。确认后创建一次原发布 attempt，`values:{}`，使用选品时的版本。原 journal、身份校验、共享四并发、任务检查及匿名详情 revision 读回继续负责恢复和成功判断。

恢复状态单独辨认 keep 提交：未确认原回执仍为未知，明确拒绝列出原因。不能从某件商品后来变成 published 推定本次发布成功。字段读回比较 productFamily/category/subcategoryIds 的值和存在性，缺省不转换为空数组，也不把 legacy 子分类顺手重写。缺主分类商品由后端逐件拒绝，正常兄弟商品继续发布。用户编辑造成的版本变化拒绝原选品；不覆盖新版本。

反对方案：按商品拆多次 assignment 会产生无意义的版本和写入，也会使“不修改分类”成为假话；伪造 saved 分类结果会混淆两种操作的回执。将 UI 扩为 100 件不属于本 MIU，保持既有 20 件范围，底层连续多批能力证据保持独立。

验证新增 13 项：4 个核心控制、两浏览器各 4 条实际子流程、1 条正式后台页面。20 件混合分类、缺分类部分成功、丢完成回复后的原任务只读恢复、并发编辑拒绝均通过。独立本地 JSON/Admin/Public/PNG 组合验证实际发布，完成后按原回执撤回，公开详情/无其他引用图片 404、计数归零，原分类字段及存在性保留。

全站 1169/1169，最终浏览器组 32/32，Node 20 改动核心 10/10，正式 Astro 后台九条 9/9，均无失败/skip/flaky。站点、既有测试和 E2E 类型通过，5 文件 Biome、15 页构建通过。三个故意破坏分别改写原分类值、丢失选品版本、忽略字段存在性，测试均检出，源码 SHA 恢复。已看 390px 的实际混合分类完成页；两引擎截图另存并记录 SHA。

失败记录保留：首轮新选择器错误不算产品红测；改用真实控件后，缺少 keep 选项才是产品红测。正式 r12 夹具把 subcategoryIds 写入 create，原 API 正确拒绝；修正夹具后 r13 在外置盘 JSON 数据库上超过 60 秒，finally 按原回执恢复全部 20 件。只把 JSON 数据库移到系统临时目录、保持同一源码和 60 秒断言后，r15 整条流程含恢复 22.4 秒，r17 组合中的同一路径 21.3 秒。Astro 构建仍留仓库卷以避免既有 EXDEV。中间 r14 被原临时根守卫拒绝，未放宽守卫；r16 新测试未复用已有 hydration 安全 choose helper，8过1败，修测试后 r17 九条全绿。该对照说明本地存储位置影响等待，不作为真实云环境的 P95 或性能通过证据。

人工 review 对照 Editor、CollectionView 消费者、分类协议、原 attempt、批次和读回；keep 的 command 不会落入 assignmentCall，恢复不需要不存在的分类保存回执。源/测试 SHA、全部日志及截图见 output 下 classification-preserve-verification.json。CloudBase SDK 没有改动。编辑/创建/新媒体/live-edit/Preview/表格入口串联、P5、全量公开矩阵、真实三件 resync 和 test 20 件恢复仍开放。

写作核对实际五个源/测试文件及本记录：将“分类保存后发布”改成“保留分类直接发布”，将“20件用22秒”限定为“单轮本地完整流程含恢复”，把外置 JSON 存储对照与 CloudBase 性能分开。没有把新增局部验收写成全部交付完成。
