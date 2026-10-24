# P5c：正常商品默认筛选与关闭路径

新增构建时开关 PUBLIC_CATALOG_READY_DEFAULT。只有字面值 1 才把 Products 默认检查状态设为 normal（Ready or published）；未设置、0 或其他字符串继续默认 all。本次保持 0，不因部署这一单元自动隐藏历史草稿。开关不控制后端准入，不绕过发布校验，也不写入或回填商品、审批、分类、正文、图片计数。

CollectionView 的首次加载、刷新和 popstate 使用同一默认值。用户显式选择 All 时，在 normal 默认下保留 checkStatus=all；问题、准备中、未检查入口始终可选。切换保留搜索 URL 中的产品类别、子分类和其他参数，并继续使用原分页/选择清理与 query key。关闭开关后显式的 all/issues/preparing/unchecked URL 仍能打开，非 Products 集合的请求保持原状。

## 启用条件与恢复

启用前先部署兼容后端，完成 P5a 当前影子报告；核对完整准备状态与 native 查询投影一致、缺字段落到 unchecked、已发布商品保持 normal，以及问题队列可访问。依据实际原生过滤和排序运行 list/count 并检查索引、结果一致性和耗时。当前历史 census 没有准备回执且有数百件旧草稿，不能把仅切换默认视为已修复历史数据。无论影子报告是否一致，最终发布仍逐件检查当前版本和媒体。

确认 test 全流程与性能后，构建时明确设置 1 并重新部署站点；保存相同 SHA、构建参数和产物哈希。当前项目 CI 使用 test 环境变量，默认 0。需要关闭时，以同一已审查源码和相同 API/SITE 参数、开关 0 重新构建站点并验证 All、问题队列与原 live 商品；关闭只改默认筛选，不删除新格式正文或恢复旧后端。不得回滚到不能读取已有内容格式的版本，也不得借关闭开关重写公开内容或计数。

## 测试与审查

新增行为红测先因缺少 productCheckDefault 导出失败，随后原三条及新增两条 5/5 通过；覆盖严格 opt-in、无效值、显式 All 与关闭、所有问题队列、URL 其他参数。临时恢复删除显式 All 的错误实现时，新增测试失败，原文件哈希恢复。既有调用者省略默认参数时仍使用 all，原 URL 回归保留。

实际 Astro 正式构建分别以 1 和 0 运行新浏览器用例，各 1/1、零重试：验证真实 CollectionView 默认 list 参数，逐一选择 Data issues/Preparing/Unchecked/All，刷新后仍为 All，浏览器后退恢复 Unchecked。API 返回在此用例中模拟，验证的是 UI 接线和 URL，不冒充云端查询或发布测试。两次专属 DB/媒体/构建目录删除，原 Playwright 9 个报告文件哈希相同恢复。新 spec 已接入现有完整本地 runner。

部署契约 504/504、site Astro check 238 文件零错误/警告，相关六个文件 Biome 通过。新 E2E 首次类型检查检出数组解构的可空 label；加 readonly tuple 类型，保持用例和运行行为不变，随后重新检查。实际审查 product-check-status.ts/.test.ts、CollectionView.tsx、env.d.ts、.env.example、deploy-test.yml、runner 与新 spec；将“回滚数据”更正为“重新构建恢复默认筛选”，保留数据修复与 UI 开关的边界。真实影子扫描、索引/性能、最终 P6 和 test P7 尚未完成，fullDeliveryReady=false。
