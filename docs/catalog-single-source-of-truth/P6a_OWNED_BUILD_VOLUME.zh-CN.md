# P6a：正式验收的构建目录与本地数据库身份

本单元修正本地验收 runner，不修改商品写入、映射、分类或发布逻辑。原 runner 在系统临时目录建立 Astro 输出，仓库在 Lexar 时，Astro 6.4.6 的 rename 从 apps/site/.astro/.prerender 到 /private/tmp 返回 EXDEV。红测保存于 owned-build-volume-red-r1.log。

现在数据库、媒体、就绪文件仍在系统临时目录；构建输出用 mkdtemp 建在 apps/site 下，与 Astro 中间文件同磁盘。正常退出、API 启动失败、构建启动失败和预览启动失败都先清理自己启动的进程，再分别删除两个自建目录。删除后只把 ENOENT 当作确实不存在；一个目录清理失败也继续尝试另一个，不把权限错误当作已删除。

复核时发现 admin-subcategory-visibility 的部分恢复用例没有独立确认 API 的 mode/db。现在统一 beforeEach 在任何登录、写入前核对 mode=local 且 db 等于 runner 的随机隔离数据库。两条反例用实际 Playwright 调用受控健康检查服务器：云环境、另一个本地数据库均被拒绝，服务器只收到 /api/health，没有登录和写入。恢复测试仍转发真实 API 请求，仅人为丢失回复；没有用虚构商品结果替代服务端写入。

验证证据均在 output/pricing-clock-repair-2026-10-13/p3e1：

- owned-build-volume-green-r1：5 通过、1 失败。跨磁盘构建和清理通过；旧静态断言只检查部分用例，暴露统一身份检查缺口。
- green-r2：6 通过、2 失败。新增负例的 grep 错误锚定了完整 Playwright 标题，未找到测试；不能算已执行安全检查。移除锚点后 ownership-r3 两条通过。
- green-r4：8/8，包含三个失败阶段和两个误连反例；e2e TypeScript 检查通过。
- canonical-p6-admin.log：直接运行原 scripts/run-catalog-admin-local-e2e.mjs --admin-only，E2E_CATALOG_FORMAL=1，系统临时目录 /private/tmp。正式 Astro 构建 15 页，12/12 流程通过，1.4 分钟。包含单件、原任务恢复、批量分类、两组 20 件发布；按用例断言恢复未发布并核对分类。两个自建目录删除成功。
- canonical-p6-artifact-preservation.json：原 output/playwright 的文件哈希在运行前后完全相同；本轮报告保留于 canonical-p6-playwright。

实际审查文件为 runner、runner 测试、admin-subcategory-visibility、Playwright 配置及环境 helper；核对生产 build/preview、健康检查真实响应、子进程所有权和 cleanup。文案把“临时目录清理成功”明确为“系统临时目录和同磁盘构建目录分别确认删除”，避免遗漏第二个目录。没有新增 SDK 方法、应用环境变量、云部署配置或真实商品写入。

C8 的正式构建门槛由本轮相同产品源码的构建及后台流程补齐。本单元没有覆盖所有公开页面组合，也没有替代后端制品、已发布编辑恢复、历史审计、test 的三件时钟 resync / 20 件真实发布恢复、COS 和性能验收。fullDeliveryReady=false。
