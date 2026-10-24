# P3e7d4 分类弹窗接入原操作发布

状态：本 MIU 本地检查通过；未部署，完整交付及真实选品验收仍开放。

## Runtime problem
`ProductClassificationEditor.save()` 在分类保存后调用 `publishConfirmedClassification`，其实际执行 `batchUpdateRecords(..., {published:true})`；重试再次调用旧更新。`refreshProducts` 又可根据商品行 `published` 将未确认的发布升为成功，无法证明这次操作的归属。

## Data shape
分类命令 `{products:[{productId,expectedUpdatedAt}],includeSavedRevision:true}` 在用户预览时冻结；确认后只接受全部且唯一对应的 saved 回执，以回执 updatedAt 建立一次 publication attempt。重试保留每件原 operationId/inputDigest/cursor。浏览器只存原操作指针，不存商品正文或 token；服务端仍决定任务状态。

## Technology constraint
React 事件处理启动修改，effect 不启动发布。TanStack Query invalidate 只是刷新缓存，不能代替本次发布凭据。分类接口的 BUSY 重试可能跨账号切换，所以每次发送前后要检查最初的 token、账号和环境。原操作恢复和官网读回共用既有并发 4、每组 20 的控制器。

## Design / flow
预览 → 绑定会话并检查恢复记录 → 确认 → 服务端 me 校验 → 分类 CAS 保存 → 校验全部 saved 回执 → 原操作批次发布 → 原操作与匿名官网读回 → 商品分类读回。

有未解决记录时先显示原操作；查询只读，继续沿用原 ID，停止先读原任务再取消。取消不会撤销已保存草稿；与完成竞争时如实显示已发布，不能声称保留未发布。关闭弹窗保留恢复记录。恢复记录不可写时阻止新发布并提供导出。

## Alternatives rejected
继续旧 REST 发布无法绑定本次回执；只看 published 会误认他人的发布；unknown 时生成新 ID 可能重复执行。把新模块静态导入 api.ts 会形成循环依赖，因此接线模块由弹窗导入。

## Code translation
分类保存版本只用于首次 `createPublicationAttempt({values:{},expectedUpdatedAt:saved.updatedAt})`。后续查询和继续只使用原 scope/cursor；不将最新 GET 的 updatedAt 当成原操作继续凭据。选品名称与类别保持既有 UI，不增加来源属性过滤配置。

## Risk / test
新增回执完整性、同 ID 恢复、只读查询、账号切换、取消竞争、存储失败和重载恢复测试；实际弹窗测试覆盖成功、部分失败、并发改稿、提交响应丢失与恢复。每个测试保留失败日志；最后执行类型检查、相关本地测试和构建。全量组合及 test 实际选品验收仍单独开放。

## Writing review
已核对 ProductClassificationEditor.tsx、api.ts、catalog-publication-batch.ts、catalog-publication-check.ts 和 admin-subcategory-visibility.spec.ts。将“刷新确认发布”改为“查询原操作并核对官网”，因为商品行 published 不足以证明本次发布。

## Final state transitions

| 状态/事件 | 本轮行为 | 本轮验证 |
| --- | --- | --- |
| 分类预览/取消 | 不写服务端；确认时验证原会话 | 实际浏览器账号切换后零请求 |
| 分类全 saved | 使用每件 saved.updatedAt 冻结一次原尝试 | 回执缺项、重复、未知、版本缺失拒绝 |
| 开始/继续 | 原 ID、digest、cursor，分组 20、共享 4 | 原控制器及真实 20/100 处理器集成 |
| 原任务 complete | 匿名官网及再次原任务读回才计成功 | 两引擎实际 20 件各一次；均撤回、引用 0 |
| 完成回复丢失/官网不可用 | 保留原指针；重开可恢复已发布商品 | 两引擎重新打开并只读恢复，无新增分类或 start |
| 未完成/停止 | 先查原 scope/digest 再取消；完成竞争仍显示已发布 | 控制测试及真实 private 任务停止 |
| 本地存储不可写 | 阻止继续修改；可导出，原任务查询仍可读 | 红测 39/40 后修复；浏览器恢复存储后沿用导出 ID |
| 并发改稿 | 原任务版本失效，不改用新版本、不重复分类 | 实际 CollectionView 在 1440/390 两尺寸验证 |

## Verification and review

新增 32 项＝14 Node 控制 + 16 浏览器子流程 + 2 父项。最终 site 1137/1137，Node20 改动控制器 46/46；站点/E2E/既有测试类型、10 文件 Biome、15 页构建通过。Node20 实际 20/100 批次集成在 review 补 digest 交叉校验之前为 48/48；最终 site 又覆盖了该真实处理器集成，不能把早先 Node20 的 48 项冒称最终同字节重跑。

9 个最终源码故障全部检出，产生 14 个重叠失败，4 文件 SHA 恢复。实际 browser 首轮发现已发布重开入口被禁用、恢复面板重复；修复后再补账号切换、并发修改、仅保存和存储恢复。首轮全站 1134/1136，另外两条列表回归仍拦截旧 approve；迁移为暂停原 continue 后，保持“新版本不能被审批、只查原 ID、JSON 完全不变”的断言，最终全绿。失败日志全部保留。

实际审阅 api.ts 的 BUSY 重试、Editor 的事件处理/卸载中止/父 busy 约束、batch/check/journal/runner、共享 DTO、handler 角色守卫、原生 cancel 与完成竞争。review 另以无 digest 初始指针 + 矛盾 digest 回应复现了错误取消请求；统一校验 check.scope/status/expected 和 revision 后拒绝。

10 张截图保存在唯一 classification-owned-ui-r6 目录并记录 SHA；已查看桌面恢复和 390px 部分失败。它们是本地实际组件调用真实 JSON/Admin/Public 处理器，未冒称云数据或完整 Astro 列表验收。

## Remaining delivery gates

正式 Astro E2E 的旧 REST 拦截仍要迁移；保留现有混合分类和 UI 大批次尚未完成；跨标签同商品多个原指针与服务端根本不存在的任务仍需可操作的处理入口，不能将本地共享 4 当作跨标签锁。P4 编辑/新图片/创建/已进入后台的身份切换，P5 实际坏数据 resync、原 JSON80 不明原因、真实 test 角色与性能、20 件真实发布/官网读回/恢复均未验收。fullDeliveryReady=false。

## Writing review update

实际复核上述 10 个源/测试文件及这份记录。把“1 original publications”修为单数，并让恢复已发布任务时不再出现“Drafts will not be published”；核对发布成功数只来自原操作加官网读回，停止提示不声称回滚草稿或下线完成发布。
