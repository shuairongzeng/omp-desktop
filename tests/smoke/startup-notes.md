# startup timing — DCL → #root 调查（R7）

调查对象：整合者实测的 **DCL(2921) → #root(4922) ~2 s 空洞**。
工具：`tests/smoke/startup-probe.mjs`（本目录，非冒烟套件成员）+
`run.mjs` 新增的 `boot/timing` 步骤。exe：`D:/GitHub/omp-desktop-r6/src-tauri/target/release/omp-desktop.exe`（与 r7 同代码 @270ce01 构建）。所有数字为多次运行取代表值；页内时间用 `performance.getEntriesByType`，墙钟用 Node `Date.now()`（Node 与 WebView2 同机同墙钟，可直接相减）。

## 一句话结论

**在本机（热机）复测，DCL → root-commit 只有 ~100–215 ms，不是 2 s。** 整合者数字里的"2 s 空洞"大部分不是页面内执行，而是 **WebView2 冷启动（进程 + profile + 首次导航）被计入了 spawn→页内各点**：本机 spawn→首个可 evaluate 的页面目标本身就要 **~820–1900 ms**，而页内 navigationStart 到 root-commit 只有 ~500–900 ms。两个数字是不同的时钟原点，直接相减会把"WebView2 还没起来"误记为"DCL 之后 React 干了 2 秒"。剩余真实成分见下表，可砍项集中在 **模块加载面（156 个 JS、~2.5 MB 解析）** 与 **tab 恢复链（live.js 顶部 IIFE 的 `_refreshProfiles → close_all_tabs → _restoreOpenTabs → start_session` 串行 IPC 链）**。

## 成分表（证据：页内 performance + MutationObserver + console 时间线）

以一次代表性 run（墙钟，spawn = t0；页内值换算 wall = page值 + navStart − t0）：

| 段 | 耗时 | 证据 |
|---|---|---|
| spawn → CDP 目标可连（WebView2 起进程 + debug 端口 + 首导航） | **~820–1900 ms**（3 次 20ms 粒度轮询实测 821/1003/1082；waitForTarget 300ms 粒度时 1470–1950） | probe4：http discovery 821–1082 ms；`run.mjs` 里 connected 983–1895 ms |
| navStart → responseEnd（index.html + 内嵌资源首字节） | ~180–250 ms | `performance.getEntriesByType("navigation")[0].responseEnd` 165–251 |
| responseEnd → DCL（**156 个 JS 脚本标签全部 fetch+执行** + CSS） | **~180–330 ms** | DCL 345–713 减 responseEnd 158–383；resource 条目 184 条 |
| DCL → root first child（React 首次 commit；live.js 顶部 IIFE 同步段 + app-live.js 挂载） | **~100–215 ms**（6 次测量 97/102/104/108/111/113/146/173/178/216，中位 ~110） | MutationObserver 打点 `__probeMarks.rootChildren`，attach 于 readyState=loading |
| root commit → composer 出现（tab 恢复渲染出激活 tab 的 UI） | ~100–1250 ms（多数 ~110–300；见下"两峰"） | 页内 stamps：root 499 → composer 608；另有 root 718 → composer 未盖（第二峰） |
| `start_session` IPC（omp spawn）→ `ready` 帧 | ~2.0–2.2 s（多 run：t0 3014/3484/4899 ms 处 `[live] ready from session …`，其中 ~1.1–1.4 s 是前段启动） | `Runtime.consoleAPICalled` 时间线，`[live] Tauri multi-session mode active` 在 1142–1444 ms |
| `ready` → commands loaded（`get_available_commands` 往返） | ~200–600 ms | 同上时间线 3684/3295/5621 ms 行 |

补充页内锚点（代表值）：FP 516、FCP 516–831、domInteractive ≈ DCL、load ≈ DCL。

### "两峰"现象：composer 出现时间 bimodal

- **快峰**（大多数）：root commit 后 ~110–300 ms —— 恢复的 tab 是激活 tab，首帧直接带 composer。
- **慢峰**（偶发，~1.2 s）：`_restoreOpenTabs` 的 `tryActivate` 要等 `results[i]`（该 tab 的 `start_session` resolve）才能 `activateSession`；composer 只在激活 tab 存在时渲染。等待 = 那次 `start_session`（含 Rust 侧 `omp --version` 冷缓存 resolved-path 探测 + 真正 spawn）的 IPC 往返。live.js 2283 行注释明确承认"A cold start may run `omp --version` once per concurrent first spawn"。

### 脚本加载面（DCL 之前的主成分）

- 156 个 `.js` 共 **~2.57 MB**（另有 28 个 CSS ~294 KB，总计 ~2.86 MB transfer）。
- 最大：`live.js` 269 KB、`react-dom.production.js` 211 KB、`composer.js` 127 KB、`highlight.min.js` 126 KB、`app-live.js` 123 KB、`chrome.js` 58 KB。
- 每脚本 fetch+exec 上界 5–125 ms（resource duration 含排队，总量不可加），对 DCL 的贡献主要是**串行解析与执行**：`app-live.js`（+125 ms）与 `live.js`（+77 ms）最重。
- 所有脚本标签无 defer 差异可优化空间：release 构建把 JSX 全部编译成 `<script defer>`（`scripts/build-frontend.mjs`），已在解析器并行路径上。

### live.js 顶部 await 链（启动 IPC 顺序，src/live.js:5441-5452）

```
prompt_history_list（并行，独立）
_refreshApprovalModes（并行）
_refreshProfiles()                      // list_profiles IPC
  .then(close_all_tabs)                 // 串行 IPC 2
  .then(_restoreOpenTabs())             // open_tabs_load → 每tab start_session（并发派发）
  .finally(_setupExternalOpens)
```

关键点：**root commit 不等这条链**（挂载在 app-live.js 底部同步执行），但 **composer 等 `activateSession` 的结果**；bridge `isConnected` 是 getter（`!!__TAURI__ && !!activeSessionId`，live.js:3962），所以 `boot/timing` 的 bridge 段与 composer 段几乎同时。

## 可砍项与预估收益

| # | 项 | 现状 | 预估收益 | 建议归谁 |
|---|---|---|---|---|
| 1 | **`omp --version` 冷探测串在每个并发首 spawn** | `_restoreOpenTabs` 注释自认；慢峰 ~1 s 的主嫌疑 | ~0.5–1 s（慢峰消除） | **A 组（Rust）**：`start_session` 前把 resolved-path 缓存持久化（profiles.json 同目录），或 setup 阶段预解析 |
| 2 | **`_refreshProfiles → close_all_tabs → _restoreOpenTabs` 串行三连 IPC** | 每个 invoke 一个往返，~50–150 ms/跳 | ~100–200 ms | **B 组（前端 live.js）**：`close_all_tabs` 与 `open_tabs_load` 并行（两者无数据依赖——close 只清 Rust 会话表，load 只读文件）；或合并为一条 Rust 命令 |
| 3 | **156 个 JS、2.57 MB 全量急加载** | 每启动全 fetch+parse+exec；xterm(490KB)/qrcode(57KB) 已是懒加载先例 | 200–400 ms（DCL 提前） | **整合者 + B 组**：按面板懒加载 terminal/browser/git/settings 族（~500+ KB）——build-frontend.mjs 的 `ensureXterm` 模式已存在，但收益中等、改动面大 |
| 4 | **`highlight.min.js` 126 KB + marked 46 KB 急载** | 首条消息渲染前用不到 | ~30–60 ms | 同上（懒加载） |
| 5 | **WebView2 冷启动 ~0.8–1.9 s** | 无法从 webview 侧削；页面级全在其后 | 0（结构性） | 无人可改；预算里当作常数 |

优先级：#1 > #2 > #3/#4。#1+#2 合计可把慢峰从 ~2.7 s 压到 ~1.6 s（本机），且不动 UI。

## 预算含义（boot/timing 步骤）

- 断言：`spawn → composer < 8000 ms`（硬，超时 FAIL）。
- WARN：`> 6500 ms`（软，只打印）。
- 依据：整合者热机基线 5161 ms + 冷文件缓存/首启 profile/重 transcripts 余量 → 8000；本机实测 1564–2718 ms，远离悬崖。
- 注意 poll 粒度（waitExpr 200 ms）与 IPC 往返都会让打印值偏大：它们是**上界**，非精确点。

## 与整合者基线的差异说明（重要）

| 指标 | 整合者 | 本机本测 |
|---|---|---|
| spawn→CDP | 1951 | 821–1895 |
| spawn→#root | 4922 | 1265–2441 |
| spawn→composer | 5161 | 1374–2718 |
| spawn→bridge | 5379 | 1374–2729 |
| responseEnd | 1746 | 940–1895 |
| DCL | 2921 | 1230–2298 |
| FP/FCP | 2402/3169 | 1414–2560 |
| **DCL→root** | **~2000** | **~100–215** |

结构一致（各段比例同型），整体慢 ~2.5–3.5 倍——像整合者测时处于冷缓存/负载下（或含首启 WebView2 profile 创建）。**"DCL→root 2 s" 不是一个可独立优化的页面内 2 s**：按本机结构外推，整合者那 2 s 的构成应是 (a) `boot/root-rendered` 的 200 ms 轮询粒度 × 慢环境下更长的等待 + (b) 慢峰的 `start_session` 等待落在 root 检测与 composer 检测之间 + (c) waitExpr 每次成功前的 200 ms 对齐损失。真正值得砍的是上表 #1/#2，不是"React 挂载前的神秘 2 秒"。

## 复现

```
node tests/smoke/run.mjs --exe <exe>            # boot/timing 行 + 预算断言
node tests/smoke/startup-probe.mjs --exe <exe>  # 成分调查：nav timing、resource 表、
                                                # root commit 打点、[live] console 时间线
```

probe 的观察器用 `{ childList: true, subtree: true }`（`childElements` 不是合法选项，observe 会 throw）；它在 readyState=loading 时挂上，root first-child 打点精度 ~10 ms。
