# P3e1：保留同一商品操作的初始输入

基线a0cf8b5的批量版本/焦点检查点有一项明确P1：原完整浏览器的丢发布响应自动恢复未通过，review未放行，精确站点15页5.01秒构建不改变这个结论。继续已批准P3修复，不发版、不另开分支或审批数据库。

本单元先在既有catalogDetailApprovals持久接口内实现operation-start/operation-get，预约现有产品的明确intent、actor/product/operation UUID、原选品revision、目标补丁摘要和完整有意义输入快照。只保存小型操作元数据与用户网站字段，不复制所有来源属性；完整来源仍在原存储。本单元不变更商品、不批准或发布，不提供新HTTP入口，也不将预约当最终恢复完成。创建幂等、自身保存/媒体阶段回执、审批/上线合一和UI接线在后续单元完成，原集成P1持续阻断。

记录为严格版本化的reserved形态，与历史staging/complete审批记录使用相同actor/product/UUID派生ID；旧记录不能被重试覆盖。重复相同输入读取原记录，改变intent/补丁/原revision拒绝；同ID的历史审批保持原字节。get只读，返回初始记录与当前输入是否仍相符，不能用当前行重写初始基线。权限每次读取当前用户，跨actor不可借UUID访问他人记录。

初始版本检查与预约写入处于同一原生事务/JSON锁。快照覆盖内容/生命周期/分类代次、网站可写字段摘要以及发布所用的来源/观察/链接身份；legacy缺失代次为0，非法代次拒绝。普通只读捕获时间不改变输入摘要。下架/归档不因坏来源而失去入口，不为了预约它们读全文来源。旧审批decoder、删除扫描和过期策略需保持原行为；reserved还不能形成批准或媒体hold，也不能被旧finish当成审批完成。

输入和记录必须有UTF-8字节/深度预算，未知可写字段或生命周期开关拒绝（开关由intent表达），JSON字段不可让循环/无限深度进入hash。边界先测试再定实现，不能只靠TypeScript。输出回执与数据复制隔离，读回方修改不能改存储。

先红测：预约/重开查询、重复零额外写、不同输入冲突、他人编辑/下架/分类/SKU代次/来源变化、仅捕获元数据不误拒、旧无代次、损坏版本、无效patch/预算、权限、历史记录保护、写失败回滚；保留旧finish拒绝无job/非管理员等正控。再实现共享事务函数和原JSON/原生适配串联；本单元仍不代表丢发布响应问题已解决。fullDeliveryReady=false。

## 已执行的小流程与复核

初始41项有7正控/34业务失败，现有持久入口不支持预约/查询；实现后首先发现只从普通可写字段生成摘要漏掉专用子分类，100正控/1失败，补上独立子分类输入。随后新旧审批与真实JSON/原生适配组合通过；增加嵌套JSON冻结、回执损坏、UTF-8字节和旧hash兼容反例后，当前组合199项通过，0fail/skip/cancel。

真实JSON重开实例与同UUID不同输入竞争验证，一件原输入预约胜出、另一件CONFLICT，商品/分类/发布状态不变。文件mtime固定到旧值后查询，首轮1正控/1失败明确发现只读成功仍persist写盘；适配器改为实际tx.set后才persist，查询/相同输入重复start均零文件写。这里首先验证重开实例，随后通过下述独立进程探针；保存/媒体/批准/上线阶段重启仍未完成。

原生持久入口以现有真实get/set包装运行，模拟object/array两种get与准确upsert插入回执；4种缺失/错ID/错误码/抛错回执均抛出并回滚。手工预约实测4个文档操作，只写job，get/重复start无额外写，reserved不能被旧finish当审批。链接预约的7操作是当前代码计数（用户/job/product/source/observation/link读取+job写），没有冒称已经云端MVCC并发实测；没有共享用户/分类写锁。

复核还发现完整来源缓存预算会误拦不参与内容hash的Date、深层或大段采集档案：新增51项中48正控/3失败，改用原hash函数相同的sourceBindingInputs/sourceObservationInputs与链接身份投影，再做预算。来源属性不被截断，旧hash的null/完整样本均按变更前固定值通过，实际有意义属性/分类/链接改变仍报告current=false。无关档案保持在原存储，默认操作记录小于4KiB样本，不复制百余条属性或证据正文。256KiB请求、512KiB预约记录和2MiB有意义快照预算是本应用保护，不是腾讯云字段限制；不据样本推断所有记录尺寸。

19项实际源码故障全部被行为断言检出，各199项/次均保留正控、无跳过/取消或编译导入假红，4源文件finally还原核SHA。首16项旧备份另存operation-faults-first16；最新结果operation-faults/results.json，不把重复运行次数当独立缺陷。另两项旧UI重试版本转发反例各9项7正控/2失败，4文件复原核SHA。

首轮七包全量中shared309、DB1285通过，site796通过/1等待超时，其余后续包未完成，不算全量通过。该测试只给BUSY4次后的Retry按钮5秒；现有三次随机退避代码推导上界约5.04秒，还没有计入HTTP和渲染，5秒不足以覆盖协议允许的时间。只把这两类BUSY测试等待改为15秒，原4请求/版本/冲突/原文件字节断言全部保留；上述两项原故障重新检出。没有降低实际服务重试要求，也没有把这次超时当产品性能达标或完整流程成功。全量后续重跑单独记录。

初次类型报错是新增failure联合缺少既有可选validation字段，补与原合约一致的声明；第一次fn-admin筛选名误写未匹配，随后使用真实包名复验DB/local/fn-admin三包成功。测试赋值表达式格式错误、以上所有红测与超时留日志，不把工具/格式错误算业务检出。

本单元仍没有HTTP start/get/resume入口，没有创建/保存/媒体/审批/最终上线阶段回执；get.current仅证明输入快照是否仍相符，reserved从不证明批准或发布。a0cf8b5原完整visibility丢发布响应自动确认P1继续阻断，不能恢复匹配字段的假成功，也不能靠绿色199项放行部署。下一段继续自身保存与媒体回执和最终提交，fullDeliveryReady=false。

| 故障 | 正控 | 失败 |
| --- | --- | --- |
| reservation-start-version-not-checked | 198 | 1 |
| reservation-rebinds-input | 195 | 4 |
| reservation-role-not-checked | 198 | 1 |
| reservation-contentGeneration-not-bound | 198 | 1 |
| reservation-lifecycleVersion-not-bound | 198 | 1 |
| reservation-classificationRevision-not-bound | 198 | 1 |
| reservation-subcategory-not-bound | 198 | 1 |
| reservation-source-not-bound | 196 | 3 |
| reservation-nested-json-alias | 198 | 1 |
| reservation-get-always-current | 190 | 9 |
| reservation-json-query-rewrites-file | 198 | 1 |
| reservation-native-ack-not-checked | 194 | 5 |
| reservation-future-version-accepted | 198 | 1 |
| reservation-stored-input-digest-ignored | 198 | 1 |
| reservation-byte-input-budget-bypassed | 197 | 2 |
| reservation-key-omits-product | 187 | 12 |
| reservation-budget-checks-unused-source-cache | 196 | 3 |
| reservation-source-capture-time-enters-hash | 197 | 2 |
| reservation-source-category-excluded | 197 | 2 |

恢复后相关七包全量3986=shared309+DB1290+admin637+local518+public131+sync304+site797，0fail/skip/cancel；Node20同5文件199项、整份实际浏览器43场景，共242通过，0fail/skip/cancel。16个相关项目类型、Astro216文件0error/warning8既有hint、8完整代码/测试文件显式Biome、standing SDK与diff通过。未重跑或借用487脚本数，也没有重跑并冒称原正式visibility的集成P1已消失。

额外独立进程探针禁止所有网络并清除云/供应商环境：Node24进程写入预约，三个新进程分别Node20查询/重复start、Node24查询；同一612字节手工样本回执、同一输入，零额外记录、零查询/重复文件写、零商品写，临时数据库清理。该探针直接运行本地持久适配，不是云部署或原生MVCC实测。命令和日志在operation-process-probe.mjs/.log。

简化及写作复核8代码/测试路径、3证据文档与原workflow/HTTP拒绝、公开投影、媒体hold扫描、JSON锁、源输入哈希消费者：复用同一hash投影，没有另造来源摘要规则；将“操作恢复已完成”限定为“预约和查询已验证”，将实例重开、独立进程、原生假事务与真实test区分。所有后续阶段和历史/性能/test真实20件验收仍阻断交付；无部署/真实数据写入、新branch/worktree/agent/PR/push，fullDeliveryReady=false。
