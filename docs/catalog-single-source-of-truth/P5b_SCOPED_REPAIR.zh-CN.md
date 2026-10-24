# P5b：定向修复与 resync 执行约束

历史问题商品通过现有单件 syncProduct 与准备/发布操作修复，不执行全量 runNow、重放分类映射、直接改产品/审批记录或修造图片校验值。P5a 影子报告仅提供候选与核对证据，不能授权写入。现场对象以重新读取的 source/link/product 三方身份为准，不能凭 T142/T157/W203 名称猜测外部 ID。

## 执行顺序

1. 保存本次明确商品 ID 清单和 sourceProductId、sourceKey、link.productId、版本、现有分类、人工标题/描述/价格/图片、published/archived、批准版本与公开状态。保存受影响共享图片的有效引用计数；同时保存其他已发布商品的 ID/公开版本基线。私有快照不进入 Git。
2. 确认管理员、test 环境和待部署 SHA，确认旧公开版本仍可读。单件调用现有 syncProduct；遇 lease-busy、provider-unavailable 或任何未确认回复时，先重读 source/link/product 和任务状态，不反复建立新任务。使用同一外部 ID 重做，禁止按名称新建产品。
3. 验证 productId 与既有 link 未变，draftCreated=false；来源 observation 更新，内容代际失效，旧 ready 不能继续使用。人工字段、分类和 published/archived 必须逐字段相同。无分类仍无分类，已发布记录保留原公开内容；仅来源的新增数据等待审查。
4. 通过 Preview/Edit 的现有准备入口推进同一任务，检查来源事实、配置/报价、图片像素和完整候选。如果媒体不可达或来源结构仍无效，保留具体 issue 和 Retry/Resync/Edit 恢复入口，不伪造成功、不强行发布。缺主分类只解释需用户分类，不能自动补齐。
5. 对 T142/T157/W203 分别实际打开 Edit、Preview，并核对同名多值规格、完整来源和报价；随后从当前已分类未发布商品选满 20 件，保留既有子分类，走 Assign category → Save and publish。逐件读回操作、批准版本、公开卡片/详情/配置/报价/MOQ/图片。表格 Publish 作为另外的入口测试，不替代这次验收。
6. 在 finally 和可恢复清单中，仅下架本次确认由验收发布的 IDs。未知回复先查原任务和公开状态；发现其他人修改时停止覆盖该对象。逐件验证不可公开访问、分类/人工字段保留、共享图片有效计数回到基线差值、其他原 live 商品不变。修复后的有效 observation 保留，不倒写旧坏来源。清理失败标为验收失败，记录剩余 ID 和可执行下一步。

## 本地证据

新增 catalog-selected-resync.test.ts，运行真实 syncSelectedAlibabaProduct、ingest、linking、promotion 与 JsonFileAdapter，raw bytes 使用专属 LocalDiskMediaStorage。provider 返回为合成数据，不冒充实际 Alibaba 调用或云端 MVCC/COS 验收。三种状态分别为未分类、已有分类、旧 live；来源改变后两次重开数据库重复 resync，验证始终同一产品/链接，不重复创建，人工标题/描述/价格/图片、分类和发布状态不变，其他 live 商品及共享图片计数完整保留。错误 provider ID 被拒绝，产品不变且租约释放。

首次测试将存储层 stale 与查询层 unchecked 混为一谈，三条均失败；对照原失效写入和查询契约，修正为 stale 映射到草稿 unchecked、旧 live normal，没有改变业务状态机。Node24 最终三条通过；Node20 与既有失效/分类映射组合 66/66、零跳过，本地类型和单文件 Biome 通过。首轮组合 65/66 的失败来自 harness 强制继承不含 JSX 设置的 local-server tsconfig，映射 UI 子进程因此报 React is not defined；改用绝对 site tsconfig 后同一测试通过，未修改原映射测试或产品代码。临时在 selected-sync 成功后强行写 published:true，测试立即失败，撤销后原文件 SHA256 恢复为 15ac3c749fe785deb5801d291996ea4da09da974b6ec290640a2e0f2fadc3c0c。

实际审查 selected-sync.ts、ingest.ts、linking.ts、promotion.ts、DB Alibaba 字段白名单与内容失效、现有分类映射和本地 JSON 测试。将“resync 后恢复未发布”更正为“resync 保留原发布状态，验收仅恢复本次新发布对象”，避免误下架原 live 商品。没有新增业务写入逻辑，也未实际 resync 云端商品；P7 真实三件和 20 件验收仍待部署后执行，fullDeliveryReady=false。
