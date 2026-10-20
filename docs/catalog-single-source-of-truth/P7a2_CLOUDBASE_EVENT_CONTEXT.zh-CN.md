# P7a2：准备任务的云调用上下文

2026-10-20，原 pricing checkout，基线 2932216f。P7a1 已提交、审查并部署；三个服务在线 health 返回完整 SHA，54 个网站制品在线哈希相符。T142 现能建立原商品的准备任务，但明确 Continue 后返回 invocation=rejected、failureCode=FORBIDDEN，任务仍 queued、attempt=0。没有发布商品；20 件清单仍保持原分类与未发布。

## 根因与范围

实际浏览器 Network Response 定位到 worker 调用被拒绝。只读云端探针确认原任务 current=true，环境与两个服务的密钥比较一致；没有保存或输出密钥。安装的 node-sdk 3.17.2 在真实 Node20.19 云函数间调用时，业务对象自动带上 tcbContext、userInfo。合成签名对象直接 verifyCall=false，只移除这两个字段后 verifyCall=true。官方函数文档与已安装 SDK 的 callFunction 参数/返回形状已核对；当前无 Context7。官方文档没有充分说明这两个字段，结论来自实际调用返回，不以文档推测代替实证。

catalogPreparationCallInput 仅在 sync 的准备函数入口复制输入并移除这两个平台字段。HMAC、环境绑定、时效、nonce、租约和 worker 的严格 schema 保持原实现；其他未知字段保留并拒绝。userInfo 不提供用户权限，未修改登录、HTTP 授权、业务字段、分类、定价、批量并发或图片计数。

前台先前把被拒绝的调用显示为“A saved preparation task is available.”。现在将其明确标记为 rejected，提示查询结果后再尝试或编辑原商品。保留现有 Check result、Continue、Edit，避免把 worker 的 FORBIDDEN 当成人的账户权限不足，也不自动重发；原 BUSY 有界恢复逻辑保留。后端原有的完成状态优先逻辑会返回 recovered，新增前台合约测试确认这类返回仍为 ready，不增加多余调用。

## 可复查的证据

新增测试经过真实入口 index.main、生产 wrapper、worker 和 authority，只替换最终 DB claim 边界。修复前，带实际上下文的合法调用误返 FORBIDDEN；无上下文合法调用能到 NOT_FOUND。修复后两者均到 claim，输入保持原样；篡改签名、nonce、其他环境、额外 role/productId/ready/HTTP 字段均在读写 DB 前拒绝。前台 API 和真实浏览器红测还原 queued/media=null 的响应，确认失败提示、保留显式恢复入口和无静默重试。

修复后准备流程组合 63/63，Node20 入口/API 48/48。全量首轮因新增测试夹具的可选方法 mock 类型和 media=null 推断错误未通过，保留失败日志后修正夹具；不将该轮记为成功。全量复跑 7706 项中 7703 通过、0 失败、3 项既有跳过；最终追加前台 recovered-ready 合约用例后，准备组合 64/64、Node20 49/49，完整工作区与 E2E 类型、测试类型、lint 1086 文件和 SDK 门槛通过。追加用例不改变生产代码。制品构建与现场验收待执行。

生产 helper 在真实云函数间调用的只读复核通过：normalizedVerified=true、extraRightsRejected=true、tamperedSignatureRejected=true、inputUnchanged=true，零 DB/COS 写入，899 ms。临时函数已删除，函数列表确认回到原三个。该结果证明云调用入口，不能替代真实图片准备、发布和恢复验收。fullDeliveryReady=false。

私有证据位于 output/pricing-clock-repair-2026-10-13/p3e1/，包括 native-call-envelope-before-cloud.json、native-call-envelope-fixed-cloud.json、native-prepare-status-cloud.json、native-call-envelope-red-r2.log、native-call-envelope-ui-red.log、native-call-envelope-green.log，以及后续全量日志。

实际 review 了 catalog-preparation.ts、新入口测试、catalog-preparation-authority.ts、index.ts、runPreparation、CatalogPreparationControls 和真实浏览器夹具。文字把“签名错误”更正为“合法签名对象因平台额外字段被严格 schema 拒绝”，把“修复了发布”限定为“修复入口并等待现场发布验收”。已比对实际 Response、真实云字段、拒绝测试、零写入边界和三个原函数身份。
