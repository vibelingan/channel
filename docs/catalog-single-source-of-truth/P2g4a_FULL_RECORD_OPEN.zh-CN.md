# P2g4a：编辑与预览先读取完整商品

## 运行问题和边界

CollectionView原来把列表row直接传给RecordForm/PreviewModal。后续若从列表省略描述等大字段，表单会把缺字段初始化为空，保存时可能覆盖原内容。即使row完整，用户点击时它也可能已经过期。本单元先切开“列表显示摘要”与“完整记录打开”的边界；实际服务端/原生字段投影继续P2g4b，当前列表仍返回原完整行。

```ts
// 原实现
onClick={() => setEditing(doc)}
// 当前产品入口
openRecord(doc, 'edit');
// 确认实际get返回同ID、且仍是当前打开请求后
setEditing(product);
```

复用现有RecordForm、PreviewModal、原生dialog及样式。小型读取对话框只负责Loading、Retry load、Close；失败不把列表row当作编辑替代品。错误文案不输出原始响应、私有字段、token或堆栈。非product集合保持原来的打开方式，没有新增接口、存储或认证域。

| 数据 | 存续 | 作用 |
| --- | --- | --- |
| productId/kind/sequence | 当前CollectionView内一次明确打开 | 产品ID相同也不代表同一次请求，避免A→B→A接受旧响应 |
| currentOpening ref | 同步更新，关闭时立即清空 | 在React卸载清理或网络取消之前拒绝旧完成结果 |
| loader active/controller | 一次effect及其显式Retry | 清理后忽略完成，取消浏览器HTTP读取 |
| 完整product | 成功打开后的现有表单/预览 | 保存使用实际读取的opened记录及既有版本检查，不用旧列表值填默认项 |
| 表单编辑 | 已打开表单自身状态 | 不因后台列表刷新重新读取/重挂表单而丢输入 |

sequence是本地只读请求身份，不是P3需要的持久化写操作ID。getRecord沿既有签名get接口读取并保留同ID检查，新增可选AbortSignal传给原callOnce。它仍有原HTTP超时/有限BUSY机制；取消HTTP不承诺取消已在服务器执行的只读查询，也不声称能回滚写操作。该打开流程本身不发起任何写入。

## 选择及接缝复核

ProductRecordLoader effect只随产品ID或明确Retry改变，回调ref避免父组件刷新造成无意义重读。父组件按sequence重挂loader并用请求对象身份检查完成结果；子组件清理active并abort。关闭可随时执行，错误只提供读取重试。只有成功且仍归当前请求时才挂载原表单/预览，后续输入由原表单管理。失败时保留可关闭的对话框，不静默展示空表单。

逐一改接行Edit、行Preview、带Changed/Removed的Publish转Edit、Preview的Review changes和Edit。审批后的已有完整响应继续沿原逻辑更新预览；表单See changes读取已经加载的完整editing记录。DashboardShell按collection.name重挂CollectionView；不把上一集合的打开过程接到另一集合。updateProductFromEditor仍使用传入opened的ID/时间戳和原意图规则；本单元不宣称解决P3的全部generation/lifecycle竞争。

拒绝用部分列表字段补表单、在读取失败后继续保存、无身份的Promise完成回调、每次父刷新重新读取并重建表单，以及把客户端取消当服务端回滚。没有新建另一套写操作状态机或持久化草稿。

## 红绿和组合证据

初始实际浏览器红测为12正控/5失败，省略字段的表单描述确实为空；另有getRecord取消13正控/1失败。实施后完整字段/新版本读取正常。第一次31项28过/3失败：StrictMode试运行提前消耗一次性网络故障，及测试在脏表单Cancel后未处理既有确认。改为故障持续到明确Retry，保留StrictMode；慢读案例转为真正Save并核对目标ID。第一版测试插入定位不唯一的脚本在写文件前被断言拒绝，留记录，不算产品失败。

负传输场景明确忽略HTTP abort，仍使用实际GET、完整原响应字节；读完响应后发出完成标记，测试等待它再检查和保存。组合删除loader active和父请求身份保护后，表单文字仍保留，却实际写到了blocked而非ready。测试以真实update请求ID及数据库读回检出，避免只看文字得到假绿。正确实现只保存ready，其他产品整行不变；随后重开blocked也正确。

最终21个实际浏览器场景包括原列表/分类/准备流程、摘要缺字段、旧列表与当前版本、Edit/Preview各自503和错ID重试、取消后晚到结果、带审核标记的行Publish与Preview Review changes。写场景核对目标与保留内容；只读/重试/审核入口比较整份JSON字节，并断言无update/batchUpdate/catalogDetailApproval。两处旧静态测试固定setEditing(row)，全量首轮725/727因此失败；同步入口约束后，另外补真实审核入口测试，不能只改正则让它变绿。

8项源码反例在最终48项组合中全部检出，每次保留42–47正控、1–6失败：Edit/Preview跳过完整读取、错ID、取消信号、组合旧完成保护、Retry不重读、带标记Publish及Review changes绕过读取。最后两项要求实际浏览器场景失败，不能仅靠源码正则。全部finally恢复并核对三个生产文件SHA。补390px错误弹窗后，原错ID反例再跑45正控/3失败；最终再跑全量729通过。

最终site729零失败/跳过/取消，显式开启图库浏览器；Node20客户端17通过，Astro216文件零错误/警告、8既有hint；6个完整代码/测试文件显式Biome与diff通过。8反例后的源码无逻辑改动；手机补充只加断言与截图。没有重新宣称本单元重跑了全部后端；后端源文件未改，前一单元的精确三函数产物验证仍是对应基线证据。

证据目录output/pricing-clock-repair-2026-10-13/p2g4a：record-open-red、record-api-red、record-open-green1/2/3、record-review-entry-green、record-site-full/final/final2、record-node20-client、record-astro-final、record-biome-final3；fault-final和fault-mobile-identity含恢复manifest/统计。实际390px错误弹窗截图product-read-mobile-error.png已查看，页面不溢出，重试后可正常打开、关闭表单；所有本次列表临时夹具已清理。构建及精确SHA审查随后记review侧车。

## 简化、契约与继续事项

实际复核CollectionView.tsx、ProductRecordLoader.tsx、api.ts、catalog-list-api.test.ts、catalog-list-readiness-browser.test.ts、product-review-render.test.ts，并追踪DashboardShell、原RecordForm初始化/Cancel、useModalDialog和updateProductFromEditor。来源/图片/供应商子面板仍沿既有机制；没有把raw数据放入URL或新缓存。新生产调用只有既有React hooks与第一方getRecord；没有新CloudBase SDK方法、依赖或shim。

写作检查实际修正测试标题“关闭后不能留下活跃raw读取”为“向HTTP读取传递取消”，避免暗示服务端查询被取消；核对21场景、48组合、729/17/216、实际写入ID及0临时夹具。未把隔离组件路由与受控传输说成正式部署或现场结果。

P2g4b仍要实现实际有界列表响应与原生字段投影，并验证数据/字节预算；P3/P4/P5/P6/P7的稳定写操作、大媒体、过期草稿/占用、历史修复、云端race、性能及真实20件发布恢复继续。没有部署或客户数据写入，没有新分支/worktree/PR/push；fullDeliveryReady=false。
