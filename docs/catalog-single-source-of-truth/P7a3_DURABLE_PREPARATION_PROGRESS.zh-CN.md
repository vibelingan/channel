# P7a3：准备任务在回复丢失后的继续执行

2026-10-20，原 pricing checkout，基线 f424c17afaa6157401d67cd076b3d220cff3712b。本 MIU 修复准备任务的浏览器协调器；不修改 worker、数据库、来源映射、价格、分类、图片引用计数、审批或最终发布事务。

## 问题与修复边界

f424 已部署到 test，三个原服务 health、54 个网站制品哈希及函数配置通过验证；原有四个公开分类共 487 件商品的公开字段与冻结基线完全相同。T142 的原准备任务已执行一段，27 张照片中 3 张验证完成，任务重新排队，浏览器却回到需要手动继续的状态。此轮没有抓到原请求的完整时序，不能把现场停顿直接认定为 8 秒等待超时。

独立复现确认客户端缺口：continue 的调用回复未确认时，后续 status 即使证明任务已持久化推进并释放租约，原协调器仍停止。HTTP 回复丢失后的状态恢复也有同样问题。修复保留原 jobId；仅当服务器确认 current、queued、leaseExpiresAt=0，且同一商品、创建时间、输入摘要、内容代数、租约版本及 attempt 单调推进时，才再次调用 continue。图片计数不得倒退、total 不变、invalid/retry 为零，并且实际检查进度或证明进度增加。首次生成媒体计划也作为一次有界进展。

ready 仍由原严格返回合约和服务端 seal 判定，不从 HTTP 成功、调用 ACK 或媒体计数自行推断。单次等待保留 120 秒与总计 64 次请求上限；每段状态查询仍有界。全局预算不随进度重置。没有进展时保留 Check result、Continue、Edit；关闭页面不会撤销远端已执行的工作。

审查发现初版 HTTP 恢复条件过宽，会把明确的业务拒绝和 BUSY 混入自动继续。增加反例后修正为：仅未知传输结果、INTERNAL_ERROR、INVALID_RESPONSE 可用持久化进展恢复；明确业务拒绝停止，BUSY 保留原四次退避上限。并发编辑、取消、权限撤销仍停止，不重新 start，不取得额外写入权限。

## 检查与审查

首轮针对缺口的红测共 62 项，57 通过、5 项按预期失败；随后修复通过。扩大审查的 71 项中，明确拒绝/BUSY 的 8 个反例按预期暴露初版缺口，收紧条件后通过。组合检查 236/236；其中真实浏览器单击 Prepare 可自动到 Ready。独立 Node20.19 检查 75/75，包含真实生产 HTTP 适配器、默认 worker、文件 DB 重开、实际 PNG 存储与解码，以及并发编辑、取消、撤销权限。测试 token 仅用于自有本地夹具，未读取或伪造真实账户登录。

首次类型检查没有通过：测试返回值推断成 unknown，以及把 DOM 模块引入 Node-only 测试包。已恢复 Node 包原文件，把跨端组合测试放入站点包并使用明确的源模块路径。站点测试类型和本地服务类型复跑通过。全工作区与 E2E 类型、lint（1087 文件）、CloudBase SDK gate 通过。全量首轮因并行生产构建触发 Vite 页面重载，WebKit 的批量子流程出现请求取消与断言失败；保留失败日志。冻结代码、避免并行构建后独立复跑通过：7735 项中 7732 通过、0 失败、3 项既有跳过。两项为原 AI 夹具跳过，gallery 浏览器项另显式执行。没有放宽断言或重试失败用例。生产构建首轮误用审批关闭模式，旧发布用例在禁用按钮上超时；保留该失败，不作为功能成功。审批开启的生产构建正式流程 156/156 通过、0 跳过，包含完整 20 件分类发布、BUSY 恢复、公开详情读回、下架、共享图片有效计数恢复、保留原分类的混合 20 件、表格单件/批量恢复与四个网站分类的移动。原 9 份 Playwright 文件逐一哈希恢复一致，临时 DB/构建目录与自有服务已清理。gallery 首次补跑命令因根包没有 tsx 入口未执行；换用已安装 tsx 的准确路径后 11/11、0 跳过。

Standards 审查对照 Frontend Islands、E2E Testing、预合并检查清单和同目录协调器：保留 AbortSignal、全局预算、回调形状和现有恢复入口；请求范围不变，新增测试只写临时目录，finally 等待自有 worker，测试结束清理。Spec 审查对照 PUBLISH_RELIABILITY_PLAN/TEST_MATRIX：本段只修准备恢复；20 件现场发布恢复、全量历史影子检查及性能基准仍未通过，fullDeliveryReady=false。依用户单一工作流约束，两轴审查在原 checkout 内完成，未启动子 agent。

实际 review 文件为 catalog-preparation-api.ts、其 API 测试、catalog-preparation-controls-browser.test.ts、新 catalog-preparation-native-flow.test.ts，以及生产 handler、invoker、worker 和 runbook。文字将“超时导致现场停止”改为“现场观测停止，独立复现未知回复后的进展恢复缺口”；把“自动完成”限定为“有服务器进展且在预算内继续”。比对了真实任务 3/27、原 jobId、拒绝代码、请求上限、退出码和 487 件公开字段。现场证据与本地证明分开记录。

证据目录：output/pricing-clock-repair-2026-10-13/p3e1/，日志前缀 durable-progress-。本 MIU 的完整本地门槛通过；后台继续使用已核验 f424。精确提交审查与最终站点构建后仅发布站点增量，再恢复原 T142 任务进行实际验收。20 件真实商品仍未发布，不能将生产构建中的临时数据验收当作云端真实验收。


## b2cc3e4b 现场结果与恢复

站点仅增量部署 6 个文件；54 个在线制品逐个哈希/MIME 验证通过，原三个后台服务仍是 f424，配置未变。三个原坏时钟实际 Edit/Preview 和准备任务完成，T142 27/27、T157 25/25、W203 24/24 张图片检查及证明全部通过；公开详情保留 T142/T157 各 113 项、W203 121 项完整属性。

实际 20 件已有分类的混合商品通过 Keep existing classifications 发布，首轮加两次 Continue original publication 共三轮，始终沿用原 20 个 operationId。最终独立匿名 HTTP 严格读回 20/20，包括完整 facts、图片、变体 ID/数量、价格摘要、原操作回执和相同 revision。全过程超过 30 分钟，页面最后仍为 19/20；未确认对象经实际 DOM 核对是麦克风 a5ab40df，不是旧摘要猜测的 W203。现场没有完整请求分段日志，不能把这件的具体根因直接认定为 8 秒确认预算。首轮完成率、确认 UX 与性能均未通过。

随后在后台按冻结 ID 逐一核对选择，分两批 Disable，20/20 返回未发布。279 张相关图片两次管理端只读快照完全相同，所有 pending ledger 为空；因此有效计数等于 base，逐一与原计数相同。独立匿名 HTTP 检查 20 件详情均 404、252 张未引用图片均 404、27 张共享图片仍 200，共 299/299，无自动重试。原公开目录另经 13 次实际 HTTP 分页读回，438 耳机、12 AI、5 玩具、32 Misc 共 487 件，逐字段一致，没有增删、重复或分类变化；该检查耗时 66250ms，不作性能达标证据。

发布按正常流程清除了这 20 件原来的“新导入待审”标记，因此恢复检查把它作为待恢复业务状态，而非用“允许历史变化”忽略。依据冻结备份，带 _id、published=false、updatedAt、生命周期版本、原操作 ID 和 reviewer 的比较条件恢复 pending=true，并恢复原来三个 review 字段的缺省形态；updatedAt 严格前进，永久审批/下架记录保留。第一条管理更新因自动权限审核超时未执行，读回证实未写后按工具允许重试成功（匹配/修改 1）；其余 19 条再次核对条件后单次匹配/修改 19。最终完整行再次与原备份比对，价格、分类、来源绑定及其他业务字段一致；仅准备/投影、审批历史、生命周期和 updatedAt 保留正常变化。没有回写整行旧数据。

证据：live-twenty-public-readback-b2cc3e4b.json、live-twenty-restoration-readback-b2cc3e4b.json、public-regression-restored-b2cc3e4b.json、live-twenty-final-restored-business-comparison-b2cc3e4b.json、live-twenty-final-restored-products-b2cc3e4b.json。截图 live-t142-restored-b2cc3e4b.png 是 review 标记恢复前的未发布状态，后续最终截图另存。已恢复实际测试对象，后续性能采样使用隔离夹具。

下一个 MIU P7a4 修复批量中途不可见进度及不能停止等待；确认与性能缺口、全量历史 AdminAPI 影子检查仍未关闭，fullDeliveryReady=false。
