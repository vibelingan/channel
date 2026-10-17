# P3d2：批量初次与重试固定输入版本

基线dd4780d已完成12文件单人审查、精确三函数和15页站点构建、Node20原生SDK事务下架/旧审批/旧guard拒绝及检查修复组合，三个health SHA相同，所有夹具清理。本单元沿批准的P3继续，无云端变更。

已确认CollectionView的batchUpdateMutation只传ids/values，遗漏选品时updatedAt；分类初次有保存回执版本，但retryPublication调用retryBatchUpdate丢掉它。retryBatchUpdate又在发布前读当前行并换用新版本，能把另一管理员后来修改/下架的记录当本次已确认输入。字段相同也不能证明本次操作成功，尤其原来就是draft时Disable丢响应，published:false不证明取消屏障已经提交。

本单元固定初次批量的ID、允许的单字段/归档补丁及每件版本，缺版本明确null，坏版本或缺映射拒绝，不能把缺映射解释成undefined无保护。函数入口复制ids/允许补丁/Map，异步4并发期间外部变化不得改变后续商品的输入。CollectionView冻结原行快照；分类retry使用原分类保存回执。初次及重试都携带原版本，不能重读最新行自动换基线。明确BUSY且未写入可同基线重试；若本次已确认自己的阶段写入，可在后续稳定操作协议记录自己的新版本，不能用任意最新get代替。

```ts
batchUpdateRecords('products', frozenIds, frozenPatch, frozenRevisions);
retryBatchUpdate(previous, retryIds, frozenPatch, frozenRevisions);
// null=仍是旧版无时间戳；undefined不得来自一个缺失Map条目。
```

所有真实产品UI调用迁移到冻结模式；既有未提供Map的内部旧API路径在统一操作迁移前单独标注，不把它当安全重试证明。带冻结版本的未知结果不能靠字段相同冒称本次成功，保持未确认并提供原Edit/Preview核对入口；持久operationId/阶段回执仍是P3后续必需，不能以这一步的CAS代替它。合法分类已保存和发布结果分开保留，不强行统一分类，不删除已有结果。

先红测：缺Map项零请求、legacy null、异步中Map/补丁变化、发布/下架retry原guard、其他actor已published不假成功、丢响应的既有draft不假下架成功；真实桌面/手机请求必须携带快照版本，并覆盖分类保存→retry。再实现、反例、review、组合与相关全量/精确构建。普通并发拒绝保留用户输入，不能自动重新发布；partial自身阶段恢复与全部稳定操作继续阻断完整交付。fullDeliveryReady=false。

## 执行与当前边界

本单元相关API测试44项（新增15），覆盖显式null、缺失/非法Map项零请求、异步外部Map/补丁/IDs变化、原guard重试、其他actor已经发布不算自己的结果和既有draft丢Disable响应。真实浏览器在1440/390覆盖初次Disable、BUSY4次后人工重试/外部编辑冲突、Archive原guard；分类保留原保存回执、未发布状态、原子分类及另一人的编辑，Check later后可实际Edit/Cancel。

完整site797项通过，0fail/skip/cancel。实际生产构建的公开41、目录90、正式11（含隔离20件分类发布/BUSY/恢复、大配置和原Preview键盘流程）通过；随后visibility6通过/1失败/1未运行，taxonomy未运行。失败保留在frozen-formal-flow5.log与lost-publication-original-error-context.md：旧验收要求发布写入后丢响应能自动确认，本步骤因尚无可靠操作回执保持未确认。它是下一P3操作协议的明确集成红测，不能删除断言、用published=true冒充确认、声称全流程通过或允许部署。

21项源码故障均被断言检出，分别为8项API输入/读回、4项实际UI版本转发、7项弹窗焦点、2项实际生产构建的上传方法/文件容量；每次都有独立通过正控，无编译/导入假红、无跳过。4生产文件finally恢复原字节并核对SHA256。故障结果保留output/pricing-clock-repair-2026-10-13/p3d2/frozen-faults/results.json。重叠失败断言不代表同等数量独立缺陷。另复验既有4项摘要/完整GET保护，结果在后续复核记录。

原public容量测试夹具没有v1字段投影协议、count请求pageSize1却返回20且缺完整GET，触发正常的列表拒绝；旧假上传凭据仍是POST/FormData。仅该夹具改为真实projectProductListResult、完整原始GET一次及PUT/headers/PNG原字节，保留原容量、移除后重试、去重和20文件接纳9个/拒绝11个断言。先前夹具失败留档，不作为产品修复证据。生产上传改POST或取消接纳上限均使原断言失败，独立无JS认证正控通过。

复核三生产文件、三测试文件及分类保存/最终update、审批job/receipt、原生CAS与JSON、列表DTO/完整GET、Modal和媒体上传消费者。固定版本解决他人修改被盲目纳入的风险；自身中间写入、稳定UUID、最终批准/上线回执仍未解决。按检查表保持集成阻断，review不得给本提交发布许可。性能变化仅为≤20项局部复制，初次不增加HTTP；不据此声称云端P95已达标。

文案逐项核对上述6代码/测试路径及本单元/焦点文档、实施记录和SDK证据，把“重试安全完成”改为“重试固定原输入，未知结果仍待持久回执”，保留所有未完成门槛。无真实云写入/部署、新分支worktree/agent/PR/push，fullDeliveryReady=false。

| 故障 | 正控 | 失败 |
| --- | --- | --- |
| snapshot-map-not-copied | 43 | 1 |
| batch-values-not-copied | 43 | 1 |
| snapshot-validation-removed | 38 | 6 |
| batch-ids-not-copied | 41 | 3 |
| legacy-null-guard-omitted | 42 | 2 |
| retry-snapshot-discarded | 40 | 4 |
| retry-rebases-frozen-input | 42 | 2 |
| matching-fields-used-as-frozen-receipt | 43 | 1 |
| initial-ui-snapshot-not-forwarded | 3 | 6 |
| retry-ui-snapshot-not-forwarded | 7 | 2 |
| archive-ui-snapshot-not-forwarded | 7 | 2 |
| classification-retry-snapshot-not-forwarded | 7 | 2 |
| focus-origin-not-recorded | 6 | 3 |
| focus-heading-fallback-lost | 8 | 1 |
| focus-pending-refresh-not-waited | 7 | 2 |
| focus-product-identity-not-bound | 5 | 4 |
| focus-new-input-not-respected | 8 | 1 |
| focus-new-pointer-not-respected | 8 | 1 |
| focus-new-keyboard-not-respected | 8 | 1 |
| actual-upload-forced-to-post | 1 | 1 |
| actual-image-selection-cap-bypassed | 1 | 1 |

恢复后复核：4项旧摘要/完整GET反例均检出（88项/次，分别84/4、86/2、80/8、82/6正控/失败），8源文件还原核SHA；本轮合计25种故障、67项重叠失败断言，不是67个独立缺陷。随后Node24与Node20同4文件132项各通过，0fail/skip/cancel。Astro216文件0error/warning、8既有hint；E2E类型、standing SDK、6完整代码/测试文件显式Biome及diff检查通过。本单元未改后端源，没有把旧后端/脚本全量数加进本轮。完整集成红测仍在，审查保留一项必须修复的操作恢复缺口，不发版。
