# P3e7c9a 浏览器原发布任务契约

基线 4e5e13bf 的三函数/site 已完成14个独立进程检查：实际105SKU+PNG的New发布时同步确认审阅，满80槽原游标恢复后完成、公开读回、实际下架和历史任务零写；隔离对象均恢复清理。对应 output/owned-source-review-exact-runtime-verification.json。客户 UI 仍用旧发布链，原丢整笔回应的 P1 未关闭。

## 原因和落点

问题属于状态/后端契约及验证缺口：旧页面只有保存版本，整笔回应丢失后仅凭商品当前行不能证明本次操作。修复应落在现有 admin API/流程层，随后接现有 ClassificationDialog/RecordForm 和反馈组件，不换视觉设计。

先建立小型浏览器发布任务 API：start/get/continue/cancel 的输入在首次 await 前复制；只接受公开协议，严格解码4KiB状态，绑定原商品/operationId/inputDigest/发布 intent。新调用使用单次传输，BUSY 等明确拒绝交还流程层，不由通用 call 自动重发写入。未知写回应仅查询原 operation；查询也失败或串号时保留未知结果和原 scope，不能猜成成功、失败或新建任务。start 未知后查询 NOT_FOUND 也不换新 UUID。

本段只做类型化 wire 和原任务查询恢复；不在客户页面启用。完整协调器还须负责持久的最小 scope、共享4并发/分组、媒体 standalone fallback、暂停/取消/登录过期、历史完成/current区分、公开读回和失败逐件恢复。start 的 operationId 必须在第一请求前生成并保留，重试同一用户输入必须复用；get恢复不能制造一个新输入。

## 验证

先证明现有 generic catalogApprovalCall 对 BUSY 自动重发，与原任务低层的单次调用要求不同；再测新单次调用。覆盖输入/游标/深拷贝、原 intent 与三项 scope、私有根和过大/损坏 DTO、未知提交后 complete/仍pending/已取消/后来下架、确认IO失败、明确问题和原issues保留、abort前零调用/途中不猜取消、只读查询不递归重试。实际API协议与真实后台流程在后续组合继续，单测不算浏览器验收。

已读取 frontend-audit-fix 及 root-cause/visual-E2E 两参考、现有 islands/API/分类和正式503用例。react-best-practices/frontend-skill 在本地技能目录未找到；本段仅写普通TypeScript API，不改React hooks或布局。页面接线仍需真实浏览器动作及截图/断言，不以组件单测代替。


## 实施与验证

新增专用单次 transport 和发布任务客户端；旧消费者未切换。createPublicationAttempt 在第一请求前生成 UUID，复制并冻结 JSON 输入；重试同一用户输入保留同一个对象/UUID，不能把用户后来编辑的表单套进旧任务。原 request action、三项 scope、游标与期望 digest 都在首次 await 前捕获。状态严格使用共享 schema/4KiB/发布 intent，不接受私有根或其他商品/操作/输入。

未知写回应只 get 原 scope，返回 recovery=status 表示查到了当前持久状态，不证明原命令一定成功；saved/取消/历史 complete/current=false 都如实保留。二次查询失败保留两个错误和不可变 scope，不含 values；确认时失去权限保留登录提示及未知结果。查询 NOT_FOUND 不生成新 UUID，abort 不猜成已取消。明确 API 错误及 issues 原样交给后续流程层；尤其不能凭 CONFLICT/BUSY 等 code 断定整条 compound continue 已回滚，流程层还须查原任务。真实后端例已证明校验拒绝前可以有私有保存/引用进度，并可沿原 scope 查询、取消。

66 新增（wire63、实际客户端模块+默认Admin/JSON/真实PNG3），全部通过。后者是注入传输到真实 handler，并非实际浏览器或真实网络：覆盖 start 和最终 continue 提交后回应丢失、原任务恢复/标记确认/公开详情、实际Admin下架、引用归零和历史重放零写；第三例覆盖已产生私有进度后的 review-change 及原任务取消。隔离目录清理。默认 transport 另用真实 client→fetch/envelope 验证认证 token/公开命令和 BUSY 单次请求，避免所有例都绕过默认绑定。

最初直接调用原 generic transport 的红测为4次请求而预期1次，新 transport 改为单次；边界红测另证明 transport 修改已发对象会影响 catch action、undefined 确认错误会丢失，以及暴露的尝试/恢复 scope 仍可被修改，均已修复。17 源码故障全部检出、24 重叠失败、2 源码 SHA 恢复，含默认 client 错接自动重试 transport 的故障；不会只验证一个未被默认路径使用的 helper。

site 全套863（含既有 typecheck:test）、19包类型/E2E、5文件Biome、site15页构建通过，local1057及类型重验通过。相关7包/部署脚本总计6128中，site/local为本步新跑，shared354/db2238/admin638/public182/sync308/scripts488复用4e5e13bf未变代码证据并核对哈希；Node20的3163是本步完整关联重跑，不称根目录所有测试。本步没有新增SDK方法/依赖/env/表/锁或改变后端，651安装SDK与精确三函数14进程证据仍为4e5e13bf。

常规 astro check 确实排除单测，但仓库已有独立 typecheck:test，pnpm test 本来就先执行它。临时显式配置只用来检查两新文件，已清理，随后回到既有命令全量检查。客户端集成例最初放local Node项目，拉入浏览器模块后报DOM/ImportMeta及不同strict配置错误，已移到site所属测试lane，没有放宽配置或抑制错误；两处Reflect.get前补对象类型收窄。

## 未解释失败仍阻断发版

新增默认 transport 检查后的首轮Node20组合为3162/3163，既有JSON80 production-index恢复例在夹具循环的operation-approval-begin返回false；原断言没有返回码。增加诊断后，单独控制、完整3163重跑、三轮每轮两项JSON80控制以及local1057均通过，但根因未建立，不能写成已修复或归因于机器负载。诊断只增加index/返回值/时间和失败时原根inspection，不改变原断言或跳过测试。

首轮完整raw日志被诊断重跑覆盖；已从当时工具输出保存失败计数、原测试名/位置/堆栈摘录，不能冒称完整原日志仍在。后续每轮压力输出使用独立文件名。JSON80-BEGIN-UNEXPLAINED-1 继续作为P6验证阻断，与原整笔回应丢失的UI P1一起阻止bless/部署；后续整体检查保留观察与诊断。

实际review/simplify/humanizer核对两个客户端源码、两测试及JSON诊断、原API envelope/session与共享状态。将“明确拒绝=全流程未写”改为“保留错误并查询已有私有进度”；将“实际浏览器通过”限定为“客户端模块与真实handler串联”；默认绑定检查也已补齐。未改页面/布局/React状态，原UI P1未关闭；接下来继续协调器、standalone媒体fallback和页面接线，fullDeliveryReady=false。
