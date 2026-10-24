# P3e7c8 原任务的供应商审阅确认

基线 33bf202f 已用同 SHA 三函数/site 和 14 个独立进程走通 105 SKU 冷 PNG、满 80 槽游标恢复、实际最终发布/公开读回/下架/历史回执不复活；隔离对象均恢复清理。初次脚本的 decoder 导入路径及根加终局证明后数量断言已改正，保留失败日志，不计业务失败。客户 UI、真实云速度和 test 现场仍未验收。

## 当前缺口与选择

最终 native 事务目前拒绝所有 Changed/Removed，包括已逐项选择的正常操作；首次发布 New 又没有清除审阅标记。不能在发布后追加一个异步清标记请求，也不能忽略未决供应商变化。

沿原最终事务核对当前来源与现有 Keep/Use incoming 决定，并在同一次商品写入确认审阅。New/旧无 reason 的首次来源批准、手工 edited 批准不要求不存在的供应商选择；Changed/Removed 只有当前输入的分项决定完整才可通过。Removed 仍沿既有业务规则，不能擅自改成网站自动下架。未知 reason、缺来源或不同来源摘要拒绝并保留原数据。

复用现有 supplierParts 的比较/摘要规则，在 DB 的 server-only 模块提取同一实现供 Admin 与 native 使用。photo lookup 仍只读取既有 catalogSourceLinks，保持原 alicdn HTTP→HTTPS 归一化和 ID/provider/url 验证，不下载、不改绑定；单次审批缓存重复 URL，最多 9+18 个链接读及 1 个 observation 读，事务不新增写入。Changed/Removed 的成本必须由 SDK 最坏数验证；常规无标记路径不增加读取。

已有匹配 Keep 可批准网站值；Use incoming 必须实际写入当前 incoming 值，不能只传一个决定标志却仍发布旧值。新来源使原决定过期；actor/source/link/版本/分类/TTL/媒体/引用和 3 写 ACK 回滚继续由原内核控制。已 complete 只读，不追加清标记或再次发布。

先用实际默认 API 复现 New/手工 edited 标记不清、有效 Keep 仍拒绝、未决错误缺少可操作提示。随后覆盖三个分项的 Keep/incoming、失效摘要、未知来源 IO、来源变化、27 个唯一链接的预算、坏 ACK/丢回应、同根重试及下架。每一步 review 与相关/组合检查，不能据此启用新 UI 或部署。


## 实施与验证

native 最终事务先复核当前审阅，随后在原商品写入中同步清 pending/reason、记录 actor 和与 approvedAt 相同的时间。根、商品、唯一公开引用证明仍是原 3 写，没有发布后异步清标记。只有完整当前来源的 New/旧无 reason，以及分项已决定的 Changed/Removed 才确认；已有来源公共摘要若不同于本次批准，返回 resync。旧记录缺公共摘要仍依赖原根完整来源快照，不强制制造摘要或倒写来源。历史 complete 不再清标记或重新发布。

supplierParts/摘要/来源照片 URL 归一化抽到 DB 的 server-only 模块，Admin 保留原接口转调，native 在同事务读取真实 observation 和既有照片绑定。正常无标记路径零新增读取；New/旧首次/已链接 Edited 的最终事务 17 个文档操作，27 照片的 Changed/Removed 为 44，仍 3 写；安装 SDK 全套最高 98。照片按归一化 URL 缓存，9+18 不超过 27 个绑定读，不读图片对象、不下载。缺决定、过期决定和只标 incoming 未应用值返回对应字段的 review-change；未知 reason 返回 system-repair，未知存储 IO 抛出，不能降级为缺数据继续批准。

新增 45 条（DB33、实际默认 API12），保留原 Admin 分项比较 9 条。最初 7 个实际业务红测复现：New/旧首次/Edited 标记未清、有效 Keep 的 Changed/Removed 被拒、未决原因不可操作、来源摘要更新后仍批准。之后 638 条关联用例、7 相关包和部署脚本总计 6062、实际 Node20 3097 均通过，无失败/跳过/取消。19 包类型/E2E/standingSDK/7 文件 Biome/diff 通过。

初轮人工 review 找到 P2：已链接 Alibaba 的 Edited 与手工 Edited 共用提前返回，跳过来源摘要。先补两个失败断言，改为手工无来源 Edited 零读、已链接 Edited 同样核对摘要与完整来源；再加入定向故障注入。受影响 DB/local/Node20、638 关联和三个消费者类型重新通过，其他未变包保留同轮结果。该问题已修复；不能因为第一轮绿就跳过混合路径审查。

14 种故障全检出，25 个重叠失败，3 个源码 SHA 恢复。覆盖 native 丢弃拒绝/清标记、来源摘要跳过、决定摘要未绑定、incoming 未应用仍接受、重复读未缓存、reason 被强转、缺 observation 被接受、照片绑定 ID 未校验、无标记被强制审阅、Admin 共享实现断开、两类 IO 被吞、已链接 Edited 绕过来源检查。源码恢复后 SDK 651、受影响包和相关回归通过。

651 安装 Node20 SDK 控制 =626+25：5 类来源审阅、手工 Edited、5 类无效决定/摘要、4 个 coded/malformed 读错误、9 个 product/root/proof 坏 ACK 回滚和同任务重试、最终回应丢失恢复。最终确认和清标记同一事务/同一 3 写；坏 ACK 保持私有且标记不丢。SDK 的新分项控制使用事先构造的可信候选；实际 canonical mapping/真实 PNG 由默认 API 与后续精确产物分别验证，不混称完整来源重建。没有真实云 MVCC、COS 或 P95 结论。

新增脚本首轮将新控制放到原函数作用域外，移回可见作用域后通过；随后发现原“手工 Edited”SDK 夹具其实带 Alibaba 关联，改为明确无关联，并另测完整关联 Edited 的正反例。新增测试的两处字符串格式和错误 DTO 类型收窄、partial-product 字面量已修正。这些工具/夹具错误保留日志，不记成产品红测。

实际 review/simplify/humanizer 核对 7 个改动代码/测试文件、原 source snapshot/媒体/引用/3 ACK 和 DEC-7/11/19/Removed 规则，确认 DB 模块不依赖 Admin、不向浏览器公开 native 命令、不新增资源。把“所有 Removed 已修好”限定为“完整当前来源且候选可构造的草稿”；live、来源缺失、旧 seal 修复仍有后续路径。把“44 次读取”改为“44 个文档操作，其中仍 3 写”，与 SDK 计数对齐。

原 UI P1、live/新图/创建、慢媒体 fallback、P5 与真实验收未关闭，未 bless、未部署。接下来按本提交 SHA 构建三函数/site，用实际编译的 105 SKU + PNG 首次 New 发布核对标记原子确认、公开读回/下架，再继续页面协调器与其他小流程。完整现场仍须三时钟 resync/load/Edit/Preview、20 件保留分类按 Assign category → Save and publish 及恢复，fullDeliveryReady=false。
