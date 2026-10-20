# P6d：来源图片客户端的运行时兼容性

P6c 扩大到 Node20 原源码检查时，两个本地导入流程因 undici 8.10.0 导入失败，报 webidl.util.markAsUncloneable is not a function。新增最低运行时契约红测在 Node24 也能检出：依赖要求 Node >=22.19，超过项目声明的最低 22.12，CI 的 22.13 同样不足。Node20 直接加载原媒体测试也在任何抓取前失败。

影响范围按实际消费者确认：catalog-import-media 位于 Admin 包，但由本地 Dianxiaomi CLI、详情 CLI、预览 seed 和测试消费。云端 index→handler 没有导入该模块，当前 Admin bundle 中 undici 出现次数为 0。不能把包目录误当作线上发布路径，也不能据此解释原三件时钟的属性错误。

只把 Admin 的直接依赖精确锁到 undici 7.30.1；该版本 2026-10-15 发布，支持 Node >=20.18.1，7.x 仍在维护，已对照[官方兼容表](https://github.com/nodejs/undici#long-term-support)、[该版本 manifest](https://github.com/nodejs/undici/blob/v7.30.1/package.json)与实际安装包。锁文件仅此依赖的 importer、完整性、engine 与 snapshot 变化。两次 add 在重新解析无关依赖时停止，使用官方 registry 的精确版本/完整性保留其余解析；最终 pnpm frozen install 成功，783 项供应链检查通过，仅 +1/-1。没有绕过策略或运行新增安装脚本。

来源媒体继续使用同一包的 Agent 与 fetch，避免与 Node 内置 fetch 的私有协议混用。新增真实本地 socket 取回完整 bytes 的测试；原 DNS 重绑定、地址拒绝、每跳重定向、超时、字节/MIME/尺寸限制测试保留。Node20 媒体 31/31，Node24 运行时契约 6/6，Admin 类型与 SDK gate 通过，零跳过。另以实际生产 fetchSourceImage、真实 TLS/DNS 和默认验证器，从 GitHub 官方 CDN 读取 7249 字节 PNG（560×560），SHA 6d6ef7bede0416b6ebee2014be5852576dbce89235fe16ea5c44ed01bd522132；没有注入 fetch 或地址解析器。首个命令因 TSX CJS 导出桥接方式错误，未调用抓取，修正 harness 后成功，两个日志保留。这是抓取字节/头部检查，不冒充像素解码或 COS 验收。

Node20 全部 62 文件第一轮 1112 过、27 失败，全部是 migrateImageLocally 尾部的 await import(DB) 经 TSX data URL 无法解析 bare package。模块顶部已静态导入同一 DB barrel 的 createDoc，改为一并静态导入 updateDoc，删除动态导入；函数调用、参数、顺序和图片状态更新不变。原 27 条测试保留，最终 Node20 全 62 文件 1139/1139、零失败/跳过（100.2 秒）；媒体 31/31、运行时 6/6 与 Admin 类型重新通过。Admin Node20 target 构建通过；将 index.js 单独复制到无 workspace/node_modules 的自建临时目录，真实 Node20 require 和 main 导出检查通过，目录删除。它是冷启动证据，最终完整 Linux 制品矩阵仍有独立门槛。未改来源映射、商品/价格/分类/审批/引用计数或 CloudBase SDK，未部署。

实际复核依赖及完整锁文件差量、index→handler/CLI 消费者、fetchSourceImage 与 makeValidatingLookup、现有媒体测试和 runtime-contract；把“云端部署兼容问题”更正为“已证实的本地导入兼容问题”，保留源码兼容与实际云端路径的区别。P5、最终 P6/P7 和原诊断缺口继续，fullDeliveryReady=false。
