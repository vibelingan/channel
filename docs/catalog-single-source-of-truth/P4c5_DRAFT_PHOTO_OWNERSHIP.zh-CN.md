# P4c5：原保存任务负责照片锁及清理

草稿新增照片复用现有图片互斥字段。申请、保存、停止都写同一个原任务 Root；不使用另一个临时 owner，不增加集合或环境变量。通用 create/update 的图片互斥辅助函数保持原有实现，原生保存只为实际新引用的图片申请锁，最多 9 张主图加 18 张详情图。配置图片从主图选择，500 个重复配置选择不会增加图片读取。

官网已有引用继续受原商品保护。历史 configurationPhotos 中不在实际主图内的陈旧选择保留兼容，但把它重新加入主图属于新增引用，必须先取得锁。只更新文字且没有照片字段的请求不多读商品、不申请锁。

| 原任务状态 | 允许动作 | 原子效果 |
|---|---|---|
| reserved，无照片锁 | claim | 检查原输入、角色、商品/来源版本与图片状态；图片锁和 photoClaimVersion 一起提交 |
| reserved，持有照片锁 | claim / Save / Stop | 重入仍使用原 Root；Save 在商品及回执事务内检查 owner、时效与 phase；Stop 同时清理自己的锁 |
| saved，照片待清理 | Save / Continue / Stop | 只完成原清理，不重写商品；清理与 photoReleaseVersion 一起提交 |
| staging | 原发布步骤 | 必须先清理照片锁；未完成清理拒绝审批 |
| cancelled | Stop | 只完成自己的残留清理，不再申请锁、不回退已保存编辑 |
| complete | 查询 / Stop | 只读，完成记录不允许照片待清理状态 |

并发 claim/Stop、claim/Save、claim/release 都写同一个 Root。CloudBase 的事务读取不等于取得写锁，因此没有把图片预读当作删除保护；图片锁由实际事务写入，Save 再检查，Stop 用相同 Root 排除迟到申请。官方事务约束核对页：https://cloud.tencent.com/document/product/876/48442 。Context7 在本会话不可用；同时检查已安装 SDK 的原始请求和事务 ID。这里不声称本地 SDK 替换 HTTP 的检查验证了真实云 MVCC。

清理只更新图片的 imageMutationOwner/imageMutationStartedAt，不重发历史图片字节。所有更新及 Root 写入都要求真实成功回执；静默、错误 code、错误 upsert 会让整个事务回滚。响应丢失时 Get 返回 photosPending，原 Save/Continue/Stop 可继续处理，不把商品保存成功谎报为整个流程完成。客户端不清除尚待清理的指针。

当前已执行：原任务竞争和管理员接管 21/21；相关组合 550/550；已安装 SDK 经实际 Admin 处理函数的 676 条矩阵通过，其中 12 条申请/清理回执回滚、27 图和 500 配置、已提交回复丢失、错误 owner/失效图片拒绝。27 图申请/清理单事务最多 58 个文档操作，商品保存 32 个；SDK 全矩阵最大 98。JSON 竞争测试验证同一进程的串行写入边界，真实 CloudBase 冲突与 COS 仍需 test 验收。

本轮 review 另外发现原生申请必须保留旧互斥字段的超时接管语义；否则旧流程崩溃遗留的 UUID 锁会永久阻止新增照片。复现用例先返回 BUSY；改用原有 transitionImageMutationAcquire 的超时判定后，原任务可以保存且清理自己的锁，有效的其他 owner 仍被拒绝。

尚未接入完整编辑表单；未部署、未修改真实商品。fullDeliveryReady=false。

一次整站并行回归记录为 1273 通过、2 失败（子项及其父项）、1 环境图库跳过。Chromium 的冷图 20 件有 19 件发布，1 件提示修复；同一用例独立运行的 Chromium/WebKit 共 54 项通过，未提高超时或自动重试。后续用真实签名 worker、实际 JSON 状态和可控请求时钟独立复现：worker 已生成 ready 回执，但 12 秒请求预算耗尽，根本没有执行第二次绑定，却被误标 repair。修复仅在确实尝试绑定仍不匹配时给 repair；预算耗尽继续原任务。该 red→green 不等于证明首次失败的唯一根因，首次记录缺少内部状态，已给浏览器用例补失败诊断；最终整站组合仍必须再过。

最终源码的 Node20 相关 528/528、已安装 SDK 矩阵 676/676、DB/Admin/local/site 测试类型、23 文件 Biome、SDK gate 和 Admin node20 构建通过。此前全量 DB 2273、Admin 638、local-server 1097 通过，早于最后两项兼容/预算补改；最终 Node20 覆盖这两项。独立双浏览器 54 项早于预算补改，最后组合验收不以它代替。
