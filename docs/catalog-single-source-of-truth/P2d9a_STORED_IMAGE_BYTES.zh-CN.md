# P2d9a：实际存储字节取证与只读检查

当前仅完成只读子单元。尚未接入就绪报告、列表准入或发布授权，也没有部署或修复现场商品。本单元不增加属性筛选、属性合并、截断或拆分存储。

## 现场事实

2026-10-15 在已核对的 CloudBase 环境读取 T142、T157、W203 的图片记录和配置图片绑定，共 57 个不同图片 ID。每个临时下载链接对应的 fileId 都与原 registry.storageFileId 完全一致；实际文件共 14,124,824 字节，57 件的长度和 SHA-256 全部匹配。检查后重新读取 57 条图片记录，状态、provider、mode、fileId、path、MIME、长度、checksum 均未变化。这是多次只读观察，不是事务快照；未修改云端文件或业务状态。

对这些实际字节使用本机已安装 sharp@0.34.5 的严格 raw 像素解码，57/57 通过。最大宽 1200、最大高 2847，单张本机解码最长 50ms。它们是三件时钟当前图片可解码的证据，不是 Linux 云函数解码、冷启动或批量性能证明。真实存储图片没有重现损坏；已取得的属性数量超限根因不变。

证据位于 output/pricing-clock-repair-2026-10-13/p2d9/physical-clock-media-20261015/，包含逐图结果、pixel-decode.json、summary.json；不保存签名下载链接。另 actual-byte-module-result.json 用新模块回放这 57 张实际文件，57/57 通过。回放读取本地已下载字节，不冒称由新模块执行了 CloudBase SDK 下载。

## 代码边界

readStoredCatalogImageBytes 只读当前图片和实际文件，在返回前重新核对同一图片的内容摘要及锁。校验真实长度、10MiB 应用上限、规范 base64、SHA-256、实际签名与允许的图片 MIME；忽略 adapter 的 byteSize 提示。opaque fileId 原样传递，包括大小写、编码和尾随空格，不能 trim 或解析重建。

结果只包含字节证据或受控原因。存储或数据库暂时不可用、锁忙、读取期间内容变化可重试；损坏记录、长度、checksum、MIME 不一致单独表示。即使下载返回坏字节或失败，仍先读回目标，避免把旧目标失败归给已经替换的新图片。引用数正常改变不使内容失效，引用数损坏仍拒绝。存在旧 inline data 的行不走 stored-file 检查，避免验证了文件而实际页面优先显示另一份 inline 字节。

该证据不是像素解码证明，也不授予发布权限；测试明确保留了只有签名、无法据此保证像素可用的样本。无持久健康写回、无图片锁获取/释放、无引用数/状态/分类/发布写入。不能把连续两次点读说成永久存储健康或事务封印。

下载仍复用原 getObjectAsBase64 接口，10MiB 检查发生在 adapter 返回之后；本单元未证明网络下载有硬截止或流式内存上限。接入服务端健康生产者前仍需补有界下载、实际像素校验/部署包契约、持久恢复及版本封印，不能据本模块开启 ready 列表准入。

## 验证

63 项行为测试通过，含默认 DB/存储 facade 接线（内存 DB 和替身存储，无云端访问）。14 种运行代码故障注入均由同一 63 项测试检出，正控通过、无跳过，最终源文件 hash 恢复一致。覆盖实际尺寸、checksum、MIME、base64、读回、opaque fileId、DB 集合、首尾锁、引用数、inline 优先级及旧失败被错误提前返回。首次故障脚本只因正则计数解析失败退出，不算缺陷检出，修正后重新全跑。

当前 251 个测试文件共 3361 项，0 失败/跳过，耗时 89.94 秒。admin 类型检查及两文件 Biome 通过；最初测试联合索引写入的类型错误与格式提示已修正，不作为业务缺陷证据。SDK 契约门禁保持 103 项。Node20.19 执行新增检查及存储 adapter 的 91 项测试，0 失败/跳过；三函数构建、Node20 打包及裸目录离线产物 cold-start/health/旧数据读取/缺集合负控通过。新模块尚未被生产 handler 引用，构建结果不代表接线已完成。

## SDK 与后续

无新增第三方依赖、直接 SDK 调用、ambient shim 或厂商返回形状。默认调用沿现有 MediaStorageAdapter.getObjectAsBase64(fileId) 返回 Promise<{body:string,byteSize?:number}>；CloudBase adapter 接收 node-sdk@3.17.2 downloadFile({fileID}) 的 Buffer fileContent，再转换规范 base64。已核对安装包声明/发送方及[官方服务端存储文档](https://docs.cloudbase.net/api-reference/server/node-sdk/storage)。Context7 本会话不可用；MCP 错误文档地址没有成功读取，改用官方正确 node-sdk/storage 页面。

仅做过本机 sharp 诊断，尚未决定把原生解码库加入云函数。官方 CloudBase 文档说明在线依赖安装会拒绝含安装脚本的包，不能把 Mac 已安装库当成可直接部署的后端依赖；需要独立打包和 Linux 验证后再接入。

文字实际复核本文件、catalog-image-bytes.ts/test.ts、实施记录和 SDK-PROBE 新增段。将“图片健康已验证”改为“实际字节与本机像素检查通过，尚未成为服务端就绪证明”，核对 57 个文件指针、真实字节总数、63/14/3361 计数及零云端写入。
