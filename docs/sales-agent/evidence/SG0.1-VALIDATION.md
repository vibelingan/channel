# SG0.1 实施与验证

2026-10-23。设计提交77876aeb先推送后才开始本单元。新增sales-contracts，未改官网询盘业务路径、未连接客户账号、未修改Hermes工作区。

## 已完成

- 复用原询盘schema/样例，唯一运行源放入packages/sales-contracts；原文档路径为相对符号链接。
- InquirySubmitted、MailSnapshot、ControlCommand、Approval、SalesRunContext五种1.0规范；TypeScript类型从同一schema生成，Python同源校验。
- 严格原始JSON解析、双语言同一规范化/哈希规则；拒绝重复键、unsafe整数、浮点及无效Unicode。
- 无网络fake：防御性复制、同key同payload重放、不同payload冲突；接受前失败和接受后超时。
- 独立聚焦CI，仅跑合同检查，无部署或真实邮件动作。

## 本地验证

| 命令 | 结果 |
|---|---|
| pnpm --filter @vibelingan-channel/sales-contracts test | 9个测试通过 |
| 同包typecheck | 通过 |
| 同包test:python | 6个测试通过 |
| 同包test:conformance | 54个共享输入，TS/Python接受结果与固定摘要一致 |
| 同包check:generated | 通过，生成类型无漂移 |
| 新增手写TS/MJS的Biome check | 通过 |
| filtered install --frozen-lockfile | 通过；原有importer及snapshot保留，不升级Astro peer依赖 |

破坏性校验演练见[SG0.1-mutation-check.json](SG0.1-mutation-check.json)：改为UTF-16排序及移除重复键检查，两种修改都使对应测试失败；随后还原并重新验证。首次类型检查发现两处无法收敛的undefined，已修复；独立复核发现邮箱换行、日期、空白字符和深度边界差异，已加入共享反例并全部通过。

源码、调用关系和边界经只读独立复核，无阻塞项。按simplify检查移除不必要断言、保持职责分离；按humanizer检查文档，将“邮件已发送”统一明确为假服务的“模拟接受”，不把数据校验说成授权或投递证据。

## 边界与下一步

校验通过不代表客户隔离或有权发送；真实正文/附件bytes、地址跨类别冲突、审批/发送状态持久化尚未实现。SG0.2及后续实现模块仍planned。SG0.1完成提交并推送后才开始SG1.0代码盘点。

提交595a48495033b538d6393def52f8c2294a4325bc已在origin/feat/sales-agent-modular-design；[远端contracts工作流](https://github.com/vibelingan/channel/actions/runs/39882624469)为completed/success，headSha与该提交一致。该工作流验证合同包，不部署官网或连接邮件服务。
