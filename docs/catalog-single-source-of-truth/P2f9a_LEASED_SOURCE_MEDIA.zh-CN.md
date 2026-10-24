# P2f9a：当前服务租约下的来源媒体写入

为后续未绑定来源照片producer复用既有SourceMediaImport状态机，不创建另一套上传协议。当前服务job/opaque lease校验后，在同一原生事务/JSON文件锁中执行来源claim/checkpoint/activate/reuse/fail/note-failure，并写相同job fence；不允许retire或物理删除，不改商品/分类/发布。内部来源command时间由本次服务事务时间覆盖。

需要既有transaction get/set/remove；CloudBase catalogRowStore已具备确认删除，JSON准备任务的copy/rollback事务补相同remove。图片去重只删除尚无字节的自有pending占位，不删除已落盘对象。每个写前及最后job fence前检查租约；途中到期必须抛出以回滚整个事务，不能在事务内吞错后留下半个来源绑定。取消/换租约与同job fence竞争。产品/来源变化在进入时检查，URL全局导入只是未附加媒体；最终采用集合和商品封印另验。

检查：实际来源状态机claim→checkpoint→activate及重复ACK；fake/旧/取消/途中到期；服务时间防未来claim；dedup remove；禁止retire；Cloudwrapper写/删除失败全回滚、操作预算；真实JSON落盘失败、跨实例来源claim竞争及无商品变更。此单元不做网络复制或ready封印。


已实现仓库命令和JSON remove；网络producer尚未接入。56协议/104Cloudwrapper/4实际JSON=164组合通过，9实际源码故障全部检出，正控158–163/164，2源码恢复；四消费者types、扩大回归/Node20/SDK/显式Biome最后结果待读回。

Source-backed claim/checkpoint/activate最大10读写、dedup12；8种URL/job写入失败或ACK异常、3种删除失败或ACK异常整体回滚。过期测试分别证明Source图片已在事务副本写入、pending占位已被删除之后仍整体回滚。真实JSON验证落盘失败/重开/去重实际删除、两商品不同租约争同URL只有一个claim一个busy。仓库样本只有元数据，不冒称图片已做字节或像素验证；后续producer需默认真实复制和保护检查。

review校正测试fake：原remove只返回deleted1而不删Map，现在真正删除并保留0/错误码/抛错路径。live时钟通过Object.assign保留getter；spread会复制成静态值，曾使late-delete反例不触发，修正后重跑。retire的独立正控最初缺清理锁而正确busy，补真实锁转换后证明确实可retire；新的服务cap仍FORBIDDEN。没有把这些测试夹具修正算作生产功能修复。

实际复核jobs分支、JSON copy事务、既有SourceMediaImport及confirmedremove、两层时钟与scope、DB/Cloud/文件测试和SDK记录；将“来源图片已可用”改为“来源元数据激活，像素另验”，保持原图/分类/发布不变。fullDeliveryReady=false，继续网络producer和完整采用集合封印。
