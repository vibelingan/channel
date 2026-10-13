# Catalog 全功能测试矩阵

这是 [整合方案](PUBLISH_RELIABILITY_PLAN.zh-CN.md) 的验收附件。状态：计划，尚未执行；表内的功能组不等于测试通过数。

## A. 执行约定

每组展开为独立 caseId，记录输入、操作入口、原状态、期望结果、公开版本、字段/图片引用断言、耗时和恢复断言。每条会写入的用例必须有 finally 恢复及服务端操作 ID；空选择、空 fixture、缺关键凭证或全部 skipped 都使该 lane 失败。用户填错与系统缺陷分开统计，不能把合法来源超限改名为用户错误。

三层数据：

- L：隔离本地 JSON DB，真实 production handlers 与构建后的前端。可做所有故障注入，测试后删本次临时 DB。
- C：真实 CloudBase 隔离资源，验证安装 SDK、真实 transaction、计数和并发，测试对象限定 runId；不注入客户实际商品。
- T：已部署 test 的实际页面。全功能编辑等使用专用测试对象；真实 20 件仅做已授权定向 resync、读取、原分类下发布和下架恢复。

所有发布入口用 Alibaba 草稿、手工商品及仍在支持范围的旧导入商品展开。手工配置不是可静默删除的例外：若当前 UI 正常暴露配置及发布入口，应给现有配置无损投影和审批测试；若数据语义无法确定，则登记为阻止发布的支持范围决策，不能宣称该功能正常。不要修改另一 importer 的工作流来掩盖本模块问题。

正常测试共同断言：没有 pageerror/未解释 4xx/5xx、没有不合理重复请求、没有假成功；请求和返回对象 ID/操作 ID/版本一致；价格、MOQ、单位、币种、配置身份跨列表/详情/询盘展示一致；私有 source/raw/存储地址不出现在公开响应。正常路径允许被系统自动吸收的 BUSY 重试，用户不能被迫重走另一入口。

## B. 24 个正常功能组

| ID | 功能与实际入口 | 必须覆盖的形态 | 成功断言与恢复 |
|---|---|---|---|
| F01 | Products 列表、搜索、排序、过滤、分页、跳页 | 四 family、无分类、旧字段缺失、normal/issues/preparing、空目录 | 结果/总数/分页一致；切换查询无旧响应覆盖；不遗漏或串选对象；读取不改状态 |
| F02 | 选品、全选、取消选择与确认面板 | 1/10/20/21 件、跨页、执行前换筛选 | 冻结明确 ID；21 件在提交前引导拆批；执行对象与确认完全一致 |
| F03 | Data issues 查看、编辑、重新检查 | 构建失败、来源缺失、媒体坏、版本旧 | 无需成功解码 CatalogDetail 即可查看原因/进入修复；修好后恢复正常列表 |
| F04 | Needs classification / Classify Save | 无主分类、Misc/None、已有子分类、跨 family | 无分类能查看保存但不误发；分类保存结果准确；没有强加分类；测试后恢复分类 |
| F05 | 新建草稿 / 新建勾选 Published | Alibaba 来源无 N/A 创建、manual/旧导入模板、有效无价、有效价格 | 一个创建意图只产生一件；发布失败保留草稿 ID；批准后才公开；专用对象还原/归档 |
| F06 | Edit 未发布商品 Save | 名称/描述/规格、价格、照片、合法已有配置、取消 | 保存不发布；全部配置不丢；有效草稿可继续编辑；恢复所改字段 |
| F07 | 管理员 Edit 已发布商品 Save | manual/Alibaba，内容/价格/照片、分类，Changed/Edited | 符合 DEC-12；成功显示新批准版本；审批失败旧公开内容完整且编辑保留；不复活并发下架 |
| F08 | Contributor 编辑与管理员接手 | draft/live、无变化保存、有效变化、禁止变更 | OWN-1：贡献者不批准；live 保留旧公开版本；必要标记准确；恢复账号/对象原状态 |
| F09 | 行 Publish/Disable 开关 | 新草稿、已批准未发布、已发布、重复点击 | 行入口运行同一批准协议；下架不再公开；测试后恢复原状态 |
| F10 | 表格批量 Publish/Disable | 1/10/20、独立/共享图、manual/Alibaba | 逐件批准与状态正确；共享计数精确；只处理确认 ID；20 件还原 |
| F11 | 单件 Assign category → Save and publish | New Alibaba、manual、Misc 无子类、有子类 | 不再一概拒绝 New；预检使用目标分类；分类/发布各自有回执；恢复原字段/状态 |
| F12 | 20 件 Assign category → Save and publish | 同供应商共享模板图，含三件修复时钟；分类保持 | 20/20 真正公开、20 个正确批准 revision；逐件详情正确；20/20 恢复未发布 |
| F13 | 正常 Preview、配置分页、关闭后重开 | 0/1/20/21/50/105 SKU，原图/人工配置图 | 不导图、不批准、不改业务状态；页与价格摘要来自同版；加载完整且快 |
| F14 | Preview Approve changes / 不编辑批准 | new、price-only changed、含图文 changed、removed | 本次明确审核范围内批准；需 Keep/Use 的内容仍有决策；不绕过供应商审查 |
| F15 | Supplier changes Keep / Use / 自己编辑 | description/gallery/description photos，各组合，新来源再次更新 | 决策绑定精确 incoming digest；人工字段保留；新值要求重新审核；恢复专用对象 |
| F16 | Gallery 上传、导入、添加、删除、排序 | source 已预备/缺图、JPG/PNG/WebP/GIF、手工选择 | 序列正确、图片真实可读、取消未保存不误入公开；清理本次未引用上传 |
| F17 | Description images 的导入和选择 | 0/17/18/19、已有 []、已有人工选择、重批准 | 首次 19 沿规则取前 18；已有人工选择不替换；公开顺序正确；恢复选择 |
| F18 | 配置照片选择与前台交互 | 单一/多配置共图、无来源配置图、人工绑定 | 确切配置身份不串；点唯一配置图选对配置，公共图不乱选；取消不保存 |
| F19 | Follow Alibaba ↔ manual website pricing | fixed/range/tiered/negotiable/unavailable，USD/CNY，MOQ/边界量 | 保存/批准语义正确；列表、详情、选项、数量及询盘展示相同版本；恢复价格模式 |
| F20 | selected resync / full/incremental/replay 的单商品落点 | 新、已有、无分类、人工改过、主来源变化 | 数据/身份幂等；不覆盖人工字段、不发布、不误分类；坏商品可正常加载 |
| F21 | 来源 link/unlink、missing/removed | 显式绑定、重试、并发变更、旧批准版本 | 主来源归属唯一且正确；旧任务不写新来源；现有公开版本不串源；专用对象恢复 |
| F22 | 发布后前台所有消费面 | list/item/id/slug/family route、SKU、图片、RFQ 价格投影 | 同一批准内容与分类投影；无私有字段或旧 row 价格泄露；不对真实客户发送测试询盘/通知 |
| F23 | Disable、Archive、Restore draft | live/draft/changed、单件/批量、重复请求、draft 已有 pending publish 时再 Disable | 显式取消即使状态相同也阻止旧发布；旧发布任务不能复活；恢复为 draft；图片 delta 正确；实际对象仅可逆操作 |
| F24 | 旧数据迁移、功能开关和版本回退 | readiness 缺失/空、旧批准 v1-v3、无 slug/旧 category | 影子数量/哈希覆盖、可中断幂等；问题入口先就绪；旧公开数据不消失；回滚仍可读 |

## C. 24 类异常与边界组

| ID | 注入/边界 | 必须断言 | 验证层 |
|---|---|---|---|
| X01 | 三件真实坏 source observation 的最小复现 | 精确阶段/字段；修复前失败、后通过；仍可查看原件；不是用合成字段冒充根因 | L + T 定向修复 |
| X02 | 100/101 facts、200/201 名称、2000/2001 值、30000/30001 描述、UTF-8 多字节、job/variant 字节预算 | 实际生效数据与未采用来源分开；合法大内容不截断；真正异常可修；L1 必要时进入门槛 | L + C |
| X03 | 重复/冲突属性、缺/重复 SKU 身份、错误报价归属、非法 tiers/币种/数量 | 不静默合并价格、不给 0 假价格、不丢配置；合法无价可成功 | L |
| X04 | source 在检查前/中/后更新、同 observedAt 不同内容、同内容重放 | 缓存只对正确 revision 生效；没有旧 ready 放行；相同内容幂等；旧 public 保留 | L + C race |
| X05 | 旧检查结果慢返回、source link 被替换或 unlink | 旧报告不能覆盖新 generation/归属；错误 source 不可用于 publish | L + C race |
| X06 | 双编辑同字段/不同字段、分类表更新/归档 | 保留我的输入；不丢修改；安全合并只限无冲突字段；分类依据精确规则，不猜测 | L + C + T 专用对象 |
| X07 | live 编辑/审批/读回间另一管理员 Disable/Archive | D02 反例必须由失败变通过；任何旧请求都不能恢复 published | L + C race |
| X08 | manual/Alibaba 保存回执缺 updatedAt、错 ID、错 operation/revision | D04 不再丢 guard；查询结果前不继续写；D10 保护保持有效 | L |
| X09 | commit 已成功但 HTTP 响应丢失/超时/JSON 损坏 | 查同一操作确定结果；不假报失败/成功、不新建第二件、不重复引用计数 | L + C |
| X10 | prepare/begin/page/finish/publish 的每个断点失败、函数预算耗尽 | 完成的阶段可继续；旧公开版本完整；job complete 与已发布区分；恢复同 ID | L + C |
| X11 | 单件 BUSY/共享图片事务冲突/锁获取冲突 | 有界自动退避、同操作重试；锁获取冲突不吞成通用 500；结果只记一次 | L + C race |
| X12 | 单个未知结果、两个持续未知、401/403 | 单件异常不无故停全部；持续不可达/撤权停止新写；逐件未尝试清楚，重新登录可恢复 | L + T 专用对象 |
| X13 | 部分成功后只重试失败项、刷新/重开页面、双标签页重复提交 | 成功件不重复批准/发布；同 actor job 续接；不接管其他 actor 的操作 | L + C + T 专用对象 |
| X14 | 选择改变、排序/分页刷新、慢旧响应、取消操作 | 确认集合与执行集合一致；已提交的部分仍有回执；旧结果不污染新页 | L UI |
| X15 | 图片复制 404/403/429/5xx/超时/重定向/坏 MIME/超大文件/GIF 假 .jpg | 暂时/永久问题区分；有快速人工 fallback；已有图不丢；不再全图库失败后清空 | L + C/T 专用对象 |
| X16 | Upload/导入尚未完成时 Save/Close；移除/重排中异步完成 | 父表单正确等待；late completion 不恢复已移除图、不乱序；对象 URL 回收 | L UI |
| X17 | 图片删除↔approve finish、删除↔publish/disable、两个商品共用同图 | 各交错序列不删正在生效的图；jobs→products 检查顺序保留；不存在负计数 | L + C race |
| X18 | job 过 1 小时、锁新鲜/陈旧/损坏、锁释放失败 | 不无限重试；安全可检查/恢复；未证明可恢复的锁不自动清除；旧任务不再 finish | L + C |
| X19 | 缺配置行、混合 revision、缺图片绑定、媒体变更超事务预算 | 不把部分配置当全量；不切换半个批准版本；有明确原因及可执行下一步 | L + C |
| X20 | 连续 3–5 个 20 件批次、共享媒体高重合、重批准/重复下架 | 无跨批串对象；累计引用计数准确；单请求仍 ≤20/并发4；耗时不持续恶化 | L + C 隔离压力 |
| X21 | 空/旧/null 字段、旧类别残留、无 slug、无价/0 SKU | 正常旧商品仍可查看/编辑/发布；不误入空状态，不要求无价商品填写假价格 | L + T 只读样本 |
| X22 | 脚本 chunk/私有预览图/供应商子面板加载失败、浏览器 back/forward | 主页面和输入保留；局部重试；无 raw storage 泄露；恢复后流程可继续 | L UI + T 专用对象 |
| X23 | readiness backfill 中断/重复页/并发更新，开关及合约版本回退 | stable _id 不漏不重；旧检查不覆盖新；不改 published/分类/批准内容/图片计数 | L + C |
| X24 | 任一验收断言失败、清理中断、他人并发修改测试对象 | finally 恢复可续；仅恢复自己的改变，不覆盖他人；清理失败使验收失败并留 ID 清单 | L + C + T |

## D. 端到端组合和故障时序

最低组合不是随机挑几件好商品：

1. manual + Alibaba New：每个发布入口分别跑；创建勾选发布、Edit live Save、Preview approve 均独立。
2. Changed/Removed/Edited：同一份 incoming value 的 Keep/Use、来源又变化、贡献者接手各跑；不能仅以 New 代表。
3. 独立图库 + 共用描述模板 + 共用 SKU 图：1/10/20 件；20 件之外连续多批，含重试与回退。数据库 race 用并发 barrier 控制真实交错，不用串行 fake 冒充。
4. 容量边界 + 105 SKU：最后一页也有最低价/错误/未绑定图；确认全量摘要和所有页面检查。
5. 每个 mutating phase 都跑“执行前失败、执行后响应丢失、恢复后重复请求”；至少包含 source write 与 readiness 写回、分类保存与发布、finish 与 lifecycle commit。
6. cold/warm 性能按方案表记录；瞬时错误恢复的时间另报，不能把恢复轮次从总耗时里扣除。

对于每个并发转移明确 winner/loser：两次同版本修改只允许一个生效；独立商品审批可以都成功；下架后旧发布意图不能获胜；来源更新后的旧 ready 不允许成功提交。不要把所有 Promise.all 的 fulfilled 个数都写成 1，按实际业务不变量断言。

## E. 恢复清单

执行前保存：runId、环境和 SHA、productId/来源 ID/操作 ID、published/archived、分类、人工字段/媒体选择、批准 revision、相关共享图片基线计数。日志不含凭证。

执行后核对：

- 真实 20 件全部恢复未发布；原分类与人工字段保持；坏数据修复保留。
- 所有公开产品/详情接口对本次下架对象拒绝访问；共享图片按总体引用数决定访问，不错误要求所有图片 404。
- 无重复记录、悬挂占用、遗漏测试对象或负计数。临时的未引用上传、隔离 fixtures、测试询盘用该环境的受支持清理协议处理；客户实际对象不永久删除。
- 有他人修改时，不用整份旧快照覆盖；生成精确未恢复清单继续处理。
- 恢复断言与功能断言同等重要。恢复未证实，整次验收未完成。

## F. 现有测试复用与新增接线

现有 `catalog-detail-source.test.ts`、`catalog-approve-once.test.ts`、`handler.test.ts`、`catalog-detail-staging.test.ts`、`catalog-source-staging.test.ts`、`catalog-product-save-plan.test.ts`、`product-batch-update.test.ts`、`catalog-detail-approval-api.test.ts`、`catalog-taxonomy-ui.test.ts`、`photo-preparation.test.ts`、`catalog-formal-journey.spec.ts`、`catalog-admin.spec.ts` 和原 public/catalog suites 提供基线。这里只核实文件和相应用例存在，本轮没有重新宣称它们全通过。

已发现缺口：普通分类刷新下架 race、manual 缺版本不降级、来源原子失效、刷新后同 operation 恢复、20 件同供应商共享图/SKU 图全链路及恢复、真实三件坏 fixture、性能门槛。需新增针对性用例；已有“并发4”单测当前以 10 件运行，不能把它冒充 20 件真实审批验收。

不得直接运行旧的全量 `catalog-live-acceptance` 作为本次现场验收：该流程含安装映射规则等全目录操作，超出用户的保留现有分类要求。新增 scoped lane 只接收经过校验的 manifest，拒绝 manifest 之外的对象和全局 mapping 写入。
