# P3e6e1 冻结自己的发布引用计划

状态：本地实现、完整回归和源码审查通过；基线 87e54d7。真实账本 producer 仍关闭。

## 运行问题与选择

原审批根已保留保存、配置分页和媒体完成回执，但最终发布仍未实现。本步只在同一根冻结服务器生成的完整公开引用差值承诺，不写图片 pending、计数或终局 proof，不设置 published。

新内部 operation-approval-references 仅接受 productId/operationId/inputDigest。沿 currentApprovalOperation 复用 actor、当前商品/来源/版本/策略、未取消、TTL 和仅 draft publish 的全部检查；必须已有合法 media 且所有配置页完成。以同一事务当前 product 和本根 publication 计算最终 canonical 引用集合，再与 media 的数量及排序摘要完全相等才生成既有 Merkle 计划。合法准备过程会把产品图库/详情图原样放进网站 header，因此 raw+approved 与本次采用集合相等；不凭直觉新增另一套 retained IDs，也不改变旧计数规则。若两集合意外分离，本步拒绝并保留原根，后续仍需完整修复/重准备路径。

## 数据与限制

根增加 optional references：kind、operationRootId、treeRoot、leafCount、bindingDigest，整个绑定最多 1 KiB。摘要绑定原操作输入/策略、版本、productFingerprint、media 回执和承诺。服务端读回从本根 publication 重建计划，核对全部承诺，不接受自洽但对应另一图片集合的伪造树根。原根 1 MiB、prepared 512 KiB、操作输入 256 KiB 和合法 10,000 SKU/图库/详情图上限保持。

只读重试恢复同一绑定；begin/page/media 的重复操作和 cancel 都保留它。cancel 仍只永久停止后续步骤，不回滚已经确认的保存，也不会创建终局取消 proof（本步尚无 pending）。绑定不写 proof ID 对应行。读写仍在原 SDK transaction/JSON 文件锁中，最多 actor/root/product/source3 + 根写 = 7 次文档操作，无逐图读、存储请求或新 SDK 方法。最终写前再次检查服务端 TTL，严格 ACK 失败不报成功。

## 退出检查

从真实持久化入口先红：正常零图与 21 配置完整分页/媒体→冻结/丢回执重复/重开，拒绝缺媒体/页未齐/撤权/取消/过期/来源或商品变化/错 actor 和摘要；客户端 evidence/legacy HTTP 不可进入。补实际计划 9 图库、18 详情、共享/重复/10,000 SKU 集合边界和坏绑定/self-consistent wrong tree、整体预算、事务坏 ACK 与文件重开/组合。执行聚焦/类型/故障注入/安装 SDK/Node20，关键串联与精确构建后继续 pending stage/final activation。原整条 publication 丢响应 P1、UI/历史/provider/P95/test 真实选品及恢复都仍开放。


## 实际结果与审查

第一版测试错误地要求拒绝响应只有 ok/code，忽略原入口的详细 validation；五个客户端 evidence 控制修正为检查错误码和 issues。另一个 changed-product 夹具改到了准备完成前的旧对象，实际存储已被替换；改成当前行后，最终把两个生产入口恢复到基线重新执行，12 个所选实际入口均业务失败。随后实现和所有正常控制通过。补 persisted unfinished-page 反例又先复现 1 个失败，解码器现在拒绝“已有冻结承诺但配置页不完整”的坏状态。没有把这些夹具/类型/格式修正冒充产品故障，也没有说新增 62 项全部先红。

新增 62 项：DB 54（实际操作 24、真实服务器计划/纯绑定 30），JSON 8。真实服务器计划覆盖零图、9 图库、18 详情图、105/10,000 SKU、跨组重复和共享图；canonical raw+approved 与本次媒体集合一致，零变化旧批准图不会被误减。自洽但错误的 root/tree/count、换成另一份合法媒体回执、坏 digest/kind/额外字段/缺媒体和原 actor/source/version/TTL 条件均拒绝。286 项最后聚焦通过；更宽的相关检查先有 379 项通过，后补控制已由全量覆盖。

除基线恢复的 12 失败外，24 项故障注入全部检出：22 组测试造成 201 次重叠失败，2 项由 SDK-only 检出；合计证据文件是 25 项/213 次。覆盖漏写、重复写、未完成分页、最终 TTL、当前状态/取消、解码丢校验或旧严格 job 提取、canonical 集合不核对、空树、错 root/tree/count/digest/媒体回执、过度拒绝大商品、提前 published 或写终局 proof、放行客户端 evidence、JSON 延迟复制，以及实际生产入口未接通/native 延迟复制。一次只移除 inspect 的取消检查时，matchesCurrent 的独立检查仍阻止继续，属于冗余保护生效；注入器之后同时移除这两处取消门槛才构成真正危险反例。五份源码 SHA 恢复，SDK 277 和 286 项聚焦重新通过。

安装 Node 20 SDK 277 项保留此前 255 项，新增 22 项。raw/生产 adapter 都实际执行保存、21 配置分页、准备完成、媒体转移和引用冻结；关联来源首次冻结 7 个文档操作、同一 transactionId、所有读取在唯一根写之前，没有逐图读取或额外 proof 行。三种坏 ACK 回滚重试，提交已落盘但确认丢失后的 status/重复冻结零写，SDK 启动前输入复制、缺媒体/撤权/取消/坏承诺零写通过。SDK-only HTTP 夹具起初没有初始化准备任务集合，随后 status 请求误带 inputDigest 被严格 schema 拒绝，分别修正夹具和请求后才全绿。只替换 HTTP，不证明真实云 MVCC/COS/P95。旧汇总中“不读 actor/source/root”的标记现明确只针对 C1 引用读端，不能套到本步 7 操作的写流程。

四个独立 Node 24/20 进程先保存/暂存第一页，再完成准备/媒体和第二页、冻结后丢弃返回结果；另一进程重开读回同一承诺、媒体、21 配置，重复冻结/begin/media 零文件写；最后的进程确认已完成页重放并取消，保留两个绑定、未发布状态和全部已做工作，拒绝继续且无新 pending/终局 proof。临时目录已删除。这是零图持久化子流程；非空真实 PNG 由精确编译 worker 串联补证，不能代替真实整条发布。独立进程脚本第一次使用旧 seed 正则，因原 SDK 夹具后来加了 legacySeed 行而未匹配，启动前修正并保留失败记录。

完整七包及 scripts 5,450 项通过：shared 309、DB 1,986、admin 638、local 742、public 182、sync 308、site 797、scripts 488；Node 20 全 DB/public 和相关 JSON/上传/保护 2,462 项通过。19 包 types、E2E types、standing SDK、六文件显式 Biome/diff 通过，零失败、取消或跳过。native/JSON 生产 adapter 整文件、原保存权限/分类 fence、B2 media 模块均与基线逐字节相同。新增实现仅一份纯承诺模块、原根 codec/内部路由和绑定步骤。

审查了三个生产模块、三个测试、原 media/准备 seal/共享引用提取/SDK 桥接和四份记录。最初怀疑 raw 与采用图片的差异需要新增 retained IDs；按真实 applyWebsiteDetailHeader/planCatalogDetailApproval 与 10,000 SKU 正控重新推导后，保留原规则，只在本步加入明确的集合相等门槛。把“所有故障测试 25 项”改为“1 个基线复证加 24 个故障”，与证据 JSON 逐项核对。类型修正使用 Zod optional 的显式 undefined 联合，没有 any 或忽略检查。

计划读回需按冻结集合重建树，CPU 工作随图片数增长；10,000 SKU 的本地容量测试不代表云上 P95。后续暂存必须按页复用同一已核对计划、执行实际文档预算与 80 槽续接测试，再量测热/冷路径。无新的全局缓存、伪 tx.get 或每图完整根读取。

本步没有 producer、最终 product/root/proof 原子激活、live-edit 私有候选或 UI 恢复；原整条发布提交后丢响应 P1、历史/真实云/P95 和 test 三时钟 resync/load/Edit/Preview/20 件已有分类发布读回/恢复仍开放。fullDeliveryReady=false。
