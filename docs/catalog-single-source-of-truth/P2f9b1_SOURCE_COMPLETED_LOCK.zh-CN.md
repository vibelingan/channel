# P2f9b1：已完成来源去重的锁恢复

依赖review发现importCandidateImage在去重后的finally忽略释放失败。URL已经ready而图片仍被该Source操作锁住时，后续像素准备会BUSY。先通过既有完成回执恢复，随后再接网络producer。

只有active URL绑定、严格合法receipt、receipt.imageId与实际图片匹配、当前imageMutationOwner与receipt.operationId一致，才可在同一来源事务清除该已完成操作的锁。claim或合法reuse/activate确认重放可补做清理；note-failure不产生新写入。其他owner、缺失/坏receipt、错误重放参数均不清锁。保留名字/字节目标/引用数/updatedAt，不动商品/分类/发布。相同owner的晚释放不能影响新owner。

验证：真实去重完成且模拟释放未落盘→新claim/确认重放恢复；合法内容和完成URL不变；重复清理幂等；其他操作锁保留；缺/坏/错图receipt不清；错误target/hash不清；同事务写失败回滚；本地实际导入/准备子流程随后接线。这里的ready只表示来源元数据绑定，不是像素许可或商品ready。


已实现并验证：6个对应测试文件共212项在Node20通过，零失败/跳过/取消。DB与local-server类型检查通过，3完整改动文件Biome通过，旧Cloud大测试文件只格式化新增块。

真实本地步骤：先复制PNG，另一个URL按SHA复用；模拟持续抛错或未确认释放，重开JSON数据库，重新请求同URL，无再次网络读取/PUT，只有一张图片，精确保留目标/内容/名字/引用数/updatedAt，清掉原操作锁。迟到释放返回not-owner。新增事务用例证明图片清锁已写入后租约到期仍整体回滚，4种写ACK失败也整体回滚，再用当前租约恢复。

review检查了SourceMediaImport完成分支、receipt严格解析、既有mutex释放、leased wrapper每写与最终job fence、Cloud/File适配器和importer finally。无新SDK调用/依赖/资源/索引；第一方store.set仍通过既有确认ACK。新增本地测试起初错误假设release返回boolean，实际协议为字符串released/not-owner等；按实际合约修正后重跑，不算产品缺陷。文案将“来源ready”等同于“像素可用”的误读收窄为“元数据绑定完成”。本单元不声称构建、云部署或发布验收；网络producer及最后ready封印继续。fullDeliveryReady=false。
