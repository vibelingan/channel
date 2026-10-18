# P3e6d7 上传激活与存储迁移引用状态

状态：本地实现、回归和源码审查通过；基线 28b5f0a。真实 pending/proof producer 仍关闭。

## 可观察边界

runImageUpload对pending采用publishedRefCount ?? 0，非空ledger/base0或显式null counter也可能activate/reject。source pending已有合法空ledger guard，上传入口需同一规则。摘要刻意排除refcount与mutex，因为它们不改变字节；不能靠摘要碰巧变化阻止错误激活。native/JSON上传命令还在SDK start/文件锁等待后才parse，调用者后改命令可能改变目标。

## 选择与保留

复用C1空状态验证，供两个pending生命周期入口共用：无ledger的旧缺counter允许原流程且不初始化counter，显式counter必须数字0；有ledger必须own count0及合法空pending。任何非空/坏ledger或有ledger缺base不能激活或标失败。vendor读取/写入错误仍发生在该纯验证以外，不吞掉。

active已完成receipt的重复确认保持只读；legacy active同一身份/大小/checksum的字节复核可在非空ledger和非零计数下继续，完整保留现有ledger/count；不得把pending约束误加到这些正常active操作。实际权限、uploader、inputDigest、owner和storage身份仍在事务/JSON锁内从当前行检查，只提前复制命令，不缓存行或权限。

native与JSON使用已有ImageUploadCommandSchema在首个异步边界前parse/复制，原runImageUpload内验证仍保留。无新锁、持久字段、SDK方法或HTTP动作。存储保护/迁移继续逐写点核对：同字节身份移动、当前image整行spread、原mutex、target/health/checksum与receipt重绑保持，不能用旧快照覆盖后来变化的引用。

## 检查

从现有native/JSON真实入口开始：pending非空ledger/坏ledger/nullcounter激活和拒绝皆0写；合法空ledger、缺counter legacy pending作正控。active completed与legacy reverify保留共享计数/账本，SDK start/JSON锁之前变命令仍按原快照。保护/迁移正向控制必须保留当前引用和字节身份，再跑相关全部模块、故障注入、实际SDK/Node20/类型/构建与恢复检查。其余own最终root/proof、UI/历史/provider/P95/test三时钟及20件发布回退未完成。


## 实际结果与审查

最初 native 18 项有 16 个业务失败、2 个正常控制；扩展到 native/JSON 62 项后有 24 个业务失败、38 项通过，加入保护流程后 120 项仍是 24 个业务失败。最终新增 44 项：native 上传 30、JSON 上传 12、存储保护串联 2；282 项聚焦测试通过。没有把实现后补齐的所有控制都描述成先红后绿。

17 项源码故障注入全部被检出：15 组造成 182 次重叠测试失败，另 2 项只由实际 SDK 探针检出。六份源码 SHA 全部恢复，随后 282 项聚焦和 SDK 255 项重新通过。覆盖漏 pending 守卫、跳账本校验、null 当缺失、过度拒绝正常 legacy/空账本/active 重验、两 adapter 延迟复制输入、source 断开守卫、校验函数擅改账本、保护 commit/release 用旧引用覆盖当前行，以及坏命令启动 SDK、生产入口未调用新实现。

实际安装的 Node 20 SDK 255 组保留此前 205 组，新增 50 组。只替换 HTTP 运输：验证 raw 与生产 adapter 上传的拒绝零写、合法状态、同一事务 ID、严格写确认、提交后丢确认的只读重放，以及 SDK 启动等待期间命令被调用者修改仍按原输入处理。没有新增 SDK 方法、shim、依赖、锁、持久字段或 HTTP 动作。Context7 当前不可用，沿用本次连续实现已通过 MCP 核对的官方事务约束，并再次执行安装包与 SDK 合约门禁；这些证据不代表真实云端 MVCC、COS 或 P95。

四个独立 Node 24/20 进程使用真实本地 PNG：pending 保持私有，上传激活后丢弃响应，随后注入明确标识的临时已提交引用；另一进程重开后重复确认完成，保留计数与账本且零文件写，公开读取仍为 200；最后恢复这个临时商品为未发布，结算引用后公开图片返回 404，私有字节、完成记录与原分类保留，再删除整个临时目录。这里的引用和商品是隔离夹具，未执行客户商品发布。

七包及 scripts 共 5,388 项通过：shared 309、DB 1,932、admin 638、local 734、public 182、sync 308、site 797、scripts 488。Node 20 全 DB/public 和相关 JSON/物理上传/保护流程共 2,400 项通过；19 包类型、E2E 类型、standing SDK、显式七文件 Biome 均通过，零失败、取消或跳过。精确三函数与 site 构建、编译后后台入口和既有审批/公开媒体串联在 commit 审查后执行。

审查了五个生产改动、三个测试文件、原上传完成入口、C1 校验、存储保护和来源 pending 写点，以及本记录/协议/实现日志/SDK 记录。把“上传要求零引用”改成“pending 激活要求合法零引用；active 完成确认和同字节复核保持原共享引用”，对照正控和故障注入核实，避免把正常已发布共享图片误拒。生产存储保护模块整文件、原商品保存 actor/classification fence 块均与基线逐字节相同。禁止使用通用 CRUD 构造 ledger 的测试夹具，原始坏状态仅在隔离文件/SDK 运输夹具中建立。

原整条 publication 提交后丢响应的 P1、own 最终 root/proof 激活、UI/历史/provider/P95、test 三时钟 resync/load/Edit/Preview 和 20 件已有分类选品发布读回/恢复仍未完成。producer 关闭，fullDeliveryReady=false；本步通过不等于可部署验收完成。
