# SEO-1：标准商品页与初始正文

状态：实施中。基线 main `37bcea5b`，共享基础 `6bcdaa1a`，pricing 已提交接口 `658d126a`。独立分支 `feat/seo-product-pages`；pricing 有未提交的后台创建/发布工作，本轮不修改它。

## Runtime problem

`SharedDetailPreview` 首次等待 effect 读取 query；`CatalogDetailController` 从 idle 发 open，旧 `LegacySkuDetailPage` 也在 effect 才消费 initialProduct。因此直接请求详情 URL 的初始 HTML 没有商品正文。匿名公开列表本轮观察为 487 条，多数没有 slug。

```tsx
const [state, setState] = useState(initialProductDetailState);
// open -> loading -> HTTP -> ready
```

## Data shape

| 数据 | 生命周期、范围 |
| --- | --- |
| 匿名完整商品清单 | 一次内容构建；分页 total/ID/公开字段一致性核对，不使用管理员账号 |
| product + 首批 detail | 公开投影；旧格式保留 legacy 组件，不因 detail 404 丢商品 |
| revision / 内容 hash | detail 使用公开 revision，legacy 使用公开投影 hash |
| `/products/p-<id>/` | 稳定 URL；不随标题或 slug 变化 |
| bootstrap / refreshing | 首次服务端和浏览器同数据 ready；更新中保留正文，权威 404 不继续报价 |

## Technology constraint

Astro 静态动态路由用 getStaticPaths 枚举。首轮不知道 query，variant 在 hydration 后恢复。构建必须提供明确快照或匿名 API origin；失败不能退回空列表。公开详情有每页/汇总容量和 revision 限制；pricing 新协议允许第一页返回更小 pageSize，后续固定实际 pageSize。

## Design / flow

匿名列表完整读取 → 公开详情/legacy 投影 → 再核对清单及详情 revision → 快照 → Astro 标准页 → 既有详情组件 ready → React 更新、选择、报价。

卡片改为真实 anchor，普通点击仍 preventDefault 后执行原 onOpen；修饰键和新标签走标准页。不增加按钮或改变卡片尺寸。沿用 Gallery、CatalogDetail、SkuDetailView 和现有询盘 transport。

## Best-practice fix

```ts
const initial = initialProductDetailState(bootstrap);
// refresh starts a request while retaining the ready body.
```

Node 构建读取和浏览器 DTO 分开；输入按公开 schema 白名单重建，丢弃会员、管理员及未来未知字段。Product/Breadcrumb、canonical、sitemap 使用同一 URL。元数据重复时增加稳定身份标记，商品可见标题不变。schema 不从首批变体猜全商品最低价。

## Alternatives rejected

- 仅取消 noindex：初始正文仍缺失。
- 新建 SEO 专用详情 UI：会与图库、价格和询盘规则分叉。
- 合并整个 pricing 分支：本轮只适配已核对的消费协议，保留其独立开发。
- 构建失败时忽略单个商品：会静默丢失公开清单，整个快照应失败。

## Code translation

快照模块只在 Node/页面构建入口使用。共享路径 helper 无 Node 依赖。Controller bootstrap 必须再次 decode；refresh 成功重新开始当前 revision 的分页，不能拼接旧版本。旧格式初始化同样 ready，保留原询盘入口。

## Risk / test

先写覆盖旧无 slug、字段泄漏、清单变化、分页错误、非 404 失败、较小 pageSize、refresh 不清空正文/404 清空的测试。真实构建覆盖当前所有公开 ID；无 JS 逐页检查正文、规范地址、schema 和 sitemap。有 JS 比较桌面/手机截图、图库、变体、URL 恢复、返回和询盘请求合同；询盘使用本地测试回执，不向客户创建真实询盘。

SEO-2 的内容触发、远端路径删除、缓存失效和线上读回不在本次部署；本次不部署。静态产物移除不代表 CloudBase 已撤回，需在上线前完成交付链路。

官方框架合同核对：Astro routing 与 framework-components 文档；同时以仓库已安装 Astro 6.4.2 的实际构建验证，不直接采用文档中新版本 API。
