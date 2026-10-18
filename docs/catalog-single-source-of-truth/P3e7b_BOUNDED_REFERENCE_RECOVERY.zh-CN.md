# P3e7b 有界满槽恢复调用

基线d7835de5。目标是让现有DB index的persistCatalogDetailApproval内部reference-page入口实际调用可信恢复，不靠测试手工给旧root。此入口仍未接客户UI，不冒充整体发布修复。

内部planner仅PENDING_FULL返回服务器产生的pendingReferenceImageId；freshmutex MEDIA_BUSY无此hint，不发起清理。封装器先重查自己的当前原操作及冻结计划，确保hint属于本次至多20张的实际页；再点读该图并完整验证明确base/全部80成员。每次最多点读3个候选根，复核其commitment与实际图片成员相同，再调用已有operation-recover；所有权限/原owner/scope/input/TTL/不可变终局资格仍由原事务决定。unknown读错误向上传播；缺失/坏根不猜cancel。

遇到已取消/完成/成功退役项后，只重试同一页一次，由已有C1完整结算并暂存原操作，绝不自己改图片计数/删pending/发布。3个候选均健康或未知时返回有界referenceRecovery cursor（imageId、完整ledger哈希、nextOffset），下次内部调用带回；当前图或账本改变重置为0。cursor只选择已验证的该页图片中成员，不授予任何写权限，不需另存第二套状态根。读取/清理总启动预算12s，超时不再发起下一次写；已生效的取消审计永久保留，重试读取恢复。

检查：PENDING_FULL与mutex区分/假hint拒绝，cursor校验与ledger变化重置/健康前缀可扫描后续，3候选上限/时间预算，未知IO失败不猜缺失/撤权，原操作版本变更停止，首个可恢复项后同页续接，丢取消回应/重复/权限变化只复用同根。保留原manual80组合；新增actualJSON80根→index自动识别旧根→原81页成功/effective0/category/unknown peers不变。实际SDK验证index真实caller、readsTX预算/ACK/丢回应。独立源码故障、整体回归/types/构建/真实PNG后才记录本步通过。

待客户operation-continue使用该cursor与稳定operationId后才称用户满槽自动恢复。整体UI P1/liveedit/review/history/provider/P95/三时钟20件门槛保留。


## 实施与最终检查

生产DB index的persistCatalogDetailApproval现已实际调用恢复封装器，绑定同一adapter实例的get/persist；内部直接adapter依然是原事务原语，避免递归。原输入schema不增字段，续接cursor是index第三个服务器参数且先strict校验；公开状态start/get/cancel不会转发此cursor或内部回执。只有planner确实遇到PENDING_FULL才给pendingReferenceImageId，fresh mutex继续普通MEDIA_BUSY且零发现。own-root重查必须当前actor/product/operation/input、版本、TTL与本次20图页匹配；实际图片点读后验证明确合法base、完整128KiB/80成员/唯一root/Merkle路径。每批最多3个候选点读，commitment必须相同，再由原operation-recover事务独立决定资格。坏/缺根不伪造cancel proof；未知IO和权限失败停止。

实际成功/已终局后只重试原操作原cursor一次，由原C1结算、图片和原根耦合写；封装器没有直接image/counter写、额外root或锁。游标绑定完整账本hash+实际图片，变化重置0、尾部回0；它只导航已验证成员，不能指定任意product/root。首个页、own-get、图片读、候选读及恢复提交的每个异步窗口均受12s单调performance.now预算保护，超预算不启动下一次写或发现。前两个等待后写窗口及第三个own-get后多余发现窗口均先红后修；预算不能硬取消已经发出的provider请求，真实延迟仍待实际云验收。

新增38项（DB37/JSON1）；441相关、全量5724、实际Node20关联2736，0失败/跳过/取消。19工作区types、E2E types、standingSDK、七文件Biome与diff通过。初始自动caller+精确hint两项业务红；保留原actualJSON80人工恢复测试，只抽取共用夹具，不削弱断言。新actualJSON80全为原start/save/begin/pages/media/references/stage产生的根，index自动识别旧失效root、原第81页成功；79其他pending+新根仍80，effective0、无commit proof、productfalse/分类字段值及存在性保留，重复0文件写。三候选导航、游标重置、权限/未知IO/错根/坏ledger/时间预算使用明确模拟peer恢复，只证明调度与边界，不冒充真实资格或MVCC。

最终源码20故障全部检出，18测试组56重叠失败+2SDK-only，五源码SHA恢复；两个SDK反例分别断开实际index和篡改续接cursor，均先完成459原控制后特定断言失败。R1格式定位失败不是产品反例；保留日志，最终R2全部重新执行，没有沿用修复前源码结果。组内scope比较被其他绑定重复保护的事实保留，不声称每个门槛单独必要。恢复后474SDK和441控制重新通过。

实际安装NodeSDK3.17.2/database1.4.3 HTTP-only探针474=原459+15：真实index自动退役+同页续接、重复零写、root/proof六种ACK整笔回滚/重试、退役commit已生效丢回应后保留首次审计并续接、原SDK start等待改输入、3候选/后3候选、事务外候选coded/malformed读确实抛错且零写；正常20图片页仍88文档操作/一个原事务/零额外发现get。全套最大单事务98未变。恢复最多分离事务，不把跨事务总数误作单事务预算；真实CloudBase首次读快照/写冲突、网络/COS/P95未验证。

四个独立Node24/20进程使用真实worker保护24x16 PNG及编译Admin start/status/cancel：原私有暂存404，创建并保存第二个真实操作、放入79合成未知占槽，index自动退役旧失效根/原页续接，丢回答后重开同页零写，原取消状态可查，取消第二操作并C1结算保留79未知项，商品/图始终404、私有SHA/尺寸和分类保留，owned夹具清理/父owned文件未改。此物理链为2个真实根+79合成peer，不冒充actualJSON80全真实根或80客户商品。混合编译产物d7835de配当前JSON/index；精确本提交产物需随后补记。R1脚本把inputDigest误传入严格get，正确被拒；改成显式productId/operationId后R2通过，未放宽生产schema。

人工审阅五生产、两测试及四记录，沿index→hint→own-get→image/member→候选→原可信恢复→同页C1/ACK/公开图追踪；native/JSON完整文件、原save actor/classification fence和legacyworkflow未改。文案把“自动清理全部满槽”纠正为“有界扫描可信候选并续接原页”，核对actual80、两真根79合成、472/474 SDK和真实PNG范围。首轮隐式any及两项测试类型收窄错误（其中一项修正前重复报告）均用实际类型修正，无unsafe fix。precommit lint--silent已知错误不作为证据。

## 仍然开放的边界

客户operation-continue/UI尚未调用该入口或保存cursor，不能说客户满槽自动恢复已交付。所有候选均健康或损坏、无法可信退役时保留账本，返回有界等待进度；用户级有限重试、Data issues/人工修复提示仍需continue/UI接线，不能把反复MEDIA_BUSY称作易用fallback。原正式UI整笔发布丢回应P1、live-edit/review/history fallback、真实provider/P95、三时钟resync/load/Edit/Preview和20保留现分类商品发布后回退未完成。客户新producer关闭，fullDeliveryReady=false。
