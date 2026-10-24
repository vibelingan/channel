# P3e6e2b 原操作图片暂存页及取消终局

状态：内部分页/取消本地测试与review完成；基线60b91dd，提交后精确产物验证待补。客户公开流程/worker的producer仍不接通。

## 同一根的暂存页

内部operation-approval-reference-page只接受原productId/operationId/inputDigest/cursor。重用原currentApprovalOperation，要求合法references/media且全部配置页完成。原根optional referenceStage保留kind、references.bindingDigest、cursor、prefixDigest；摘要从冻结有序变化计划推导，损坏/跳进度拒绝；重复旧cursor只读，超前cursor冲突。每页最多20张图片，合法大商品继续分页，不能缩小商品图库或SKU上限。

一次真实事务先读actor/root/product/source，再读本根唯一终局proof槽必须为空；从同一C1快照读取图片及其小证明、结算全部终局。要求当前image身份/status/storage/原mutex可用及现存protected-pixel证据，再用纯stage追加本根成员。所有读取完成后，合并settlement与pending写入每张图一次，再写原root进度；没有published或commit proof。强ACK或事务失败不能单独留下进度、图片或错误成功回执。

预算98，预留原actor/root/product/source3=6读、本根proof槽1读和root写1。每张图最少image1+health2+image写1；正常20张共88。单张80proof最多8+81+2+1=92。逐项准入：剩余不足最小4时不再读；C1在图片get后、proof读取前报告不足时计入已发生的1读，提交已完成前缀；第一张合法80proof总能装入。禁止先读20张再失控读proof，禁止把缓存image或root伪装成SDK读取，实际重复proof读取按真实成本计费。后续性能优化必须以实际P95为依据。

## 取消与终局

只在referenceStage.cursor>0时扩展原cancel：同事务点读唯一proof槽，缺失则写既有cancel proof并永久标根；原cancel proof精确重放只读；commit proof/错承诺拒绝且不翻转。无pending的原操作保持既有取消4操作语义。允许来源/商品后来变化或过期后的原actor取消，不先读坏supplier。取消释放的是本根pending，不撤销既有保存/媒体/页，也不删除其他根proof或图片字节。正常actor撤权后的管理员恢复/服务端过期清理仍是启用前门槛，本步不能把原actor取消冒称自动恢复完成。

## 验证退出

unit非空metadata夹具必须经实际reserve/protect/health/advance/seal/finish与own保存/分页/media/references，另以编译worker真实PNG补关键串联。覆盖27图20+7、0图、旧/超前cursor、源码/权限/版本/TTL、当前锁/缺base/坏ledger/pixel证据/终局槽、80full与取消结算续接、逐项预算、坏ACK/后段写失败整体回滚、同根重放/重开、取消不可翻转/不丢他人pending，JSON双adapter竞争及真实安装SDK文档计数。最终product/root/proof发布、过期/满槽自动恢复、UI/liveedit/历史/provider/P95和test真实三时钟/20件发布恢复均仍未完成。fullDeliveryReady=false。


## 本地实施、review 与证据

新增只读分页规划模块 catalog-operation-reference-stage.ts；同一原根记录小型 referenceStage，逐项预算后一次事务写图片和进度。取消在已经暂存至少一项时，同事务写原永久取消标记及唯一 cancel proof；尚未暂存的取消保持原四操作。未知供应商错误继续抛出，真实满槽返回 MEDIA_BUSY，损坏/缺字节证据返回 MEDIA_NOT_READY。本步未接客户 HTTP/UI/worker 的新发布调用，最终 commit proof/product/success receipt 尚未实现。

新增49个用例（DB37、JSON12）。原171项首轮有18项业务红；缺新路由是当时明确原因。最终相关365项通过；完整5529=shared309/DB2053/admin638/local754/public182/sync308/site797/scripts488，fail/skip/cancel均0。实际Node20相关2541项通过，19包types、E2E types、standing SDK、六文件显式Biome和diff检查通过；Astro216文件0error/0warning、8既有hint。pre-commit 的 lint --silent 已知错误不能算验证。

38项源码故障全部检出，其中三项使用安装 SDK 的既有断言，35项 unit 故障累计198重叠失败；不是198个新增测试。首次 unit 对“提前忽略终局槽”没有失败，改以已有 SDK 终局槽冲突断言证明其敏感性，未把全绿 unit 记作检出。故障脚本 finally 还原五文件 SHA，最终完整回归与 SDK 正控在恢复后重跑。提前写 commit proof 的反例另跑实际 PNG 流程，确实触发匿名200而预期404；记录 owned fixture removed。旧名称 expired-prefix-replay-rechecks-images 实际覆盖有效期内已确认前缀重放，不能据名称声称过期继续暂存。

实际 Node20 安装 SDK 329项仅替换 HTTP 传输：生产 adapter 与原持久化入口均经过真实 SDK 方法，正常20图88文档操作、7图尾页36；78proof重项加两普通图达到98，80proof加一图96。49+34边界在下一张 proof 读取前停止，含该图片已发生get；80未知项90只读操作返回忙，永久取消一项后92操作恢复。所有成功读取先于写，图片/root后段坏ACK回滚；commit已应用但确认丢失可查询同断点，重复零写。取消六操作，重复零写，已有commit或错误cancel不可翻转。HTTP替换不证明真实云MVCC、COS或P95。

真实保护PNG四独立Node24/20进程：编译worker准备→实际JSON暂存并丢回应→重开同根/零文件写→取消proof及C1结算0/空账本。每步匿名404，24×16尺寸/SHA校验、私有字节和原有分类保留，商品未发布。第一次父进程仍持有同一JSON文件，子进程被原进程所有权守卫拒绝；未绕过守卫，改由未被父adapter打开的独立快照文件让子进程顺序接管，原父文件逐字节未变。R1失败日志保留，R2退出0且finally清理夹具。这里使用60b91dd的编译worker/public结合当前源码JSON；本提交精确构建与同流程还需在提交后补跑。

## 验证脚本审计更正

P3e6e1 的两项旧 late-capture 负例把复制结果字段写成 value，实际入口读取 command，因而当时失败不能单独证明等待期间改写输入。保留旧日志与历史计数，本轮改为 command 后重证：正常 JSON27 流程仍通过，JSON 锁等待输入用例失败；安装 SDK 的正常用例先完成261项，随后真实 startTransaction 等待输入用例失败。恢复后329项 SDK 与完整回归通过。新证据替代旧两项的因果解释，不改写原日志。

## 人工核对与仍需完成的工作

审阅新分页规划、原根codec/取消/当前状态检查、统一持久化路由、共享测试夹具及DB/JSON测试六文件；对照C1预算/全体结算、protected-pixel两次读取、纯stage/终局schema、native原actor保存围栏、JSON锁及public门禁。native与JSON生产文件和原save actor/classification区块均与60b91dd字节相同；共享metadata夹具只由测试/SDK构建探针导入，不进入生产入口。

文案把“自动恢复满槽”改为“结算终局后可重试，服务端过期/管理员恢复仍待实现”，把metadata夹具与真实PNG字节证明分开，并明确独立快照的四进程边界。用源码调用点、进程ID、字节校验和日志核对这些表述。本步没有用户可见布局变更、新SDK方法、shim、依赖、环境变量、分支、worktree、PR、push、云部署或客户数据改动。

原正式整笔发布已提交却丢响应的P1仍开放。原actor撤权后可信恢复、服务端过期/80槽恢复、最终product/root/commit-proof原子提交、live-edit、历史坏数据fallback/UI串联、真实provider并发与P95、test部署和三时钟/20件真实发布及自有清单恢复仍待完成。fullDeliveryReady=false，不可据本步启动客户新发布路径。
