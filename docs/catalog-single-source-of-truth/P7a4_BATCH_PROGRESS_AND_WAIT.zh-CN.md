# P7a4：批量发布时显示进展并允许停止等待

基线 b2cc3e4b，仍在原 pricing checkout。执行模式 solo MIU，不新建分支、worktree 或子 agent。

## 现场和边界

实际 20 件通过 Assign category → Keep existing classifications → Save and publish 发起。每件只有一个原 operationId，首轮加两次原任务继续，共三轮才全部完成；独立匿名 HTTP 读回 20/20，通过严格 decoder 和原审批记录的完整属性、图片、变体、价格及 revision 比对。页面最后仍显示 19/20，未确认对象实际是麦克风 a5ab40df，不是 W203。旧摘要中的 W203 判断以本次 DOM 与原恢复记录核对为准。完整冷流程超过 30 分钟，性能及正常一次完成验收失败，不能算已修好。已通过现有后台 Disable 分两批准确下架 20 件，未改分类。

当前生产代码在 ProductClassificationEditor 中创建 createPublicationBatch()，没有接已有的 onItem。它一直等 batch.run 返回才显示结果，旧结果会在继续期间滞留；所有退出入口随 pending 禁用，无法停止本地等待。

## 数据形状与约束

| 数据 | 生命周期和范围 | 判断依据 |
|---|---|---|
| onItem 的 scope 和 state | 一次当前批量，当前账户/API/商品/原 operationId | 由已有 batch 严格验证；不从 ACK 推断成功 |
| 已检查数与已确认数 | 当前组件一次等待，随下一次检查重置 | 仅同步回调累积，不写数据库 |
| 原 publication journal | 当前账户/API 的持久恢复记录 | 由原 batch 保留；停止等待不删除 |
| 已公开内容及图片计数 | 原发布和下架事务 | 本 MIU 不改变 |

batch.run 已等待所有受控 worker 和 onItem 回调退出，再返回结果。组件不能在 abort 后立即解锁；仍等原 batch 和读回收尾。回调须检查 mounted、原 AbortSignal 和选中 scope，停止或卸载后不再更新进度。React setter 只提交计算结果，不拿 setter 当 getter。

## 修复方案

创建 batch 时接同步 onItem，显示当前已检查/总数/网站确认数；最终反馈仍由原完整 batch 结果和分类读回生成。继续时隐藏上轮结果，避免旧的 19/20 看似当前进度。发布等待中提供 Stop waiting，仅 abort 浏览器本次等待，显示正在停止，并保留原任务和已公开结果。服务端取消仍是独立的 Stop original publication。复用当前 buttonClass、output 和恢复区域。

不采用提高并发或无限延长等待；本 MIU 不解决冷图速度，也不放宽确认条件。8 秒确认预算的现场原因尚未抓到，不在这里推断成根因。

## 测试与审查

先新增 Chromium/WebKit 真实组件 + 生产 handler + 文件 DB + 实际 PNG 的反例：挡住一件原 continue，另一件真实发布且公开确认时，应立即显示 1/2；停止等待后已公开件保持公开，不发送 cancel/stop；导出的原恢复记录含同一 operationId，释放旧请求后继续原任务，2/2 发布且分类不变。原全量组 finally 通过现有操作下架并校验图片计数，清理临时 DB/目录。

先跑该浏览器组合验证红测，再实现、两轴 inline review 和回归。确认预算、冷准备速度、全量历史 AdminAPI 影子审计及性能基准仍是后续门槛，fullDeliveryReady=false。


## 实现与反例结果

ProductClassificationEditor 通过 createOwnedBatch 接已有同步 onItem；回调检查 mounted、当前 batch、AbortSignal、商品和原 operationId，仅计算当前已检查/已确认数。确认数仍由原严格网站读回产生。runOwned 每轮重置进度，完整结果继续走原合并和分类读回；等待期间隐藏旧反馈，不把上一轮结果冒充本轮进度。Stop waiting 只中止本次浏览器等待，保留 journal，不发出服务端 cancel/stop。

第一轮红测将新用例放在既有固定 starts.size=20 的用例之前，新增两件夹具造成额外计数失败，并在失败后的换页产生 WebKit 取消错误。已把新用例移到这些固定计数检查之后，不放宽计数断言。独立红测 34 项，30 通过；两个新进度用例按预期失败，两个父测试因此失败。原有 30 项全部通过。

首版修复 Chromium 通过，但 WebKit 在停止等待后仍等待不返回的请求，恢复按钮 5 秒内不可用。两条独立单测复现私有 RPC 和公开 fetch 忽略 AbortSignal 时挂起：44 项中 42 通过、2 项按预期失败。审查还发现停止后会自动开始额外的产品读回等待。

修复 batch 的私有/准备 RPC 和公开 fetch 等待边界：同时遵守整个 batch 和单个 RPC 的信号，发送前检查，等待时用既有 until 与中止竞争；迟到 rejection 有消费者，迟到公开 Response 主动关闭 body。原请求在服务端仍可能完成，不能把浏览器等待结束说成远端取消；原 ID、后台租约、CAS 和生命周期栅栏仍是正确性边界。组件等待客户端批量 worker 退出后解锁；用户中止时不再开始一轮新的产品读回，明确保留未核验结果和原恢复入口。

新增迟到公开 body 清理检查。组合 79/79，0 跳过；Chromium 与 WebKit 均证明 1/2 实时进度、快速停止等待、已发布件保持公开、没有 cancel/stop 或额外 get/list、导出保留原 operationId、迟到请求完成后继续同一任务、2/2 发布且分类不变；所有夹具通过原服务下架/取消并核对共享图片计数归零。完整工作区 7740 项，7737 通过、0 失败、3 项既有跳过；与前一轮相同的跳过口径，未放宽断言。完整类型/构建检查见后续记录，当前尚未部署本 MIU。

## 两轴审查和文字核对

Standards：实际审查 ProductClassificationEditor.tsx、catalog-publication-batch.ts、两份对应测试，并对照 api.ts、catalog-product-operation-api.ts、catalog-publication-run.ts 和 journal 的边界。沿用原 Select/buttonClass/恢复区，回调无 I/O，未通过 setter 读取状态；未改 API DTO、数据库写入、价格、分类、worker 或权限；RPC 中止后的迟到结果不能重新更新进度。发现的忽略中止和额外读回已修复，当时静态审查未见遗留 P1/P2；随后生产构建的真实组合门槛失败，本 MIU 尚未完成。

Spec：对照 PUBLISH_RELIABILITY_PLAN 中“逐件状态与回执”“慢件不阻塞已成功回执”和保留原任务的 fallback。本 MIU 覆盖进度与停止等待；没有把恢复能力当作 20 件首轮成功、全历史数据已审计或性能达标。远端已提交请求仍可完成，页面说明必须保留。确认总预算、冷图多轮准备和 P95 仍是独立硬门槛。

实际文字审查包括 P7a3/P7a4 与 IMPLEMENTATION_LOG，将“20 件通过”改成“20 件最终公开读回通过，首轮与性能验收失败，恢复验收通过”；把“等待 worker 退出”明确为“客户端 worker 退出，远端原请求仍可能完成”。核对了 20 个原操作 ID、113/121 属性数量、299 个公开恢复检查、279 张空 ledger、487 件原公开字段和退出码。证据日志前缀 batch-progress-，fullDeliveryReady=false。


## 生产构建门槛失败，继续修复

首轮生产构建公开41/41、目录90/90通过；formal10/11，20件共享图片在原90秒门槛时仅16件确认，仍有4件在准备中。首次日志出现一个准备CONFLICT，但定向复跑的完整 trace 只有注入的 BUSY，没有其他业务错误，不能把 CONFLICT 当作本次慢流程根因。失败用例保留了真实 API 阶段记录（不含 token/请求正文）和自有临时数据库。两次都恢复原9份报告哈希、清理自有临时DB/构建/进程。没有部署本 MIU。

定向复跑：每件9张真实PNG，前16件准备均需5次 worker，耗时12.64–19.42秒；90秒时最后4件检查9/9，证明0–1/9，仍在running。20次start平均191ms，37次publication continue平均2481ms，69次preparation continue平均3288ms；只按完整四件流程占4个并发槽，额外分轮成本累积超过原门槛。该观察引出 P7a5 独立优化；不延长测试时限，不把第二次失败称为新故障修好了。
