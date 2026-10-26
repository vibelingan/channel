# SG0 客户边界与共同接口

2026-10-26 复核：以[权限与真实工具设计 D1](../SECURITY-AND-TOOLS-DESIGN.md)为本轮补充，开发暂停。现有单元完成状态只覆盖原验收范围；任务级授权、可信来源核验、安装归属及真实接线待补。

依赖：无。实施单元：SG0.1、SG0.2。统一依赖表见 [执行方案](../EXECUTION-PLAN.md)。

## 结果与已有基础

输出双方都能校验的询盘、成果、批准及控制合同，以及固定的客户连接映射。复用 v3“客户独立 Apollo 空间＋授权代管”、客户 Resend Team；不把Partner Seat误当Agent凭据。当前 Hermes 有 customer_id 与门户权限，但能力路由及执行卷未证明按客户隔离。

## 详细设计

合同放入版本化 schema；Channel 的 TypeScript 与 Hermes 的 Python 均读取同版本。未知 schema 主版本拒绝，不让双方各维护一套不同含义的DTO。允许增加非敏感可选字段的次版本兼容；必填字段或授权含义变化需要共同升级及回滚窗口。

每个客户一条服务器登记的 ClientBinding，包含source安装、business允许范围、runtime、知识空间、Resend inbox/发件身份、Apollo workspace、凭据引用、操作者映射与自动化模式。模型最多拿到任务限定的工具句柄，不能枚举全部客户连接。

```ts
// 目标核心约束
const binding = await resolveAuthenticatedConnection(principal.connection_id);
assert(binding.active && binding.client_id === event.client_id);
assert(binding.business_lines.includes(event.business_line));
const taskScope = issueRestrictedScope(binding, event.source_record_id);
// 未绑定就拒绝；禁止fallback到默认客户、默认邮箱或全局定海。
```

授权按动作分层：资料读取、生成成果、审核、批准实质邮件、暂停、人工接管、运营连接管理。普通生成Agent不能签发Approval。客户公司的销售与我们运维的权限分开；紧急停止者可被授权暂停，但恢复/批准不因此自动获权。

加入服务依次登记客户环境、单独授权连接、批准业务范围/发件身份/负责人、通过dry-run。退出先阻止新任务、暂停/交接活动并核对send_unknown，再撤Agent凭据和人工代管。撤销API key不自动停止已运行Apollo sequence，必须单独检查。

## 实施切片

- SG0.1：建立 schemas、有效/无效fixtures、跨语言校验及fake provider；只做数据合同，无真实账号。
- SG0.2：建立ClientBinding读取、动作权限与连接撤销；deny-by-default；定义全流程kill switch和credential refs，不保存真实secret到仓库。

建议写范围：Channel新增`packages/sales-contracts/`及接口文档；Hermes新增销售流程边界适配，不改公开客服角色或其他客户。共同schema只有一个维护方；依赖方通过固定版本消费，接口变更先协商再合并。

## 验收

目标用例 `contract_rejects_unknown_version`、`unbound_connection_has_no_default_client`、`client_a_cannot_read_or_send_for_b`、`partner_seat_is_not_tool_authorization`、`revoked_binding_blocks_new_dispatch`。A/B必须有不同canary数据、文件、连接，测试检查真实工具目标，不只检查输出文本。schema检查可离线完成，客户账号授权留到接入窗口。
