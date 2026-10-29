# SG1.2：官网提交、可靠通知与补偿接入实施计划

2026-10-29。继续当前两条 Sales 分支；本模块对外保持 SG1.2 编号。已完成来源授权，现补真实提交与持久投递。不部署、不连接真实客户、不发邮件、不实施待确认 UI。

## 目标与完成条件

OEM／单品正式保存成功后，在同一可靠边界留下不可变接入登记。通知失败不要求买家重填；通知进程中断可以从登记恢复；同一登记重投只产生一个 Hermes 任务。最后通过真实提交、实际 HTTP sender、Hermes MySQL 和原 Dispatcher 证明整条接入链，而不是由测试手动伪造完成状态或直接创建任务。

SG1.2 到“可靠接入并具备来源授权资格”为止。生产 accepted-task 消费器、自动模型调用和 Resend 审批发送不在本模块；跨仓测试随后由可信测试宿主调用既有 grant/read/prepare，只证明兼容。

## 已有代码与发现

- 单品 `saveQuoteInCloud` 已有批准产品快照、限流、幂等和 node-sdk 事务，直接扩展新记录分支。已有记录重试只返回原 ID，不能补归属或补登记。
- OEM 现有流程是先写项目，再激活附件，失败后补偿删除；补偿可能失败。启用 Sales 的现代附件／无附件路径用专用事务一起创建项目、激活已验证附件、写完成标记和登记。复用现有 secret、single-winner claim、实际下载和字节／摘要验证。关闭开关时维持原行为。
- OEM upload intent 在启用时写固定服务端归属；没有证明的旧 pending 附件不能在最终提交时顺手认领。使用实际字节检查得到的 MIME，客户端声明不能决定权限。
- legacy inline 附件保持原有兼容保存，本次不自动登记。智能客服尚无正式确认提交实现，不把聊天伪装成表单。
- 发现单品实际 runtime 通过公共 `get()` 读取未注册私有集合而失败。改用仅允许 OEM／单品询盘／文件三个集合的专用读取口，不把私有询盘加入泛型 CRUD。测试直接覆盖 `createSalesRuntime`，不能再靠替换 `readDoc` 绕过实际接线。

## 可信配置与数据

```ts
SalesCaptureScope = {
  client_id, business_line, source_installation_id,
  environment, cloud_env_id, cutover_at // 服务端固定；时间统一为秒
}
```

范围从函数启动配置传入，不能来自表单 body。新提交事务核对安装证明；功能默认关闭。开关关闭不新增归属或登记，旧数据不补录。提交时刻必须不早于启用 cutover；网络回执和后台备注不创造新的提交。

不可变登记：`channelSalesSourceRegistrations/<hash(owner + environment + source)>`。

```ts
record = {
  schema_version: '1',
  client_id, business_line, source_installation_id, environment,
  source: { kind: 'oem' | 'product', id, revision },
  event: InquirySubmitted,
  registered_at, cutover_at
}
```

登记键、revision 和 event 都由真实保存事实计算；共用纯来源投影／规范事件函数，避免 producer 和 reader 各算一套。登记只建不改，冲突拒绝。状态另存 `channelSalesSourceDeliveries/<registration hash>`。producer 在创建登记的同一事务中仅创建一次初始 `pending` 状态；已有记录不补建、不覆盖。通知方随后记录尝试、短期领取、下一次重试与 Hermes 回执，不改原始询盘和事件。这让登记与待处理项一起保存，避免依赖进程内通知。

## 通知与补偿

- 只向服务器固定的 HTTPS Hermes `/sales/events` 发送；只有显式本地测试可用 loopback HTTP。禁止重定向、环境代理、模型指定 URL 或凭据。来源凭据留在后端。
- 每条登记发送前重读当前原始来源、归属、完成标记、版本及安装／客户权限。无证明或已撤销则拒绝，不发送私有资料。
- 网络请求放在数据库事务之外。领取、重试和接受回执分别在短事务内保存，写入必须仍属于同一尝试；失去领取权的旧进程不能覆盖新结果。
- 发送成功必须有 202、严格任务／run／queued 回执及当前事件摘要。Hermes 对可选 `X-Sales-Receipt: source-v1` 返回同版本和 `X-Sales-Source-Sha256`，摘要按已接受事件去掉 `event_id` 后的规范 JSON 计算。旧调用不带此头时响应不变。
- 首次响应丢失时保留待重试；Hermes 复用已有 source identity 去重。不能把网络超时直接当失败重建任务，也不能把格式正确但缺来源绑定的回执当成功。
- 补偿只扫描本模块持久待处理项（`pending`／`retry`／`inflight`），不扫描全部旧询盘，也不让已接受的历史项继续占满队列页。使用有界批次、稳定顺序和可恢复／周期回绕的游标，不用后台列表 offset。旧游标后补入的事项仍能在后续周期被覆盖；未成功项始终有持久恢复依据，不能因推进游标而丢失。
- 提供明确的服务端单次执行入口和运行说明；部署时再配置定时调用。不开启公共聊天或模型控制扫描的入口。未部署定时器不能称线上自动运行。

## 写入范围与分工

| 工作 | 写入范围 |
|---|---|
| 来源与真实保存 | DB server-only source/read/submission 模块和测试；单品新记录事务；adapter/facade 最小专用方法；OEM 提交／upload-intent；public-api 配置传递；local JSON adapter 对应专用接口；Sales runtime 专用读取接线 |
| 通知与补偿 | sales-integration 内 sender、delivery store、registration scanner、服务端执行入口及测试；不改 producer、DB 公共接口和 package 依赖 |
| 跨仓验收与回执 | Hermes 新 website E2E、小型机械 helper、原运行器新增套件；Sales HTTP 可选来源摘要回执及测试，默认接口不变 |
| 协调与复核 | 本计划、解释文档、状态入口、独立评审、跨分支兼容检查、最终精确提交／推送 |

共用的 server-only 类型与导出由来源实现方提供；通知实现方只消费，不另建不同的数据形状。测试夹具独立导出机械能力，不 import 大型 `.test.ts` 文件，也不手工设置 finalized 或 source_verified。

## 业务不变量与验收

1. 单品新保存同时有完整原记录和登记；事务失败两者均无。原幂等、限流和批准快照回归保留。
2. OEM 附件验证后最终事务失败，项目、附件激活和登记不产生部分结果；旧补偿残留项目不被接入。
3. 正式配置只来自后端；请求伪造客户、来源和完成标记无效。旧记录、旧 pending 上传、关闭开关和 cutover 之前提交不补发。
4. 登记成功但 HTTP 失败／回执丢失，重启后由补偿恢复，同一来源只接受为一个任务。并发投递和过期领取不能覆盖当前结果。
5. 错客户、来源变化、错误回执、错摘要、未知协议、重定向和异常 SDK 返回均拒绝。
6. 补扫超过一批以及登记晚到均不永久漏掉；坏登记不让后续全部饿死。已接受历史数超过一批时，新 pending 不被历史记录拖慢。每个仍未完成的登记可查询和重试。
7. 实际 runtime 能读取单品来源；不能再因私有集合未注册而 503。正常读取仍受客户和任务双门禁约束。
8. 新增纵向 E2E 走实际保存、通知、HTTP 接收和 Dispatcher，再用显式可信宿主复验原准备模块。使用合成资料、事务替身和临时 MySQL；不宣称 CloudBase 线上或真实模型验收。

重要门禁做有针对性的缺陷注入，不给每个辅助函数机械添加测试。独立复核后修复，再跑约定受影响回归和一次最终跨仓验收。保留启动、业务和清理失败；本轮继续复用已核实的有界 MySQL tmpfs 与逐用例进度。

## 兼容与不纳入的变更

本轮已更新远端引用：pricing `30b84b18`、SEO foundation `01438e52`。两条线都修改过 DB adapter／facade；本轮仅作增量接口与保存分支接线，不合入、重写或修改对方工作树。完成前对计划写集做实际差异和冲突检查；无法协调时停止相关修改并报告。

不改产品价格计算、SEO、页面、现有 SMTP 确认信和其他 Agent。OEM 目前没有表单提交幂等键；本轮保证同一持久登记的任务去重，不保证买家重新提交另一张表单也零重复。


## 实施中复核补充

初版 scanner 会循环扫描全部不可变登记，再逐项跳过已接受记录。按每分钟 20 条，1 万条历史记录会使完整周期达到约 500 分钟，新的待处理事项可能被历史数据拖慢。现改为同事务创建初始 pending，只扫描未接受状态；保留原来的游标回绕和审计记录，不增加新模块或新表。SDK 查询的 `in` 与范围／排序组合必须按官方文档和已安装运行时核对，并有查询形状与历史积累回归。
