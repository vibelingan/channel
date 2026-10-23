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

先加入拒绝未知版本、沿用询盘、重复key/unsafe数、Unicode/整数key排序和非JSON对象的失败用例。记录RED后再实现；完成后补实际命令与结果。

### 验证结论

SG0.1离线实现完成。9个TS测试、6个Python测试、54个共享一致性样例、typecheck和生成类型检查通过；两处故意破坏校验均被测试捕捉，修复后重跑。详见[evidence/SG0.1-VALIDATION.md](evidence/SG0.1-VALIDATION.md)。这不是SG0.2授权、真实投递或部署验证。
