# P7a7：在图片进度事务内更新当前租约

## 运行问题

P7a6固定前台提前暂停后，原20件生产构建仍在90秒时只确认8件。阶段时序显示准备continue平均7.355秒，多次超过8秒ACK等待。worker每处理一张图片先调用独立renew事务，再调用已验证同一租约、当前候选、绑定与持久进度的事务；证明阶段也如此。9张已有图片产生9次像素前renew和9次证明前renew，共18次额外完整当前候选读回及job写入。27张产生54次。这个数量来自实际循环与每次最多4张像素/16张证明；不是线上耗时百分比估算。

```ts
await run({ action: 'renew', jobId, lease });
await run({ action: 'reserve-image-check', jobId, lease, imageId });
// 原事务持有图片hold、验证输入，然后写job。
```

## 数据与技术约束

| 值 | 范围与约束 |
| --- | --- |
| job leaseOwner / leaseVersion / nonce | 服务器内存能力绑定，序列化或旧租约始终拒绝 |
| leaseExpiresAt | 原120秒TTL；只有仍有效的当前租约可推进，不允许过期复活 |
| job.mutationRevision | 每次实际job写入递增1；不承诺每张固定两次写入 |
| media与mediaSeal cursor | 同一事务持久化；ACK丢失重放不能重复推进或改写幂等证明 |
| candidate digest / contentGeneration | 每个原事务前后重新校验；编辑、取消、替换绑定仍使旧工作失败 |
| worker budget | 原20秒与8秒收尾余量保留；4张像素/16张证明上限保留 |

CloudBase事务内所有依赖在写入前读取。authority.currentLeaseScope从新读的job验证当前未到期、owner、version、nonce、候选；绑定的内存grant不固定expiry，所以原renew已允许延长期限。expiry更新不能早于最后一次租约检查，也不能把失效租约写成有效。

## 选择与代码落点

在 packages/db/src/catalog-preparation-jobs.ts 的 reserve-image-check 已有job写入中加入 leaseExpiresAt: now + ttl；有效hold与当前候选仍先读先校验。attest-media-image 只有确实推进seal时，在原job写入同样更新expiry；bind-media-seal和重复最后一条证明维持原行为，不为幂等重放追加写入。两个动作原本均会改job，因此不增加文档数、不扩大事务、不改SDK/DTO/存储合约。像素advance和最终finish仍重复检验当前租约。

在 worker 中去除这两个动作前单独的renew。来源导入的renew保留，因为它是另一条有外部网络的子流程，本单元不扩大范围。claim仍给每次有界worker一个新120秒租约。

不直接删除心跳而依赖20秒假设；把心跳和原进度同事务提交，可避免长事务/未来调度改变后失去续租。也不做16张合并事务：每张仍独立检查，编辑/取消仍能在下一张中止。减少18/54次命令不代表云端P95已达标。

## 风险与反例

先补独立时钟测试：reserve和attest在仍有效租约的第90秒成功后expiry必须为当前时间+120秒，grant在原expiry之后仍可继续；旧实现expiry不变应失败。没有任何进度的过期租约、取消后的能力、已被新worker接管的旧能力、候选被编辑的能力均不允许续租或推进。ACK重放相同attestation不得改变expiry/写入数。真实9张PNG经3个原worker到ready且独立renew最多30次。第一条反例测到总计48次：其中18次是本单元去除的媒体/证明前续租，另30次来自原candidate inspection的权限/当前输入检查，保留。没有把18次误当作整个流程的全部续租。原图片、分类、价格、未发布状态和引用计数必须不变。

运行kernel、native JSON/PNG、105张/取消编辑/ACK/时间预算和Node20回归；两轴review后重跑原生产构建20件90秒断言。全量测试与test云端真实验收继续，不把局部绿灯说成最终完成。


## 官方与安装包合约

Context7当前不可用。通过CloudBase MCP读取官方 /database/transaction：100操作、30秒限制，事务快照及写冲突、get/set/commit/rollback保持原合约。本单元不增加文档/SDK调用或事务尺寸。官方页泛称仅node-sdk支持；仓库已用实际wx-server-sdk4.0.2与node-sdk3.17.2的运行时probe、类型及SDK gate证明现有runTransaction表面，按已安装运行时执行，不新增类型shim。SDK gate本轮已通过，最终改动后仍复验。云环境只读auth确认原ap-shanghai/diversity环境READY，未操作线上数据或配置。

第一轮11条新增反例8通过、3失败：reserve/attest原expiry不更新，完整9张使用48个独立renew，超过保留inspection的30个上限。过期、取消、接管与编辑的8个反例在原实现均拒绝，修复后必须继续拒绝。


## 实现、复验与审查

生产改动仅kernel两处已有job写入增加expiry更新，worker移除两处重复renew；来源导入renew、所有逐张事务、严格当前输入/能力/取消/计划/像素检查均保留。Node20.19的kernel/完整worker/真实HTTP-PNG组合180/180、0跳过。包含105张独立图片、DB/authority重开、ACK丢失重放、原时间预算、实际编辑/取消、过期及新owner接管；新增reserve/attest在第90秒推进后过原expiry继续只读成功，重复证明全文件字节不变。

首次定向green为10/11：一条attest夹具在bind-seal前未达到可证明状态，原setup只断言ok，未保留其media结果。已增强setup必须verified=1并记录完整返回码；单跑1/1、随后完整180/180均通过，尚无证据把第一次的根因认定为磁盘或实现问题。保留增强断言，正式组合继续检验。

Standards：实际对照jobs的reserve/attest分支、authority的grant绑定/activeLease、image hold、protected pixels、媒体seal的立即ACK幂等，以及JSON事务提交/回滚。写expiry前仍已通过原当前输入和最后租约校验；没有过期后续命，也没有在失败返回前提前写expiry。所有读仍在job/hold写之前，未增加事务操作数、SDK或权限。claim/renew/release和来源子流程未变。

Spec：9张图应减少18次独立续租，仍保留30次原inspection守卫；不把无额外对象读取说成无数据库成本。180项通过只证明局部功能，本MIU的生产构建20件和test云端性能尚未通过。与P7a6全量回归重叠时追加下一MIU的RED用例，旧全量运行已标为interrupted-not-a-gate；它的部分绿灯不作最终稳定快照凭据。仅结束cwd和stdout日志都核实一致的自有pnpm测试子树，没有停止用户浏览器或其他任务。最终整体回归在修复快照稳定后运行。

文字核对实际查看本MIU、worker、jobs、authority和新测试；修正“全部18次/零独立renew”为“媒体与证明前18次，另保留inspection30次”，核对120秒TTL、原20秒/8秒预算、4/16张限制及180项结果。fullDeliveryReady=false。


## 后续生产构建

progress-lease-heartbeat-formal-r1：10通过、1失败，90秒时12个原准备任务全部完成、10件已发布；尚有8件未开始。35次准备continue平均6917ms、最大9042ms，唯一明确错误仍为注入BUSY。比前一快照多2件发布，但不是达标证据。11份原报告哈希恢复，owned DB/媒体/构建/进程清理。随后全仓lint在构建目录清理后1087文件通过；在临时构建存在时运行lint曾扫描生成JS并报告547条产物错误及一处新增测试格式，后者已格式化，未改lint规则或格式化生成物。后续继续减少inspection中的重复完整输入读取和job写入，保持独立MIU与原90秒断言。
