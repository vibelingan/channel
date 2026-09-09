# CUI-07：本地列表到共用详情的导航验收

日期：2026-09-07。工作区：`$CHANNEL_REPO`。
分支 `fix/alibaba-sync-storage-wiring`，HEAD 仍为 `60b051b`；本次变更未提交、未推送。

结论：CUI-07 本地完成。不是生产路由切换，不是云端同步或 RFQ 云端验收。
本轮没有部署、改云端配置、发布商品、触发同步、发邮件或写入测试询价。
既有本机用户询价、其它 worktree 和历史未提交工作保持原样。

## 实际接线

- 本地入口：<http://127.0.0.1:4328/headphones/?preview=shared>。
- 四个分类 Astro 路由实际都调用 `CatalogFamilyPage`，不是 `HeadphonesPage`。
  因此首先接实际路由；旧组件只增加相同的可选兼容接点，没有新建重复页面。
- `SharedCatalogPreview` 是 dev-only 组合层：原列表继续持有搜索、类别、已加载页数；
  打开详情时隐藏而不卸载列表，详情仍用 `CatalogDetailController`。
- 卡片按 canonical product ID 打开；不需要 slug、子分类或新数据库字段。
  URL 为当前分类页 `?preview=shared&id=...`，与已有 `/products/item/` ID 入口共用详情。
- 只有真实选中的 canonical SKU ID 才写入 `variant`；使用 replaceState，不重建详情、
  不清空数量，不给每次选型新建历史项。刷新/前进后重新通过批准版本与 SKU 存在性校验。
- Back 与浏览器返回恢复卡片焦点及原滚动位置；加载中和错误页也能返回。
  关闭卸载详情并取消请求，迟到响应不能重新开页。
- 新详情 404/坏参数不回退旧 DTO。不带 preview 参数的分类页和生产构建仍走旧页面。
  生产包经检查没有 shared preview 导航、详情或本地提交代码。

状态保留的寿命是当前文档：返回不丢搜索/筛选/已加载页数，但没有新增跨刷新列表缓存。
刷新详情仍按商品/SKU ID 打开；刷新后没有内存返回点，Back 展示当前分类的新列表。
URL/history 不保存买家联系信息、询价草稿、商品快照或 JWT；history 只有导航 token。
这次没有做类别映射，因此某些分类仍然没有本地样本，是数据归属问题，不靠导航伪造。

## 测试与发现

先写导航纯函数断言：列表模式、URL 构造/还原、canonical SKU、旧模式隔离、坏 ID。
未实现时 4 个用例失败，1 个旧模式保护通过；实现后 5 个通过，连原 preview 合同共 7 个通过。
浏览器实施前也实际点击过卡片：URL 不变，旧 detail=1、新 detail=0，确认了原缺口。

浏览器发现的真实问题：详情 ready 后聚焦标题同时滚动，会把 Back 放到固定页头上方
（按钮 y=-98）。改为外层负责定位、标题仅 `focus({preventScroll:true})`，复测按钮
桌面 y=88、手机 y=87.75，均可见，并保留键盘焦点语义。此边界已进入浏览器回归。

另外修正了测试自身的一处环境假设：4328 的默认 `/api` 代理与页面配置的 3013 样本
API 不是同一个本地库。分页测试改为捕获真实 UI 的列表响应后生成边界 fixture，
不再假设 `page.request('/api/...')` 就是 UI 当前的数据源。

### 本轮结果

| 检查 | 结果 / 范围 |
|---|---|
| Node 22.13.0 全仓 `pnpm test` | 1,370 passed / 0 failed / 0 skipped；site 327 |
| 全仓 typecheck，含 E2E | 通过；Astro 167 files，0 errors / 0 warnings / 8 既有 hints |
| 全仓 lint | 通过 |
| Node 22 site build | 15 页，成功 |
| 导航浏览器回归 | 6 passed / 0 skipped，Chromium，真实本地 API + 明确的边界 fixture |
| 既有详情/RFQ 只读浏览器回归 | 17 passed / 0 skipped；显式排除询价写入测试，不创建记录 |
| 桌面与手机人工脚本复核 | 1440×1000、390×844；返回滚动分别 844→844、1170→1170；焦点回原卡；无横向溢出 |
| 生产构建隔离 | 输出 JS 不含 preview 导航/详情/本地提交；临时 4330 静态预览忽略 preview 参数，ID-only item 保持旧 not-found |
| diff 与文档 | `git diff --check` 通过；README、DESIGN、MIU、registry 与本报告同步 |

导航的 6 项用例：

1. 真实样本搜索→详情→返回/前进，搜索与焦点/滚动保留，选型 URL 正确，数量不重置。
2. 第二页 + 非默认类别筛选返回后仍有 13 张卡，不重新请求列表。
   **13 张卡是浏览器网络边界 fixture，不是本地库新增 13 个产品。** 本地库仍是原 4 个样本。
3. 暂缓真实详情响应，加载中返回后再释放响应，详情不会复活。
4. 无 slug/类别依赖的深链、刷新配置恢复、新文档 Back 不跳外站、item 共用入口。
5. 坏参数、错误 preview 模式、不存在产品均不回退旧详情，仍可返回。
6. 普通分类 URL 保持旧详情、无 shared 导航。

未对另一条已无页面引用的 `HeadphonesPage` 兼容接点创建专门浏览器路由；类型与原组件
测试覆盖保留，浏览器证据针对真实 `CatalogFamilyPage` 路由。没有将未使用代码宣称为实页验收。
静态预览使用其默认本地代理的空列表，只验证旧 shell / preview 禁用，不把它算成真实商品列表验收；
实际样本列表的旧/新行为在 4328 上分别验证。

## 复跑与证据

```sh
NODE_OPTIONS= pnpm --package=node@22.13.0 dlx -c \
  'pnpm test && pnpm typecheck && pnpm lint && pnpm --filter @vibelingan-channel/site build'

E2E_SITE_URL=http://127.0.0.1:4328 E2E_SHARED_DETAIL_PREVIEW=1 \
  pnpm exec playwright test tests/e2e/shared-catalog-navigation.spec.ts --workers=1

E2E_SITE_URL=http://127.0.0.1:4328 E2E_SHARED_DETAIL_PREVIEW=1 \
  pnpm exec playwright test tests/e2e/shared-detail-preview.spec.ts \
  --grep-invert 'local inquiry explicitly saves' --workers=1
```

导航 suite 在执行前限制 loopback baseURL/API 与只读方法，不能用它向远端发送提交。
手动验收使用独立 `cui07` 浏览器会话，未使用或导出用户浏览器 Token。
所有新增源码/测试通过 `apply_patch`；没有引入路由、存储或表单新依赖。

日志位于 `/tmp/channel-cui07-final-validation.log`、`/tmp/channel-cui07-browser-tests.log`、
`/tmp/channel-cui07-detail-regression.log`。截图均已实际打开核看：

- `output/playwright/cui07-list-detail-desktop.png`
- `output/playwright/cui07-restored-list-desktop.png`
- `output/playwright/cui07-list-detail-mobile.png`
- `output/playwright/cui07-restored-list-mobile.png`

临时生产构建预览 4330 已关闭；原开发站 4328 和样本 API 3013 保留，未重置样本库。

## 下一阶段

CUI-08：补齐正式验收矩阵与完整本地采购者→询价→管理员跟进旅程，加入状态冲突、
失败恢复及重复提交的跨层核验。当前 23 项浏览器回归不能代替完整旅程验收。
之后仍需正式详情 API/入口、正式提交 transport、云端批准快照与资源预检/迁移接线。
这些完成并验证后提交同一分支、经审查与 CI 再整合 test，统一 CI/CD 发布；禁止回到逐函数手工部署。
邮件、订单/支付/发票、分类客户确认、Excel worker 启用仍独立后置。
