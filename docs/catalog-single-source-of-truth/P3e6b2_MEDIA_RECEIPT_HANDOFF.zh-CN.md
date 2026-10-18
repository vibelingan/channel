# P3e6b2 将完成的媒体准备回执交给同一审批根

状态：内部回执接收与本地验证完成，尚未接入最终发布或HTTP/UI。基线4cf5101。

## 真实运行边界与选择

现有catalog-preparation-image-hold.findCatalogPreparationImageHold对completed任务继续保护当前ready输入的每张图片；completed任务没有单纯按旧lease过期释放的规则。readCompletedCatalogPreparation已核对完成receipt/report哈希、nonce/leaseVersion、完整media进度、当前source/link/generation及像素/媒体政策。复用这个事实来源，可以避免在每个审批再造一轮逐图检查或另一张worker任务。

新内部operation-approval-media(productId,operationId,inputDigest)，只接受本操作标识。原根必须staging、未取消且原身份/版本/来源/策略/TTL仍匹配。服务器从当前产品ready报告找job，再用现有完整回执读端核对；不接收浏览器submitted report、health或prepared seal。只有准备完成的图片ID集合与本根prepared publication的gallery9/description18/SKU全集去重排序后完全相等，才把小型绑定写回原根。没有引用计数写入，没有批准或发布。

删除保护交接：旧完成准备任务在输入仍current+ready时持有图片；原审批根已经durable staging且列出相同publication图片，随后才绑定。来源/内容改变既会撤旧准备hold，也使本操作原guard失效，不能把新source当旧输入；根取消为永久停止。交接之前或期间删除必须经过同一图片mutex及preparation→approval→product扫描。全体图片invalidating writer、真实provider快照/时钟仍是最终省掉逐图final读和启用分阶段计数前的硬门槛；本步不宣称这些已证明。

## 数据与读写预算

原staging根增加optional media：kind、preparationInputDigest、ready小seal和bindingDigest。ready只存jobId/receiptId/planDigest/图片集合摘要与数量/媒体及pixel政策；不复制完整报告、source、health或逐图状态。bindingDigest绑定根ID、原operation.inputDigest、revision、productFingerprint和全部媒体receipt；不同操作/版本不能借用。历史codec保留旧policy字符串，资格另按当前policy判定，避免新policy让旧操作历史无法读回。

优先直接复用现有readCompletedCatalogPreparation；保守预算actor/root/product及原source3共6读，加准备job1读，既有completed读端product1/source3再4读，最后根1写，共12文档操作，独立于图片数。重复source读暂不做假tx.get缓存；如后续实测需要，再以明确数据复用接口优化。三方SDK方法不变。无变化重复0写，绑定保留原createdAt、原saved、原分页cursor。重复begin/page/cancel必须保留media，旧legacy严格decoder继续拒绝新版root。

采用图片集合仅来自本根prepared publication，正好与原approval hold的三个路径一致。现有公开counter/legacy模式和删除引用集合保持原语义；不在这里擅自改变catalogReferencedImageIds的raw+approved规则。计数producer仍关闭。

## 检查与退出条件

先以真实runCatalogPreparationJob/start→claim→seal→finish构造合法零图片ready回执，再接own begin/media；分别覆盖ready在begin前后、21分页串联、重复/丢响应/重开/取消保留，以及错job/product/input/source/generation/nonce/receipt/hash/图片集合/policy/不完整进度拒绝。绑定只能写原根，其余行完全不变，不能报批准或发布成功。非空图片用现有实际worker→protected pixels→ready小流程接入验证，避免只手写“看起来合法”的ready对象。Native/JSON/Node20/坏ACK/等待前冻结/故障反例，关键节点整体回归和精确产物按影响补证。

后续final仍需采用原actor/分类/供应商/生命周期、媒体immutability/删除握手、counter差值/不可变证明的完整提交协议。原formal发布丢响应P1、所有UI组合、P95、test部署和真实三时钟/20件验收未完成，fullDeliveryReady=false。


## 状态转换与交错

| 原状态 | 命令及条件 | 结果 |
| --- | --- | --- |
| reserved/saved | media | 拒绝，不改变草稿或操作 |
| staging，无media | media，原guard有效且服务端completed回执/图片集合准确匹配 | 仅原根增加media |
| staging，有media | 原命令重复 | 返回同一回执，0写 |
| staging，有/无media | 配置page | 保留media与原guard，推进原nextPage |
| 任意非终态 | cancel，原actor及inputDigest匹配 | 永久cancelledAt，保留media和已完成的页 |
| cancelled/expired/stale | media/page | 拒绝；历史get仍可返回可解码回执 |

media/media允许一个首次写入及一个幂等读回；media/page允许两个步骤按原根串行完成并保留彼此结果；media/cancel允许先绑定再取消，或先取消后拒绝绑定，两种最终都不能继续。JSON两adapter同文件锁的allSettled覆盖三对；native沿现有事务读原根再写原根，真实provider写冲突仍列为后续门槛。没有要求本来可以幂等成功的两次请求只能一次成功。

## 实现、验证与review

catalog-operation-media复用既有readCompletedCatalogPreparation，服务端重新核对当前报告与job完成证明。readOwnedApprovalMedia验证小绑定摘要、采用图片数量和有序ID摘要及冻结策略；present undefined/损坏值拒绝，历史旧策略可解码但current=false。core读取旧legacy形状时明确移除media，legacy decoder自身保持严格；重复begin同样只比较原prepared计划，不把新回执误认为计划变化。page保留media，cancel保留其历史且阻止推进。客户端不能提交自己的report/seal。

50新增：DB46、JSON4。全量七包+scripts4981（309/1683/638/631/131/304/797/488），fail/skip/cancel0；实际Node20全DB+三相关JSON1792，invoker另15。19包types/E2Etypes通过，Astro216项0error/0warning、8既有hint。六代码/测试/脚本文件显式Biome和diff通过。14回执源码反例检出96重叠失败，三生产文件finally SHA恢复；脚本第一次因预期匹配次数写成2而非1中止，恢复后只续跑剩余两例，未把脚本异常算业务检出。

安装Node20 SDK与编译native持久化仅替换HTTP：11组，首次12文档操作且读先于唯一根写、原根和其他行保留、staging/已分页、3坏ACK回滚/重试、commit已落盘但确认丢失后get/0写重放、实际SDK启动前输入冻结、撤权/取消/坏job/source拒绝。四独立Node24/20文件进程丢弃transfer答案后恢复同一media，再续21配置并取消；夹具已删除。

非空媒体小流程使用4cf5101已review的真实worker/admin编译产物与当前source持久化衔接：5来源URL归并1张实际24x16图片，原worker继续两步后ready；调用真实prepareCatalogSource再own begin/media，绑定同一ready receipt，重复0写。读端检查prep→approval交接都有保护，取消后仅own approval hold释放，prep仍有效。最初夹具有另外两件共享同图商品，first-match返回artifact-warm是正常保护；保留失败日志后隔离其他自建商品/任务再精确核对本件，不据此误报产品缺陷。该阶段混合产物/当前source，不冒称新SHA完整发布；精确产物在提交review后另测。没有实施实际字节删除，也不是完整删除并发证明。

整体门禁发现上一节点漏项：invoker测试拆为启动和已流式两项后，verify-cloudbase-sdk-contract仍要求旧测试名。旧归档有绿色SDK日志，但不能据此认为4cf5101最终测试/门禁组合完整通过；本轮门禁实际失败已保存。脚本现要求两项新测试名及至少15项全通过、0skip/cancel/fail。将生产硬截止故意放大十倍后，完整SDK门禁以实际Missing expected rejection失败；finally恢复生产SHA4705c450…且逐字等于HEAD，再实际门禁通过。只改门禁断言，没有改生产8秒逻辑或接受失败。既有b1文档/实施记录附上这一更正。

本步逐项review三个生产模块、两测试、验证脚本、b1/b2/实施记录/SDK记录；复核准备完成读端、图片引用提取、准备hold、native与JSON事务边界。简化为直接接收完成回执，未新增另一轮逐图任务、SDK方法/依赖/shim/环境变量。人工措辞将“图片保护交接已证明”改为“本地读端交接检查通过”，逐一对照原删除锁、实际worker和未测试provider MVCC边界；将先前SDK通过说法更正，避免归档旧日志掩盖最终源码门禁失败。

原正式丢发布响应P1仍在，尚未具备最终提交、计数账本consumer、全部UI/真实并发/P95/test部署与三时钟/20件发布恢复的证据。fullDeliveryReady=false，继续后续MIU，不作整体验收结论。
