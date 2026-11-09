# Changelog

## v1.0.0 — 2026-11-09

首个公开版本。

### 功能

- **当前会话字面量查找**：中文友好（不依赖分词器），结果带轮次号与摘要，实时刷新（150 ms 防抖）。
- **跨会话搜索开关**：复用宿主 `session.search`；面板会明确标注"中文可能漏词"（宿主 FTS5 限制）。
- **像素级定位**：点击结果或按 `↑/↓`，视口精确停在匹配文字上，并逐层处理 DSH 的嵌套滚动容器（会话视口 + 展开的工具调用分组内层滚动体）；流式输出后按 anchor key 重查行重建 Range。
- **不碰 React DOM 的高亮**：CSS Custom Highlight API；不支持该 API 的环境降级为"只列结果、不画高亮"。
- **范围透明**：底部显示"已扫描 N 行 · 更早历史未载入 / 整个会话已载入"，并提供「载入更早」。
- **偏好持久化**：「跨会话」开关记在 localStorage。

### 开发期修复的 7 个运行时 bug

1. 插件不出现：`exports` 缺 `"./package.json"`。
2. `session.loadOlder is not a function`：slot inject 面返回查表函数而非会话对象。
3. `cannot get property "sessions" without inject`：未声明 `inject: ['slots','sessions']`。
4. 插件行重复注册：同时进 `dsh.profile.bundles` 与 `cordis.patch.yml`。
5. 跨会话点结果抛错：调了不存在的 `sessions.open()`。
6. 点击放大镜无反应：面板被 header 的 `overflow: clip` 容器裁掉 → 改 `createPortal` + `position: fixed`。
7. 点击候选定位不准：整行 `scrollIntoView` 把整轮居中 → 改为按匹配 Range 逐层滚动所有滚动容器。

### 质量与验证

- **81 项自动检查**（client 32 / panel 20 / host-resolution 11 / scroll 18）。
- **两轮 Subagent 代码复核**：第一轮抓到"内层滚动容器被外层短路"回归与"流式后 Range 失效"，修复后第二轮放行；第二轮用**变异测试**验证测试有效性（把实现改坏，对应断言立刻失败）。
- **真实 GUI 验收**（DSH 0.2.2-rc.1 / Windows）：长消息中后段定位、`↑/↓` 导航、展开工具分组后点内层深处理均通过。
- README 截图已做隐私脱敏（侧边栏/用户名/会话标题模糊，正文换用无个人内容的会话）。
