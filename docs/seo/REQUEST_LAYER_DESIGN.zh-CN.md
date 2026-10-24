# 前端请求与 React Query 统一设计

2026-10-20。设计稿，本轮不落地公共层。SEO 在 `feat/seo-foundation` / `f5150e5` 上继续；pricing 初读为 `3d157ac4`，结束前推进到 `d0863eb3`，新增提交没有改动本设计涉及的公共 catalog/shop/lib 请求代码或部署入口。未提交内容不纳入兼容性结论。实施迁移前需要再次核对双方 HEAD。

## 当前为什么有两种实现

网站已经安装 React Query。`AdminApp.tsx` 在后台 React 树中创建 QueryClient 和 Provider；默认关闭重试和窗口聚焦刷新。独立 Astro island 不会自动继承另一个 island 的 React Context，所以公开商品页没有这个 Provider。

公开详情已有 fetch transport、解码器和业务状态机。商品 SSG 复用了它，再增加 bootstrap 和挂载后 refresh。这个沿用决定减少了当时对交互的修改，但保留了两套请求生命周期管理。SSG 可以和 React Query 配合，手写 effect 并非 SSG 的要求。公共层需要统一；不能把目前三个 effect 都解释成今后必须保留的结构。

| 现有位置 | 已复用的能力 | 仍分散的能力 |
| --- | --- | --- |
| `lib/api-url.ts`、`lib/api-envelope.ts` | API 地址、envelope 解析 | 不承担完整 HTTP 生命周期；泛型本身不验证业务 payload |
| `islands/admin/api.ts` | 后台 action 调用、token、错误、30 秒 signal | 其他后台模块另有调用器；响应体边界未统一 |
| `islands/admin/inquiries/inquiry-api.ts` | inquiry 解码与调用 | 自己组合 15 秒 signal 和错误处理 |
| `islands/admin/alibaba-catalog-sync/alibaba-api.ts` | 同步任务相关请求 | 另一套请求和业务错误入口 |
| `islands/shop/api.ts` | 目录 DTO 解析与调用 | 自己请求；目录可能携带登录身份以取得相应价格 |
| `catalog/infrastructure/catalog-detail-api.ts` | 匿名、取消、字节上限、runtime decoder、revision 检查 | 没有完整请求超时、Query 缓存和自动恢复刷新 |
| `catalog/application/public-quote-transport.ts` | 询盘协议、幂等与业务校验 | 必须保留写操作语义，不能套用普通读取的重试规则 |

React Query 管服务器状态、缓存、取消信号和重取调度，底层仍需 fetch/HTTP transport。HTTP 层、Query 层和商品状态机应各自有明确职责。[TanStack Query 取消请求](https://tanstack.com/query/latest/docs/framework/react/guides/query-cancellation)。

## 建议的四层结构

```text
页面与展示组件
  └─ 业务 hooks：useCatalogDetail / useCatalogList / useInquiry
       ├─ queryOptions：key、initialData、刷新、重试、失效规则
       └─ 领域 API：catalog / inquiry / admin / auth
            └─ HTTP transport + envelope reader + runtime decoder
```

1. **HTTP transport。** 注入 base URL、fetch、AbortSignal；明确 anonymous 和 authenticated 两种身份，公开 SSG 不读取浏览器 token。截止时间覆盖请求头和整个响应体，合并外部取消，限制解压后字节数，失败时取消/释放流。统一网络、超时、HTTP、业务 envelope 和解码错误，保留 status/code/retryAfter/requestId。泛型返回值必须经过业务 decoder。上传、流式 AI 和二进制预览保留专用 transport，复用取消与错误基础能力即可，不强制经过 JSON 解析器。
2. **领域 API。** 负责 endpoint、参数和 payload decoder，例如 `catalogApi.detail({productId, revision, page, pageSize}, {signal})`。只负责数据契约，不读 React state、不跳转页面、不弹 toast。Node 的采集脚本可直接使用它，不引入 React/Query。
3. **Query options。** 集中定义 key、queryFn、retry、staleTime、initialData 和失效关系。重试只由这一层负责，HTTP 层不再重试一次；仅对可安全重试的读取做有限退避。401/403/404、解码失败和业务冲突不按网络故障无限重试；429 尊重服务器提示。现有 detail 的失败 union 要在 Query adapter 转成可识别错误，不能把 `{status:'network-error'}` 当成功数据缓存。[Query options](https://tanstack.com/query/latest/docs/framework/react/guides/query-options)。
4. **业务 hooks。** 组合 query 结果、revision 分页、变体选择和 URL 状态。页面保留渲染、DOM 聚焦和必要浏览器事件，移出请求 effect、通用取消和重复调度。询盘输入草稿仍是客户端状态，数据刷新不得重置用户已填内容。

这些名称是建议目录与接口，不表示本轮已经新增了这些模块。

## 商品详情的具体接法

- “最新详情”key 和“固定 revision 的分页”key 分开。key 包含 API origin、public/auth 范围、商品 ID、view、分页协议、pageSize；固定分页还包含 revision/page。分类列表包含筛选、排序、分页。身份相关数据另含稳定 session 身份标识并在退出/切账号时清理，不能把 token 原文写进 key，也不能让会员价格进入匿名缓存或构建产物。
- 构建数据通过 `initialData` 输出首轮正文；只注入与该 query 请求完全一致的数据。当前快照只是首批变体，不能冒充完整详情聚合结果。后续分页使用服务器实际协商的 pageSize 和首批 revision，新 revision 出现时重新组织分页，不能拼接版本。
- `initialDataUpdatedAt` 应取可信采集时间；当前快照 schema 没有该字段，迁移时必须一起补 schema、decoder 和 fixture。不能用浏览器 `Date.now()` 冒充内容更新时间。`staleTime: 0`、挂载重取可满足先显示正文再校验 API；后台刷新失败继续显示已有正文并明确重试，确认 404 则进入撤回态。[初始数据与重取](https://tanstack.com/query/latest/docs/framework/react/guides/initial-query-data)。
- 先使用普通 `useQuery`，避免 Suspense 改变目前正文保留和错误区域。Query 的 signal 传到 HTTP 层，切商品/取消时让库正确识别取消。revision 的业务一致性检查仍保留；React Query 不代替它。
- 聚焦、重新联网重取在公共 Query 配置集中设置；bfcache 的 `pageshow.persisted` 在 Provider 边界统一触发相关 query 失效，避免页面再各注册 focus/online/visibility 监听并并发重复请求。刷新阈值需按真实请求量确定，不照搬后台关闭聚焦刷新的默认配置。[默认刷新行为](https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults)。
- 不让两个独立 Astro island 误以为共享一个 Provider。先在目录/详情各自的根 React 树设稳定 QueryClient；确有跨 island 共享需求再引入浏览器级 owner。服务端渲染不得使用跨请求的全局 QueryClient，避免账号数据串用。构建渲染与浏览器首轮必须收到相同 bootstrap。
- 询盘 mutation 默认不自动重试；需要恢复提交时沿用相同幂等键和后端 revision 验证，不把一次重试变成第二次询盘。读请求刷新不能重建询盘草稿或覆盖用户选择。

## 迁移顺序与检查

这轮先确认合同和目录，不迁移正在并行开发的调用方。pricing 合并边界明确后，做一个可单独验收的纵向切片：公共 HTTP reader → 详情 domain API → queryOptions → `useCatalogDetail` → 现有 Controller。保持原 DTO 和组件 props，验证通过再逐步接目录列表、后台 inquiry 和其他后台调用。

迁移验收至少覆盖：初始 HTML 和 hydration；同 key 去重；切商品取消与迟到响应；响应头/体超时和字节上限；404/409/429/503；revision 分页；后台错误不能变成成功缓存；匿名与会员缓存隔离；退出后清理；焦点/重连/bfcache；刷新不丢询盘输入；mutation 幂等；原图库与变体交互。删除旧请求 effect 时，相关用例必须仍经过实际 Query adapter，而不是只测原纯状态机。

## 本轮核对记录

实际阅读：上表文件、`CatalogDetailController.tsx`、`ProductLanding.tsx`、`catalog-detail-pages.ts`、`catalog-product-detail-state.ts`、site package/lockfile，以及 TanStack Query v5 官方文档。pricing 未提交内容未复制、未测试、未修改。

措辞修正：“当前 effect 有必要”限定为现有组织下有用途；设计上应交给 Query 的网络生命周期不再继续按页面复制。“没有公共请求层”改为“已有 URL/envelope 等基础能力，完整 transport 与错误/刷新策略尚未统一”。这些是代码核对和设计判断，迁移本身尚未实施。
