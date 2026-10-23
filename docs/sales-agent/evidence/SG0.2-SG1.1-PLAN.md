# 客户授权与资料读取：本轮实施边界

2026-10-23。用户已授权继续SG0.2、SG1.1，并要求与pricing、SEO worktree兼容。顺序为SG0.2验证、提交、推送，再开始SG1.1；不启动询盘自动派发、邮件发送或其他人的工作。

## 两步分别完成什么

SG0.2在既有sales-contracts中加入唯一的服务器ClientBinding配置schema、连接认证及动作授权。配置读取由服务器提供，每次调用重新读取，停用客户、撤销连接、控制版本变化均使后续调用失效。连接凭据从服务器引用解析，使用恒定长度摘要比较；不把secret或全部客户连接交给模型。生成Agent即使被错误授予approve，也不能批准；操作人必须在固定客户映射中。调用限定客户、业务、安装、runtime、environment和control_epoch，不提供默认客户。

SG1.1新增独立的sales-integration入口，使用上述认证，受控读取已有询盘、批准产品资料及经归属校验的附件bytes。不改OEM/RFQ保存、报价计算、公开客服或后台页面。SG1.2尚未实现，OEM没有可靠完成标记时不能伪称已完成自动交接；历史资料需明确区分只读可查看与有资格自动派发。模型不能提供集合名、任意URL、管理员token或存储对象ID来扩大读取权限。

共同schema继续作为TypeScript和Python的数据规范。SG0.2的服务器授权实现首先由Channel私有入口调用；Hermes平台接线及runtime/files隔离依赖后续SG2，不能把本地策略测试说成线上Hermes已隔离。

## 复用与兼容证据

| 参考工作区 | 本轮开始核对的提交 | 接口影响及处理 |
|---|---|---|
| Channel main | 404d1a257722175dcd70916e3f92ec6763fa0243 | SG1.0已选定的实现参考。只整合到销售分支；不切换原工作区 |
| pricing：feat/catalog-alibaba-price-tiers | 333c0240bac5a6aa8f61868f7519ab05f8b84610 | catalog-quote开始使用resolvePublicVersion；publication扩展priceSummary、facts上限。销售不复制价格计算或写回批准资料；保存的询盘snapshot仍为当时依据 |
| SEO：feat/seo-foundation | cd4cd2b9527344799732d819b3306ee51e6e6c98 | 新增静态产品路径和文章链。销售接入不绑定页面URL、不修改路由、公开投影或SEO部署工作流 |

上述远端SHA已用git ls-remote确认。pricing与SEO分支继续只读；不清理它们的未跟踪文件，不合并它们的未完成提交。与main的预合并仅发现pnpm-lock.yaml冲突，可按main现有依赖加回sales importer机械处理；如出现业务规则或归属无法兼容，停止该单元并报告，不替另一工作流作决定。

## SG0.2的数据及检查

服务器registry保存客户绑定、连接ID/凭据引用、actor类型与动作集合，不存真实secret。authenticated连接确定主体；请求中的client_id等仅做一致性检查。绑定资料可以部署在服务器私有配置，生产加载必须每次获取最新授权，不使用进程内永不过期的副本。

核心调用形状：

```ts
await access.execute({ connection_id, bearer_token, action, scope }, async (grant) => {
  // grant只含这次获准的客户和业务范围，不含其他客户和凭据。
  return readFromBoundInstallation(grant);
});
```

风险及先写的测试：正确A/B主体能分别访问自己的canary；A不能读/发送B；未绑定/错环境/错业务/错runtime/错版本均拒绝；撤销和kill switch在下一次调用生效；Agent不能审批；只有对应操作人可控制；错误或空凭据不调用资料/发送工具；连接或安装身份重复的配置拒绝。拒绝配置错误与请求越权时都不输出secret或客户资料。

撤销阻止后续执行，不承诺撤回已经提交给外部平台的请求。暂停/接管的任务持久状态及在途发送对账仍由SG5实现。

## 真实测试必须独立完成

本地fake只验证程序行为。真实验收须先记录线上HermesInfra的部署提交、实际调用链、客户runtime/连接、Channel环境以及测试邮箱和负责人；不能直接把本地ff066b12或本轮main当线上事实。分三层留下独立结果：

1. 离线：A/B canary、撤权、无网邮件fake、资料/附件越权及接口合同。
2. 隔离环境真实服务：用部署后的Channel与Hermes连接实际认证/查询/附件读取；用隔离Resend账号和测试收件人验证草稿及投递。实际To/CC/BCC由服务器白名单限制。
3. 获批的线上小范围联调：核对线上版本与配置后，用独立合成任务测试；记录真实provider ID、收到的邮件及附件，演练撤权、暂停和失败恢复。客户真实发送另需业务批准。

后两层需要相应模块和环境就绪，不能因前两项开发完成而标为通过。本轮不部署、不调用真实发送，不在仓库保存真实密钥。
