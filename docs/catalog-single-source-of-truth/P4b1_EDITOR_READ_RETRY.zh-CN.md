# P4b1：编辑附属读取独立重试

范围是现有 RecordForm 的供应商变更、Alibaba 照片读取与原始编辑入口，沿用现有后台样式。两项读取失败各自提供 Retry，显示读取进度，失败不会要求关闭表单。每次重试只重新读取自己的面板，不自动应用供应商数据；Keep/Use 仍由用户决定。响应同时检查本次尝试与 effect 的取消状态。

浏览器先让实际 AdminDetailPreview 返回校验错误，再从修复按钮打开实际 RecordForm。测试使用签名管理员、真实 client API、admin HTTP handler、JSON 数据库和实际 supplier/photo DTO。初次两项读取分别返回503，用户输入名称和描述，再分别重试；交叠场景让供应商响应晚于照片返回，在等待中继续输入。最后通过 updateProductFromEditor 的版本保护保存，验证输入保留、未发布、未强加分类、照片和来源观察未变、供应商待审核未被清除，实际审批集合和发布凭据未变。只有一次 update，零 prepare/begin/page/finish/create。读取成功和仅发出请求分开断言。

初始红测检出两个 Retry 按钮缺失。最终7个源码故障分别破坏供应商触发、照片独立性、两项错误提示、两项读取保留编辑、输入不触发重复读取；每次均有15正控和2个浏览器断言失败，不以语法错误或整项超时代替检出。持久备份、恢复原字节和SHA256记录在 output/pricing-clock-repair-2026-10-13/p2d9/raw-editor-fault-summary.json。

恢复源码后，完整site677项全部通过，图库浏览器检查显式开启；零失败、跳过、取消。Node20两文件17项通过；Astro213文件零错误/警告，8个既有hint；三个完整代码文件显式Biome、CloudBase SDK gate、diff检查通过。精确提交的生产site构建另记审查侧车。没有修改SDK、依赖、云资源或鉴权协议。

边界：这里验证的编辑保存是隔离JSON环境，尚非test客户选品验收。读取面板重试不等于登录过期后的草稿持久恢复。单张来源照片导入仍有使用旧表单快照覆盖并发删除/排序的代码风险，下一单元先做实际浏览器反例。P2准入、P3稳定操作和合法大媒体事务、P4其余恢复、历史修复、性能及真实20件发布恢复继续，fullDeliveryReady=false。

文案核对 RecordForm、两个新浏览器文件、实际API/schema和故障日志。将“Close and open the product again”改为表单内独立Retry及“Your edits are still in this form”；对照真实保存记录核对输入、分类、发布、来源和审批状态，未把本地通过写成线上完成。
