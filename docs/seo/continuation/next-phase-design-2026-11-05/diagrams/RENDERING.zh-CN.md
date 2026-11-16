# 评审后图入口与复刻方法

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
