# SG2 Hermes 调度、客户执行与成果

实施单元：SG2.1、SG2.2、SG2.3。

2026-10-24：SG2.1、SG2.2已在Hermes独立分支feat/sales-agent-runtime完成代码、代码复核和隔离Docker/MySQL CI，见[验证记录](../evidence/SG2.1-SG2.2-VALIDATION.md)。实现采用单客户专属Sales服务/数据库和固定绑定，复用原dispatcher；没有改全局路由或现有文章流。SG2.3仍待实施。以下保留整体设计，不能据此认定已接通线上定海或邮件发送。

## 复用和缺口

复用Hub assignments、事务outbox、dispatcher租约/退避/死信；不另建任务调度平台。当前`registry.resolve(capability)`未按客户限定，角色级HOME卷和`/app`时间窗收集不能证明客户隔离。目标是试点客户明确的执行边界，不借这轮销售设计重构全部Hermes业务。

实际代码在Hermes仓库实施；本worktree只交合同和验收。候选范围`deploy/hub/sales_flow/`及必要的注册/工具边界适配、运行配置与tests。所有共享调度修改先与平台维护者对齐，保护当前定海、内容工厂、发布助手的既有流程。

## 执行边界

任务从已认证source绑定客户，配置选择客户runtime与flow版本。共享中枢可只处理标识和路由；会接触私有正文的定海、内容和发布步骤都进入客户范围。独立运行目录/HOME/记忆/KB工具授权/连接/产物；同一镜像可复用，不共享可变状态。

```python
# 目标逻辑，非当前接口
scope = bindings.require(connection_id, business_line)
runtime = registry.resolve_for_client(scope.client_id, 'sales.prepare')
assert runtime.client_id == scope.client_id
run_dir = scoped_runs.create(scope.client_id, task_id, run_id)
# 工具服务注入client范围；模型传入workspace不扩大授权。
```

第一期同客户可采用低并发或队列串行，降低成本与竞争；串行不能代替客户隔离。scope丢失时拒绝任务，不自动选全局定海。每个任务运行ID固定；跨重试新增run、复用根task，保留控制epoch。暂停不会要求必须立即杀容器，任何对外工具必须再次查授权和epoch。

## 任务接受与成果

事件入库＋根任务＋outbox在Hub同一事务完成，唯一索引以客户/安装/源记录/事件类型约束。接收202说明已持久受理，不表示已拟好邮件。重试返回同task；三个分支状态独立。工作执行状态和邮件发送状态分开，不用旧assignment完成当作邮件投递完成。

成果必须显式提交manifest：client/task/run/版本、文件路径引用、sha256/MIME/大小、来源资料版本、正文及缺项。服务端只接受当前run目录内文件，拒绝`../`、symlink跳出、其他run路径及未登记附件；先持久保存并验证内容，再标review_ready。旧run晚到只归档，不覆盖当前成果。

```python
# 现有时间窗扫描的替代形状
for item in manifest.items:
    file = resolve_inside(run_dir, item.relative_path, reject_symlinks=True)
    verify_size_type_hash(file, item)
    artifacts.save(client=scope.client_id, task=task_id, run=run_id, file=file)
```

## 切片和验收

- SG2.1：客户runtime/工具/记忆/文件边界；先用A/B canary验证，禁外发。
- SG2.2：统一事件接收、稳定task、复用outbox、run及分支状态。
- SG2.3：manifest归档、固定版本、运行失败重试及控制epoch拒绝旧run。

目标用例 `wrong_runtime_is_rejected`、`a_cannot_retrieve_b_memory`、`artifact_manifest_rejects_other_run`、`artifact_symlink_escape_denied`、`late_run_cannot_replace_current_version`、`duplicate_event_has_one_root_task`、`dispatcher_crash_recovers_without_new_root`。这些需要实际运行与并发测试，不用prompt文字证明隔离。未完成SG2.1不得让试点Sales读取真实客户私密资料。
