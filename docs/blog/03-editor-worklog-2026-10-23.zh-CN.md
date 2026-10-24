# 本地接手云端工作：审查与文章编辑页

2026-10-23。原分支 `feat/seo-foundation` 已更新到云端提交 `832ea96133b88fd4727e7bde385c40ae657194b5`，包含 `1f7fac43` 的草稿服务和 `832ea961` 的 CloudBase 事务适配器。本轮在该分支继续，不创建分支、worktree、PR，不部署、不创建云端资源。

## 云端工作审查

对比范围 `cbe38b9d...832ea961`，对应模块 02 的计划与合同。由当前会话按项目要求直接审查，未委派代理。

| 检查 | 结果 |
| --- | --- |
| 身份与权限 | admin handler 先重新检查当前账号；仓储事务再次查 users，拒绝停用、降级和删除账号。文章未进入通用 CRUD，资源准备未加入默认部署 |
| 创建与保存 | CloudBase 用操作者/requestId 的确定性编号与内容摘要去重；事务内检查 revision，旧修订不能覆盖；本地文件适配器写失败恢复内存旧值 |
| 存储合同 | 读取重新校验，写入确认 updated/upserted，列表投影摘要，异常不泄露 SDK 栈；不回灌商品数据或改公开引用 |
| 入口与打包 | admin 云函数注入真实仓储，文章依赖进入 bundling；既有 SDK 总检查实际运行离线传输测试，不只查方法名 |
| 独立复验 | db 包 246 项通过；全仓回归、SDK 总检查、全工作区类型及 E2E 类型均通过。另读回云端精确 SHA 的 CI success：[832ea961](https://github.com/vibelingan/channel/actions/runs/39796228453) |

未发现需要重写这两个提交的后端阻断问题。真实 CloudBase 的隔离、权限与事务并发仍未现场验证，不能因为离线夹具通过就确认真实平台行为。本轮保留这一限制。

接页面前确认一个现有前端接线缺口：`admin/api.ts` 原来只保留错误 code/message，会丢弃云端新增的 currentRevision。本轮在同一个公共请求层保留该值，并增加回归；没有另造文章 fetch 层。此问题属于新前端接入前的完善，不把原本尚未实现的页面列为云端后端缺陷。

## 已实现的页面

- 原 DashboardShell 中新增仅管理员可见的 Articles 栏目。保持原默认栏目和布局，文章走独立页面，未注册成普通数据库 CRUD。
- 列表支持标题搜索、继续编辑和下一页；正文是独立 Tiptap OSS 组件，统一固定 **3.32.0**，不安装 Pro、Cloud、AI 或协作服务。
- 手动保存、指定修订预览、保存后重开和刷新。标题/正文为主，署名、slug、摘要及搜索字段折叠；较少用的格式收进 More formatting，没有发布假按钮。
- 请求复用 `admin/api.ts`，列表/详情用 React Query，保存/预览用 mutation。查询按账号隔离，登出由原 AdminApp 清空缓存。恢复标签页/网络可发现新版，但表单自己保留当前输入并提示，不用新查询结果覆盖正在编辑的内容。
- 未确认的创建重试沿用 requestId 和原内容；未确认的保存重试只在读回“恰好下一修订且内容一致”后确认成功，不自动把修订升高再覆盖。确定的冲突保留输入，回列表前提醒。
- 脏内容离开提醒涵盖后台栏目切换、回列表、返回站点、退出和浏览器刷新。上传尚未接入，本轮不提供上传按钮；已有图片只保留 mediaId/alt/caption/align 占位，遇到图片的预览明确说明未完成媒体接入。

编辑器的节点与文章核心保持一致。实际包检查发现，新版默认 orderedList 带 type、表格单元格带 align、链接带 title；本轮通过窄的扩展属性定义保持既定正文合同，没有放松服务端校验来迁就额外字段。格式样例覆盖全部启用节点/标记和原有图片引用，经真实编辑器 getJSON、保存和存储读回比较。

依据：[Tiptap StarterKit](https://tiptap.dev/docs/editor/extensions/functionality/starterkit)、[表格扩展](https://tiptap.dev/docs/editor/extensions/nodes/table)、[SSR 配置](https://tiptap.dev/docs/editor/getting-started/install/nextjs)及已安装 3.32.0 源码。此处沿用 Astro/React，并未迁移 Next.js。

## 实际验收

| 检查 | 本轮结果 |
| --- | --- |
| 完整仓库 `pnpm test` | 3,311 总计；3,308 通过、0 失败、3 个既有跳过 |
| 全工作区 `pnpm typecheck`、E2E 类型 | 通过；最终站点复验 0 error / 0 warning，保留既有与 beforeunload 的弃用提示 |
| `pnpm verify:cloudbase-sdk` | 通过，包含 CloudBase 草稿实际 SDK 离线传输；没有访问真实云库 |
| 独立本地产物构建 | 28 HTML 页、20 个可索引 canonical URL、sitemap/验证文件检查通过；只读取独立本地 API 的假商品 |
| 真实服务浏览器回归 | 7 项通过，0 跳过；最后一轮为**可见 Chromium**操作构建后的页面，真实登录、真实本地 HTTP、真实文件落盘；每轮使用独立端口/数据库并清理 |
| 脚本复用 | 原本地 E2E runner 增加可选 `--articles-only` / `--headed`，原默认测试模式及既有部署 workflow 未改 |
| 桌面与窄屏 | 1440 桌面和 390 窄屏截图已保存；窄屏无横向溢出，沿用共享 Select 和原响应式导航。窄屏模拟不是手机真机 |
| craft runner | 扫描器无执行错误、新增发现 0；仍有原基线 12 项（流程因果 1、旧表单 4、跳过 5、边界解析 2），两个依赖仓库配置的扫描项不适用，没有当作已覆盖 |

七项浏览器回归：格式保存/预览/重开/刷新；双标签冲突；真实断网后重试；侧栏离开提醒与窄屏；服务器已保存但响应丢失后的创建/更新重试；全部启用节点的编辑器往返和图片引用保留；常用格式、拒绝危险链接、表格增删及桌面/窄屏操作。响应丢失用真实请求先完成写入，再丢弃响应，不拦截成假的保存成功。

验证过程中发现并修复：断网时 mutation 默认暂停导致一直“保存中”；Tiptap 默认额外属性导致严格正文校验拒绝。还修正了浏览器用例对共享 Select 的角色假设，以及 Mac 上插入表格前必须真实点击段落折叠选区的操作。没有通过删断言或放宽正文规则求通过。

重跑命令（仓库根目录，Node 22.13.0 / pnpm 11.5.0）：

```bash
pnpm test
pnpm typecheck
pnpm verify:cloudbase-sdk
pnpm lint
# 独立本地 API + 假商品构建 + 浏览器 + 自动清理；不连接生产：
E2E_BLOG_SCREENSHOTS=1 node scripts/run-catalog-admin-local-e2e.mjs --articles-only --headed
```

截图位于 `output/blog-editor-2026-10-23/`。不要把 UI 图当成真实 CloudBase 验收。远端 CI 在推送后按本次准确提交核对，结果由最终交付回报给出。

## 与其他分支及后续衔接

只读 main 为 `404d1a257722175dcd70916e3f92ec6763fa0243`，pricing 为 `400e923b991e7a113a042c6d075781d6f40679f3`；本轮未合并或修改 pricing。它也修改过 DashboardShell、api.ts、site package 和 pnpm lock，后续整合要人工核对这些共享文件，不能承诺零冲突。本文新增文章目录独立，请求层只增加错误信息保留与已有 call 的导出，没有做全站请求迁移。

共同任务记录是 [NEXT-STEPS](NEXT-STEPS.zh-CN.md)，已接到 AGENTS、Blog 索引和云端交接入口。后续先做 E2 的媒体用途与归属、真实字节和 Blob 预览，再按明确授权核对真实 CloudBase。公开 Blog/SEO 发布属于 04，Hermes 草稿接口属于 05，均未实现；不因 E1 完成擅自开启部署和恢复。

本机 Documents 同步目录曾阻塞普通 Git 刷新，因此在临时普通源码目录执行验证，并逐文件核对后同步回原 checkout；它不是另一个 Git worktree，不改变分支模型。本轮没有复制凭证、上传私有业务记录或启动线上测试。

## 表达与资料核对

实际阅读了模块 02/03、云端两份实施/SDK/交付记录、AGENTS、Engineering Craft 的认证/前端状态/E2E/部署规则，以及已固定 dev-pipeline 的 Codex 适配说明和相关审查类别。将“适配器完成，编辑器可用”拆为“后端代码完成；编辑页经本地验收；真实库和部署尚未验证”，核对了提交、真实端口归属、存储路径、修订与测试统计。React 专项 skill 在本机未找到，未声称执行它；本轮以现有项目模式、已安装 React/Tiptap API、类型和实际浏览器结果核对实现。
