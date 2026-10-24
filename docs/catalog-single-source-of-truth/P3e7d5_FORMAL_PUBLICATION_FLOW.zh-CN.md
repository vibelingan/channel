# P3e7d5 构建后的分类发布与配置边界

状态：本 MIU 本地验收通过；全交付门槛仍开放，尚未部署。

## Runtime problem
新的原操作必须通过 handler 的 enableDetailApproval 守卫，但分类弹窗未查询能力，关闭配置仍可点发布并先写分类。正式 E2E 仍拦截旧 update/approve，不能证明新操作。正式夹具三处 1x1 PNG 的 IDAT CRC 错误，已独立计算验证。

## Data shape and constraint
能力只包含 enabled:boolean，从现有 catalogDetailCapabilities 获取；失败/加载时禁用发布，分类保存仍可用。错误可重试，查询不能写分类。原操作 ID、分类版本和恢复指针维持前一 MIU 的合约。配置改变后后台守卫仍是最终权限判断。

## Design / flow
能力读回 → 明确入口可用性 → 预览确认 → 分类 CAS → 原 start/continue → 原 get 与公开读回。正式页面按真实原操作拦截完成回复丢失、读回失败和暂停；故障恢复不得换 nonce。只使用 runner 的一次性 DB、本地 PNG、假账号。测试结束按原 operationId 核对并恢复未发布。

## Alternatives rejected
不因正式测试失败而放宽 PNG 校验；不把旧 REST 拦截保留下来冒称它仍在注入故障；不跳过能力关闭路径，也不让用户点击后才知道无法发布。

## Code translation
API 解码能力 boolean；弹窗用既有 useQuery / 按钮 / alert，pending/error/disabled 都禁止发布但允许分类保存。正式 fixture 替换成项目已验证的真实 PNG。测试监听 start 记录原 operationId，只有真实 complete 后才丢弃响应。

## Risk / test
先补两引擎配置关闭的红测，再实现能力入口及失败重试；正式 Astro 列表弹窗验证排除选品不变、部分拒绝、并发改稿、丢完成响应、读回后恢复、重试中禁用与相同 ID 继续。严格保留恢复及未发布读回。完成后 review、局部测试和构建，再决定是否需要完整组合重跑。

## Writing review
已审阅 handler.ts 的角色/能力守卫、Editor 的 canPublish、正式 E2E 的旧拦截、prepare-catalog-pricing.ts 的三处 PNG。将“发布失败”细化为“能力关闭时入口仍可点，分类先保存后发布被拒”，区分配置问题与商品数据问题。

## Cold shared-image defect and bounded recovery

r2/r3 的测试图片先因缺 byteSize/checksumSha256 被 stored-record 守卫拒绝；原 1x1 PNG 的 IDAT CRC 也独立验证为错误。补成合约完整的 24x16 PNG 后，r4 才暴露真实并发问题：一件成功，另一件原准备任务仍 queued/current、worker 明确 rejected/BUSY，客户端却结束为 needs-action。此前 20/100 集成预热过图片，未覆盖这一冷共享交错。

新增不预热的真实 20 件集成红测，以及两引擎各 20 件冷图片的完整分类 UI。runPreparation 只在明确 BUSY 拒绝后，最多四次延迟 400/800/1200/1200ms，重读同一个 job。当前性、leaseVersion/attempt 不倒退、createdAt 不变、queued/continue 才允许下一次调用；原发布包装器还会在每次准备写前核对原 operationId/digest。已 ready 只读结束；响应不明、权限变化、未知跟进、状态失效都不盲重发。原 64 RPC/120s 预算和原任务 ID 保持。raw HTTP BUSY 也先查状态；原始 transport 仍不自动重试。

## Final verification

新增 20 项＝12 准备恢复控制、1 能力解码控制、6 浏览器子流程、1 冷20处理器集成。最终 site1157/1157、Node20改动核心163/163、Node20真实 warm20/warm100/缺分类/cold20 四集成通过；每个正常发布样本均按原回执撤回，确认详情/图片404及有效引用回到基线。两引擎实际 UI 各自 warm20/cold20，不把已预热结果冒称冷路径。

正式 Astro 后台八条全部通过，retries=0，无失败、flaky或skip。覆盖分类名称/过滤/分页、完成回执与列表读回失败、Check later/焦点/切区、分类响应丢失/Escape、平板可见性操作、贡献者权限、合并发布故障组合、归档。最初整组 r7 因另外两条旧 update 拦截等待超时，1过/1败/6未运行；迁移 start/真实 complete 回复后，r8/r10 八条全绿。关闭审批能力的独立正式路径 r9 通过：只保存分类，零 publication start。两条“成功原回执”正向测试在关闭能力时有显式 opt-out，关闭路径另有实际负向测试；启用整组没有跳过。

缓存重开还发现了另一个 UI 缺口：旧 enabled 缓存重查时，按钮短暂可点。先前严格请求次数断言被 StrictMode 双只读请求挡住，不算产品红测；改为检查分类可保存及发布按钮后，Chromium 确实显示 enabled 而应 disabled。加入 isFetching 保护，并覆盖旧数据重查失败及只读重试，两引擎和最终全站通过。

11处故障全部检出、22个重叠失败，3源码 SHA 恢复；能力 boolean/关闭/重查/旧缓存错误、明确拒绝、四次上限、fresh读取、租约/attempt/创建时间均有反例。站点/E2E/既有测试类型、11文件Biome、15页构建通过。16张最终截图及SHA保留，已看390缓存错误及1280冷20完成页。早期错误、trace、JSON报告均留在各自r目录；一次临时runner选择断言在启动前失败，不计业务失败。

## Review and remaining work

实际检查11个源/测试文件、handler能力及角色守卫、图片record/字节校验、原准备工作流/状态机、原任务包装器和共享队列。所有重试仍是同任务，后台claim与保护锁决定能否写；源/产品/身份/租约变更停止，不用最新商品行冒充旧回执。没有改变生产图片校验或新增SDK方法，后端精确制品、657 SDK/14进程仍9efd824c，不当成本轮重跑。

本轮关闭分类恢复的正式UI门槛；完整公共路由组合、保留现有混合分类、大批次UI、编辑/创建/新照片/live-edit/Preview接线、跨标签多指针及不存在任务fallback、P5历史与实际3时钟resync、原JSON80原始失败归因、真实CloudBase并发/角色/COS/网络P95与真实20恢复，均仍开放。fullDeliveryReady=false。

## Writing review update

将“PNG就是失败根因”改为“先是记录缺元数据，PNG另有CRC问题，修正后暴露BUSY停止”，并把“全测试完成”限定为本轮站点和分类正式组。核对原队列仍共享4而非跨标签锁；暖/冷、HTTP模拟/本地真实处理器/实际云环境分开记录。
