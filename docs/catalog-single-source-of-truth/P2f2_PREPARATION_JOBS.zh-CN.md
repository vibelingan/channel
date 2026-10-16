# P2f2：持久准备任务与租约写入

状态：实施中；fullDeliveryReady=false。把P2f1接入真实数据库适配器，建立任务创建/读回/取消/显式重试、服务准入、原子领取/续期/释放。实际producer和检查证据接线继续，当前单元不伪造ready。

## Runtime Problem / Data Shape

当前准备检查没有持久任务。创建结果丢失后重试可能重做；旧worker被接管后回来也缺当前版本的写围栏。私有catalogPreparationJobs的ID由policy/product/inputDigest/generation计算SHA256，同一输入重复创建返回同一任务。nonce由服务端随机32字节产生，不进入进度DTO。

queued→running→queued表示有界步骤；retryable供后续producer报告可重试故障，cancelled/stale/blocked/completed不自动复活。显式retry仅接受cancelled/retryable，必须匹配当前leaseVersion，轮换nonce并推进version。旧签名、旧取消和旧worker因而失效；普通start不会重置取消状态。

## Technology Constraint / Flow

复用CatalogApprovalTransaction get/set。CloudBase runTransaction和JsonFileAdapter mutation lock提供实际原子边界，领取/续期/释放在同一事务内读当前job与product/source/observation/link、检查准入或当前不透明lease、写job。网络/像素工作留在事务外。任务进度只含job/product/state/attempt/leaseVersion/时间；dispatch服务消息只在后台调用链返回，无浏览器ready写入入口。

状态和安全整数先解析后判等。签名准入先于任何任务写入；同owner重复claim仍返回busy。过期接管递增version，每次服务写入重新比对当前输入。任务变化不修改分类、发布状态或批准内容。

## Code Translation / Risk and Test

runCatalogPreparationJob(tx, authority, command, now)为纯事务操作；start/get/cancel/retry/dispatch要求当前真实admin。claim核对签名与DB nonce，renew/release核对当前grant。STALE结果可以伴随job写入，本地adapter须按实际changed落盘，不能只按ok值判断。落盘失败恢复内存，CloudBase写入失败抛出回滚。

红测覆盖：创建丢ACK重试、真实本地持久化/重建、两个worker领取恰好一个成功、过期接管旧worker迟到、取消和nonce轮换、商品/来源更新、撤权、私有投影、损坏状态/溢出、落盘失败回滚、真实CloudBase事务包装。后续producer才保存像素receipt和准备报告，不能把进度当通过证据。

## 已验证与精确review修复

真实JsonFileAdapter跨实例领取恰好一个成功；重开数据库、丢ACK重试、过期接管、取消与接管的两种竞态顺序、旧grant迟到、STALE失败仍持久化、落盘异常回滚均通过。CloudBase事务包装测试核对先读后写、确定性重放、confirmed set以及抛异常/零写入/带错误码/错upsertId四种写入失败回滚；这是本地SDK形状测试，不是现场云数据库并发证据。

review发现并用红测修复两个时序问题：默认时间必须在获得本地写锁或进入每次云事务回调后取得；有效租约可能在读取输入期间到期，实际写入前须再验证。3条迟到claim/renew/release反例先失败后通过。小范围时钟倒退仍保持canonical ISO时间单调；损坏日期返回CORRUPT，不抛RangeError。

当前113项任务/适配器组合及Node20关键179项通过，零失败/跳过/取消。12种实际源码故障全部检出、正控至少91项、3个源码文件finally恢复。加最终guard后，移除早期guard一度仍由最终guard保护，未计检出；补上伪造能力应在昂贵输入读取前拒绝的行为测试后，重复12轮全部检出。证据preparation-jobs-mutants.json与mutation-harness-note.json。

已运行DB/local-server广泛回归1127项；最终guard修订后的完整重跑结果另存broad-final，不混记第一轮。四后台类型和CloudBase合约门禁通过。显式Biome针对三个新源码/测试和package.json；既有大文件只格式化新增片段，未把旧格式问题称为root lint通过。原临时Node20路径消失，已重新从官方nodejs.org取得20.19.0 darwin-arm64并校验SHA256 c016cd1975a264a29dc1b07c6fbe60d5df0a0c2beb4113c0450e3d998d1a0d9c；本机20.19.0不等于云Linux20.19.3实测。

事务文档明确快照读不获取写锁；本单元只写技术job形成job写冲突，不宣称输入在事务后永不变化。最终准备结果提交必须重新核对并原子写当前product，媒体目标保护与真正receipt producer仍待完成。服务job状态、游标或当前图片观察都不单独授权发布。

最终修订广泛回归：DB792项、local-server339项，共1131项，零失败/跳过/取消；对应耗时1.99秒/72.55秒。preparation-jobs-broad-final.log为当前源码结果。113组合、Node20关键179、四后台typecheck与显式Biome结果均属同一修订。全站root lint/完整浏览器/应用部署/业务验收仍未完成。

## P2f2a：部署资源漏项修复

eaceace2精确review被BLOCK：虽然两个adapter已接线，新catalogPreparationJobs集合没有加入部署清单。新增ADMINONLY、按_id点查的资源声明，全集合数量31→32；部署前自动配置私有集合，不增加timer或HTTP入口。新增测试先因缺集合失败；486项部署脚本测试全部通过，零跳过/取消。实际移除集合、改为客户端可读两种配置故障均被测试检出并恢复原文件。此前三个eaceace2函数产物构建/Node20裸启动已过，不能代替这一资源修复。

实际复核resource→ensureNoSqlResources→package/smoke/deploy链路与真实SDK缺集合行为，纠正“adapter可写即部署可用”的遗漏。云端尚未创建集合，业务写入和应用部署仍为0。根build脚本会经npx尝试取pnpm12.11.2，已停止自己的npm子进程并直接用已安装11.5.0递归构建；未修改仓库依赖或源文件，保留该尝试日志。
