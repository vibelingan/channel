# Alibaba 首次真实同步事故复盘

日期：2026-09-03  
环境：CloudBase Test，`diversity-123-d9grnqfux221323bb`  
最终部署版本：`0c54e96041939a84a4a2e0eb9b1dad677054dfdd`  
成功全量任务：`full-2026-09-03T07-28-56-187Z`

## 如果在面试里讲，我会先给这个结论

这次问题不是一个简单的“接口地址写错了”，而是首次接通真实供应商后，四层问题按依赖顺序暴露：云函数启动 wiring 不完整、Alibaba 业务接口协议选错、真实响应的序列化形状与文档示例不一致，以及恢复后的旧错误没有从管理页清掉。

我没有一看到失败就反复点同步，也没有绕过安全闸门直接写产品表。我的处理方式是先判断请求走到了哪一层，再为这一层保留证据，修复后只推进一层。最后用真实全量数据证明：1074 个供应商商品和 3801 条报价已经落到我们自己的数据库，1702 份原始响应进入私有对象存储，业务键没有重复，现有 7 个已发布商品也没有被误改。

这次还有一个需要诚实承认的过程问题：OAuth 放在云端完成是合理的，但协议、签名和响应合同不应该等到云端拿到真实 token 后才开始验证。安全边界是对的，验证顺序不够好。

## 场景和我们必须守住的边界

这个功能不是简单抓一份商品 JSON。一次同步会经过：管理后台发起、云函数读取加密 token、调用 Alibaba、先保存原始响应、解析和标准化、写供应商镜像与报价、通过隔离门，最后才可能更新已明确关联的 Channel 商品。

因此我在调查前先冻结了几个边界：不把 access token、refresh token、签名、JWT 或完整 HAR 放进日志；不为了制造测试数据去修改 Alibaba 店铺；不批准被隔离的旧任务；没有分类映射和显式 link 时，不允许同步自动改写或发布现有商品。

最初的 browser-agent handoff 是一份只读 smoke-test 说明。它要求遇到第一处失败就停下来交证据。后来用户明确授权实施和部署后，我们才进入修复阶段。也就是说，文档是调查背景，不是越过用户授权的执行指令。

## 为什么 OAuth 最初放在云端，而不是本地

这部分要分开评价。

把 OAuth callback 放在云端是正确选择。Alibaba 要求应用已经上线，回调地址必须与登记地址一致；客服也确认当时的线上回调地址匹配。token 交换后，access token 和 refresh token 会立即使用 CloudBase 环境中的密钥加密并写入服务端数据库。整个过程中浏览器、终端输出和报告都不需要看到 token 明文。

如果为了本地同步把 token 从云端复制到开发机，就会扩大秘密的暴露面：本地 shell history、环境变量、调试输出、崩溃转储和第三方工具都可能成为新的泄露位置。并且本地环境不能完整复现 CloudBase 的数据库事务、云存储身份和函数运行权限，所以即使本地 API 调通，也不能证明线上持久化链路正常。

但这里不能用“安全”替整个流程开脱。我们真正做得不够好的地方，是把两个问题混在了一起：

- OAuth 和 token 应该留在云端；
- API 协议、签名算法、URL 组成和响应解析可以在没有真实 token 的情况下本地验证。

后者本应更早完成。正确的顺序应该是：本地用非秘密 golden vector 验证 TOP 签名；用官方 SDK 做差分验证；用脱敏 fixture 覆盖文档形状和真实序列化形状；然后才把 OAuth callback 部署到云端，用一个返回脱敏结果的 probe 做首次真实调用。这样 token 仍不离开云端，但绝大部分确定性错误会在部署前被发现。

所以我的结论不是“应该把 OAuth 搬到本地”，而是：云端 OAuth 的安全决策是对的，cloud-first debugging 的范围过大。我们保护了 token，却把本来可以本地消除的协议风险拖到了真实环境。

## 事故是怎样一层层展开的

### 第一层：任务启动了，但第一份原始响应写不下来

最早的任务是 `incremental-2026-09-03T03-51-21-454Z`。管理页显示任务存在，说明浏览器到后台、run 创建和基本调度已经工作；错误是 `page-failure:raw-failed`，说明失败点在“先保存原始响应”这一层，而不是 OAuth 本身。

代码检查发现 `alibaba-catalog-sync` 的入口只执行了数据库的 `initCloudBase` 和 `setAdapter`，没有像 `admin`、`public-api` 那样设置媒体存储 adapter。部署只是把代码和配置放进云函数；每次冷启动仍是一个新的 Node 进程，共享包里的 adapter 必须由这个函数入口显式注册。未注册时，`mediaStorage().putObject()` 会在第一份 Alibaba 响应到达后失败。

这不是漏走 upload intent。Upload intent 是浏览器把用户文件直接 PUT 到 COS 时使用的短期单对象授权。这里的数据已经在服务端函数里，正确路径是服务端 CloudBase SDK 的 `uploadFile`，由 `mediaStorage().putObject()` 统一封装。

修复提交是 `30b46c4`。同时增加了冷启动回归测试：导入真实函数入口后，执行第一笔 `storeRawPayload`，确认对象写入 adapter 和 hash-addressed metadata 写入都发生一次。这样以后即使函数仍能导出 `index.main`，只要漏掉 storage wiring，测试也会在第一笔原始响应路径上失败。

### 第二层：存储修好后，Alibaba 拒绝了业务 API 路径

原始响应能保存后，错误前移到了 `InvalidApiPath`。这其实是有效进展：OAuth token、函数出网和原始存储已经不是当前阻塞点，失败明确发生在 Alibaba 网关路由。

我们先尝试了文档中展示的点号 REST 方法路径，提交为 `6073559`。真实调用仍被拒绝，证明问题不只是把斜杠改成点号。这一步是错误的中间判断，应当保留在复盘里，而不是事后删除。

用户提供的 2026-08-20 客服截图其实已经给了关键边界：

1. token 接口走 `POST https://open-api.alibaba.com/rest/auth/token/create`；
2. 商品接口统一走 `https://open-api.alibaba.com/sync?method=alibaba.icbu.product.list`，使用 TOP 协议；API Reference 里的 REST 风格路径只是展示形式。

也就是说，OAuth 和业务 API 本来就不是一套 transport。项目此前把“新域名”误等同于“所有接口都走 GOP REST”，并且曾因主机名判断把已经实现过的 TOP 客户端整体回退。这是这次最核心的工程判断错误。

为了避免只凭截图改代码，我又走了一条独立验证路线：下载 Alibaba 官方 Java SDK，检查商品调用示例和 `TopExecutor` 的实际行为，确认它请求 `/sync?method=<apiName>`，使用 `method/app_key/v/timestamp/format/session/sign_method`，并对排序后的非空参数做 HMAC-SHA256。随后用官方 SDK 和 TypeScript 实现计算同一组非秘密参数，两边得到相同签名。

最终修复 `f5a10c8` 只让 ICBU 业务方法走 TOP；OAuth token create/refresh 仍保留已经成功工作的 GOP REST。这避免了为了修商品接口而破坏授权链路。

### 第三层：接口成功返回，但列表被解析成空数组

TOP transport 生效后，手工增量任务 `incremental-2026-09-03T07-07-47-411Z` 成功完成，但最近四小时没有商品。这个结果只能证明 OAuth、商品列表请求、原始存储和 checkpoint 工作，不能声称详情和落库已经端到端通过。

为了不修改 Alibaba 店铺制造测试数据，我们让现有 full-sync 机制到期，启动受控全量任务。第一次全量响应报告 1074 个商品，但代码得到的 items 是空数组。原始响应显示真实结构不是文档示例里的直接数组，而是：

```text
products.alibaba_product_brief_response[]
```

旧解析器只接受 `products[]`。如果没有保存原始字节，这里很容易被误判为“店铺没有商品”。修复 `d07fc20` 增加了 live TOP wrapper 解析和错误 envelope 测试。旧 run 被明确标记为 `superseded-after-live-list-contract-fix`，保留审计后重新开始，没有删除或伪装成成功。

### 第四层：列表有数据了，但图片和价格不完整

新的全量任务开始写入真实商品。抽查数据库发现标题、描述和分类存在，但所有 `sourceImageUrls` 为空，报价多数是 `unavailable`。这说明数据确实落库了，但字段合同仍不完整，不能因为“有行数”就宣布成功。

真实详情响应再次暴露 Java-to-JSON wrapper：

- 图片在 `main_image.images.string[]`；
- SKU 在 `product_sku.skus.sku_definition[]`；
- 库存在 `inventory_dto_list.product_inventory_dto[]`；
- 阶梯价在 `bulk_discount_prices.bulk_discount_price[]`；
- sourcing 商品的币种和 FOB 区间位于 `sourcing_trade`。

修复 `074a5cb` 为这些形状增加统一 unwrap，并补齐图片、库存、MOQ、FOB 区间和 SKU 阶梯价的解析测试。这里保留了一个重要的 fail-closed 规则：如果 Alibaba 的 wholesale 响应给了价格却没有明确币种，我们不猜它是 USD，报价仍标记为 `unavailable`。错误币种比缺失价格更危险，因为它会产生看似合理但实际错误的销售价格。

同样，旧任务被标记为 `superseded-after-live-detail-contract-fix`，然后从干净 checkpoint 重跑，避免同一个 run 混用两套解析语义。

### 第五层：供应商临时错误和控制面超时不能被误判成同步失败

最终全量过程中，Alibaba 两次返回：`ISP / code 15 / Remote service error`。这两份 206 字节错误响应都先进入私有对象存储，checkpoint 没有弹出失败的时间窗；后续切片重试同一页并成功恢复。

CloudBase 控制面的同步调用还多次在接近 60 秒时报 network timeout，但云函数仍在后台继续运行。我们没有立即重复触发，而是读取 run、checkpoint 和 lease：只有确认计数和 `updatedAt` 已前移、租约释放后才发下一片。有一次紧跟调用得到 `lease-busy`，也验证了并发保护没有让两个 worker 同时写 checkpoint。

这一区分很重要：控制面没有拿到响应，不等于业务函数没有提交；反过来，控制面返回 200 也不等于数据已经落库。最终判断必须来自持久化状态。

过程中还发现 `errorSummary` 会保留已经恢复的临时错误，导致 completed run 的 Errors 栏仍可能显示旧故障。`0c54e96` 增加了“先遇到 API error、续跑成功、完成后清空错误”的回归测试和修复。运行中仍保留错误供观察，只有同一 checkpoint 真正完成后才清空；原始错误证据不会删除。

## 最终验收结果

干净全量任务 `full-2026-09-03T07-28-56-187Z` 于 `2026-09-03T08:16:13.530Z` 完成，checkpoint 游标提交，active run 清空，lease 正常释放。管理页在真实 Chrome 会话中显示 `completed`，Errors 为 `—`，OAuth 仍为 `Connected — channeltec`。

数据库和存储的精确结果如下：

| 验收项 | 结果 |
|---|---:|
| Alibaba 目录返回的唯一商品 | 1074 |
| 我方唯一 source ID / 唯一业务键 | 1074 / 1074 |
| 有标题、描述、分类、至少一张图片的 source | 1074 |
| Supplier offers | 3801 |
| Active offers | 3672 |
| Active USD tiered offers | 1808 |
| Active unavailable offers | 1864 |
| 已停用的旧 `@product` offers | 129 |
| Offer 业务键重复 | 0 |
| 悬空 source 引用 | 0 |
| 本轮 raw payload metadata | 1702 |
| `product.list` / `product.get` raw payload | 400 / 1302 |
| 缺失存储指针、hash 不一致或状态非 stored | 0 |
| parse / raw / unsupported-currency failures | 0 / 0 / 0 |

1302 次详情处理大于 1074 个唯一商品，不是重复数据冲突。时间窗二分使用包含式边界，桶在预算中途耗尽时会完整重读；确定性 `_id` 让这些重复调用收敛到同一 source 和 offer。我们把“调用次数”和“唯一业务行”分开统计，最终唯一键重复为 0。

另外，129 条 inactive `@product` offer 是详情 wrapper 修复前生成的产品级占位报价。新的 SKU 详情到达后，它们被正常停用而不是物理删除，既不会参与定价，也保留了事故审计。

当时数据库中没有 Alibaba category mapping，也没有 product link。因此同步只写供应商镜像、报价和原始证据，没有自动创建商品草稿；原有 7 个已发布商品数量和 Alibaba 字段均未变化。这不是同步没存下来，而是产品写入安全门按设计工作。

## 测试和部署证据

最终代码增加了六组有明确故障对应关系的提交：

| 提交 | 作用 |
|---|---|
| `30b46c4` | 冷启动时初始化 raw-payload 云存储 adapter |
| `6073559` | 点号 REST 的中间尝试；由真实 `InvalidApiPath` 证明仍不正确 |
| `f5a10c8` | ICBU 业务方法切换到 TOP `/sync` transport |
| `d07fc20` | 解包真实商品列表 wrapper |
| `074a5cb` | 解包图片、SKU、库存、sourcing 和阶梯价 |
| `0c54e96` | 成功恢复后清空旧 errorSummary |

部署后运行了全仓测试、TypeScript typecheck、Biome lint 和 CloudBase SDK contract verification。部署环境的 health endpoint 返回最终 release `0c54e96041939a84a4a2e0eb9b1dad677054dfdd`。

本地测试机当前是 Node `v25.6.1`，CloudBase 函数运行时是 `Nodejs20.19`。测试命令中的 `NODE_OPTIONS=--no-webstorage` 只是关闭本地 Node 25 自动暴露的 Web Storage，规避宿主环境中无效 `--localstorage-file` 的兼容警告；业务代码没有使用 `localStorage`，远端运行时也没有因此变成 Node 25。

## 我会怎样改进下一次首接供应商的流程

第一，收到供应商支持回复后，把每一条协议边界转成可执行测试，而不是只更新 setup 文档。比如“token 用 REST、业务 API 用 TOP”应直接变成两个 transport contract tests。

第二，把首次真实接入拆成四个可单独验收的阶段：非秘密签名和 URL 组成、本地 fixture 解析、云端 OAuth 与脱敏 probe、最后才是持久化 full sync。任何阶段失败都不能用后一阶段的成功来掩盖。

第三，冷启动测试不能只验证导出函数存在。所有全局 adapter、SDK client 和加密 provider 都应至少走一次它们服务的第一条真实调用路径。

第四，错误观测要区分浏览器、控制面、云函数、供应商和数据库五层。Chrome Network 只能证明管理页到我方后台；云函数到 Alibaba 必须依靠服务端调用、供应商 request ID、raw payload 和 checkpoint。没有 CLS 时，不能假装拿到了历史 stack trace，应明确证据缺口并用可持久化证据重建。

第五，成功标准必须包含数据质量和不该发生的写入。只看到 run completed 不够；还要验证唯一业务键、字段完整率、原始证据、悬空引用、已发布商品是否变化，以及未知币种是否安全降级。

## 三分钟口述版

我处理过一次 Alibaba 首次真实同步事故。表面上管理页只有一个 `raw-failed`，但最后发现是四层问题串在一起：云函数冷启动漏了 storage adapter，业务 API 错用了 OAuth 的 REST transport，Alibaba 真实 JSON 又比文档多了 Java list wrapper，最后管理页还会残留已经恢复的错误。

我先把链路按浏览器、函数、供应商、原始存储、标准化和产品写入拆开。第一步通过 run 已创建但没有 payload 确认失败在原始存储，补齐 server-side storage wiring；第二步从 `InvalidApiPath` 追到客服回复和官方 Java SDK，确认 token 走 REST、商品走 TOP `/sync`，并用官方 SDK 对同一个非秘密向量做签名差分；第三步靠已经保存的原始 JSON 发现列表、图片、SKU、库存和阶梯价的实际 wrapper，逐层加 fixture 和解析测试。

最终全量跑完 1074 个唯一商品和 3801 条报价，1702 份原始响应进入私有对象存储，业务键重复和悬空引用都是 0，已有 7 个已发布商品没有变化。过程中还遇到 Alibaba `ISP code 15` 和 CloudBase 控制面 60 秒超时，我用 checkpoint 与 lease 区分了“调用端没拿到响应”和“函数没有提交”，没有盲目重试。

复盘下来，OAuth 放云端是对的，因为回调地址和 token 加密边界都在服务端；不够好的是协议验证也被拖到云端。下一次我会保留云端 OAuth，但在部署前完成 TOP 签名、transport 和真实响应 fixture 的本地合同测试。
