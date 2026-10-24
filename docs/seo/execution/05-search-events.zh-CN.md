# 05 搜索事件

状态 `planned`，MIU `SEO-REL-E1`。本模块先交实际内容差异、合并及预览；Google/Bing 的稳定 sitemap 地址继续使用，不要求本期新增外部推送服务。

## 输入、存储与调用合同

拟新增 `scripts/release/search-events.mjs`、`scripts/drain-search-events.mjs` 和 `scripts/search-release-events.test.mjs`。输入只接受 B 已提交的 activation/change-set 引用，不读取工作目录中尚未验收的 dist 当作现网事实。

```ts
type SearchChange = {
  url: string; activationId: string; generation: number;
  semanticHash: string; state: 'present' | 'withdrawn';
  notBefore: string;
};
type SearchDelivery =
  | { state: 'disabled' | 'superseded' | 'pending' }
  | { state: 'sent'; provider: string; attemptId: string; semanticHash: string };
```

公开 HTML/标题/canonical/schema/URL 状态决定 semanticHash，内容 hash 的规范化规则版本化。代码 SHA、构建时间、JSON 对象键顺序不构成内容变化；`lastmod` 缺可靠来源就不造时间。

每次激活的 URL 差异预先封在候选 payload 内，B 原子提交一个 change-set 引用；worker 分页读取并按 URL upsert `siteSearchEvents`，可重入 checkpoint。不要把数千个商品事件塞进发布控制面的一次事务。恢复 A 也用新的 activationId，旧 B 事件不能继续通过“同 SHA”检查。

## MIU SEO-REL-E1：只合并和通知实际有效的变化

当前发布链路没有可靠的通知队列；目标是在成功提交后记录变化，默认发送器 disabled，不把“未配置推送”写成 sent。

```js
const active = await store.readActive(targetId);
if (event.activationId !== active.activationId) return superseded();
if (event.semanticHash === lastDeliveredHash) return noChange();
return sender.enabled ? sender.send(event) : disabledPending(event);
```

约 30 分钟稳定窗是本项目可调参数，不是搜索引擎规定。worker 不在持部署锁的进程里 sleep 等待；可手动 drain/预览，未来启用具体发送器时再接独立调度。预览必须显示待发 URL、hash、状态和抑制原因，不能改写 active。

只有已确认送达 A 的 baseline 才能让 A→B→A 合并为不发送；没有 lastDelivered 时保留当前候选，不能凭空假设 A 已通知。B 若已发出，无法撤销；后续按当前 A 状态合并。外部调用超时用 attemptId 和读回/重试策略记录未知结果，不无限重发。

发送前重新读 active/generation，检查当前 URL；它与外部平台之间仍没有原子事务，最后检查之后又发生发布时可能有一条很快过期的通知。后续对账修正，不因此恢复站点。sitemap 文件由 C/D 与页面同时交付，不能为了稳定窗继续列出真正撤回的 URL。

不采用每次部署重提完整 sitemap，也不调用 Google 索引/移除工具模拟通知。IndexNow 仅是后续可插拔 sender；本 MIU 的完成不以“已接入 IndexNow”计。[Google sitemap 指南](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap)、[IndexNow FAQ](https://www.indexnow.org/faq)。

拟测试 `A B A before send produces no duplicate delivery`、`disabled sender does not mark sent`、`new activation supersedes queued event`、`notification error never rolls back active site`。命令 `node --test scripts/search-release-events.test.mjs`。主要通过本地可控 clock 和 fake sender 验证；F 确认 canary 不在 sitemap、不发生对外通知即可，无需线上反复通知搜索引擎。
