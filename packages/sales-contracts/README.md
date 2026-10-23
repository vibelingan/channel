# Sales 共同数据合同

SG0.1：五种版本1.0的数据校验、精确JSON摘要和无网络假邮件服务。`schemas/`是运行规范的唯一来源；TypeScript类型由它生成，Python读取同一目录。设计中的询盘schema/样例路径通过相对符号链接保留。

```ts
import { parseContract, hashCanonicalJson } from '@vibelingan-channel/sales-contracts';
import { FakeMailProvider } from '@vibelingan-channel/sales-contracts/testing';

const inquiry = parseContract('inquiry', rawJson);
const digest = hashCanonicalJson(snapshot);
```

支持询盘、邮件版本元数据、控制命令、批准记录及运行上下文。`validateContract`接收已解析对象，校验并返回数据副本；HTTP原始JSON应调用`parseContract`，在重复键和数字精度丢失前检查。未知版本或附加字段拒绝；不转类型、不填默认、不删字段。

冻结的JSON规则：安全整数范围±9007199254740991；原始整数不接受浮点或指数写法；负零转0。按Unicode code point键序逐字段序列化，数组顺序保留，不做Unicode normalization。拒绝重复解码后的键、孤立surrogate、getter、稀疏数组、循环及非JSON对象。最多262144字节，根值深度0、最大值深度64。

为保持双语言一致，邮箱目前限定ASCII addr-spec及DNS域名，不支持quoted local-part/EAI；所有邮箱显式拒绝CR/LF。时间限定0001到9999年、UTC大写T/Z、秒00到59及最多6位小数，不接受闰秒和offset。源适配器之后应明确转换为这个共同格式，不能改变原询盘快照事实。

本包验证数据形状，不授予操作人权限，不核验真实正文/附件bytes，也不检查发送前的地址跨类别冲突。`content_sha256`形状合法不代表内容已验真。客户连接和授权属于SG0.2，冻结/审核/发送属于后续模块。

Fake只在实例内存模拟草稿与接受结果，返回`mode: fake`、`simulated_accepted`。同key同payload重放，不同payload冲突；可模拟接受前失败和接受后超时。它不读取SMTP/Resend凭据、不联网、不代表已投递或生产持久幂等。

## 验证

```sh
pnpm --filter @vibelingan-channel/sales-contracts... install --frozen-lockfile
python3 -m venv packages/sales-contracts/.venv
packages/sales-contracts/.venv/bin/python -m pip install -r packages/sales-contracts/python/requirements.txt
pnpm --filter @vibelingan-channel/sales-contracts check:generated
pnpm --filter @vibelingan-channel/sales-contracts typecheck
pnpm --filter @vibelingan-channel/sales-contracts test
pnpm --filter @vibelingan-channel/sales-contracts test:python
pnpm --filter @vibelingan-channel/sales-contracts test:conformance
```

Python命令优先使用`SALES_CONTRACTS_PYTHON`，然后本包venv，再使用python3。CI使用自己的Python环境。`fixtures/conformance.json`对同一输入同时检查TS/Python的接受/拒绝和固定摘要。修改schema后运行`generate`并提交生成类型；`check:generated`检查漂移，不自动改文件。

实现依据：[Ajv2020](https://ajv.js.org/json-schema.html)、[JSON解析visitor](https://github.com/microsoft/node-jsonc-parser)、[类型生成器](https://github.com/bcherny/json-schema-to-typescript)。依赖实际版本以lockfile为准。
