# P2f9b：当前租约下的来源照片导入

在既有 alibaba-catalog-sync 签名入口接通 importCandidateImage。网络导入仍使用原 HTTPS/域名/DNS/重定向/体积/魔数/SHA/持久目标检查；仅注入第一方 persistence callback，让每个来源阶段经过当前准备 job/opaque lease，未知 ACK 重放完全相同的命令。callback 仅接受该次采用 URL，禁止 retire，不借用人类 admin 身份。无新函数、资源、SDK、依赖或 timer。

私有候选按现有配置选图规则提供来源 URL/imageId 和完成操作提示，只含网站实际采用的前9张配置照片；管理员已选配置图时不复制供应商照片。URL 去重排序，沿用批量链接查询，无逐图 metadata N+1。人类 inspection 剔除 imageIds/sourcePhotos，页面已有 source DTO 保持原投影。完成操作字段只是恢复候选提示；实际清锁仍必须通过严格 Source receipt 和 owner 检查。

worker 先处理未绑定 URL，每步最多4个且遵守20秒软预算/8秒尾部预留；全部绑定后重新读取完整候选，再建立像素计划。仍有未绑定时不建立残缺 image plan，也不回报 checked。瞬时失败返回 retryable，已知永久失败给 edit fallback，其他合法产品不受影响。此单元的 checked 仍不是 ready 或发布权限。

Source SHA 去重在已有图片的同一物理写入中清锁，再提交 URL 绑定及移除无字节 pending 占位；不增加操作数，不再依赖 finally 的独立释放。历史残留锁由 adopted URL/完成 owner 定位，调用现有严格恢复后重新做像素准备；只有 fresh busy 才尝试一次匹配 URL，不扫描全表或清除其他 owner。updatedAt/名称/字节/引用数/商品/分类不变。

## 已执行的检查

五URL实际PNG流程：先复制4个，数据库重开后补第5个，全部同SHA仅一来源PUT，之后保护复制和原生像素检查；所有链接绑定才建立完整像素计划。永久404第二次不再下载；503不绑定残缺计划；复制前取消零fetch/写，复制后取消保留tracked pending目标且不激活；下载期间商品编辑保留新编辑并拒绝旧checkpoint；activation ACK丢失不重复网络/PUT；不同URL/retire callback拒绝。已有人工选图/完整105配置/坏像素/历史锁恢复/私有字段不泄漏均覆盖。

最终源码组合 Node20 298项通过，0失败/跳过/取消；扩大 DB948+admin549+public131+alibaba304+local418=2350项全部通过；四消费者类型检查及SDK门槛通过。7项实际源码故障全部检出，每轮123至132个正控/共133，原字节恢复并记录SHA。反例包含跳过producer、残缺plan绑定、URL scope、私有字段泄漏、人工选图覆盖、绕过租约持久层、去掉原子清锁。没有将解析失败或运行超时冒称检出。

测试修正留痕：旧candidate兼容性测试需剔除新私有sourcePhotos；取消测试最初缺expectedLeaseVersion，按既有CAS协议补齐；重开fixture最初dispatch闭包仍指旧适配器，改为当前实例；可选callback测试类型排除undefined。均记录为测试修正，不算产品修复。

review实际读取Source plan/binding、候选/human投影、worker、真实main入口、importer/Source事务、Cloud/File适配器及对应测试；简化时复用既有importer和事务，没有新上传平台。文案把“4张/20秒硬限制”改为“每阶段最多4张、20秒软预算”，因为DNS/网络/PUT现有超时仍可能跨过软预算。后续性能门槛必须真实测量。精确提交后的构建/原生产物/实际bundled main小流程结果将另记。

完整ready封印、列表、统一用户操作、UI恢复、历史修复、全量组合/性能、test部署与三时钟/单件/20件发布恢复继续，fullDeliveryReady=false。
