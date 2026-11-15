# SG7 多渠道联系人与维护活动

实施单元：SG7.1、SG7.2。先选一个有明确数据获得方式的渠道，不承诺第一期所有平台实时同步。

## 输入和归并

适配器输出来源、来源记录ID、客户/业务范围、联系人、需求/关系依据及联系资格证据。国际站、环球资源、展会可以先用获授权文件导入；有明确官方接口后再自动化，不用未经确认的爬虫或账号共享补接口。

联系人身份限定客户；同email保留多来源、多业务关系，不按来源覆盖旧关系/退订。导入有batch_id、行级结果和稳定外部记录ID；重复文件/重复事件不得产生重复联系资格或销售任务。归属不明先进入待分类，不拿Channel产品报价主动联系。

```json
{
  "client_id":"client_demo_a",
  "source":"trade_show_import",
  "source_record_id":"batch_demo:row_001",
  "business_line":"gift_oem",
  "relationship":"met_at_trade_show",
  "marketing_permission":"unknown",
  "evidence_ref":"authorized_import_demo"
}
```

## 维护活动

维护有独立目标、受众快照/可核验选择条件、产品范围、邮件和附件版本、发件身份、时间与停止条件。使用Resend适合的群发能力而非给每人新建网站询盘。首次入Resend不自动触发营销，Apollo回复也不自动加入新品推广。

创建内容可复用Sales/内容工厂，批准和执行复用SG5/SG4；受众变化要重审，实际发送前复查退订/禁止联系。对持续变化受众的活动，必须事先批准明确选择规则和排除规则，否则冻结名单后发送。单封销售回复与营销广播不是同一资格判断。

## 实施及验收

- SG7.1：一个渠道adapter＋导入回执＋去重＋来源/业务/许可保留。其余渠道只留接口，不提前实现全部连接。
- SG7.2：一个维护活动模板、受众/内容审批、发送前抑制过滤及结果归档；发送仍需授权。

目标用例 `same_import_does_not_duplicate_contact`、`multi_source_preserves_unsubscribe`、`unknown_business_cannot_receive_channel_quote`、`contact_sync_is_not_marketing_permission`、`audience_change_invalidates_approval`、`unsubscribe_after_approval_excluded_before_send`。
