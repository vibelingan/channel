# 01 文章核心：正文、渲染和草稿版本

## 要解决什么

现有后台用集合注册表、CollectionView 和 RecordForm 管商品；`packages/catalog-import/src/structured-content.ts` 负责把供应商 HTML 转成商品说明。它的降级、裁剪和字段推断适合导入商品，不能直接用于人工文章，否则未知节点可能变成普通说明或丢掉语义。

本模块 `BLOG-C1` 独立实现可复用的文章核心。没有数据库、网络、UI 或云端写入。未来后台保存、预览、SSG 和 Hermes 转入都用它，避免各写一份解析器。

## 数据形状

正文外层为 `{ schemaVersion: 1, document: { type: 'doc', content: [...] } }`。Tiptap adapter 只负责这层封装及相同的校验；当前树形结构与 Tiptap JSON 对齐，业务版本由我们维护。迁移其他编辑器时新增转换器，保留原正文和版本，不从生成 HTML 反推唯一正文。

支持段落、H2–H6、粗体/斜体/删除线/下划线/行内代码/链接、换行、列表、引用、代码块、分隔线、简单表格和 `articleImage`。正文不允许 H1，页面标题负责唯一 H1。表格首版不支持合并单元格或任意列宽；编辑器必须据此关闭对应操作。未知节点、属性、标记和版本返回带位置的错误，不静默剥掉正文。

`articleImage.attrs` 保存 `mediaId/alt/caption/align`，不保存 COS 地址、临时签名 URL、Blob URL 或作者指定的宽高。媒体适配器另行提供已核对的 MIME、尺寸和访问地址。公开输出只用可公开媒体；私有预览只用前端鉴权取字节后创建的同源 Blob URL。

文章内容包括 `title/slug/excerpt/authorName/seoTitle/seoDescription/body`。空标题和空 slug 可以保存草稿；准备发布时必须填写标题、有效 slug 和作者，并有可阅读内容。字段由严格 schema 校验，不接受 `published`、自定义脚本或任意 CSS。时间、修订和编辑者由服务器提供，不能从文章内容读出。

## 对外接口

```ts
fromTiptapJSON(input: unknown): ArticleDocument;
toTiptapJSON(input: unknown): ArticleDocument['document'];
parseArticleContent(input: unknown): ArticleContent;
renderArticle(input: unknown, options: RenderOptions): {
  html: string; text: string; mediaIds: string[];
};
createArticleDraft(input: NewDraft): ArticleDraft;
saveArticleDraft(current: ArticleDraft, input: SaveDraft): ArticleDraft;
prepareArticlePublication(current: ArticleDraft, now: string): ArticleCandidate;
```

前四个接口在浏览器和 Node 都可使用；草稿与快照操作放 `./drafts`，其中的内容 hash 使用 Node crypto，不进入编辑器浏览器入口。

## 版本与副作用

`saveArticleDraft` 要求 `expectedRevision` 等于当前 revision；有变化才递增。过期修订、倒退时间或版本溢出拒绝。相同内容重放不制造新版本。函数返回独立副本，不修改调用方的当前记录。**这只是版本规则；真正的并发安全由 02 的数据库事务完成，本模块不宣称已实现数据库原子保存。**

已发布记录只保存公开修订引用；保存草稿必须保留它。准备发布冻结 `articleId/revision/content/contentHash/frozenAt`，不设置 `publishedAt`，不把文章标记为已上线，也不更新 sitemap。已有公开 slug 时，改变 slug 必须走后续明确的地址迁移，不能自动换掉原 URL。

contentHash 对规范内容计算，不包含编辑者、冻结时间或部署时间。相同内容不会因重新构建而变成“文章更新”。真正的发布日期和显著更新时间由 04 在验收公开结果后维护。

## 渲染与扩展

输出只有固定标签、固定布局 class 和经过转义的文本/属性。链接只允许本站根路径、锚点和 HTTPS；拒绝脚本、data、协议相对地址、反斜线和控制字符。图片不发起后台下载，缺图或访问范围不对就拒绝输出，不以占位图冒充发布完整。

JSON 输入先检查循环引用、深度、数量和 UTF-8 大小，再进入递归 schema；限制为 32 层、20,000 个 JSON 值、512 KiB，避免合法外形的超大输入拖垮预览或构建。普通重复对象引用不是循环，不能误拒绝。

后续新增节点时必须同时增加类型/属性校验、编辑器扩展、静态映射和往返测试，再升级规则或提供明确迁移。一期不启用 `siteAction`。不提供“任意 HTML”旁路。

## MIU BLOG-C1 与验收

只交付“同一篇文章能安全地保存格式、转成正文，并冻结指定草稿版本”。代码分 document/article/render/drafts 四个模块；复用现有 Zod、tsx 和仓库测试方式，不新增收费或编辑器运行时依赖。

行为测试包括：基本节点和 Tiptap 格式往返；未知节点/属性/危险链接；循环/深度/大小边界；简单表格；特殊字符转义；公开/私有图片范围；正常保存、相同内容重放、过期保存、公开版本保留；快照不可被后续编辑影响；缺标题/作者/slug、slug 变化和空正文拒绝发布。

先运行这些行为测试得到失败，再实现。完成后运行包测试、typecheck、原仓库测试、lint 和精确提交 CI。没有页面接线，不把本轮记为客户可用编辑器，也不需要用新增截图证明一个未改变的 UI。

2026-10-22 本地结果：37 项行为测试通过，包测试同时运行 TypeScript 检查；包括审阅时补充的快照不可变、稀疏数组预算、嵌套表格和重复格式标记检查。整个包只新增在工作区，不接入现有后台或部署入口。完整回归与远端 CI 的实际结果随本轮交付记录保存，不以此推断云端或编辑器 UI 已验收。
