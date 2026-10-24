# P2f9c1：检查期间的配置图删除保护

实际缺口是来源配置图可以不在 product.imageIds 中。旧的检查进度不能防止图片在检查后被删除，因此还不能据此写 ready。

worker 在读取/复制/检查每张图之前，先用当前 opaque lease 在既有 catalogImageObservations 写入一条私有占用记录。ID 绑定 policy、job、nonce、image；记录绑定 product、inputDigest、generation。写入前后核对租约和当前商品/来源/链接，同一事务物理写 job 防止取消竞态。未知 ACK 重试保留同一条记录。图片内容、公开引用计数、商品、分类、发布状态均不改。占用本身不证明图片有效。

两个活跃图片删除入口均在持有原图片锁时先查占用，再查旧审批和商品引用。当前 queued/running/retryable/blocked 任务保护图片；暂停或租约过期不自动丢掉可续接任务的占用。取消、stale、nonce 改变或当前输入变化使旧占用失效，无需同步修改全部商品。completed 仅保护匹配当前 ready 报告的输入。损坏记录或查询失败拒绝删除，不当作没有引用。后续 P4 必须提供取消/恢复入口；本单元未启用页面或 ready。

查询按 kind、imageId 和 _id 游标分页，部署 manifest 为已有私有集合加入对应非唯一复合索引；无新集合、SDK 方法、shim 或依赖。内部查询使用已配置 adapter，不通过只允许通用集合的 CRUD 门面，不向客户端开放私有集合。

竞态检查使用实际 JSON 适配器、磁盘字节和两个真实删除入口：占用先提交则不删；删除先取得锁并完成空扫描时，后来占用可记录，但图片检查看到 busy，不产生可用像素回执。取消后删除成功，元数据和实际字节按原协议清理。两个事务写入各自的抛错、零 ACK、错误码和错误 upsert ID 共8个故障均回滚；第一占用写入后租约过期也回滚。来源商品完整输入时共8次点读写，读全部在写之前，不读取或改写图片/商品。

执行：最初4项红测明确得到 VALIDATION_ERROR；新命令实现后通过。扩大回归 DB984+admin549+public131+alibaba304+local423=2391项，0失败/跳过/取消；Node20八文件492项通过；四消费者类型检查、11个完整修改文件 Biome、仅新增 Cloud 测试块格式检查、SDK gate 和 diff-check 通过。5项真实源码 mutation 全部检出，每轮55至58个正控/共59项；恢复后源码字节哈希一致。历史 nonce 超过100项、旧来源/observation/link、损坏记录、lease/input/cancel/ready 条件均覆盖。

开发过程中组合回归抓到私有集合误走通用门面的接线错误，已改为内部 adapter 查询并重跑。两项旧取消/编辑测试原来断言整个 observations 集合不存在；改成断言无像素检查回执、有一条已失效占用，保留其原来防止旧数据通过的目的。没有把这两项期望调整算成产品修复。一次修改脚本因匹配文本已格式化而未生效，重复启动的测试已停止，修正后重跑；该次不计通过。

review 实读 worker、两删除入口、Source retire/orphan cleanup、占用读取与 job 事务、产品版本输入、Cloud/JSON 适配器、资源部署索引与对应测试。pending/failed 清理不能退休 active 图片，未扩展无关清理路径。文案将“过期即释放”改为“取消/输入失效释放，过期任务仍可续接”，与实际状态机核对。无子 agent、新分支/worktree/PR、push 或云端写入。

后续仍需完整候选/像素回执的最终封印、列表准入、统一用户操作、恢复 UI、历史修复、全流程/性能、test 部署及真实三时钟和20件发布恢复。fullDeliveryReady=false。
