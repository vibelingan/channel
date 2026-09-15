# CUI-08：买家到 Admin 的完整本地验收

日期：2026-09-07。分支 `fix/alibaba-sync-storage-wiring`，HEAD `60b051b`。
工作区 `$CHANNEL_REPO`；本轮变更未提交、未推送。

结论：**completed-local**。买家浏览、选型、询价与 Admin 查看、跟进、完成已通过
真实本地 HTTP handler 和文件数据库验收。不是纯前端状态演示，也不是云端已验收。
没有部署、修改云配置、发布商品、发邮件、运行 Alibaba sync，或修改原样本询价。

## 两边各做什么

买家：分类列表 → 商品详情 → 选择真实 SKU / 数量 → Requirements / Contact / Review → 保存。
Admin：Product Inquiries → 读取同一编号的快照 → 备注或明确改变状态 → 完成并记录原因。

- 查看或仅添加备注后仍为 Unprocessed，未处理计数不减少。
- 明确改为 In progress 后进入处理中；Completed 必须有原因。
- Completed 指询价跟进结束，不代表付款、发货或订单完成。
- PDF 是询价摘要，含提交时商品/配置/来源报价及买家信息，不含内部跟进记录；不是正式报价单或发票。

## 隔离方式及证据边界

页面继续使用现有 Astro `4328`，生产代码的本地提交 `3013` 和 Origin 保护不放宽。
Playwright 测试会话将允许的业务 API 请求转发到独立 `127.0.0.1:随机端口` 服务，
保留请求方法、body、Origin；正常请求由真实路由、授权 handler 和 JsonFileAdapter 处理，
不是静态 JSON 冒充保存。延迟、503、坏 JSON、409及丢回执等边界按各测试明确注入。

每个写入用例 fork 一个使用项目 tsx loader 的子进程，避免 Playwright 的代码转换器接管
Node 服务依赖，也避免进程级 DB / media adapter 串用。mkdtemp 临时目录只复制
products / productVariants / images 和本地媒体，断言每个商品是 localDetailClone；
不复制原 users / catalogQuoteRequests / catalogSourceLinks。新生成测试管理员，走正常
登录页，不读取或导出原管理员 JWT。IPC readiness 与磁盘读回经过 Zod 校验。

浏览器端业务 API 仅可访问允许的本地路径；保留原网站 Google Fonts 的静态 CSS/font GET。
所以“无外部业务调用”不等于“浏览器完全离线”。不注册 Alibaba SDK、云存储或邮件发送器。
旧只读详情/导航用例禁止提交；scoped config 明确排除原来会向用户样本库留记录的测试。
截图/视频/trace 自动采集关闭，仅在登录后对合成询价截图，凭据不进入附件。

每次 teardown 关闭自己的服务、核对源 db.json SHA-256 未变，再删除自己的临时目录。
独立读取落盘文件，核对编号、目标 SKU、数量 500、国家 HK、服务端快照、版本和事件数量。
源库最后只读检查仍有 4 products / 21 productVariants / 21 images / 2 inquiries / 1 user。
没有清空、重建或重置用户工作区。测试询价用完删除，因此不会出现在用户原 Admin 列表中。

这验证了本地真实 HTTP、业务策略、登录授权、并发控制和落盘；**转发测试不能代替**
CloudBase SDK 原生事务、部署网关/CORS、线上配置、集合/索引和真实批准快照的验收。
服务重启后的落盘恢复由 CUI-06E 现有集成测试覆盖；本轮浏览器测试是页面重载和独立磁盘读回，
不把浏览器 reload 称为服务器重启。

## 实际发现及修复

### 1. 桌面弹窗中的国家选择被底层滚动打断

从真实列表选 SKU、填数量再打开表单，快速到 Contact 后选择 Hong Kong，弹层关闭、输入清空。
单独的手机国家选择测试此前通过，不能覆盖这个路径。

记录得到：底层页面 scrollY 在 2199→1353 的平滑滚动期间，国家输入先为 Hong、
aria-expanded=true，下一次 document scroll 后变成空值及 false。仅 preventScroll 或仅 CSS
不会取消已开始的滚动，因此还需在 native dialog 打开时以当前位置 instant scroll 取消它。
最终修复：打开该 sheet 时停止既有动画；仅该 sheet 打开期间禁用背景平滑滚动/滚动；
步骤切换重置 dialog 自己的 scrollTop，标题 focus({preventScroll:true})。
没有通过延时、强制点击或关闭 React Aria 的正常浮层保护掩盖失败。

依据：[MDN dialog 的原生焦点和模态行为](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/dialog)。
实际滚动因果来自上述浏览器事件记录，不是仅凭文档推测。

### 2. WebKit 的 320px Contact 字段组撑宽

320×360 时 dialog clientWidth=318、scrollWidth=326；逐节点定位到字段组宽 306，
而内部可用宽度只有 278。原因是 fieldset 的 min-content 最小宽度。
早期怀疑空 portal，但去掉其尺寸后溢出不变，已撤回这个无效试改，CountryPicker 保持原样。
最终仅给 Requirements / Contact 两个 fieldset 增加 min-w-0，原测试在 WebKit 通过。

### 3. 测试基础设施纠正

- 直接把服务端模块加载进 Playwright 时，Node JSON import 语义与 tsx 服务启动方式不同；
  改成真实服务子进程，不修改国家数据模块或业务 parser 来迁就测试。
- 本机旧 WebKit 缓存不是当前 Playwright 1.61.1 所需版本；使用该版本的 install webkit
  下载 WebKit 26.5 / build 2311。没有把无法启动计成通过，也没替换浏览器可执行文件冒用版本。
- 501 用例初稿把真实按钮 Next page 写成 Next，已根据实际 UI 修正定位；不是产品分页缺失。

## 最终验收矩阵

| 检查 | 实测结果 |
|---|---|
| Chromium 1440×1024 + WebKit 390×844 | 54 passed / 0 failed / 0 skipped，retries=0 |
| 真实数据来源 | 3 个 Alibaba 历史快照（3/6/4 SKU）；1 个生成 Excel 经真实 parser/adapter 的样本（8 SKU） |
| 导航 | 搜索、筛选、已加载页返回、焦点/滚动还原、深链、刷新、Back/Forward、慢响应取消；旧 URL 保持旧详情 |
| 内容 / 响应式 | 显式描述标题、参数/包装分组、真实图片、父图不改 SKU；320/390/640/700/768/900/1023/1024/1440 检查；720px 为 CSS reflow，不冒充实际浏览器缩放 |
| 规模 / 错误 | 0、51、501 变体；501只保留当前页，逐页到11页后选到501；503可重试，revision409丢弃旧快照，404/坏JSON不回退旧DTO |
| 买家完整提交 | 从列表选 Black SKU、数量500，服务端保存目标与快照；真实编号读回；没有前端提交价格作为事实 |
| 状态持久化 | new v0 → note-only new v1 → in_progress v2 → required-reason completed v3；3条不可编辑事件；页面刷新仍为completed |
| 丢回执 | 后端先提交成功再中断响应；界面不虚报成功；相同幂等键重试，磁盘只有1条询价 |
| 两个 Admin 会话 | 同读v0，一个先更新v1；另一个旧提交收到冲突，禁用保存；重新加载并复核后更新v2；旧备注没有静默写入 |
| 导出 | Chromium 实际生成1页 A4 PDF并渲染检查；两浏览器 print DOM均排除内部备注；未调用系统打印机 |
| 全仓 Node 22.13.0 测试 | 1,372 passed / 0 failed / 0 skipped；包含新增2项隔离样本校验 |
| 最后窄屏修复后 | 重新跑 site 327测试、全仓typecheck（167 Astro files，0 errors / 0 warnings / 8既有hints）、lint、15页build，全通过 |
| 生产隔离 | 最终dist JS没有 shared preview detail/list、Save inquiry locally、本地quote提交路径标记；此轮没有开启正式前台 |
| 本地服务 | 4328列表页面及3013 API均返回200，保留供用户查看 |

51 / 501 / 13行分页及坏响应属于明确的合成边界数据，不是另拉了501个真实SKU。
不会把生成的 Excel 文件说成客户整本 Excel，也不会把旧 Alibaba 快照说成本轮实时同步。

## 复跑与文件

先保留/启动 README 中的本地服务。**不要重置或重新 seed 用户的 ui05。**

```sh
NODE_OPTIONS=--no-experimental-webstorage E2E_SHARED_UI_ACCEPTANCE=1 \
  pnpm exec playwright test -c playwright.shared-product-ui.config.ts

NODE_OPTIONS= pnpm --package=node@22.13.0 dlx -c \
  'pnpm test && pnpm typecheck && pnpm lint && pnpm --filter @vibelingan-channel/site build'
```

Node 25 是本机默认工具环境，不是本次宣布的云函数运行时；Web Storage 参数只用于本地测试进程。
完整包验证使用 Node 22.13.0。scoped 浏览器配置固定 loopback，默认 CI 不会自动运行本地写入验收。

日志：`/tmp/channel-cui08-browser-final.log`、`/tmp/channel-cui08-validation.log`、
`/tmp/channel-cui08-final-check.log`。最终截图/PDF在 gitignored `output/playwright/`：

- `cui08-chromium-admin-completed.png`
- `cui08-webkit-admin-completed.png`
- `cui08-inquiry-summary.pdf`、`cui08-print-1.png`

## 下一阶段：继续本地接线，不开始手工部署

1. 为正式 canonical 商品/变体建立明确的批准快照边界：批准什么版本、源更新是否只生成待审核版本、
   现有发布/NEW状态如何保留；先补跨源/幂等/并发测试，不能靠重新发布所有商品获得快照。
2. 正式列表/详情和正式 RFQ transport 同批接线；复用现在的共用 UI 与 handler，功能开关关闭时
   旧接口/旧页面继续工作。新详情不可用不能偷偷回退到未批准源数据。
3. 将集合/索引、迁移预检、函数、配置、前端纳入同版本发布清单；完成兼容回归、审查、本分支提交及
   PR CI之后，才整合 test并由CI/CD部署。线上权限/原生事务/数据读回是部署后的验收门，不是本地开发前提。

邮件、订单/支付/发票、客户类别映射、真实客户Excel整本导入及worker启用继续后置。
不借用旧OEM提交流程、不扩大云端授权、不触碰其他worktree。
