# SG3.1 独立代码复核

2026-10-29。只读复核独立 Hermes 销售分支的未提交代码，基准提交 `3bbeadada0b8150414a90af15699625c3ce68c52`。本报告不评价其他工作流，没有修改产品源码、Git 或容器。

## 当前复查结论

作者已修复初次发现的三处缺口，并按根agent的后续复核补上空白计价单位/文本事实的拒绝规则。最终独立重跑针对性23项测试全部通过，0失败/0跳过；原先可接受的外部目标、主题与非法MOQ反例现在均拒绝，新增空白字段反例也被拒绝。规范轴和需求轴均无尚未关闭的确认阻断。

这份结论仅覆盖下方最终源码hash对应的SG3.1离线范围。不是已接真实模型、邮件平台或生产权限，也不证明自由文本商务真实性。

## 初次发现与修复经过

初次19项单元测试和8个离线样例均通过，但独立反例发现3处应在本模块收口的缺口。根agent协调作者先补失败测试，再修复；以下保留当时的反例，不能理解为最终版本仍然存在这些问题。

### 规范轴

未发现独立于格式/静态工具的确认规范阻断。代码复用共同严格JSON、现有Scope、Inquiry/MailSnapshot合同与SG2.3 manifest；未增网络、数据库、发送工具或另一套归档库。实际修改范围限Sales准备模块，符合本轮界限。

### 需求轴

1. **P2：模型可自行加入外部回复或草稿目标。** `preparation.py` 的 `_snapshot` 只比较固定 `MAIL_IDENTITY_FIELDS`；共同MailSnapshot合同却允许 `reply_target` 和 `resend_draft_id`。在合法fixture的候选快照中分别加入 `{inbox_id: "other_inbox", thread_id: "other_thread", email_id: "other_email"}` 或 `resend_draft_id: "other_draft"`，当前校验仍接受。这违背候选结果不能决定外部目标的边界。当前没有发送执行，尚不是线上发错信事件；但这些字段不能作为已验证成果往下传。本期未支持时明确拒绝，或由可信context逐项固定。

2. **P2：结构化商务整数只有相等检查，没有类型和范围检查。** 将宿主产品事实 `moq` 及候选对应事实同时设成 `true` 或 `-1`，仍被接受。可信来源表示有权使用这项数据，不代表数据类型永远正确。应为数量/MOQ/交期等已有业务字段规定明确类型和合理下界，至少拒绝bool和负数；不能仅因两端值相同就放行。独立反例使用匹配任务/资料，未绕过客户权限。

3. **P2：邮件主题未进入宿主固定元数据。** 保持 `context.mail_identity.content_sha256` 不变，只改候选 `mail_snapshot.subject`，当前仍接受。当前模块明确不读正文bytes，也不负责复算整封邮件hash，这个范围可以保留；但能在此独立比对的主题不应漏掉。建议将主题加入宿主固定元数据，并断言候选改变主题会拒绝。实际正文bytes与hash一致性仍留给SG3.2及归档/发送边界，不要求本轮扩成完整生成管线。

复现所用代码形状：

```python
context, candidate = fixture()
candidate["mail_snapshot"]["reply_target"] = {
    "inbox_id": "other_inbox",
    "thread_id": "other_thread",
    "email_id": "other_email",
}
validate_preparation(context, candidate)  # 初次复核：接受，应拒绝或精确绑定
```

其余两个外部目标/主题反例同样只改候选字段。MOQ反例则对context中的产品事实副本和候选事实提供同一非法值，证明缺的是语义类型检查；没有据此宣称模型能改宿主context。

## 初次实际执行

命令使用现有项目虚拟环境：

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=deploy/hub .venv/bin/python -m unittest discover -s deploy/hub/tests -p test_sales_preparation.py -v
```

结果19通过、0失败/0跳过。另直接运行 `evaluate_samples()`，8个样例的允许/拒绝、缺项、下一步和无发送权预期均通过。

独立补查的5个边界均被拒绝：bool作为task_id、NaN事实值、101项事实数组、51项缺项数组和主题CRLF注入。这些反例在内存中构造，没有修改测试文件或依赖真实数据库。候选数据深拷贝、上下文/候选相等比较以及已有旧稿保留用例均已阅读；未拿这些测试证明自由文本商务真实性。

初次检查的源码SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| `deploy/hub/sales_flow/preparation.py` | `d0490ae11620f3beed21c3992c07f10bfc2cf930d82110e33a58ff2e4fb2caaf` |
| `deploy/hub/sales_flow/preparation.schema.json` | `38cf60fbcfc09fcc2dd628cb01875eb97479315592fb81122acfaf44b8340785` |
| `deploy/hub/tests/test_sales_preparation.py` | `a15e6d50539edf4eba44e2893d3536ae70f08003038f01d9c8f3084b09877a2f` |

## 修复后的独立复查

- 候选 `reply_target` 和 `resend_draft_id` 均明确拒绝；本期初始准备不支持由模型选外部邮件对象。
- 主题已进入宿主固定元数据，改变主题但复用宿主hash的原反例被拒绝。这个检查没有冒充实际正文bytes的hash复算。
- MOQ、quantity、lead_time_days 的bool、负数和字符串三个反例各自被拒绝；其他合法上下文和资料保持匹配，未靠另一个字段错误制造假通过。
- 独立执行15项内存反例：上述外部目标2项、主题1项、bool任务ID/NaN/超长事实数组3项，以及三个商务字段各3个非法值，均被拒绝。
- 另外独立确认返回结果被修改不会改变候选、原始询盘、证据、manifest或宿主邮件身份；原测试中的旧稿保留用例也通过。
- 第一次修复后曾重跑22项通过；随后根agent另行发现空白计价单位可通过，作者新增回归并在计价单位及已知文本事实中检查去空白后的非空性。最终独立阅读了这两处新增检查，并复跑原15项反例，均拒绝；另构造空白计价单位、product_name、category、payment_terms共4个匹配宿主证据的反例，也均拒绝。
- 同一针对性命令最终重跑23项通过，0失败/0跳过；`evaluate_samples()` 的8个离线样例符合各自预期。这些检查均未调用数据库、模型或外部provider。

最终复查源码SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| `deploy/hub/sales_flow/preparation.py` | `3b5482e7d47689cf16267ed499194dbf476003095db391c874b6fe10de593770` |
| `deploy/hub/sales_flow/preparation.schema.json` | `38cf60fbcfc09fcc2dd628cb01875eb97479315592fb81122acfaf44b8340785` |
| `deploy/hub/tests/test_sales_preparation.py` | `b2f49893df0c37150f0dc1389dde34e5304877204863e69256ca5f40aad2008b` |

## 明确保留的范围

本模块校验宿主提供的当前上下文，不查询实时数据库授权，不证明文件bytes已归档，也不证明自由文本、HTML或报价绝对正确。它没有模型执行、企微回调、批准或发送能力。类型/schema与引用比对通过，只表示这些被检查字段满足当前规则；SG3.2仍须完成实际生成、来源读取、成果固定和内容审核接线。

初次规范轴0项确认阻断；需求轴3项P2缺口，均已修复并复查。最终仍未覆盖真实模型文案质量、全量Hub回归、远端CI和部署；这些由整体交付记录分别说明。
