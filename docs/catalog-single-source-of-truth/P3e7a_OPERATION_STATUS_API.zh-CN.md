# P3e7a 有界操作状态入口

基线3206c985。现有catalogDetailApproval鉴权与enableDetailApproval开关内增加product-operation-start/get/cancel三个公开动作，映射到既有operation-start/get/cancel。通过DB index的manageCatalogProductOperation进入独立facade，旧审批workflow整文件不改。浏览器不能传prepared、原根、actor、recovery reason、publication、proof或调用内部publish/media/references/recover。start仅冻结原编辑与意图，不保存商品、不自动发布；cancel永久停止原操作并保留既有内容。

## 请求与状态合约

start沿原256KiB输入预算，允许正常30000字符描述；预算常量移动到shared并由内核与handler引用，数值和内部约束不变。get/cancel及所有旧动作保持4096字节请求限制。strict request先校验，整命令在首个异步persist前深复制；之后使用原JSON锁/CloudBase事务里的当前admin、actor/product/operation/input和版本/TTL检查。

响应显式白名单，shared CatalogProductOperationStatusSchema限制4096 UTF8字节。含原productId/operationId/intent/inputDigest/state/createdAt、current/revisionCurrent/expired、必要的saved时间与版本、配置页/媒体/引用进度和cancelledAt。complete必须有原revision、完成时间/商品版本/published-at-completion；配置/引用完整且媒体准备完成，回执revision匹配。历史完成与当前有效分开：后来下架仍可读取完成历史，current=false且零写，不能再次上线。过期操作状态仍可只读查询，不隐式取消或保存。

响应不含完整record、values、publication、原source/SKU、图片对象、私有链接、根快照或大数组。取消保留原state和cancelledAt，不能把staging当成可继续；前端接线时必须优先识别cancelledAt、过期与current。3种scope返回串号或旧approval进度不能冒充本次操作。

## 先红、review与验证

新增53项：shared17、DB9、实际Admin+JSON27。首次直接内部动作路由的红测286项中9失败，其中包含旧session错误码预期和取消夹具字段错误；不能都算产品缺陷。修正这两个夹具，独立公开动作保留全部旧内部拒绝测试。初版把新状态并进旧workflow返回union引发6个旧review消费者类型错误，改为独立facade，旧workflow byte-equal基线。action mapping按实际判别分支收窄，不添加宽类型断言；两个测试unknown/void回调类型修正，未削弱生产合约。完整状态合约14项先出现7反例失败，进度一致性修复后通过，再加3个staging反例确保不被complete门槛掩盖。

315最终相关控制、5686全包/脚本、实际Node20关联2698项通过，0失败/跳过/取消。19工作区types、E2E types、standingSDK、九文件Biome与diff检查通过。12源码故障全部检出、46重叠失败，四源码SHA恢复：实际Admin路由断开、DB facade断开、深复制变晚、3种scope比较遗漏、私有根返回、历史误报current、正常长描述误拒、start映射错命令、staging与complete一致性省略。恢复后459实际SDK与315控制再次通过。

实际安装NodeSDK3.17.2/database1.4.3仅替换HTTP传输，459=原441+18，raw与真实DB index生产facade均覆盖小状态、staging/complete/下架后历史、cancel重复零写、开始3种坏ACK整笔回滚、开始commit已生效丢回应后同operation查询、实际SDK start暂停后改输入、当前角色撤销。start不保存原商品。未新增vendor方法/shim/dependency/env。Context7不可用；官方v3.25.76 tag source与安装types.js/.d.ts交叉确认strict/extend/safeParse/discriminatedUnion/superRefine，v3网站页面无可提取正文且错误raw路径404均不作证据，实际tag packages/zod/src/v3/types.ts376–384可读；未套用Zod4合约。

人工逐项审阅handler/DB index/facade/原内核预算/shared DTO和export、三测试及四记录文档，并沿current-session→kernel事务→严格ACK→DTO白名单追踪。把“complete就是当前发布”改为“完成历史与current分开”；实际核对字段和zero-write文件mtime/SDK calls，不以技能名称代替证据。正式UI、自动有界满槽恢复、live-edit/review/history fallback、真实云/P95及三时钟20件验收仍未完成，fullDeliveryReady=false。

## 精确构建后的退出条件

本地完整三函数/site构建及精确编译Admin+实际PNG四进程链随后补证：stage状态查询、重复start只读、可信退役后expired/cancelled状态、重开HTTP get/cancel重复0写、私有PNG/分类保留与自有夹具清理。此记录目前不宣称尚未执行的编译产物检查；原整笔发布丢回应UI P1保持开放。此次公开状态入口尚无客户UI调用，不能说刷新恢复已经交付。
