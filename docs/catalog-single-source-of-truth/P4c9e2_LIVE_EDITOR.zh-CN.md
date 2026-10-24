# P4c9e2：实际编辑表单接入原任务

已发布商品的管理员 Edit 保存现在沿 refresh-live 的同一原任务完成保存、媒体准备、审批和公开读回。首次发布继续使用 publish；直接下架、归档保持带打开版本的普通 update，不创建发布任务。分类变更时表单省略 published 仍按原商品的 live 状态处理；不会给无分类商品补分类。旧兼容审批入口仍保留给功能关闭等调用者，本单元没有删除它。

归档浏览器红测暴露了实际缺陷：native update 已把 archived=true、published=false 写入，客户端却再调用 approve 并显示失败。ProductWriteIntent 增加 archive，禁止归档走自动详情审批。实际手动和来源关联商品的归档均验证只发一次带 expectedUpdatedAt 的 update，无变更型审批，公开详情返回 404。

另一轮 review 发现，发布能力查询失败时若把整个 live 表单禁用，下架和归档也会被挡住。因此 live 表单保留编辑，下架/归档可正常提交；普通 live Save 在能力未知时保留输入、拒绝写入并提供只读重查。重查成功后仍需用户点击 Save，不自动重放。draft 的原有禁用规则保持。CollectionView 只有管理员使用 ProductEditForm；contributor 的独立 RecordForm 路由保持。

证据在 output/pricing-clock-repair-2026-10-13/p3e1/live-editor-*：

- helper 六条有效红测在旧逻辑全部失败；恢复旧 ProductEditForm 的实际 Chromium 红测确认正常保存没有创建原任务，finally 源码哈希一致恢复。
- Archive 红测记录实际保存成功后多发 approve；能力未知四条实际 Chromium/WebKit 红测在旧禁用逻辑全部失败。
- 最终聚焦 37/37，0 skip：22 条实际 helper/后端，以及 15 条实际 Chromium/WebKit 表单。覆盖正常、丢失保存回复、start 未到达后停止再试、会话重连、105 配置来源商品、分类变化、下架/归档及能力查询失败。会话切换在本地 harness 改 actor 并用同一签名 token，不冒充两次真实账号登录；C8 后端角色检查另有覆盖。
- 最终 site 全套 1345/1345，0 fail、0 skip；GALLERY_BROWSER_TEST=1。test 类型、Astro check（238 文件，0 errors、0 warnings、11 hints）及 6 文件显式 Biome 通过。
- Node20 的 helper/product-form 共 37/37（在最后 UI 能力提示修改前，API/helper 未再变）；不把它写成 Node20 浏览器验收。

浏览器使用真实 ProductEditForm、RecordForm、Admin handler、JSON native 事务、PNG worker 和公开 handler。Preview 请求故意拒绝以进入既有修复编辑入口，因此这些测试不证明成功 Preview；最终完整正式构建另测。用例在自建临时 DB 上完成后 native 下架并验证，再清理临时资源，不算云上真实商品恢复。

正式 canonical 构建首轮另有失败，现场已保存，不能放行：raw 图片夹具缺少 byteSize/checksumSha256，且旧 1x1 PNG 被真实解码器拒绝；分类并发下架用例仍拦截旧 prepare/approve，未触发新原任务；混合发布 1 成功/1 失败符合预期但提示断言已过时。P6b 修正真实夹具和触发点后必须完整重跑；不降低媒体校验或跳过流程。首轮 runner 终止码 143，原有 9 个 Playwright 报告哈希一致恢复。

实际 review 文件：ProductEditForm.tsx、api.ts、catalog-product-publication.ts、catalog-editor-publication.test.ts、catalog-live-editor-browser.test.ts、testing/editor-recovery-browser-harness.tsx，以及 CollectionView 的管理员/贡献者消费者。对照了 stop/恢复 scope、归档服务端规范化、版本检查和旧兼容路径。文案把“全部 live 审批替换”纠正为“管理员启用功能时的 Edit 接入”；对照代码保留实际兼容范围。

fullDeliveryReady=false。未部署、未变更真实商品。P5 历史数据审计及修复、P6 完整构建组合、P7 test 三时钟 resync/load/Preview/20 件保留分类发布与恢复、真实 COS/MVCC 和性能门槛仍需继续；两项既有未解释诊断缺口仍开着。
