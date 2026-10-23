# 分模块实施记录

## SG0.1 共同合同与假服务

状态：离线实现与验证完成。设计文档提交77876aeb已先推送origin/feat/sales-agent-modular-design。本单元不连接客户账号，不开放HTTP路由，不实现SG0.2授权。

### 当前问题和数据归属

现有inquiry.schema.json只用于设计检查，TypeScript/Python还不能共用运行合同。现有AI聊天DTO与金额canonicalNumber处理不同业务，不能拿来校验销售草稿或精确批准摘要。

```ts
// 当前只有设计schema与文档类型；没有sales运行校验入口。
// 目标：先校验安全JSON，再按唯一schema校验，返回类型和数据副本。
const inquiry = parseContract('inquiry', rawJson);
const digest = hashCanonicalJson(immutableSnapshot);
```

数据均为合成fixture；schema按1.0固定，真实客户数据、长期任务存储和授权不在此单元。输入限定安全整数、合法Unicode和有限大小/深度，拒绝重复JSON key，防止两种语言看到不同内容。

### 选择及技术限制

复用已有询盘schema及样例，将唯一运行源放入sales-contracts；文档引用该源。TypeScript使用Ajv2020，Python使用jsonschema读取同一schema；TypeScript类型由schema生成并检查漂移。精准摘要使用逐字段序列化，不能先排序对象再JSON.stringify，因为整数形key会被再次重排。

无网络的fake只模拟草稿、接受和超时。实例内同key重放/不同payload冲突用于恢复测试，不代表生产鉴权、持久化或全局一次发送。不能复用现有SMTP包作为fake。

### 测试和执行

先加入拒绝未知版本、沿用询盘、重复key/unsafe数、Unicode/整数key排序和非JSON对象的用例。最初执行因缺少tsx路径而失败，不能把它算作业务断言已观察到RED；完成后通过两次故意破坏校验来证明测试能捕捉对应错误。

### 验证结论

SG0.1离线实现完成。9个TS测试、6个Python测试、54个共享一致性样例、typecheck和生成类型检查通过；两处故意破坏校验均被测试捕捉，修复后重跑。详见[evidence/SG0.1-VALIDATION.md](evidence/SG0.1-VALIDATION.md)。这不是SG0.2授权、真实投递或部署验证。

提交595a48495033b538d6393def52f8c2294a4325bc已推送origin/feat/sales-agent-modular-design，远端[contracts工作流](https://github.com/vibelingan/channel/actions/runs/39882624469)成功，headSha一致。本单元通过后才开始SG1.0。

## SG1.0 询盘源码核对

状态：指定提交的源码审计完成；未修改官网业务实现。开始于595a4849，范围仅为路由、开关、落盘、后台、附件完成条件及复用选择。

### 选择与后续影响

选main 404d1a25为后续Channel实现参考、Phase 2 a7e16aa2为客服设计参考。正式单品询盘来源dbf802b2已同时在两者中；两者各有独有提交，不能将Phase 2当主线超集。销售worktree仍保留原起点，本轮没有merge、rebase或复制产品代码。

查明首页/OEM走真实submitProject，正式单品走public quote事务及专用后台；旧modal的模拟代码存在不代表当前正式目录仍用它。客服Phase 2预填尚未实现。OEM项目先保存、storage附件后激活且回滚可能失败，不能仅凭项目行存在就补扫派发。详细依据见[SG1.0-BASELINE](evidence/SG1.0-BASELINE.md)。

### 检查及可重复证据

新增源码清单固定44份文件、7组覆盖和80处行标记；check_source_snapshot.py核对Git对象、哈希、行号、共同祖先及6份跨分支相同文件。它只检查源码身份，业务结论另经跨文件只读复核。未运行该固定主线的产品测试，未读线上配置及客户数据。

本轮实际审阅SG1.0-BASELINE、modules/SG1-channel、GAP-AND-REUSE、README、handoff及两份实施证据。具体措辞修正：把“较新Phase 2有正式单品询盘”改为“main和Phase 2均已具备”，把“走通”明确为“指定提交的源码接线核对”，避免暗示已完成线上测试。核对了提交关系、正式/legacy调用链、OEM激活顺序、后台不发邮件提示及两个后端开关。

独立只读复核另指出两处表述过宽，已按main handler:1120,1145-1158,1169-1170改正：旧inline只推导MIME而非同等类型匹配拒绝；OEM仅存Number转换结果，不能承诺恢复数量原文。复核者独立运行源码检查通过，未修改文件。

SG1.0是源码审计，没有新增产品行为，不对生产代码进行RED/GREEN或声称旧产品测试已执行。通过范围为源码清单、文档及schema检查；最终命令和结果记录在SG1.0证据中。其余21个单元保持未实现，SG1.1仍依赖SG0.2授权及选定主线整合。

最终检查通过：源码44份/80处/7组、6份跨分支同源；23单元DAG、文档链接、原稿哈希及schema样例通过；临时篡改源码哈希被检查器拒绝。具体命令和结果见[SG1.0-validation.json](evidence/SG1.0-validation.json)。原Channel与Hermes分支、本地HEAD及既有未提交文件保持原样；本轮仅更新销售目录中的文档和核对脚本。
