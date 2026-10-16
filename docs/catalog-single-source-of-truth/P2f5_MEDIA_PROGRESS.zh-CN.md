# P2f5：有界图片检查的持久断点

范围：在已有技术job中保存完整采用图片计划的digest、数量、cursor、verified/invalid/retry数量与最后一步回执。仅服务lease可绑定计划和推进。human进度可看数量，不返回签名、nonce、存储目标或图片诊断原文。完整采用计划由worker从当前source/manual候选计算，不接受浏览器图片清单。

bind-media-plan对同一digest/total幂等；不同计划拒绝，不能悄悄接续旧cursor。advance-media-check把当前图片观察与cursor/count/最后receipt放在同一事务。只有当前cursor可推进；同一步响应丢失后，相同payload重放返回原进度且不重复推进，不同payload拒绝。旧lease、取消、输入更新、图片替换、租约在读取中到期继续按已有围栏拒绝。所有读取先于写入。

每一步成功或失败观察均有确定结果，retry也被记为已检查而非已验证；cursor到total仅说明扫描结束，绝不写ready/completed/published。最终producer仍需保护物理目标、读取所有当前证据并封印；本MIU不能绕过这条门槛。显式human retry轮换nonce、清空旧扫描；允许已有扫描计划的queued job显式重试，包括来源图片绑定在准备中变化或需要重新检查已处理目标的情况。正常未完成任务的普通resume保留进度。

测试检查：0/1/多图片、完整进度、重复绑定/变计划、越界/跳步/重复不同数据、丢ACK、正确分类计数、非法能力/过期/取消/输入与目标变化、严格坏记录、溢出、真实文件重开/回滚，以及云事务写入失败的组合回归。worker入口与真实native小流程随后接线。fullDeliveryReady=false。

本地证据：最初11项红测均因未实现协议失败；最终161组合+24真实文件=185，Node20同185，0失败/跳过/取消。9源码故障全部检出，167–184正控保留，两源码finally恢复。广泛DB848+local355=1203通过；四后台types、显式4文件Biome、SDK106通过，Cloudwrapper新增片段单独格式化，不重写历史大文件。Cloudwrapper验证源任务最大9操作、读先于写以及throw/zero/coded/wrong-ID第二写故障时回滚cursor+观察；不是现场云并发验收。

真实默认文件存储/原生像素继续使用原上传完成路径；释放、数据库重开和新authority后从cursor1继续；丢ACK不重复计数；两真实adapter重复并发步骤均得到相同回执且只推进一次；文件失败两部分同时回滚。源码review确认服务输出只含计划哈希/数量，human进度只含数量，无nonce/signature/lastReceipt/存储地址。最初损坏测试把invalid1重新设为invalid1并未改变记录，修正为2后验证strict不变量；私有persist访问类型错误已改为删除本测试自有override恢复原方法，不开放生产方法。

风险边界：cursor只代表历史检查，当前目标/字节可以后变；扫描结束不授权ready，lease持有者必须由真实worker从完整候选取imageIds。绑定变化时旧digest被拒，普通resume保留cursor；显式retry清空扫描并轮换nonce，避免卡在无法恢复的旧计划。后续物理目标保护和最终采用集合复核仍是硬门槛。实际复核job/纯进度schema/观察+两adapter事务/测试以及本文，将“已验证数量”纠正为“已检查数量”，区分invalid/retry计数。fullDeliveryReady=false。
