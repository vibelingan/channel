# SG1.2：可靠通知与补偿执行说明

2026-10-29。代码默认关闭，本轮不部署、不创建线上集合、不启动定时器、不连接真实客户或发邮件。

## 运行方式

生产保存事务同时写不可变来源登记和一次性的 `pending` 投递记录。通知器只更新投递记录。每次执行最多检查 20 个活跃项；可由可信宿主调用 `WebsiteDelivery.tick(1..50)` 调整本次上限，模型和公开请求没有这个接口。

`tsup` 构建的 `dist/reconcile.js` 会复制进同一独立函数包 `dist/package/reconcile.js`。HTTP 的 `scf_bootstrap` 继续运行 `index.js`，不会隐式启动通知器。可信服务端的单次入口是：

```sh
node dist/package/reconcile.js
```

运行位置必须是具有对应 CloudBase 服务身份的可信作业宿主，或由运维明确注入该环境服务凭据的服务端进程。普通客户电脑、公开浏览器和仅下载了包的无凭据机器不具备数据库访问权。HTTP Function 的主进程不会自动执行这个 CLI，也不能仅给 HTTP 入口挂一个 Timer 就当它会运行补偿；本轮没有部署独立 Timer Function。

本地已有 workspace 依赖时也可运行 `pnpm --filter @vibelingan-channel/fn-sales-integration reconcile:once`。定时调用属于部署配置，应在上线阶段明确设置；代码存在不代表线上正在补扫。

## 固定配置

凭据通过受控服务环境注入，不放进命令参数、浏览器、模型或群消息。

| 配置 | 用途 |
|---|---|
| `SALES_SOURCE_DELIVERY_ENABLED=1` | 显式开启单次通知执行；缺省返回 disabled，不初始化数据库 |
| `SALES_CLIENT_ID` / `SALES_BUSINESS_LINE` / `SALES_INSTALLATION_ID` | 固定客户、业务和网站 |
| `SALES_ENVIRONMENT` / `TCB_ENV` | test 或 production，以及实际云数据库环境 |
| `SALES_SOURCE_CUTOVER_AT` | 与生产保存一致的启用时间，整数秒，不回填历史 |
| `SALES_RUNTIME_ID` / `SALES_CONTROL_EPOCH` | 与当前客户绑定一致的运行身份与权限版本 |
| `SALES_CHANNEL_CONNECTION_ID` | 绑定中允许读取询盘的 runtime 连接 |
| 该连接 `credential_ref` 对应的环境变量 | 每次发送前核对当前读取权限；不作为发送给 Hermes 的凭据 |
| `SALES_HERMES_EVENTS_URL` | 固定 HTTPS 地址，路径必须 `/sales/events`；仅 test 可用明确的 127.0.0.1 HTTP |
| `SALES_HERMES_SOURCE_TOKEN` | 对应 Hermes 的 `SALES_SOURCE_TOKEN`；与运行、读取控制、来源签发等凭据分开 |

与来源捕获相同，安装和客户绑定必须已登记且仍有效。通知器不会从传入事件猜客户，也不从原询盘补造归属。

## 数据库准备与查询

上线前需由运维按项目资源流程明确创建并配置私有集合，运行器不自动创建：

- `channelSalesSourceRegistrations`：不可变来源登记，键为客户／环境／来源的规范摘要。
- `channelSalesSourceDeliveries`：同事务初始化 pending；后续记录尝试、领取、重试或接收回执。
- `channelSalesDeliveryCursors`：按客户／业务／网站／环境的稳定扫描位置。

同时复用已存在的安装、绑定、OEM、单品询盘和文件集合。客户端数据库规则应禁止公开读写这些 Sales 私有集合。服务端存储口也限制集合，不向泛型 CRUD 注册私有单品询盘。

实际扫描语句为：

```ts
collection('channelSalesSourceDeliveries')
  .where({
    'record.client_id': clientId,
    'record.business_line': businessLine,
    'record.source_installation_id': installationId,
    'record.environment': environment,
    'record.status': db.command.in(['pending', 'retry', 'inflight']),
    // 非起点页：_id: db.command.gt(lastId)
  })
  .orderBy('_id', 'asc')
  .limit(20)
```

按上述四项范围、状态和 `_id` 准备组合索引；上线时用实际环境的查询计划检查该组合能支持 `in`、范围与排序。当前没有连接线上 CloudBase 验收该索引。accepted 审计记录不再占活跃页，测试包含一千条已接受记录仍能在第一页处理新 pending。

游标不是后台列表 offset。一次扫描读至末尾会持久回绕，晚到但键较小的待处理项会在后续周期处理；坏来源会拒绝并留下持久登记，不阻塞后续行。空尾页只回绕，因此调用频率会影响最坏发现时间；应按待处理数量与所需响应时间设置周期，而非把 2 秒退避误当成一定 2 秒后完成。

## 一条投递的执行约束

1. 短事务重读登记、当前来源、完成标记、版本、安装和权限。检查新的 pending seed 确实随保存产生；不临时替旧登记补 seed。
2. 同事务领取 30 秒，写入随机 attempt 身份。其他工作者会看到 busy；HTTP 在事务之外执行。
3. 原生 HTTP／HTTPS 连接固定目标，禁止重定向，不使用环境代理；总截止时间最多 5 秒，响应最多 16KiB。错误不回显远端正文或凭据。
4. 成功必须是 202、严格的 task/run/queued 三字段，以及 `source-v1` 和当前事件摘要回执。摘要不是审批或发送授权。
5. 写入 accepted 之前再次核对来源、权限和当前领取身份。失去领取权的旧进程既不能写成功，也不能把新尝试改成 retry。
6. 网络失败、回执丢失或不确定结果保留为 retry；短退避从 2 秒增至最多 300 秒。进程在写回前退出时，领取过期后可重新接手。Hermes 的来源去重负责把同一登记的重投映射到同一任务。

若回执无法持久化，不能向调用方宣称成功。接口返回受控失败，原 pending／inflight／retry 仍提供恢复依据。通知失败不回滚已成功的买家提交。

## 验证与 SDK 依据

已查安装的 `@cloudbase/node-sdk 3.17.2` 与 `@cloudbase/database 1.4.3`：Query 的 `where`、`orderBy`、`limit`，Command 的 `in`／`gt`，get 的 `{data}` 与可能错误包分支，及事务 set 的扁平数据与确认形状。复用本轮 DB 共享的严格读取和写入确认，不扩充 SDK shim。

官方 MCP 搜索可找到新文档索引，但读取旧 node-sdk database/query 地址返回 HTML 或 404；没有把它当成有效合同证据。另核对 [官方 node-sdk 数据库文档](https://github.com/TencentCloudBase/node-sdk/blob/master/docs/database/database.md) 的查询链和命令，并以安装源码和离线实际 SDK 序列化测试为当前版本依据。Context7 当前未提供。环境凭据引用也复用服务器共用的 `resolveSalesCredential`：支持安全 POSIX 大小写变量名，只读取受控配置的自有字段，避免两条接线各写一套规则。线上集合、索引和事务仍要另做部署验收。

测试分层覆盖真实保存后的投递、并发领取、过期恢复、旧成功／旧失败不能覆盖新 owner、网络期间撤权、异常 SDK 包、回执摘要、代理／跳转、慢响应、有界分页和晚到键。临时源码缺陷注入单独核对预期断言，不把语法／导入／环境失败算成抓住业务缺陷。

文字复核参考 `humanizer` 与普通技术说明规则，实际检查了 sender、worker、store、CLI、fixture、测试与打包入口。将“自动补扫已运行”改成“单次执行入口已写入部署包，定时调用尚未部署”，避免把代码、打包和上线混为一谈。

## 本轮验证记录

通知部分 41 项 focused 测试通过，包含真实 loopback HTTP、实际生产保存生成的登记、真实安装 SDK 的查询序列化及临时事务存储。类型检查、双入口构建、打包和冷启动通过。冷启动既验证默认关闭的 CLI，也在网络被阻断的环境中构造启用配置的 CJS factory；没有调用 tick 或接触线上数据库。

定向缺陷注入的九项包括：错误来源摘要、总截止时间、响应流大小、已完成来源、篡改的联系人、旧成功写入、旧失败写入、已接受历史挤占页面、游标不回绕。首轮九项全部被对应断言发现。一次最终复跑在 clean baseline 模块加载阶段超过 15 秒，尚未执行任何注入，按失败保留；其他大型回归结束后，同一源码和同一时限隔离复跑，九项全部通过。该结果支持测试资源争用的解释，不证明它是唯一原因，也没有放宽业务时限。

证据分别保留：`SG1.2-delivery-defects-first/report.json`、`SG1.2-delivery-defects-final/report.json`、`SG1.2-delivery-defects-isolated-final/report.json`。前后核对了被测源码摘要，实际工作树没有注入坏代码。

SDK wire probe 的第一版也保留了失败原因：raw ESM 动态加载遇到 CJS interop；改用直接加载 SDK 后，又发现排序字段使用 Extended JSON 数字包装，旧断言误按普通 JSON 期待。最终测试使用该 node-sdk 实际依赖的 `@cloudbase/database`，仅替换最低层请求器，执行真实 store、查询构建器及序列化，并按实际 EJSON 包装断言。这个测试不调用完整 SDK init，避免把它的异步云环境元数据预检混入离线序列化验证。没有为适应测试而修改业务 SQL、SDK shim 或源数据规则。
