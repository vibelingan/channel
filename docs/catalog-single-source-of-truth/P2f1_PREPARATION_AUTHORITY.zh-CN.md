# P2f1：准备任务的服务身份与租约能力

状态：实施中。此单元只建立可信调用和当前租约的边界；任务持久化、实际worker、报告写回和列表接线在后续单元完成，fullDeliveryReady=false。

## Runtime Problem

图片检查已由93f9105验证。把它接入后台时，必须保证普通JSON、浏览器ready值或类似现有源同步入口的事件标签不能成为写入准备结果的权限。现有入口形状为：

    event.Type === 'Timer' || typeof event.TriggerName === 'string'

这段只说明事件分支，不能用作新准备服务的身份。本单元不改源同步触发器，也不创建假管理员行或改写用户登录。

## Data Shape

| 值 | 形态 | 生命周期与范围 |
| --- | --- | --- |
| 服务调用 | kind/jobId/nonce/issuedAt/expiresAt/signature | 30秒准入，绑定环境、用途与私有任务 |
| 任务nonce | 64位hex | 服务端生成并保存在私有job；不进入浏览器进度DTO |
| 活跃租约 | owner/version/expiresAt | 最多120秒，后续仓库在事务内校验/续期 |
| 本进程能力对象 | Symbol标记与WeakMap登记 | 不能JSON复制或跨进程转发，绑定job/product/input/gen/lease |

现有JWT_SECRET只在服务器配置中使用；HMAC消息有独立用途前缀和环境域。门户JWT即使同算法/密钥也不能作为服务调用。服务权限只有准备图片和存储准备报告，没有发布、审批或分类权限。

## Technology Constraint

已核对CloudBase官方Node SDK函数文档及安装3.17.2：callFunction只有同步name/data/qualifier和请求timeout，types/src都没有async选项。后续采用明确的有界步骤与持久进度，不添加假SDK选项，不启用既有timer。独立工作进程必须重新验证签名并取得自己的租约能力；不能把JSON里的能力标记直接当可信对象。

## Flow and Choice

后台入口先验证严格消息形状、环境/用途MAC和时间，得到不含秘密的本进程ticket。仓库读取并原子claim私有job后，以当前job和本worker的owner绑定lease能力。每次写入前读取当前job，再检查状态、nonce、产品、输入digest、generation、owner、leaseVersion及有效期。

    verifyCall(raw) -> opaqueTicket
    bindLease(ticket, currentJob, ownOwner) -> opaqueLease
    currentLeaseScope(lease, freshlyReadJob) -> technicalScope | null

签名有效不代替数据库租约；租约有效也不代替内容检查或发布用户授权。issuedAt允许至多5秒时钟偏差，准入失效后不能新绑定；已经开始的步骤以当前租约为界，取消/新epoch立即撤销旧能力。配置和能力快照固定，job对象后续变动不会改写已绑定范围。

没有采用事件Type、role字符串或复制管理员行作服务权限。没有把能力做成可被客户端重放的JSON对象；线上job/签名transport与同进程能力分开。

## Code Translation and Tests

实现位于packages/db/src/catalog-preparation-authority.ts，独立子入口，不进入浏览器shared根出口。数据边界运行时解析，MAC固定sha256、固定长度比较，所有失败返回null；配置/服务器时钟错误属于程序错误。

红测覆盖合法签名→当前租约→技术能力，以及字段/环境/用途篡改、门户JWT MAC、无签名Timer、额外ready/role、过期/未来/错误类型、私有nonce/owner/version/输入/产品变更、取消、租约续期与替换、JSON/伪造能力、跨issuer复制和配置快照。能力不得含用户admin角色、发布权限或秘密值。随后以实际代码故障注入验证测试有效性，再运行相邻准备/版本/存储小流程、类型与SDK门禁。

实际文字复核本文、现有事件分支、Node SDK声明/发送体和服务授权范围，将“后台调用即有权限”明确为签名准入加当前DB租约；完整任务继续。

## 本单元验证结果

权限模块已实现，仍无HTTP或worker消费，fullDeliveryReady=false。66项模块测试、165项相邻准备/版本/来源组合、Node20的133项关键组合全部通过，零失败/跳过/取消。9种真实源码故障分别移除MAC、环境域、准入期限、nonce、租约版本、generation、inputDigest、租约期限或running状态检查，全部被测试检出，正控仍通过，finally恢复原文件。DB类型检查、显式Biome和CloudBase合约门禁通过。

SDK实测使用安装的zod3.25.76，packages/db/node_modules/zod/v3/types.d.ts声明与66项运行匹配；官方参考https://v3.zod.dev/。本单元没有CloudBase方法、部署参数或类型shim变更。标准Node crypto HMAC与固定32字节timingSafeEqual经过独立签名与错误长度输入检验。

实际复核两个源码文件、DB子入口、本文及现有准备存储/检查消费者，将“建立服务身份”限定为调用准入与本进程租约能力，未写成任务已自动后台执行。后续仓库须在事务内读当前job并检查能力，不能在事务外assert后直接写。任务领取/进度/取消与实际producer继续接线。
