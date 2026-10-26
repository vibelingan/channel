# SG1 官网询盘接入与受控业务资料

2026-10-26 复核：以[权限与真实工具设计 D1](../SECURITY-AND-TOOLS-DESIGN.md)为本轮补充，开发暂停。现有单元完成状态只覆盖原验收范围；任务级授权、可信来源核验、安装归属及真实接线待补。

实施单元：SG1.0、SG1.1、SG1.2。依赖按 [计划](../plan.json)。

## 复用事实与写范围

SG1.0已完成[源码核对](../evidence/SG1.0-BASELINE.md)。SG1.1使用以main `404d1a25`为起点的销售集成分支；正式单品询盘在该版本及Phase 2 `a7e16aa2`均已具备事务、幂等、快照、管理历史，生产transport已接线。OEM保存及附件激活后best-effort发SMTP确认，无持久发送账。旧模拟组件不等于当前正式目录在走dummy；客服预填仍是设计。功能开关和部署未验证，既有产品代码保持main原内容。

候选新增范围：`apps/functions/sales-integration/`、`packages/db/src/sales-inquiry-*`及对应tests；现有OEM/单品保存路径只加最小交接，产品schema/限流/批准revision校验继续复用。SDK、Storage或事务代码实施前遵守项目CloudBase contract gate，核对选定基线的已安装包和官方合同。

SG1.1实际只新增独立sales-integration HTTP函数并复用db/media-storage facade、InquiryDetailSchema及public-api的getProductDetail；没有改既有数据库公共接口、询盘保存、报价或SEO代码。接口为受信任后端服务调用，模型不能持有该服务凭据；SG2工具代理仍须把调用限定到任务来源和run。部署时固定一个客户/业务/安装/环境，不按请求切换全局adapter。完整边界及本地结果见[SG1.1验证](../evidence/SG1.1-VALIDATION.md)。

## 目标流程

1. OEM、产品和客服确认表单各自保存原业务事实。只有最终成功才有资格被接入，附件激活失败/回滚不触发。
2. 按同一InquirySubmitted输出，不要求数据库合表。`source_record_id`保留原ID，提交快照不可用当前产品字段覆盖。
3. 保存后发送低延迟通知。独立补偿扫描读取已提交且有效记录，重复投递相同业务身份。外部通知失败不改成提交失败、不要求买家再填。
4. 接入服务持久接受后创建稳定task，确认信/准备/联系人分支独立执行。接入cutover_at之前记录默认只归档，不批量补发。

```ts
// 当前OEM核心形状（03be923c，省略附件补偿）：
project = await createDoc('oemProjects', projectData);
await sendOemConfirmationEmail({ to: email.toLowerCase(), projectId: project._id, contact, company, category });
// 目标：原记录是恢复依据；HTTP通知不是唯一可靠来源。
await notifySales(stableEventFrom(finalizedProject)).catch(recordDeliveryHintFailure);
// reconciler重读最终有效记录，幂等接入；不依赖进程内fire-and-forget。
```

保存与Hermes不共享事务。单品可用原事务扩展可靠交接标记；OEM多步骤以最终有效记录＋附件归属为准。SG1.0发现项目先写、storage附件后激活且补偿可能失败，现有项目行没有最终完成标记；legacy inline附件也不能套用storage元数据。SG1.2必须实现可恢复的完成标记及各分支校验，不能只扫描项目行是否存在。扫描索引及SDK分页合同在实施前单独核对；后台列表offset不充当补扫游标。扫描有重叠窗口、稳定排序及周期完整核对，游标只在接受回执后推进。后台备注／状态更新不算新询盘；若客户团队的运营人员暂停跟进，应走明确的控制接口，不从买家聊天中猜“关闭询盘”，也不再发确认。

## 给Agent的数据

只读这条已授权询盘、批准产品事实及允许附件。联系信息是业务必要资料，直接在私有Sales范围传递；官网公开客服仍无这些私有工具。表单摘要可编辑确认，客服不自动提交、不关联完整conversation id。准备时默认读当前批准产品；既有提交快照保留作历史事实，审核时留存实际依据。报价/交期/MOQ的商业依据有版本，没有依据返回missing，不能让模型填数。

附件以归属检查后下载的bytes提供，限制大小和MIME，审计访问。不给万能DB查询、管理员token、任意URL抓取或公开桶链接。原始询盘不能由Agent直接改写；另建成果/回执关联。

## 实施与验收

- SG1.0：已完成指定提交的路由/开关/落盘/后台核对及OEM完成条件缺口；清单44份文件、80处标记。此步不迁移别人代码，不证明线上实际启用。
- SG1.1：已完成受控读取、按ID查询批准产品及现代OEM私有附件；归属负向、loopback HTTP、stream上限及打包检查已通过。游标补扫和实际派发不在此单元；线上网关与Hermes尚未联调。
- SG1.2：通知、补扫、稳定事件身份、cutover及两种原表适配。

目标测试 `three_confirmed_sources_share_envelope`、`chat_without_submit_creates_no_sales_task`、`oem_attachment_rollback_is_not_dispatched`、`save_succeeds_notification_fails_reconciler_recovers`、`same_submission_replays_same_task`、`admin_note_does_not_resend_ack`、`source_snapshot_survives_catalog_update`、`asset_from_other_client_is_denied`。现有单品快照/幂等测试继续执行，不删除原保护。
