# P3e7c9c 浏览器原任务恢复记录

基线 f350dffc。C9b 已能沿一个原scope推进，页面刷新仍会丢失该指针。第一次请求前若没有留编号，回应丢失后就难以找到原任务；把编号只放组件state无法跨刷新。此MIU先做独立记录层和控制测试，下一段才接实际UI和共享4并发队列。

## 记录合约

每个原操作一个键，按实际API地址和当前登录actorId分区，避免不同商品/标签页共用一个读改写数组而互相覆盖。只记录publish的scope与可选引用检查点，不存表单、供应商原数据、JWT、照片或“已发布”判断。scope在首次start之前即可记录，此时可能没有digest；首次真实状态返回后补同一编号的digest。引用游标必须带digest且使用共享schema。持久记录只是恢复指针，每次恢复仍要查原生任务。

```ts
{ schemaVersion: 'catalog-publication-recovery-v1',
  owner: { actorId, endpoint },
  entry: { scope: { productId, operationId, inputDigest? },
    referenceRecovery?: { imageId, ledgerDigest, nextOffset } } }
```

单记录4KiB；新指针准入上限500条，扫描最多2000个origin键。达到上限时在新start前拒绝新指针，不驱逐旧未完成记录；扫描不完整返回limit，保留已知内存和原存储字节，不能把部分列表当完整备份。仍可按原scope单独导出指针。不会凭本地时间自动丢弃未确认任务。一个标签页只能覆盖同一操作的检查点；不同原操作分键。Web Storage没有跨标签CAS，因此不据此判断锁、审批成功、最新版本或授权；服务器scope/digest和原生事务仍是依据。相同操作若已有不同digest，拒绝覆盖，避免把输入换到旧任务。

## 存储失效与恢复

localStorage getter、length/key/getItem/setItem/removeItem均可能失败，所有访问置于捕获边界。写入失败时保留内存指针，返回memory状态，调用者必须展示可复制/导出的恢复信息；不能把它描述为可跨刷新持久保存。存储损坏独立报告并保留原字节，合法的其他记录仍可加载。明确导出只含上述指针和owner；导入时先验证整个文档/owner/大小/冲突，再写入指针，没有网络调用，更不能直接重播start。

不选择共享JSON数组，因两标签同时新增不同商品会丢记录；不持久保存256KiB表单，因该层只需定位服务端已冻结输入。若原start尚未落库，刷新查询返回NOT_FOUND时仍保留unknown，由原任务查询/用户明确处理，不自动生成替代操作。resolved指针只有调用者核对服务端/公开结果或用户明确关闭后才移除。

## 检查

先红测：请求前记录/模块重建后读回、补digest与cursor、跨环境/账号隔离、两个标签并发写不同商品、同编号不同digest拒绝、回调副本不改指针、getter/read/write/remove失效、损坏一条不淹没其他条、超预算不静默清理、导出无表单/token和导入全量验证/零RPC。之后实现并接C9b真实Admin/JSON/PNG的刷新恢复小流程；再跑对应完整site、Node20、类型/构建、故障注入和review。原UI P1/JSON80原因未明及真实test验收门槛仍开放，fullDeliveryReady=false。


## 实施、红绿与小流程

`catalog-product-operation-api.ts` 统一 `PublicationCheckpointSchema`，协调器第二个回调参数给出真正有效的 `{scope, referenceRecovery?}` 副本。只读get可能不带引用提示，不能只序列化当前DTO，否则会再次丢掉已保留游标；对此先有失败测试，再补共享检查点。首次start前保留只有两个ID的scope；真实status回来后补digest。存储只定位服务器已冻结输入，NOT_FOUND保持unknown，不在刷新后换UUID。

首轮12控制先红后绿，随后33控制中3项红测暴露：额度失败没有明确unavailable、修复失败回滚漏掉旧pending标记导致内存唯一指针消失、导入碰到后部损坏目标时已写入前部新记录。三处修复后再补容量/性能边界：旧实现每次进度更新会扫描全部键，且不完整扫描可被当完整导出。现已知操作只读写自己的键，返回副本；完整列表仅read/export/新指针准入需要。全导出在limit时拒绝，按scope单项导出仍可从原键读取，未删记录。500/501条与2000外部键边界都有控制，不把本地准入上限说成跨标签原子锁。

40个记录控制、1个有效检查点控制、1个真实Admin/JSON/PNG刷新恢复、2个实际浏览器Storage控制，共44新增。真实小流程先记录编号，实际start落库后丢掉回应和确认查询，重建journal/协调器只get原编号，从reserved续成complete，公开详情revision/名称/图片核对后实际Admin撤回、公开404和引用归零，最后移除该指针。Chromium/WebKit均在独立浏览器context的真实localStorage中验证刷新、两个标签写不同商品及同商品不同操作、账号隔离、getter SecurityError、setItem QuotaExceededError与单项导出后另一标签导入；无pageerror。两者是浏览器存储测试，真实API组合是模块桥接，尚未组合成客户页面点击流程。

13项故障全部检出、13重叠失败，两源码SHA恢复；包括分键少operationId、digest覆盖、丢pending、回滚未恢复pending、静默写/删确认、导入未预检、返回对象改坏内存、重复扫描、假完整导出、准入越限和回调检查点不完整。导入不是跨标签CAS事务：预检后若另一标签写入冲突，仍可能已有部分指针保存；原字节/已保存指针保留且不进行任何服务器写，UI需展示状态和原scope后再让用户继续。

site968/local1057/Node20关联3266全通过且无取消/跳过；19包与E2E类型、既有site测试类型、7文件Biome、15页构建通过。相关证据6233含本步site/local和C8未变shared354/db2238/admin638/public182/sync308/scripts488（源码哈希核对）；Node20不含两项浏览器存储测试，它们另在Node24执行。651安装SDK和精确三函数14进程继续为4e5e13bf；没有改后端/SDK/env/资源。不会将pre-commit错误使用Biome --silent后误报passed当验证，本步以显式七文件检查结果为准。

## Review和启用前边界

实际审阅七个改动源码/测试与原session、onAuthChange、C9a/C9b契约、真实workspace/公开读回和先前故障日志。按frontend-async-state核对存储getter也在catch内、返回副本、pending失败回滚、导入预检和原scope身份；归并重复checkpoint schema，没有新增表单存储或局部自定义协议。测试夹具曾每次storage getter都创建新磁盘，已改为稳定同一个Map，不能用不持久的假磁盘证明恢复。humanizer实际核对本记录与IMPLEMENTATION_LOG，将“超限保留新指针”改为“新start前拒绝准入，旧指针不驱逐”，将“浏览器通过”限定为Storage行为。

发现两项接线前边界，继续阻断客户producer：原 `session.onAuthChange` 泛监听所有storage事件，记录写入会通知其他标签的登录订阅，应下一小MIU过滤到token/user/clear，并保留本地auth事件；原 `getToken/getUser` 还会在storage getter被禁时抛错，因此记录层memory fallback不代表该环境已经能登录或发布。需要实际UI/会话组合验证，不能凭独立Storage测试关闭这两项。

原UI P1、JSON80一次begin失败原因未明、共享4并发/20分组和50/100组合、Classification/RecordForm接入、P5坏数据resync、新上传/live-edit、真实云角色竞争/P95、三时钟与20件真实选品发布后回退均未完成。当前fullDeliveryReady=false；继续小MIU，不启用客户producer或部署。
