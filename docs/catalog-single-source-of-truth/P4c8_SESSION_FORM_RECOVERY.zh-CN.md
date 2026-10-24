# P4c8：登录过期时保留后台表单

已在实际 AdminApp 复现旧问题：后台列表返回 401 会清掉 session 和 query cache，再跳转登录页，未保存输入随页面离开。红测日志 `admin-session-form-red-r1.log` 保留。

验证过的后台现在保留原界面，用第二层 native dialog 暂停操作。请求发出前核对原账号；回复回来再核对原会话，避免迟到响应进入新会话。只有 me 身份核对可在暂停时请求。浏览器换账号或存储不可读也暂停，原账号和权限未确认时不恢复写入。

恢复顺序是核对服务器用户及角色、通知原表单登录变化、重连原创建/编辑控制器、恢复请求、刷新只读查询；不自动重放保存、创建或发布。创建保留原 nonce、原输入和回执指针。未保存正文留在原表单内存，需要离开时下载当前输入，使用 Blob 后撤销 URL；不会把正文或 JWT 写进恢复 journal。显式退出登录仍沿旧路径。

后台通用表单和分类编辑注册当前输入 getter；不从 DOM 抓字段，不重建组件。商品控制器按原 actor 和 endpoint 重新核对。原权限已改变时继续暂停，用户可下载后离开。此处只解决会话恢复，通用非商品 CRUD 的跨网络幂等性并未因此获得保证。

实际组合已通过 43/43：Chromium/WebKit 打开通用表单后遇到 401、禁止 Escape 关闭、保留原输入、暂停期零写请求、下载后再允许离开、拒绝其他账号，以及实际商品创建后进入编辑、第二次验证再保存同一草稿。商品保持未发布、无分类不补分类，未调用通用 product create/update。另覆盖创建验证与保存互斥、验证中途切换账号、丢失创建回复后仍只有一个原商品。

独立故障注入分别移除请求暂停、迟到成功回复核对、表单重连；对应测试确实失败。每次进程退出后才恢复源码并核对 SHA256，见 `admin-session-fault-proofs.json`，没有把编译错误当作反例。

复核并实测了 token A → B → A 的边界：旧 A 成功回复被误接收，旧 401 和缓存错误又暂停新会话，三条红测都失败。现在每次重连递增独立代次，错误所属代次留在 WeakMap，迟到成功/401 和缓存旧错误都不进入新会话。修正后的组合 46/46，Node20 核心 36/36；浏览器再覆盖同 token 验证并实际刷新查询，防止缓存旧 401 反复锁住表单。

审查涉及 AdminApp、DashboardShell、API、session guard、内存表单 registry、恢复 dialog、RecordForm、分类编辑、商品创建/编辑控制器及对应真实 Admin/JSON/浏览器测试和宿主。对照统一 session 的本地/跨 tab 事件、React StrictMode 清理、query cache 通知、native dialog 焦点和窄屏溢出。文案把“重新登录即恢复”改为“确认原账号和权限后恢复”；核对无自动写入、无 token 序列化和原商品身份。

没有新增 CloudBase SDK 方法、集合、环境变量或权限配置。无部署、无真实商品变更。live-edit、历史审计、完整后端制品和 test 的真实三时钟 / 20 件 / COS / P95 仍未完成，fullDeliveryReady=false。

SDK 核对：已安装 @tanstack/query-core 5.101.0 的 `_tsup-dts-rollup.d.ts` 1307–1308 行确认 cancelQueries / invalidateQueries 返回 Promise<void>；[官方 QueryClient 参考](https://tanstack.com/query/latest/docs/framework/react/reference/classes/QueryClient) 及官方 query-cancellation / query-invalidation 说明分别取消查询、使查询失效并重新读取，不重放 mutation。Context7 不可用；直接旧参考 URL 返回 404 后，以官方检索找到当前地址，不把 404 当作 SDK 不存在。

最后新增的真实组合另外抓到一个缓存事件问题：实际 handler 已创建草稿后暂扣回复，原账号换 token，验证先因创建仍在运行而暂停；释放旧回复并再验证时，缓存的旧 UNAUTHORIZED 在 observerOptionsUpdated 中再次锁住界面。已安装 query-core 的 mutationObserver.ts 78–82 行、mutationCache.ts 的事件联合类型独立确认了通知机制；AdminApp 现在只对 updated/error 新事件处理鉴权错误。原红测两个浏览器均失败，修正后 `admin-session-committed-creation-green-r1.log` 46/46。该组合实际查询原创建回执、确认只有一个原商品，没有再次 start。

Chromium/WebKit 的 390px 恢复弹窗截图已实看：原表单仍在、恢复操作可见、页面无横向溢出，图见 `admin-session-recovery-ui/*-2.png`。前两轮整站分别 1313/1316 通过、0 失败、各 1 个图库开关跳过；它们早于缓存事件修正，不能代表最后源码。最终整站 r3 为 1316 通过、0 失败、1 静态开关跳过，183080ms；显式图库 r1 为 11/11、0 跳过。15 文件最终 Biome、diff check 和 Astro 检查通过。首轮 Astro 新增 role:string 错误已按 SessionUser 的 Role 联合类型收窄，保留失败日志。正式构建验收紧接 P6 的同磁盘构建修正，尚未计为本单元完成。
