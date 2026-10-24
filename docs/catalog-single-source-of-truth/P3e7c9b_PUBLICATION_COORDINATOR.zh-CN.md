# P3e7c9b 单产品原发布任务协调器

基线 df3fe46f：浏览器 wire 已验证固定scope/单次传输/未知查询，尚未接页面。原UI P1和JSON80-BEGIN-UNEXPLAINED-1继续阻断bless/部署；后一项诊断/重跑通过并不等于根因已经修好。本段是独立的客户端协调，不移除这两项门槛。

## 规则

输入只有首次生成并保留的publish attempt，或已保留的原scope。协调器不生成新UUID、不重置原用户输入、不将后来编辑的行套进旧操作。恢复先get原任务，再按同一digest继续。已complete且current=true只表示原生提交当前有效，返回committed；后续调用者还必须做公开读回才计入published。历史complete/current=false不重发；未完成且过期/取消/非current立即停。

continue可能先保存私有进度再失败，不能凭CONFLICT/BUSY等错误码断定整条流程没写。沿原scope查询：若已完成，按真实回执返回；若仍私有，保留明确issues及恢复入口。明确BUSY在查询有效原进度后才有界等待重试；未知查询失败保留unknown及scope，不重建任务。登录失败停止进一步写入，待同账号回来查询。

媒体提示wait/continue时，复用已有runPreparation和签名Human start/status/continue；每个Human写前重查原发布任务。它使用独立RPC预算，解除owned continue剩余不足10秒、始终wait的路径。ready仅触发查询/继续原发布任务，不算已发布。retry/edit/repair保留用户动作；旧completed seal与新来源绑定不符仍须P5修复，不能盲目retry。来源/角色/取消在等待期间变化，原native终局仍最终核对。

引用恢复只携回服务端cursor，不能传图片列表/增量。总运行120秒/64请求上限、连续不推进时退避并pause，预算向下传signal；abort仅停止等待，不谎称原生取消。临时定时器在所有结束路径清理。提示回调出错与RPC错误分开，保留最新真实状态并停止后续写入。

本段不实现批量/持久scope存储/React页面接线，也不改变后台或新增env/表/凭据。下一段才接共享4并发、分组及现有Classification/RecordForm和反馈；缺主分类不自动补。C9b先用假传输和实际共享DTO锁定控制，再以真实Admin/JSON/PNG串联，不把受控时间当真实P95。

## 验证表

暖启动/恢复无新start；历史完成/取消/过期/编辑后停止；满槽cursor携回；媒体wait独立Human准备后续同根；准备后来源或权限变化；明确错误后的complete和私有进度；BUSY查询后重试；未知/错scope/两次查询失败；最大调用/时间/无进展退避；回调错误与abort；实际前后端原任务、公开读回/实际回退。全部按适用状态展开，核心路径有mutation证据。


## 数据与状态转移

输入在第一次 await 前校验并复制。首次是 C9a 已冻结的 `PublicationAttempt`；恢复只有原 `PublicationScope {productId, operationId, inputDigest?}`。保存的 `referenceRecovery {imageId, ledgerDigest, nextOffset}` 是1024字节内的服务端游标；它可与恢复 scope 保留，不能代替服务端账本事实。缺 digest 不接受引用检查点。新 UUID 只由调用者在第一次用户提交前生成，本协调器没有生成入口。

| 当前事实 | 协调动作 | 结果 |
| --- | --- | --- |
| 新 attempt | 单次 start，再推进原 scope | 所有后续写保留原 operationId/digest |
| 恢复 scope | 先 get，不另建操作 | saved/staging 才继续 |
| complete/current | 停止写 | committed，仍须公开读回 |
| complete/非 current | 停止写 | historical，不复活商品 |
| 取消、过期、未完成且版本变化 | 停止写 | cancelled 或 needs-action |
| preparation wait/continue | 独立 Human RPC，每次写前查询原根 | ready 后继续原发布任务 |
| preparation retry/edit/repair | 保留当前任务 | 明确用户处理入口，禁止盲目换 job |
| continue 明确错误 | 查询原根 | 已完成按回执；仍私有保留 issues；BUSY 有界重试 |
| continue 回应及查询都未知 | 停止追加写 | unknown，保留原 scope |
| 请求/时间/无进展预算或展示回调失败 | 暂停 | 保留最后真实状态和检查点 |

原风险代码会让调用者自行循环并把展示回调当同步通知：

```ts
onStatus?.(structuredClone(status));
await nextContinuation();
```

异步写浏览器记录失败时，下一写已开始；`throw undefined` 也无法靠 `observerError !== undefined` 识别。现实现等待回调，单独记录 observerFailed，并用总 signal 释放挂起的回调；迟到拒绝始终有处理者。回调只能拿副本，不能改真实 scope。若服务器已给出 complete，展示失败保留 committed 和真实回执，后续仍需公开读回。

引用检查点只在尚未完成的引用页使用；只读查询且仍是同批准 revision/引用进度时保留。已发出的 continue 不论是否有可读回复，都先丢旧检查点，再只接收新的服务端游标；明确失败后查询也不能沿用可能过时的账本位置。终态、其他阶段、引用完成清除。服务端继续验证 ledgerDigest，客户端保存不是授权。

选择复用 `runPreparation`，让媒体 start/status/continue 各有独立 HTTP 预算，同时受父120秒/64请求限制。提高服务器单次20秒上限或削掉原8秒worker启动契约都会把问题推给超时；本步没有改变这些约束。重建原发布任务会丢掉用户冻结输入和私有进度，因此恢复只查/续原scope。批量调度、Web Storage容错和跨页UI生命周期由下一MIU接入，不能把本模块状态当持久记录。

## 红绿、故障与组合验证

初始2个主路径先红；保护测试36项中6项失败，分别暴露恢复检查点丢失、同步/undefined/异步回调失败、挂起回调不能释放和null输入TypeError。修复后扩为54控制，全通过。7个真实客户端模块↔默认Admin↔JSON/PNG组合也通过：0/105来源SKU、开始或最终回应丢失、实际保存耗时2200毫秒使inline剩余不足10秒、独立Human处理后回应丢失、真实review-change后原scope恢复、浏览器暂停后原reserved恢复及撤回后的历史零写。每例公开详情revision/名称/SKU数和图片可读；finally通过实际Admin下架或取消，原分类字段逐一保持、公开404、有效引用归零、临时目录清理。这是本地模块桥接，不是浏览器点击或云COS证据；2200毫秒只用于触发确定分支，不是P95测量。

14项故障第二轮全部检出，19重叠失败，单源码SHA恢复。第一轮“未清旧游标”幸存：已有测试只经过未知网络错误，低层恢复后的observe也会清游标；补上明确BUSY后的确认查询与第二次continue分支，再全轮重跑。保留第一轮结果，不把幸存写成通过。格式检查曾因模板字符串建议退出，手动改正；没有忽略规则、抑制类型错误或改测试配置。

命令包括 `node --import ./apps/functions/admin/node_modules/tsx/dist/loader.mjs --test apps/site/src/islands/admin/catalog-publication-run*.test.ts`（实际运行分别列出两个文件）、既有 `pnpm --filter @vibelingan-channel/site test`、local-server test、Node20关联组合、`pnpm typecheck`、四文件Biome、site build。site924/local1057/Node203224均0失败/取消/跳过；19包类型和E2E类型、既有site测试类型、15页构建通过。相关证据合计6189，其中shared354/db2238/admin638/public182/sync308/scripts488复用C8未变源码证据且核对哈希；651安装SDK和精确三函数14进程仍为4e5e13bf。本步未改后端、共享状态合约、依赖、env或SDK表面。

## Review与未完成项

实际逐文件review/simplify核对四个改动源码/测试，以及C9a客户端、原preparation循环、实际Admin入口/最终事务、共享DTO、workspace清理与公开详情。按frontend-async-state规则核对所有await/回调迟到拒绝/取消后写及未确认响应。文案将“发布成功”细化为“原生提交committed，仍须公开读回”，将“取消”区分为“浏览器停止等待”和“服务器原根已取消”，将受控预算与实际延迟分开；humanizer核对本记录和IMPLEMENTATION_LOG的数量/范围。

没有接客户页面或声称原UI P1已修好。JSON80本轮完整local/Node20通过，原一次begin失败原因仍未建立，继续阻断bless/部署。跨标签/刷新记录、共享4并发20分组/50与100组合、Classification与RecordForm接入、旧坏数据P5修复、新上传/live-edit及真实云角色竞争/P95、三时钟resync和真实20件选品后回退均待后续，fullDeliveryReady=false。
