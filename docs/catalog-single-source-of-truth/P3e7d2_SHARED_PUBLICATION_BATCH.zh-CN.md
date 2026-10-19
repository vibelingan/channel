# P3e7d2 共享批量发布队列

基线ef7c0a32。复用已验证的原任务runner、journal和公开check；20/50/100选择按20分组，上一组全部settle后进入下一组，全页共享最多4个产品流程（含准备与公开检查）。不新增服务端调度平台，不只给每个按钮各开4个。输入先冻结/验证唯一商品选择，操作ID在账号/商品scope内使用，恢复仅接已有scope/checkpoint，不新start。

新批次先后台确认当前actor/admin；浏览器原token、actor、API endpoint每次私有RPC前后都必须保持一致，不将localStorage角色当授权。每件第一次请求前持久保留原scope、状态进展补digest/cursor；持久化失败暂停并保留可导出指针，不伪称可跨刷新恢复。只有checkPublication confirmed计数成功，unknown仅保留原任务供再查，历史完成不重新发布。中断只停后续请求；所有活动worker settle后才返回，finally释放共享名额和同产品执行保护。

先控制20/21/50/100、两个同时批次共享4、冻结输入/重复ID、取消/身份变化/后台账号错配、存储失败、unknown/历史/恢复不换ID、observer失败与最终释放；再实际Admin/JSON/PNG的20/100个手工零SKU草稿共用真实照片，公开读回后逐件实际撤回，分类/有效引用0/公开404核对。100个共图也覆盖80引用台账整理。此MIU不接用户UI，不改变分类。登录清除失败、原正式UI/P5和真实test门槛仍开放，fullDeliveryReady=false。


## 实施与验证

createPublicationBatch复用原runner/check/journal，输入在后台me验证前复制，最多100件、唯一商品选择；原生操作按账号/商品/操作组合定位，不要求跨商品UUID不同。每20件全部settle后才启下一组，模块内共享4名额覆盖不同controller，单商品在活动期间不进入第二个producer。所有release在finally；取消等待者不虚减名额。此限制属于同一页面模块，跨标签仍由原生事务保护，未宣称跨标签全局锁。

每批先用后台me证明原actor/admin，原token/actor/endpoint在每次私有RPC前后核对，真实撤权使本批后续项暂停。首次请求前持久保留原scope，状态补digest/cursor；存储失败停写，内存指针可导出但不能冒称跨刷新持久。公开确认额外校验同商品/操作/digest和批准revision；unknown保持原指针，历史/取消/已确认才移除恢复记录。观察者失败/取消会消费迟到拒绝，保持已确认事实，全部workersettle后返回。

35新增（32控制+3实际默认传输Admin/JSON/PNG），包含20/21/50/100、两个controller共享4、冻结输入、空/重复/稀疏项、后台账号错配、token/actor/环境变化、撤权、存储与进度失败、原游标恢复、错误确认、历史和observer。首轮23控制21过2红，暴露撤权后继续调度和错误scope确认被计数，已修复后全绿。复核原生组合身份后补两类红测，去掉过严跨商品UUID限制并拒绝稀疏项。初始调度夹具已收紧为共享完整DTO，无any；测试分类字段的TS7053在实际运行前拦下，使用字面量字段迭代修正。文本补丁定位断言失败的两次均未写不完整生产文件，旧日志保留。

12顺序故障最终全部检出，25重叠失败/SHA恢复。首轮9检出后游标故障幸存：fake runner里的assert被队列转unknown，而测试也期待unknown，属于验证缺口；移到捕获范围外后检出。格式整理后第三轮12全部检出，证明当前生产源码恢复。3文件Biome修正独立声明/导入排序，再完整回归。

实际默认HTTP客户端在本地运行20/100件混合现有分类草稿共用真实PNG，全部公开读回，每件start恰好一次；全部RPCsettle后按自己的receipt逐件实际Admin撤回，分类值与字段存在性保留、公开详情/PNG404、有效引用0。100件经过80条引用台账整理；一次照片准备CONFLICT通过原任务查询自动恢复，最终全确认。3件样本含1件无主分类，2件成功、该件needs-action且保持未发布/无分类。最后20/100旧操作再次批量恢复均historical，零新start/零公开GET、原JSON字节不变，未重新发布。Node24/Node20最终组合均覆盖这些加强断言。单独本地20约2.6秒、100约36.7秒，仅JSON夹具观察，不是浏览器或云P95。

最终site1075、Node20客户端276、站点/E2E/既有测试类型、3Biome/15页构建通过，无失败或跳过；相关证据6358含未变包基线，完整Node203349仍5024700b，657安装SDK和14精确后端进程仍9efd824c。本步无后台/SDK/env/公开DTO变化，未将本地100件当test真实选品验收。

实际review/simplify核对三代码/测试、原任务runner/check/journal、api默认once传输/me、原生operationKey与原20件清理、分类UI调用链；humanizer核对本文/IMPLEMENTATION_LOG，将“全局并发4”改为“同页面模块共享4”，区分fake回调与真实默认HTTP、历史读回与重新发布。客户UI尚未接入；原正式UI P1、登录清除失败、P5/旧JSON80原因及真实云性能/角色竞争/20件选品恢复门槛仍开放，fullDeliveryReady=false。
