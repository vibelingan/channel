# 评审后图入口与复刻方法

11月18日多尺寸续作新增图源[image-responsive](image-responsive-20261118.sequence.json)，本机交付HTML为`output/responsive-images-20261118/image-responsive.html`。它说明本地已实现的尺寸准备、追加登记、浏览器选择、当前引用检查和中断重试；琥珀色卡明确标记尚未发布，不替代此前默认图的真实云上验收。只提交图源；HTML、截图及测试回执保存在忽略目录。生成命令沿用下文sequence入口，浏览器检查与人工看图结果记录在`output/responsive-images-20261118/local-receipt.json`，实现状态见[原模块文档](../01-images.zh-CN.md#多尺寸实现与交付边界11月18日)。

11月18日更新：图片上传图源`image-new-upload-20261117.sequence.json`已改为两类私有云上入口的实际验收状态；本机最新HTML为`output/source-media-probe-20261118/image-pipeline.html`。目录内同名旧HTML继续保留历史版本，不能据其“尚未上线”判断当前状态。复刻时将下方deliver命令的类型设为sequence、输入设为该图源，输出选择本机新位置。图源及小回执入Git，生成HTML和截图仍保存在忽略目录。

最新图片图的9项产物检查全部通过，错误/警告均为0；四个桌面尺寸及端点深浅主题的浏览器检查通过，并实际看过1440浅色和2048深色截图。源摘要`ab1aa61d485f81d879ecef49441d4234bba615fdb191e6819f704f8867b7a798`、HTML摘要`04a5e492875b9e47c1dd8f543c5ff3a02312e9119acaf07456b5b377806d56d0`，结构与视觉证据分别保存在[来源云上回执](../evidence/source-image-cloud-20261118.json)和本机同目录截图。下文11月12日三图仍为历史设计记录。

2026-11-12。本轮只更新设计。为避免每次提交大量生成HTML和截图，新版本提交源JSON及小型验收回执；HTML/PNG保存在仓库已忽略的 `output/seo-design-review-20261112/`，没有加入Git。目录内旧HTML和旧截图保留其历史版本，不是本次新方案。

| 当前图 | 源文件 | 生成结果 |
|---|---|---|
| 执行先后与条件任务 | [review-order](review-order-20261112.workflow.json) | `output/seo-design-review-20261112/review-order.html` |
| 图片生成、缓存与撤回时序 | [image-target](image-target-20261112.sequence.json) | `output/seo-design-review-20261112/image-target.html` |
| 模块分工与边界 | [module-map](next-phase.architecture.json) | `output/seo-design-review-20261112/module-map.html` |
| 当前真实部署分工，未因本次评审改变 | [runtime源文件](runtime-20261112.architecture.json) | [此前已核验HTML](runtime-20261112.html) |

## 本机或另一台机器怎样生成

需要Node及Archify 2.17技能包（`tt-a1i/archify`）。本机已安装于 `~/.codex/skills/archify`。其他机器先核实安装版本；不能用未记录的新版本重新生成后声称与本次字节相同。源JSON与程序化核验回执可直接从GitHub取到，生成结果在各机本地产生。

在SEO仓库根目录执行，`CHANNEL_ARCHIFY_DIR` 指向技能包目录：

```sh
CHANNEL_ARCHIFY_DIR="$HOME/.codex/skills/archify"
CHANNEL_SEO_DIAGRAMS="docs/seo/continuation/next-phase-design-2026-11-05/diagrams"
CHANNEL_SEO_OUTPUT="output/seo-design-review-20261112"
mkdir -p "$CHANNEL_SEO_OUTPUT"
node "$CHANNEL_ARCHIFY_DIR/bin/archify.mjs" deliver workflow "$CHANNEL_SEO_DIAGRAMS/review-order-20261112.workflow.json" "$CHANNEL_SEO_OUTPUT/review-order.html" --quality showcase --json
node "$CHANNEL_ARCHIFY_DIR/bin/archify.mjs" deliver sequence "$CHANNEL_SEO_DIAGRAMS/image-target-20261112.sequence.json" "$CHANNEL_SEO_OUTPUT/image-target.html" --quality showcase --json
node "$CHANNEL_ARCHIFY_DIR/bin/archify.mjs" deliver architecture "$CHANNEL_SEO_DIAGRAMS/next-phase.architecture.json" "$CHANNEL_SEO_OUTPUT/module-map.html" --quality showcase --json
```

每张图deliver成功后再执行对应命令，例如：

```sh
node "$CHANNEL_ARCHIFY_DIR/bin/archify.mjs" visual-check "$CHANNEL_SEO_OUTPUT/image-target.html" --json
```

`deliver`检查格式、布局和源文件/HTML摘要；`visual-check`在真实浏览器测四种桌面尺寸与两端尺寸的深浅主题。两者都不能代替实际看图。本轮已分别看1440×900浅色、2048×1320深色截图；修改后的执行图也重新看图。记录见[本轮图回执](review-20261112.receipt.json)，各图SHA-256用于确认看的就是所交付版本。

## 语义核对

- 执行图中的主线有明确先后，视频及请求改造是条件任务，不是自动启动的后台任务；图例“后端程序”不表示调用模型。
- 图片图将新鲜缓存、到期联网核对、撤回最后公开引用分开。五分钟为待业务确认建议；仍有共享公开引用时不应拒绝。
- 单尺寸修复先行，多生产者协调和响应式尺寸后续接入；旧缓存过渡及已下载副本的边界保留。
- 模块图是职责关系，不是所有模块必须串行。07延后，09由其他工作流负责，原SEO分支本次没有实施或部署。
