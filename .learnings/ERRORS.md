# Errors

## [ERR-20260728-001] integrated-browser-search

**Logged**: 2026-07-28T11:32:00Z
**Priority**: low
**Status**: resolved
**Area**: docs

### Summary

Google 搜索返回 429；Bing 导航超过 10 秒但已产出可读页面快照。

### Error

```text
Google: 429 unusual traffic / sorry page
Bing: page.goto: Timeout 10000ms exceeded
```

### Context

- 通过 VS Code 集成浏览器检索 Accio 官方 API/开发者资料。
- Bing 调用虽标记超时，但返回了正确页面标题、URL 和可访问性快照。

### Suggested Fix

Google 429 后不要重试；使用 Bing 或官方 URL。Bing 已有页面快照时直接 `read_page`，不要重复导航。

### Metadata

- Reproducible: unknown
- Related Files: docs/accio-alibaba-integration/task_plan.md

### Resolution

- **Resolved**: 2026-07-28T11:32:00Z
- **Notes**: 改用现有 Bing 页面和官方站点直达页。

---

## [ERR-20260728-002] macos-grep-repetition-limit

**Logged**: 2026-07-28T11:40:00Z
**Priority**: low
**Status**: resolved
**Area**: docs

### Summary

macOS grep 不接受超过 255 的正则重复上限，三条并行的上下文窗口查询均失败。

### Error

```text
grep: maximum repetition exceeds 255
curl: (56) Failure writing output to destination
```

### Context

- 试图用 `grep -oE '.{0,240}keyword.{0,500}'` 检查 Alibaba Open Platform 的压缩前端脚本。
- 三条并行命令使用相同正则形状，因此同因失败。

### Suggested Fix

对大压缩脚本使用 Node `indexOf` + `slice`，不要用 macOS grep 的大范围重复量词。

### Metadata

- Reproducible: yes
- Related Files: docs/accio-alibaba-integration/task_plan.md

### Resolution

- **Resolved**: 2026-07-28T11:40:00Z
- **Notes**: 后续改用 Node 字符串切片。

---
