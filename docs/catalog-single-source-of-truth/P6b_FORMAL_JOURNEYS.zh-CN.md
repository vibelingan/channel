# P6b：正式浏览器流程、有效引用数与恢复

本单元把既有正式浏览器验收接到当前的稳定商品操作协议。没有改商品写入、审批提交、计数结算、来源转换或分类规则。唯一新增的后台能力是管理员只读查询图片有效引用数；普通 `get images` 的返回形状和原始字段含义保持不变。

## 先证明失败的原因

原始 raw-wire/raw-color 夹具的 PNG 无法通过实际解码，记录也缺字节数和 checksum。新版准备流程拒绝它们是正确行为。夹具改用既有 24×16 PNG 的真实字节，字节数和 SHA-256 从文件内容计算；不预先植入 ready、像素回执或审批回执。新增测试实际执行 seedRawCatalog、存储记录校验、磁盘读回和生产像素解码。旧夹具红测保留在 `formal-fixture-red-r1.log`；正测为 4 项（含只读计数接口）。有意验证坏图片兼容行为的其他夹具保持原状。

正式用例原先拦截旧 `approve/prepare`，无法触发新版 `product-operation-continue` 的故障。现改为核对 start 的原始 operationId、intent 和每次 continue；BUSY 注入发生在请求到达服务端前，只拒绝一次，随后必须恢复同一任务。并发下架场景实际先完成批准，再在浏览器收到 ACK 前通过受版本保护的 API 下架；确认公开 404、检查原发布不新建任务、商品保持未发布。

r2 的 20 件已全部发布并恢复，但失败断言比较了原始 `publishedRefCount`。该字段不包含已提交、尚未结算的终态凭证；原生计划器独立核对 9 张图均为 before base=1/effective=2、after base=2/effective=2。不能把这种差异改写成计数修复，也不能手工把 base 写回旧值。

r3 的 20 件已完成逐件公开内容、报价、分类和计数检查，并经 UI Disable 全部恢复；随后 finally 误去取消历史 complete 任务，被 INPUT_CHANGED 正确拒绝。现在仅取消尚未完成且未取消的任务，完成后仍逐件核对未发布、公开 404、原分类和有效计数。编辑用例的历史图片同理：before base=0/effective=1，after base=1/effective=1；那 1 个引用来自此前仍在线的夹具商品，不能归零。trace、原始 DB 和原生读函数的独立探针均保留。

## 只读计数接口

`getImageReferenceCount` 先经过现有认证和实时用户权限复查，仅 admin 可用；严格接收合法 imageId，拒绝 caller 传入 settle 或其他字段。接口只调用已有原生 `readCatalogImageReference({action:'read'})`，读取同一事务快照中的图片与终态凭证，不更新图片或结算凭证。返回 counted/effective count；旧记录缺计数返回 legacy/null，找不到和快照读取失败均明确报错，不退回误导性的 base=0。

实际 JSON 集成测试先走完整原生发布，制造 base=0、effective=1 的未结算成功凭证，再调用真实 Admin handler；逐字比较数据库未改变。覆盖额外字段、旧记录、缺图、原生读取失败、旧 admin token 对应账号降级或停用。降级/停用时没有原生计数读取。未新增 SDK 方法、SDK shim、集合或计数写入分支。

## 本地验证与边界

最终夹具/计数测试 Node 24 与部署 Node 20 均 4/4，零跳过；Admin/local-server/e2e 类型检查、5 个完整变更文件显式 Biome、CloudBase SDK gate 通过。对应 `p3e1/formal-fixture-count-green-r2.log`、`formal-node20-final-r3.log`、`formal-types-final-r3.log`、`formal-biome-final-r3.log`、`formal-sdk-final-r3.log`。

完整真实前后端脚本每次使用专属 JSON DB、媒体与同文件系统的构建目录。运行前将原 `output/playwright` 移到同文件系统备份，finally 恢复，并比较原 9 个文件的全部 SHA；新报告另存 `formal-canonical-playwright-rN`，不覆盖已有证据。r2/r3 均真实失败且保留；不能算通过。r3 为公开 41、目录/SKU 90 通过，正式 9/11；原始临时 DB/媒体和构建目录均已删除，原报告 9 个文件哈希一致。

r4 正式流程 11/11 全过，包含实际 Edit 冲突后停止、导出未保存输入、打开当前已存版本、正常草稿/在线保存及并发下架。随后 Admin 组合测试 8 过、1 失败、3 未执行：唯一失败要求共享图片清理后 404，但此前正式流程的 Manual Ready 商品仍在线，实际有效引用数为 1、图片返回 200。trace 只有这一条失败断言，其余混合成功/拒绝、回复丢失、读回失败、原任务重试均完成。现改为进入测试前记录有效计数及公开状态，清理后核对相同基线；另一个 20 件混合分类测试采用同一规则。这样同时覆盖独立运行的 0/404 与串联运行的 1/200，不能为测试撤回既有在线商品。

同一原生计数 helper 统一正式与 Admin 两套验收，严格检查图片身份、counted、非负安全整数。7 文件显式 Biome、e2e 类型及 Admin 构建（Node20 target）通过。临时将有效计数强制返回 0 的故障注入令真实 handler 集成测试失败，finally 恢复源码并核对 SHA 与 r5 的候选一致；日志 `formal-count-base-mutation-r1.log`。

r5 收齐：公开 41/41、目录/导航/SKU 90/90、正式流程 11/11、Admin 组合 12/12；最后 taxonomy 1 项失败。合计 154 过、1 失败，不是整体验收通过。正式流程的来源 20 件、表格 20 件和保留分类的混合 20 件均完成发布、逐件读回和恢复，原报告 9 个文件哈希一致，自建 DB/媒体与构建目录已删除。

taxonomy 失败不能归为提示文本过时：14 件实际均有 complete/current 回执且表格显示已发布，但 1 件最终读回超时，界面为“13 published · 1 couldn't be checked”并保留原任务。trace 中该件第一次状态读取耗时 6507.7ms，随后匿名详情 200，再次状态读取在共享 8 秒预算内未完成。未注入故障；正常组合下的这个确认失败及耗时原因留给下一单元定位，不增加超时或删除确认断言规避。证据为 `formal-canonical-all-r5.log`、`formal-canonical-preservation-r5.json`、`formal-canonical-playwright-r5`。本提交只关闭夹具、原协议接线和计数断言这一单元，P6 完整组合门槛继续开放。

性能另记：r3 trace 的 Confirm save and publish 点击到 Done 可见约 83.6 秒，测试包括首次来源/媒体检查、BUSY、随后完整读回和恢复；这是单个本地 JSON 案例，不满足“已准备 20 件、云端 P95≤60秒”的证据要求。不能拿整项成功代替速度验收。历史影子核对/回填、默认范围启用、云端原生交错、部署产物、test 三件时钟与真实 20 件及恢复仍有独立门槛。

写作复核实际对照本文件、handler.ts、两个新增本地测试、seed-raw-catalog.ts、catalog-formal-journey.spec.ts 与 r2/r3 trace：将“计数没恢复”改为有证据支持的“原始 base 与有效计数不同”；核对只读性、complete 不重跑、旧记录 unknown、分类和原报告恢复边界。没有据此宣称整项修复完成。`fullDeliveryReady=false`。
