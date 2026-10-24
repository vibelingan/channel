# P3e7c7b 原任务最终发布调用

基线64ea7206：native最终分类校验已修复，5987完整覆盖/3022Node20/610安装SDK/5故障10重叠。最后精确三函数/site仍d67cf6ab。本步打通完整手工商品小流程后再构建新精确产物和公开读回/回退。

## 问题与选择

实际continue已能完成source、配置、媒体和private引用，但从未调用原operation-publish；不能把staging或“全部准备完成”显示为发布成功。沿同一scope调用原16文档操作/3写的最终事务，不新增published补写、新根、请求参数或表。

新增独立server finisher，以scope/digest/current/intent/版本/TTL/全部配置/媒体/引用为前提。只在父剩余预算至少2秒时开始最终调用，给读回留余量；这是调用准入预算，不能称为真实网络P95或强制取消事务。成功后读真实小回执，要求同一operationId/inputDigest/revision且complete；无持久完成的OK必须拒绝。已complete只返回历史回执，不重新发布，即使后来下架或编辑。

最终事务抛出未知IO时，读取原根确认：只有匹配的complete回执可恢复为已提交；staging/读失败都不能猜成功，也不能新建operation。坏ACK回滚后保持原私有进度，下一次沿同scope继续。明确失败保留validation/remedy，取消/编辑/撤权/来源变化仍由原native事务拒绝。

## 组合与测试边界

production manager默认使用真实finisher，Cloud Function和local-server沿同一handler，不增加环境开关或浏览器publish能力字段。AdminConfig可注入同型finisher依赖，与原preparationInvoker一致用于分段测试；现有私有source/media/reference夹具明确延后最后一步，不能把这些阶段测试称为完整发布验收。新增完整API/精确编译流程不注入延后依赖，实际执行最终事务。原controller依赖注入的子步骤仍可单独验证，完整caller增加最后一步组合。

正常流程仍只有start/get/continue/cancel公开语义；私有native operation-publish不向浏览器开放。referenceRecovery只用于原引用阶段，不带到原最终写入。公开complete与current分开：历史完成不代表商品仍公开，UI后续须按当前版本与公开读回显示结果，不能盲目重发。

## 验证顺序

先用真实PNG和实际Admin默认配置复现两个业务红测：默认continue仍staging；最终提交回应丢失也无法获得complete。随后验证完整manual publish→同操作重复/重开→公开商品与PNG、假OK、坏ACK/丢回应、预算在读/调用间耗尽、取消/编辑/撤权、错误scope/digest、缺分类及历史完成后下架不复活。旧私有阶段的验证显式注入延后finisher，新完整默认路径不注入。

安装SDK增加真实默认manager最终调用及16文档/3ACK回滚/丢回应读回；旧阶段探针明确延后最终提交，原native610控制保留。精确三函数/site、Node20/24多进程真实PNG/105SKU、满80游标恢复继续到实际complete后，必须加公开读回和回退。source New审阅确认、Changed/Removed明确决定、live/新照片/UI/P5和真实20件仍在后续范围，不能把手工商品小流程当全部功能完成。


## 实施与验证

默认 manager 已接原最终事务。新增 30 个实际 API/服务用例；旧私有阶段夹具提取到 testing/catalog-operation-workspace.ts，显式延后最终提交，保留原 122 个阶段测试。完整用例使用默认配置，没有延后依赖。两个初始业务红测分别证明默认流程不完成、丢最终回应无法恢复；修复后使用实际 PNG 发布、公开详情和图片读回、同根重放均通过。

本轮 7 个相关包及部署脚本共 6017 条通过，实际 Node 20 关联回归 3052 条，均无失败、跳过或取消；19 个工作区类型检查、E2E 类型、standing SDK、7 文件 Biome 和 diff 检查通过。最后复查将 20 件测试的 Promise.all 改为 allSettled，等所有工作者结束才执行 finally，避免一个断言失败时其他工作者仍在发布；随后 584 条相关用例、local 类型和 626 SDK 控制再次通过。这个调整只改变测试清理，不改变生产执行或测试数量。

20 件是本地隔离的手工商品，4 并发，共用一张实际准备过的 PNG。逐件读回批准 revision/名称/0 SKU，图片有效引用 20；finally 通过实际 Admin update 下架本次拥有的商品，保留分类字段及其是否存在，逐件详情 404、共享图片引用归零/公开 404、私有像素保留。随后对每个历史完成任务再次 continue，均 current=false 且零写，不能复活商品。这没有经过浏览器 Assign category，也不是 test 的真实选品或性能验收。

故障注入 11 种均检出，产生 16 个重叠失败，3 个生产文件 SHA 完整恢复。包含默认 final 断开、阶段依赖被忽略、错误 native 命令、假 OK、预算防护缺失、scope 未捕获、丢回应未确认、未知 IO 猜 pending、错误批准 revision、未就绪/取消/过期仍调用、父预算被重置。补例验证最终读回版本不符时拒绝假成功；实际已提交的根可稍后同 scope 只读确认。空照片返回 imageIds/edit 提示；坏现有子分类保留 classify 问题，不强加分类。

626 安装 SDK 控制为原 610 加 16：默认 manager 真正完成；product/root/proof 共 9 种坏 ACK 整体回滚且同任务可继续；最终 commit 回应丢失按原根确认；目录 coded/malformed 读取错误不吞；错误分类保留 issue；异步前捕获输入；已完成后下架，原任务只读且不重新发布。最终事务 16 个文档操作/3 写/0 图片读取，全套最高 98 保留。旧阶段控制明确延后最后一步，不能冒充完整发布。传输被替换的 SDK 探针不证明真实云 MVCC、COS 或 P95。

实际人工 review 核对上述 7 个代码/测试文件，以及 handler 权限、输入白名单、原 native final、共享状态 schema、原媒体和引用子步骤。保留服务端默认 final，不增加客户端可关闭发布的参数；确认 4 KiB 小回执不泄漏根或来源。文案将“20 件通过”改为“本地 20 个隔离手工对象通过”，将“2 秒足够完成”限定为调用准入门槛，真实延迟仍须实测。脚本首次生成时匹配了两处 published=false，已限定第一处；SDK 恢复命令首次漏传 bundle 路径，补齐后 Node 20 的 626 项通过，这两次均是工具调用错误，不算业务红测。

当前仍有原 UI P1，未 bless、未部署。精确三函数/site 将在本提交后构建并在独立 Node20/24 进程验证：冷 PNG + 105 SKU、满 80 槽恢复继续到 complete、公开读回、实际下架和旧任务零写重开；结果按确切 SHA 写入 ignored output。source New/Changed/Removed 审阅确认、live 编辑/新照片、媒体慢调用 fallback、坏历史数据修复、UI 全组合和真实三时钟/20 件验收继续，fullDeliveryReady=false。
