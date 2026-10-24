# P4c9b：已发布商品的原子保存

本单元实现 refresh-live 的内部保存事务，前台编辑入口和保存后的 native 审批仍未接完。当前 HTTP product-operation-save 继续拒绝 refresh-live，不把内部事务测试算作完整编辑、部署或真实 CloudBase 验收。fullDeliveryReady=false。

旧通用 update 在商品提交后逐图维护公开计数，失败只记录日志；它不能提供本次要求的商品、回执、引用同时提交。因此新增内部保存阶段，沿用原 actor/product/operation/inputDigest 和 Root，不创建第二个业务任务。

内部 bind 和分页事务逐次读取真实商品、来源及版本，重算候选行的 canonical 图片集合。保存阶段不替换已批准详情，变化只来自历史行图库/描述图（最多 18+18）与新输入（9+18），最多 63 个不同图片变化。Root 保存有上限的差量、摘要和进度，不复制 10000 配置的旧图片清单；超过限制或摘要变化会拒绝写入。只更新文字时无图片差量，不写空树 proof，避免与稍后的空变化审批共用终态槽。

每页最多 20 张，按图片及所有证明的实际读取量预留写预算；已失效的满槽任务使用原有有界恢复，取消资格仍在事务中重验。暂存本身不给新图片公开权限。native save 在同一事务中提交商品、原 saved 回执、身份字段和引用 proof；任一写失败全部回滚。重试先核对原回执及 proof，只返回已有结果。已发布状态保留，清空手动价格延续 Admin 的空值约定，已批准详情继续作为买家版本。

新图仍需由本 Root 获取有效上传锁；移除旧图库引用不要求先修好旧图片字节，但计数损坏、未知计数、异常锁不会被猜成有效状态。取消 reserved 任务同时写取消证明并释放照片；取消 saved 任务保留已确认编辑及已提交计数。并发下架、归档、重新分类、编辑、账号失权和新图失效都在原保存中拒绝，不重复写商品。最终批准前的像素、内容和来源检查留在后续审批阶段。

保存阶段的状态和竞争结果：

| 当前状态 | 允许的下一步 | 业务结果 |
| --- | --- | --- |
| reserved，未绑定差量 | bind / cancel | 商品不变 |
| reserved，部分差量暂存 | 继续原 cursor / cancel | 图片没有新增公开权限 |
| reserved，差量全部暂存 | 原子 save / cancel | 两者在同一产品/Root 上竞争 |
| saved | 原结果读取 / 照片释放 / 后续审批 / stop | 保留已保存商品和 commit proof |
| cancelled | 原状态读取 | 拒绝再次 save |

两个不同原任务同时保存同一版本，只有一个提交；同一原任务重试可以都收到 saved，但共用唯一回执和引用变化。save 与 cancel 先提交者决定是否保存，随后 stop 保留已确认业务写入。普通编辑、下架、归档、来源和权限变化均由写事务内的原快照检查拒绝旧输入；真实云端 MVCC 竞争仍由 P7 验收，SDK mock 不模拟数据库调度。

本地证据均在 output/pricing-clock-repair-2026-10-13/p3e1：

- live-save-red-r1：新需求 28 项中 3 项预期失败，分别是 live 价格清空和两条显式时钟/锁检查；实现后 green-r1 28/28。新增负数计数保护后纳入组合。
- live-save-native-r3：两个适配器共用同一契约，30/30。前两轮 JSON 的“直接损坏图片”模拟被普通 ledger 写保护挡住，改为有明确注释的特权存储故障，再验证保存拒绝；未放松正常写保护。
- live-save-full-slot-r2：两端各用 80 个实际原任务暂存同一旧图，失效其中一个后恢复第 81 个原任务并保存，公开计数从 81 正确变为 80。r1 的额外 inputDigest 被 strict get schema 拒绝，修正测试请求后通过，原日志保留。
- live-save-combination-r1：现有保存计划、operation、审批、引用、CloudBase SDK 事务模拟、实际 JSON adapter 等 1064/1064；DB/local-server TypeScript 通过。随后新增有效批准版保留用例，两端 buyer-version 2/2，核对真实 public-version 选择和批准图片有效计数。
- live-save-node20：45/45、0 跳过；live-save-admin-build：实际 Admin bundle 构建通过；live-save-types-final：DB/local-server 类型检查通过。Biome 检查 11 个文件；仓库配置排除 cloudbase-adapter.ts，对本次该文件差量人工审查并由类型、构建、原生事务模拟覆盖。
- live-save-fault-omit-proof：故意省略 CloudBase native 保存的最后引用证明，两条目标测试均失败。finally 恢复源码，live-save-fault-proof.json 的前后 SHA256 相同。首次注入准备因格式匹配断言停止，未修改源码；后一次完成真实注入。

实际审查新 live-save 模块、Root 解析/保存/取消/照片/恢复、两个 adapter、内部命令入口、引用读取与公开版本规则、两端共用契约及反例。复核所有读取先于写入、98 次事务上限、ACK、原任务幂等、空差量证明、旧图损坏移除、新图锁和保留分类。未增加 SDK 方法、类型 shim、集合、环境变量或部署配置。

文案审查将“live 编辑完成”限定为“内部保存事务完成”，并将 CloudBase 测试称为“SDK 事务模拟”；核对没有云端部署或真实商品变化。后续必须接好 native 审批差量、原任务状态与时间预算、真实编辑表单，并进行串联、构建及 test 选品/恢复验证。此前 JSON80 原始 begin 失败及 WebKit access-control 原因调查继续保留，不用本次通过替代其归因。

精确提交复审补充：eb04b1b8 复审发现缺少 live 编辑直接竞争测试，保留该审查项并补齐。实际 JSON mutation lock 执行 Promise.allSettled：两个编辑只一个 saved、同原任务两次保存只一组 delta、save/cancel 两种入队顺序均保留赢家并释放照片。live-save-race-r1 共 21/21（新增 4 条并发，其余 17 条原契约）。这部分没有放宽产品或图片断言，也未把串行 SDK mock 称为云并发证明。
