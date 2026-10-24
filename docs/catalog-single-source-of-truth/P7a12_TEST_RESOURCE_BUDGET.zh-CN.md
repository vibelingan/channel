# P7a12：本地服务测试的文件并发预算

## 运行问题与证据

eaa55b8原全仓命令完成7810项：7805通过，3失败，2个既有跳过。业务失败是Admin冷PNG continuation未在本轮完成媒体准备、raw正式fixture的首张PNG像素解码返回retry/timeout；另一个失败计数是raw测试父项。production decoder仍是原5秒上限。本机availableParallelism=10，local-server有63个测试文件，原命令`tsx --test src/**/*.test.ts`允许多个无关的独立数据库、XLSX和native decoder初始化同时争抢本机资源。

相同源码、相同外部临时盘、相同断言和时限，定向两文件4/4通过：Admin1.431秒；raw完整图片解码42毫秒。该对照支持资源竞争假设，不单凭一次定向通过就认定全仓已通过。全量受控文件并发的结果仍需独立验证。

## 数据与技术约束

这里只调整测试进程的文件调度；产品JSON、来源、价格、分类、发布、5秒像素时限、20秒worker预算和120秒客户端边界均不改。每个测试文件中的真实四槽批次、Promise.all竞争、100商品、ACK故障、取消与恢复仍按原用例执行。Node的文件并发数不能代表产品的用户并发数；实际业务并发必须由这些原用例显式制造和校验。

## 选择与翻译

采用站点测试现有的两文件并发模式：

```json
"test": "tsx --test --test-concurrency=2 src/**/*.test.ts"
```

改动仅在local-server/package.json。拒绝增加像素时限、seed伪造保护回执、跳过raw解码、把mediaReady=true改成允许false或通过自动重试抹掉失败。也不为使测试通过而改动本地JSON适配器缓存或生产worker。

## 风险、review与验证

风险是文件间隐式共享可能被调度变化掩盖；各文件原独立临时DB/媒体目录和进程仍保留，文件内显式竞态不降并发。根pnpm test再次完整运行，同一源码完成类型、lint、SDK与构建；核对原7810分母和原2个跳过，失败记录保持。此前156项生产构建全流程对应的应用源码与本MIU字节相同，因此不为纯测试配方再次重跑该套并修改任何用例。后续云上真实流程与性能仍是单独门槛，fullDeliveryReady=false。

已实际审查local-server/package.json、site/package.json、raw-catalog-fixture.test.ts、catalog-operation-continue.test.ts与media-storage/pixels.ts。文案将“图片解码器坏了”改为“全仓时超时，定向原时限通过，受控全量待验证”，保留根因证据边界。
