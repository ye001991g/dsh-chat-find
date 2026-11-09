# 安装 dsh-chat-find（Chat 正文查找插件）

## 当前状态：**已安装 + 已修 6 个 bug（2026-11-08 在真实 GUI 实测通过）**

| 项 | 状态 |
|---|---|
| profile 依赖 | ✅ `@local/dsh-chat-find` 在 `node_modules`（`file:` 依赖是**复制副本**，不是软链） |
| `cordis.patch.yml` 插件行 | ✅ **不重复挂载**：只靠 `package.json` 的 `dsh.profile.bundles` 一行（见 Bug 4） |
| `dsh.profile.bundles` 元数据 | ✅ 完好 |
| 原有依赖 | ✅ 全部保留 |
| 备份 | `package.json.bak-*`、`cordis.patch.yml.bak-*`（安装脚本生成） |

### ⚠️ 只有「首次安装」需要这两个动作

**1）在 GUI 的插件管理里把它打开。** 默认是"关闭"状态。

这不是可有可无的——`dsh-client-modules/lib/index.js` 的扫描逻辑会跳过 `entry.disabled` 的行：

```js
if (entry.options.name !== entryName || entry.fiber === void 0 || entry.disabled) continue;
```

**被禁用的行根本不会被扫描**，客户端模块压根不会注册 → 界面上不会出现任何东西。

**2）首次装载后重启一次 DSH。** 客户端 JS 是**新模块**，HMR 只能替换**已加载过**的世代，不能首次装载一个新模块。

> 已完成首次装载的插件，之后改 `client.js` **不需要重启**（见本节末尾的 HMR 说明）。

### 已修复的 7 个 bug（都是运行时才暴露的）

| # | 症状 | 根因 |
|---|---|---|
| 1 | 插件完全不出现在界面上（静默） | `exports` 缺 `"./package.json"` |
| 2 | `载入更早历史失败：TypeError: session.loadOlder is not a function` | **inject 面返回了"查表函数"而不是会话对象** |
| 3 | `跨会话搜索不可用：Error: cannot get property "sessions" without inject` | 未声明 `inject: ['slots','sessions']` |
| 4 | 插件行重复注册 | 同时进 `dsh.profile.bundles` 和 `cordis.patch.yml` |
| 5 | （review 发现）跨会话点结果会抛错 | 调了不存在的 `sessions.open()` |
| 6 | **点放大镜图标"没有任何反应"（图标在、点了不出面板）** | **DSH 0.2.2 把 header 动作槽包进 `overflow: clip` 的 `.titleCluster`，`position: absolute` 的下拉面板被裁成一条 ~30px 的横条，等于不可见** |
| 7 | **搜索后点击候选，视口定位不准（停在长消息中部，而非匹配处）** | **`hit.el.scrollIntoView({block:'center'})` 居中的是"整轮 row"；一行 = 一整轮，长回复可数屏高，居中整行后匹配点可能落在视口外** |

**Bug 3 的机理**：`sessions` 服务由 session-controller **在它自己的 ctx 上** `provide`，属于兄弟 fiber。Cordis 的取值会沿 fiber 链向上找，找不到就抛那句 "without inject"。声明 inject 后 `Fiber._reload` 会把注入到的服务放进本地 store，于是可取。修复：`inject: ['slots', 'sessions']`。

**Bug 2 的机理（更隐蔽）**：slot 的 inject 面是**被调用**的，返回值**原样展开成 props**（`runInject` → `bindInjectSources`）。我写成了 `() => ({ session: (id) => ... })`，于是 `props.session` 是个**函数**，自然没有 `loadOlder`。
**而且我自己的测试掩盖了它**：测试里手动 `injected.session('sess-1')` 再喂给组件，伪造了运行时不会产生的形状。已改成展开 inject 面，并加断言禁止 `session` 是函数。

**Bug 5**：`ISessions` 上**没有 `open()`**（那个 `open()` 是 `Session.open()`）。已改用官方惯例 `ctx.uiWorkspace.openSession(id)`。

**Bug 6 的机理（DSH 0.2.2 的布局变化，2026-11-08 定位）**：插件原来把面板写成 `.dshfind-root`（`position: relative`）里的 `position: absolute; top: 100%`。DSH 0.2.2 的会话 header 结构变成：

```
.an3WzG_titleRow  (container-type: inline-size)
└─ .an3WzG_titleCluster  (overflow: clip + mask-image 渐隐遮罩)
   ├─ .an3WzG_crumbs
   └─ .an3WzG_headerActions   ← 插件挂在 conversation.session.header.actions
      └─ .dshfind-root
         └─ .dshfind-panel (absolute, top:100%)   ← 完全落在 titleCluster 之外
```

`overflow: clip` 会把面板裁到 titleCluster 的 content box（高度 ~30px）里，而面板从 trigger 下方才开始 → **整块被裁掉**。表现就是"点一下图标只看到图标变灰，什么都不出来"，而 React 状态其实已经 `open=true`（用 UIA 树能读到面板的输入框与复选框，但截图里一个像素都看不到）。

修复：面板改为 **`ReactDOM.createPortal(panel, document.body)` + `position: fixed`**，坐标在打开时用 trigger 的 `getBoundingClientRect()` 算出（右边缘对齐，钳制在视口内），并在 `resize` / `scroll` 时重算；`pointerdown` 的 outside-close 同时检查 trigger 与面板两个 ref（面板已在 `body` 下，只查 rootRef 会让面板内点击被误判为"点外面"而立即关闭）。

**Bug 7 的机理（2026-11-09 定位）**：点击候选的跳转原来是

```js
hit.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
```

`hit.el` 是 `[data-chat-anchor-key]` 行 —— 而 DSH 的"一行"是**一整轮**。一条长回复（比如带多个表格的长答案）就是一个 row，高度可达 3000–5000 px，远超视口。`block:'center'` 对超高元素的实际效果是"把整行居中"，于是视口落在**整行中部**，与匹配点可能差两三千像素——这就是用户截图里"点了第 2 条，却停在『四、验证』而不是『六、…』"的原因。

修复：**滚匹配点，不滚行**。
1. 从命中项的高亮 `Range`（`hit.first`）取 `getBoundingClientRect()`，拿到匹配文字自己的视口矩形；
2. **收集匹配到会话外层之间的所有滚动容器**（内→外）：DSH 除了会话滚动容器 `[data-conversation-scroll]`，还有内层滚动体 —— 展开的 process group body 是 `max-height:min(400px,50vh); overflow-y:auto` 并带 `[data-step-process-body]` 标记（`dsh-client-ui-chat` 源码里同名属性/类）。命中若在这个内层 body 里，只滚外层会让整组被推出视口、匹配仍不可见 —— 这是第一版修复的回归，已改为一层一层滚：先内层、后外层，每滚一层重读 Range 矩形；
3. 目标 `scrollTop = container.scrollTop + (rect.top - box.top) - (box.height - rect.height) / 2`，clamp 到 `[0, scrollHeight - clientHeight]`；单容器用 `smooth`，多容器用 `instant`（避免平滑动画的异步与下一层测量竞争）；`prefers-reduced-motion: reduce` 时一律 `instant`；
4. **点击时重解析命中**：扫描结果是快照，流式输出可能已经替换文本节点（Range detached）或重建整行。`refreshHit` 会按 `data-chat-anchor-key` 重查行、必要时用 `compileQuery` + `highlightRow` 重建 Range，避免退回到"整行滚动"这个原 bug；
5. 兜底：拿不到 Range、Range 几何为 0（确实无法重建）、或找不到任何滚动容器时，才回退到 `row.scrollIntoView`。

配套回归测试 `test-scroll.mjs`（18 项断言 / 9 场景）：单容器精确居中（手算 `scrollTop=2310` + 物理不变量"匹配中心=容器中心"）、**内层滚动体双层**（手算 inner=610 / outer=1900、顺序 inner→outer、instant、最终居中）、无 Highlight API 时重建 Range、零矩形回退、无 data 标记靠 computed overflow 识别、超界 clamp、**文本节点被流式替换后重建**、**整行被流式替换后按 key 找回**、`prefers-reduced-motion` 降级 instant。

**两轮 Subagent review（deepseek-flash / max）**：
- 第一轮**不放行**：指出 (1) 只找第一个滚动容器会让「展开的 process group 内层滚动体」里的命中把整组推出视口（回归）；(2) 流式后缓存 Range 失效会退回原 bug。两条均已修（即上面的第 2、4 点）。
- 第二轮**放行**，并用**变异测试**验证：把 `scrollableAncestors` 改成"只取第一个"→ 场景 B 立刻失败（inner=1/outer=0、matchCentre=2300 而非 400）；把 `refreshHit` 改成"直接返回缓存"→ 新增的 G/H 场景失败（scrollTop=0、rowCalls=1）。正常代码下全绿。
- 复核锁定的 `client.js` 哈希：`8815830D…`（2026-11-09 01:07:07）。**若再改 client.js 需重跑复核**。

**已知遗留（非阻塞，本轮未改）**：
1. **面板遮挡**：匹配被放到滚动容器垂直中线，而面板在右上（宽 360、高可到 ~430px）；窗口高 ≤860 且行尾命中时，中线可能落进面板竖向范围。建议后续把落点压到面板底边以下或 40% 位置。
2. **折叠区搜索**：`isHidden` 用 `closest('[hidden]')` 会把 `hidden="until-found"` 的折叠区一起跳过（与 collectRows 注释的"应包含"矛盾）；扫描后中途折叠再点命中会出现"Range 仍连接但零几何 → 重建也拿不到 → 回退整行"。修法需在点击前 dispatch `beforematch` 展开（DSH inspector 的做法）。
3. **回退强度**：`revealMatch` 的 `moved` 只表示 `scrollTo` 没抛异常；`[data-conversation-scroll]` 未校验是否真可滚。若未来 marker 挪到不可滚包装层，会静默不滚也不回退。

**Bug 4**：`dsh.profile.bundles` 里的条目会**自动应用该包自己的 patch**，所以 GUI 那一条已经足够；脚本再往 `cordis.patch.yml` 插一行就会**挂载两次**，而 `conversation.session.header.actions` 是 `kind:"list"`，重复 `id` 会抛错。已删除 patch 行，并把「不得重复挂载」写成回归测试。

### 另外修掉的一处**会损坏 React 渲染**的问题

高亮原本用 `<mark>` 包裹匹配文字——**这替换掉了 React 自己的文本节点**。React 之后往那个已脱离文档的节点写字，表现为**搜索过后那段文字不再更新**，删除时还可能抛 `NotFoundError`（在 React 的 commit 里，外部 try/catch 抓不到）。

已改用 **CSS Custom Highlight API**（`CSS.highlights` + `Range`）：**完全不碰 DOM**。不支持该 API 的环境会降级为"只列结果、不画高亮"，并在底部注明。

顺带修掉：折叠区（`hidden="until-found"`）之前被跳过（DSH 自己刻意让它们可被浏览器查找）；嵌套分组行导致匹配被**重复计数**；`loadOlder()` 在非 `open` 状态静默 no-op 且永不 reject，已改为显式检查状态。

> **`pnpm add file:` 是复制而非软链接**，所以改完源码必须 `remove` + `add`（或直接 `Copy-Item` 覆盖）才会刷新 profile 里的副本。`install.ps1 install` 单独跑会显示 "Already up to date" 而**不更新**。
>
> **改完 `client.js` 不需要重启 DSH（2026-11-08 实测）**：`@deepseek-ai/dsh-client-hmr` 每 500 ms 对所有 client bundle 做 stat 轮询，文件 mtime/ctime/size 一变就 `clientModules.rebuilt(id)`，再经 `/plugins/events` SSE 推 `rebuilt` 帧给浏览器，浏览器端 `entries.reload(id, rev)` 热重载该模块。实测：`Copy-Item` 覆盖 profile 副本后约 2 秒，client graph 里 `@local/dsh-chat-find` 的 `rev` 从 `d557984e1e94` 变成 `1aeabce5a386`，图标自动重新注册、新代码立即生效。想确认是否已重载，直接读 `http://127.0.0.1:<port>/plugins/events` 首帧里该条目的 `rev`。


> ⚠️ 重启会终止正在进行的 DSH 会话。只有「首次装载」必须重启；已装载过的插件改代码走上面的 HMR。

### 检查 / 卸载

```powershell
$d = "<your-repo-dir>"
pwsh -File "$d\install.ps1" status      # 只读，看当前接线状态
pwsh -File "$d\install.ps1" uninstall   # 移除插件行 + 依赖
```

### 如果重启后 DSH 起不来

用备份还原这两个文件，然后重启：

```powershell
$p = "$env:USERPROFILE\.dsh\profiles\desktop"
Copy-Item "$p\package.json.bak-20261004_174152"      "$p\package.json"      -Force
Copy-Item "$p\cordis.patch.yml.bak-20261004_174152"  "$p\cordis.patch.yml"  -Force
```

（patch 是纯追加，理论上加载失败只会跳过插件、不会阻止启动；上述还原是万一。）

---

## 方式 B：命令行安装（需要重启）

在你方便的时候，**在一个普通 PowerShell 窗口**里执行（不要在 DSH 会话里执行）：

```powershell
# 1) 链接插件依赖
node "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs" `
  --dir "$env:USERPROFILE\.dsh\profiles\desktop" `
  add "file:<your-repo-dir>"

# 2) 让 profile 加载它：在 $env:USERPROFILE\.dsh\profiles\desktop\package.json 的
#    dsh.profile.bundles 数组里加一行 "@local/dsh-chat-find"。
#    ⚠️ 不要再往 cordis.patch.yml 加 insert 行——bundles 条目会自动应用本包 patch，
#    再加一行会挂载两次（见 Bug 4）。
```

然后 **重启 DSH 一次**（首次装载）。

> ⚠️ **重启会终止我们这个会话。** 所以请在你不需要我继续干活的时候做。
>
> ⚠️ 客户端 JS 是**新模块**，所以必须重启才能加载（HMR 只能热替换已经加载过的世代，不能首次装载一个新模块）。

---

## 装完之后怎么用

1. 打开任意一个会话。
2. 会话头部（右上角动作区）出现一个 **放大镜** 图标。
3. 点开 → 输入要查的中文（如 `界面`、`功能`）→ 结果实时高亮，带轮次号。
4. `↑ / ↓` 在匹配之间跳转；点结果行也可跳。
5. 底部会**如实说明范围**：
   - `已扫描 N 行 · 更早历史未载入` + **载入更早** 按钮 → 点一次往前翻一页，翻完重扫；
   - `已扫描 N 行 · 整个会话已载入` → 已覆盖全量。
6. 勾选 **搜索所有历史会话** → 切到跨会话模式（走 DSH 自带的 `session.search`）：
   - 结果列出**会话 + 摘要片段**，点击打开那个会话；
   - ⚠️ **这个模式下中文会漏词**（DSH 现有 FTS5 用 `unicode61`，实测两个汉字词常常 0 命中）。面板底部会写明这一点。
   - 如果后端没挂载，会**原样显示错误**：`跨会话搜索不可用：session search is unavailable: …`，不会静默失败。

---

## 已验证 / 未验证（如实说明）

**自动检查（81/81 通过）**

| 项 | 结果 |
|---|---|
| `node --check` 语法 | `client.js` / `index.js` ✓ |
| 清单字段（`dsh.bundle.patch` / `dsh.client` / `exports`） | ✓ |
| bundle 用 `window.__ModuleLoader__.load` 注册、id == 包名 | ✓ |
| `apply()` 注入 `conversation.session.header.actions` 并注册组件 | ✓ |
| inject 面能解出 session face；未知会话返回 `undefined` | ✓ |
| 组件渲染不抛异常 | ✓ |
| 面板打开 / 输入框 / 范围勾选框 | ✓ |
| 面板经 `ReactDOM.createPortal` 挂到 `document.body`、`position:fixed` 定位（Bug 6 回归测试） | ✓ |
| 点击候选按**匹配 Range 自身矩形**逐层滚动所有滚动容器（含内层 process body），不再用整行 `scrollIntoView`；流式后重建 Range；越界 clamp（Bug 7 回归测试 `test-scroll.mjs` 18/18） | ✓ |
| 范围偏好写入并持久化（重挂载生效） | ✓ |
| 跨会话模式**确实调用** `ctx.sessions.search` | ✓ |
| 跨会话结果可点击并打开该会话 | ✓ |
| 后端未挂载时错误**被显示而非吞掉** | ✓ |
| 中文召回 vs FTS5（真实会话数据 219 条 / 233,784 字） | 插件 **0 漏**；FTS5 对 `历史/界面/功能/侧边栏/这个网页` 全部返回 **0** |

**2026-11-08 真实 GUI 实测（DSH 0.2.2-rc.1 / Windows）**

| 项 | 结果 |
|---|---|
| 点放大镜 → 面板出现 | ✅ 浮在会话 header 下方右侧，深色主题下背景/边框/圆角/阴影正常 |
| 中文搜索 `成本` | ✅ `1/3 处 · 共 7 次`；3 条结果带轮次号（`#4`/`#4`/`#6`）与摘要；正文匹配处呈琥珀色高亮 |
| 范围提示 | ✅ `已扫描 23 行 · 更早历史未载入` + 「载入更早」按钮 |
| 面板内点击不误关 | ✅ 点「搜索所有历史会话」后面板保持打开，状态行切到"跨会话搜索使用宿主索引；中文可能漏词" |
| 关闭面板 | ✅ 再点放大镜面板消失、图标恢复非激活态 |
| HMR 热重载 | ✅ 覆盖 profile 副本后约 2 秒自动重载（graph rev `d557984e1e94` → `1aeabce5a386`），无需重启 DSH |

**2026-11-09 真机验收（DSH 重启后 · 真实 GUI · 用户授权前台操作）**

| 项 | 结果 |
|---|---|
| 插件在重启后的 DSH 中加载 | ✅ 插件管理页显示 `@local/dsh-chat-find` v1.0.0「运行中」 |
| 搜索 `插件`（ralph 会话） | ✅ `1/2 处 · 共 5 次`，两条候选都来自同一条长回复（`#1`） |
| **点第 2 条候选（长消息中后段，Bug 7 主场景）** | ✅ 视口精确滚到「…官方 Ralph **插件**（The Register 报道…」处，琥珀色高亮可见；UIA 交叉验证：匹配行在视口内 |
| `↓` 导航 | ✅ `2/2 → 1/2`，视口跟随到第 1 处匹配（用户消息，UIA frame `y=317` 在视口内） |
| **内层 process body 场景（review 建议 (b)）** | ✅ 展开「已完成，用时 8分53秒」工具分组后搜 `运行命令`（`1/31 处`），点第 8 条：**内层 body 从「Check DSH checkout…」滚到「List tool-ralph package and docs」**，匹配高亮在视口内（UIA frame `y=638`） |
| 面板打开 / 关闭 | ✅ 正常 |

> 验收方法说明：cua-driver 的 UIA 对 portal 面板的树更新不稳定，所以面板状态以截图为准、滚动位置用 UIA 元素坐标交叉验证（元素 `frame.y` 落在视口 100–864 内即视为可见）。

**仍未验证**

- 跨会话搜索的**后端真实调用**：本机 `session-query-sqlite` 是 `openAt: first-search`，本次没点进跨会话结果，`session.search` 的真实返回路径仍只有桩测试覆盖。
- 极窄窗口（< 400px）下的面板钳制只经过代码推导，没有实际拖窗口验证。
- 样式用的是 `--dsw-alias-*` 主题 token 和我自己写的类名（官方禁止插件 import `dsh-client-ui-primitives`，所以按钮是手写的）——与原生控件的间距/圆角可能有肉眼可见的细微差异。

**Bug 7 验证方法（用户手动，约 20 秒）**

1. 打开一个**长回复**的会话（一条 assistant 回复明显超过一屏）。
2. 点放大镜 → 输入一个在该长回复里出现、且不在开头的词（例如 `共创`、`成本`）。
3. 在结果列表里点**第 2 条或更靠后**的候选。
4. 期望：页面停在**该候选摘要里那段文字**附近（匹配处有琥珀色高亮），而不是停在长回复的中间。
5. 修前对照：同样的点击会停在长回复中部（与匹配处差几千像素）。
6. 附加检查：按面板里的 `↑ / ↓` 逐条跳转，每次视口都应跟到对应匹配处；点「载入更早」后重新扫描仍正常。

> 说明：面板行内滚动用的是 `smooth` 平滑滚动；如果一次点击后视觉上还没动完，等 300 ms 内会停稳。

---

## 卸载 / 回滚

```powershell
# 1) 从 profile 的 package.json 删掉 "@local/dsh-chat-find" 依赖与 dsh.profile.bundles 里的那一行
# 2) 从 node_modules 移除
node "...\pnpm.mjs" --dir "$env:USERPROFILE\.dsh\profiles\desktop" remove "@local/dsh-chat-find"
```

（`cordis.patch.yml` 里**没有**本插件的行——见 Bug 4，不要再加，否则会挂载两次。）

插件只往会话头加了一个控件，卸载后行为完全复原；不改 app.asar、不改会话日志、不碰模型请求。
