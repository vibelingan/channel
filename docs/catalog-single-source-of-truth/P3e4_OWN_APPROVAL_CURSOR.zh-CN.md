# P3e4 同一操作的审批起点与查询

状态：本步局部验证通过，整体验收未完成。沿既有 P3，不建立第二个协调器。

## 运行问题与本步边界

现有 `operation-start → save` 在 catalogDetailApprovals 的同一 key 写 reserved/saved；旧 begin 在该 key 要求严格旧 job，遇到 saved 会 CONFLICT。因而丢失审批开始响应仍没有自己的可恢复游标。本步只接入私有持久化 `operation-approval-begin` 与 `operation-get/start` 的 staging 查询；不开放 HTTP，不执行分页/finish，不发布。

## 数据、约束与决定

key 仍为 hash(actorId, productId, operationId)。新增 staging 根保留旧审批 publication/pageHashes/variantIds、原始 operation 和 saved 回执。原 createdAt 保留，重试不续 TTL。原始输入256KiB、旧 job512KiB限制保持；合并根采用独立1MiB应用预算，组件分别校验。容量模型已用真实 prepare + reservation 合约测得保守形状787891字节；本步用保存后的合法 UTF8 组合验证：审批正文低于512KiB，合并根超过512KiB但低于1MiB，256条属性和30000字符管理员说明完整保留；正文单独超过512KiB仍拒绝。该预算不是云平台上限声明。

从 staging 模块提取纯 job 合约、指纹与解码到无运行时适配器依赖的模块，避免 operation↔staging 循环。旧 job 解码保持 strict；旧 begin/page/finish 对新版根关闭。删除保护已读根 publication，新增字段不能遮蔽图片引用；以实际消费者测试确认。

只有当前 admin、publish intent、saved 且当前未过期的操作能进入审批。核对 inputDigest、actor/product/key、准备的 productFingerprint、expectedRevision、来源/身份/策略/内容/生命周期/分类版本与 saved updatedAt。重试返回已持久化 revision/cursor，不能用新准备的随机 revision 覆盖。不同计划或输入拒绝。不得将 staging 或批准完成推定已发布。

## 可独立检查项

1. 同根转换一次写；原输入、saved 和创建时间不变；产品/分类/图片不写。
2. 丢响应后 get/start/重复 begin 返回原游标，零额外写；保存重试也不重复写。
3. 未保存、非 publish、其他 actor/ID/digest、过期/未来时间、内容/来源/分类/生命周期/旧批准变化、坏 prepared 均无部分写。
4. 保持历史旧审批工作流；新版根旧 page/finish 拒绝，图片删除仍识别 unfinished 引用。
5. 真实 native/JSON 保存串联、Node20安装SDK传输探针、进程重开、容量/写失败回滚与源代码故障注入。

## 剩余风险

分页、批准回执、最终公开、冻结分类/供应商上下文、大媒体事务协议、所有 HTTP/UI 入口及原正式响应丢失 E2E 仍是后续工作。不得将本步局部通过报告成发布恢复完成。云MVCC、test部署、真实三时钟和20件回退尚未验证。

## 实施与验证

新增纯 `catalog-approval-job.ts`，旧 schema、指纹、sameProduct、readJob 经导出重命名后与58be04d逐字比较一致。native adapter、actor classificationAuthFence、SDK类型与依赖未改。staging查询还核对准备内容指纹，避免来源投影改动后误报 current。合并根保持 saved snapshot；旧保存请求可读回自己的保存结果，不能把这当作审批完成。

先运行28条新核心测试，4条业务红（开始/重试、容量、未确认写入），其余负控不能单独证明守卫有效；后以10个源码反例验证。最终新增43条，522条聚焦、全七包加脚本4723条通过：shared309/DB1447/admin637/local610/public131/sync304/site797/scripts488，0失败/skip/cancel。Node20相关535条通过；19包types、E2E types、Astro216项0error/0warning（8既有hint），7源文件显式Biome、SDK合约、diff检查通过。

10个源码反例分别移除输入摘要、过期、updatedAt、intent、来源/版本检查、重试计划检查、保留TTL、组件容量、legacy strict和真正写入，检出28个重叠失败；两源文件均finally恢复且SHA一致。28条原新核心红绿之后增加来源3集合×开始前/后、投影变化和正文独立容量负控。未减弱原正式E2E断言。

native与JSON实际保存串联、原根唯一/重开/零写重试、3种ACK失败回滚、unfinishedApprovalUsingImage实际删除保护消费者均通过。20个隔离对象按4路调用开始审批并重开，20个operationId/revision各自独立，0商品公开，分类保留。该驱动没有证明正式UI的并发和最终批量发布。

独立Node20安装SDK探针只替换HTTP传输：6组验证、begin4次文档操作（来源绑定会多3次点读）、实际startTransaction延迟时冻结准备内容、get/start/save/重复begin零写、3种坏ACK回滚、生命周期变更拒绝。4个独立Node24/20进程验证丢弃开始响应后重开同游标、零文件重写，移除测试目录。SDK/JSON回读省略optional undefined，测试按实际JSON线格式比较全部可持久化字段；生产捕获继续使用structuredClone。

工程迭代中的脚本错误（fixture新增linked参数遗漏、控制器名称写错、误列不存在workflow测试路径）保留日志并改正，不记作业务红。所有执行session收口后提交。精确SHA打包与强制产物smoke在提交审查后补证。

## 审查与后续接缝

当前公开workflow严格schema仍只有原动作；后台persist只接服务器构造命令，未将prepared开放给浏览器。旧page/finish拒绝带operation/saved的新根，且实际图片删除检查仍识别publication引用。单步只写根，不写商品/图片/分类共享记录。

新增根使单条最大读取量增加；unfinishedApprovalUsingImage目前list整条job，须在开放正常UI前增加有界媒体引用投影或等效读取并做大根分页预算测试。不得只把pageSize调小掩盖性能问题。HTTP状态DTO也须有界投影，不能把整份正文/原始patch当进度返回。这些随分页/finish、最终visibility及大媒体协议一起验证，整体验收仍被原P1阻挡。

文字核对：实际审阅7个实现/测试文件、本MIU、IMPLEMENTATION_LOG、SDK-PROBE和既有workflow/删除保护消费者；把“审批成功”纠正为“审批游标已保存”，以产品published=false和无approvalReceipt断言核对。没有把隔离20件起点测试写成真实20件发布验收。
