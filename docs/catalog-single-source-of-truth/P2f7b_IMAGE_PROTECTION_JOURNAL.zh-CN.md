# P2f7b：图片复制登记与原子目标切换

本单元实现后端仓库协议，并用真实 LocalDisk、JsonFileAdapter 和默认原生解码器验证。默认 worker 的自动复制尚未接入，云端和商品发布验收待后续单元；fullDeliveryReady=false。

复用私有 `catalogImageObservations` 集合，以不同 kind 和目的哈希区分复制登记和既有健康观察，没有新增集合或索引。登记键绑定存储保护策略、imageId 和原始图片元数据摘要；共享同一图片的商品复用一次尝试。登记只保存原始目标、MIME、大小、SHA、随机 attempt、任务租约和目标阶段，不保存图片内容或上传凭证。存储保护策略独立于网站内容策略，网站规则变化不会因此要求再复制图片。

| 阶段 | 写入条件 | 中断后处理 |
| --- | --- | --- |
| reserved | 当前租约、图片元数据和互斥锁匹配，原子登记尝试 | 继续同一 attempt |
| targeted | beforeWrite 回调内持久化实际永久目标，完成后才能发送字节 | 先检查已登记目标，保留原始指针 |
| committed | 新目标真实字节和像素检查通过，当前来源、商品和租约仍匹配 | 原子切换图片指针并保存 marker；重复确认返回原回执 |

网络和解码都在数据库事务外。锁 owner 绑定 job、worker 和 leaseVersion；新鲜的其他 owner 返回 BUSY。登记能证明旧任务取消、过期或已被接管时，新 worker 才能接着使用旧目标。过期能力仅能释放自己那一版锁，不能准备、提交或释放新拥有者的锁。丢失确认不创建新 attempt，不盲删对象；本单元保留旧对象。

切换只修改图片目标及技术状态，保留当前名字和引用数，不修改商品、分类或发布状态。marker 证明服务器登记的受控目标，不能当作商品 ready 或发布许可。最终 ready 仍需完整采用集合、当前输入和产品提交保护。

跨流程 review 修复了两个确定反例：来源 activate 的重复确认原先因物理地址变化而冲突，现在只接受同一来源登记和完整原始字节身份；普通上传完成回执在相同 image/uploader/uploadIntent/purpose/MIME/大小/SHA 下更新目标摘要。名字可编辑，字节和上传者不能替换。两条路径均有先失败后通过记录。

验证：仓库29项和实际文件11项组合40项通过；另补实际双适配器竞争，只有一个成功、一个 BUSY，最终相关96项通过。Node20组合313项及新增竞争所在文件12项通过。9种源码故障均被检出并恢复，新增实际竞争又单独重现缺少BUSY保护的失败。CloudBase wrapper 测得来源任务 begin/checkpoint/commit 最多10/9/10次读写、读先于写；第二/第三写的抛错、零ACK、错误码和错误ID均回滚图片、登记及任务。真实文件覆盖落盘失败、丢确认、重开、普通上传重复完成及当前目标默认读回。

六个消费者类型、13文件显式Biome及SDK门禁通过。大体量旧 cloudbase-adapter.test.ts 只格式化本单元新增块和导入，不声称整文件格式检查通过。扩大回归记录在 image-protection-journal-broad-*；最终本地套件在新增竞争和故障恢复后单独重跑。

review 实际检查新增保护合约/协议/测试、authority、jobs、source-media-import、image-upload、shared path、media-storage re-export、两适配器 wrapper 和实际文件/worker测试。测试清理使用 Reflect.deleteProperty，避免 undefined 仍被当作存在字段，或被 process.env 转成字符串。文字将“保护完成”收窄为“图片目标切换”，保留它与商品准备、云端部署和发布验收的区别。
