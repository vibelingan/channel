# CloudBase 草稿适配器：SDK 合同核对

2026-10-22。此记录核对本轮源码使用的方法，不表示已经连接腾讯云数据库。

## 来源

- [腾讯云官方 SDK 数据库文档](https://github.com/TencentCloudBase/node-sdk/blob/b3c9dda879254ef769adc20aefbb116dd46c5eb7/docs/database/database.md)，已通过 GitHub API 读取固定提交。
- 实际安装：`@cloudbase/node-sdk@3.17.2`、`@cloudbase/database@1.4.3`；原有 `wx-server-sdk@4.0.2` 路径继续使用，没有增加虚构类型。
- MCP 官方站点检索返回 Domain forbidden；本轮没有 Context7，因此对照官方 GitHub 文档、安装包源码和运行时测试。
- `packages/db/src/article-repository.test.ts` 使用实际安装的 Node SDK 和 BSON/EJSON，只替换发请求的传输类。无需云凭证，不是云数据库模拟器或现场验收。

## 实际调用及证据

| 使用点 | 已确认合同 | 本轮检查 |
| --- | --- | --- |
| `runTransaction(callback)` | 自动提交，回调异常回滚；DATABASE_TRANSACTION_CONFLICT 重跑整个回调，安装包默认最多三次重试 | 并发创建、保存竞争、提交失败、重试时重新检查账号 |
| 事务 `doc.get()` | 安装包返回 `{data: object|null}`；旧文档数组描述不能直接套用；错误不等于不存在 | 缺记录、重开、SDK 返回错误、坏记录 |
| `doc.set(data)` | modifyDocument，merge:false、upsert:true、transactionId；data 不含 `_id` | 真实序列化请求、完整替换正文数组、零写入确认拒绝 |
| set 确认 | 旧记录 updated:1；新记录核对 upserted 中的准确编号 | 创建和零写入失败重试，不提前消耗请求号 |
| where/orderBy/limit/field/get | 独立集合查询；按 `_id` 升序，只读 limit+1 条摘要。排序线协议为 EJSON 的 `_id:1` | 多页不重复、投影无正文、排序请求检查 |
| command.gt、RegExp | `_id` 的 $gt 条件；查询先转小写、转义文字，再交给 SDK 正则包装 | 唯一键分页、`[SPECIAL]` 按文字匹配、长中文查询下一页 |
| EJSON | SDK 把数字编码为 $numberInt 等；测试传输用实际 BSON 解码后模拟存储 | revision 和 schemaVersion 读回仍是数值 |
| 云函数 index | 注入 `createCloudBaseArticleRepository(cloudStorageSdk().database())`，初始化不准备资源 | 编译真实 index，在隔离 VM 检查传递的配置，不访问云端 |
| 集合与权限准备 | 复用已有 NoSQL check/create、get/update permission 及读回合同 | 只处理文章三个集合，ADMINONLY，重复运行不重复写，错误权限读回会失败 |

SDK database 初始化会覆盖默认请求类，所以夹具在创建 database 后才替换传输。曾出现的缺凭证失败来自测试夹具的初始化顺序，已修正；没有配置真实密钥让离线测试通过。

## 存储选择

- 编号为 `article-` 加 SHA-256(操作者、requestId)，同时保存原配对和初始内容摘要；去重与草稿在同一文档，不维护事务外请求表。
- 创建/保存在事务里读取当前用户和文章。重试重新检查用户、版本，不包含消息、上传或其他事务外写入。
- 列表不假设事务支持集合查询，在查询前和返回前分别检查当前管理员。摘要单独运行时校验，不捏造空正文。
- 记录仍限 384 KiB、请求仍限 256 KiB。游标上限从 512 调整到 1024 字符，容纳云端编号和合法长查询；非法编码和换查询仍拒绝。
- 独立资源准备函数不运行命令，未加入默认部署资源表，没有创建集合。

## 现场仍要验证

真实事务隔离、客户端私有权限、缺集合返回、实际数据尺寸限制及目标身份范围尚未验证。离线夹具的读集冲突模型只用于制造可重复重试，不能证明云平台采用相同隔离实现。现场前核对目标和授权，再记录创建、权限读回、并发、重试及测试资源清理；本轮不执行。
