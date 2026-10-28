# Changelog

## 0.3.6 — 2026-10-29

### 修：安全闸按候选 base 逐个判定

`reveal` / `open` 两条路由原本用 `isInside(process.cwd(), abs)` 做越界检查——而宿主的 `process.cwd()` 并不等于会话 workspace，这是个潜伏的错判点（`allowOutside: true` 时被掩盖，一旦关掉就会误拒 workspace 内的合法文件）。改为 `insideAnyBase(abs, allowOutside)`，逐候选 base 判定。

## 0.3.5 — 2026-10-29

### 新：「在侧边栏预览」

右键菜单新增一项，把文件交给 DSH 内置右侧边栏渲染——和聊天里点文件链接走同一条通道（`dsh-resource://file/` 地址 + 宿主 `openResource`），所以 PDF、Word、Excel、PowerPoint、Markdown、纯文本、CSV、图片、音视频都能在里面看。

实现上做了两件事：一是地址构造与官方 `dsh-util-workspace-path` 逐字对齐（不新增依赖）；二是加了一道类型闸——查看器渲染不了的扩展名**自动改走默认程序**，不会给出一个空白面板。客户端插件声明 `inject: ["slots"]`，预览器缺席时该菜单项自动隐藏。

## 0.3.4 — 2026-10-29

### 修：右键偶尔「假死」

右键菜单弹出后立刻点菜单项，第一次点击有时被吞。改为用 pointer 事件绑定菜单项，并避开菜单挂载那一帧的焦点竞态。

### 新：音视频扩展名

白名单补上 `.flac .wav .mp3 .m4a .ogg .mp4 .mkv .mov .webm .avi`——音频产物（TTS 输出、母带）此前完全点不动。

## 0.3.3 — 2026-10-28

### 修：先确认文件存在，才让它变成芯片

之前的判定只看「文字形状」——正文里任何像文件名的片段都会被画成可点芯片（悬停变手型、蓝色虚线高亮、右键弹自己的菜单）。日志摘录、示例路径、报错原文全中招；点开只会得到一句「没解析到这个文件」。

这条提示本身就是设计错误：**给出一个点不开的入口，比根本不认识这个文件更糟**。

改法是加一道存在性闸门：

- 悬停命中候选后先异步 `resolve`，**只有文件真的存在**才变手型 + 画虚线；
- 右键时若已确认「不是产物」，直接**放行宿主原生菜单**，绝不 `preventDefault` 抢走；
- 左键同理，确认不是产物就什么都不做；
- 解析结果进 30 秒 TTL 缓存（`raw → {ok, abs}`），同一段文字反复悬停不重复请求，同一次事件里的并发查询合并成一次往返；
- 彻底删掉「没解析到这个文件」提示——静默收场，不装作成功也不打扰。

副作用是好的：正文里的普通文字现在**看起来就是普通文字**，不会再有一堆点不动的伪芯片。

## 0.3.2 — 2026-10-28

### 修：「在文件夹中显示」改成 Explore 开窗 + SelectItem(29) 选中

0.3.1 换成了 `SHOpenFolderAndSelectItems`，`hr = 0`、`SelectedItems()` 也真有值，但用户实测**窗口完全不弹**。这个 API 是「在已打开的窗口里定位」语义，没有现成窗口时什么也不显示，不能当「打开」入口用。

同时回头查清了 0.2.8 的老毛病：`SelectItem($item, 1)` 只带 `SVSI_SELECT`，在窗口刚打开、目录项还没填充好的瞬间调用会静默无效——当时既没轮询也没校验 `SelectedItems()`，只看到脚本退出码 0 就记「成功」，于是「日志全绿、实际没选中」。

现在分工明确：

- **开窗**交给 `Shell.Application.Explore($dir)`——实测唯一可靠的开窗入口；
- **选中**交给 `SelectItem($item, 29)`，`29 = SVSI_SELECT | SVSI_DESELECTOTHERS | SVSI_ENSUREVISIBLE | SVSI_FOCUSED`，缺 `ENSUREVISIBLE` 就不会滚到可视区；
- 两处都加轮询：`Windows()` 最多等 6 秒，`ParseName` 最多等 6 秒；
- **成功判据改为 `SelectedItems()` 非空**，不再是「脚本没报错」。

实测（`powershell.exe` 5.1，与插件同款；跑前先关掉目标目录全部窗口）：`window_found=yes`、`item_found=yes`、`sel_count=1`、`sel_item=目标文件`。

降级链不变：拿不到窗口（exit 5）、拿不到目录项（exit 3）、选不中（exit 4）→ 退回 `explorer.exe <目录>`，保证至少能开。

## 0.3.1 — 2026-10-28

### 修：「在文件夹中显示」只打开目录、不定位到文件

0.2.8 把 reveal 从 `explorer.exe /select` 换成了 `Shell.Application` COM（`Explore` + 轮询 `Windows()` + `SelectItem`）。脚本退出码 0、日志写「成功」，但用户实测**只打开了目录、没有自动定位到文件**。

根因：跨进程 COM 里 `$w.Document.Folder.ParseName($name)` 拿到的 `FolderItem` 与目标窗口不保证落在同一 PIDL 空间，`SelectItem` 会**静默失败**——不报错，也不选中。日志之所以显示「成功」，是因为脚本确实正常退出了。

改用 `shell32!SHOpenFolderAndSelectItems`（资源管理器自己执行「在文件夹中显示」时调的就是它）：`ILCreateFromPath` 建 PIDL → 一次 API 调用完成「打开目录 + 选中项」→ `ILFree` 释放。不依赖窗口枚举，也没有跨进程 COM 的对象归属问题。

实测：`hr = 0`，`SelectedItems()` 立即返回目标文件名。

降级链保留：PIDL 建不出（exit 3）或 API 非 0（exit 4）→ 退回 `explorer.exe <dir>`，保证「至少能开」。

## 0.3.0 — 2026-10-28

### 新增：右键菜单补齐「搬运」和「喂给 AI」两类动作

原来右键只有三项（打开 / 定位 / 复制路径），文件能看见、能打开，但**搬不走**。这次补三项，并按用途分组：

| 分组 | 菜单项 | 做什么 |
|---|---|---|
| 看 | 用默认程序打开 | `explorer.exe <file>`，交给系统默认关联程序 |
| 看 | 在文件夹中显示 | Shell COM 定位并选中（0.2.8 已修） |
| 搬运 | **另存为…** | 弹系统保存窗口，把文件复制到用户选的位置 |
| 搬运 | **复制文件** | 文件本身进剪贴板（`CF_HDROP`），可粘到任意文件夹 |
| 搬运 | 复制文件路径 | 只复制路径文字 |
| 喂 AI | **添加到对话框** | 把绝对路径插入上方聊天输入框 |

菜单项之间加了 1px 分隔线，视觉上把三组分开。

### 「复制文件」不是「复制路径」

这两个必须分清，因为用户拿到的东西完全不同：

- **复制文件路径** → 剪贴板里是字符串，粘到记事本得到一行文字；
- **复制文件** → 剪贴板里是 `CF_HDROP`（文件列表），粘到资源管理器得到**文件副本本身**。

实现走 `Set-Clipboard -LiteralPath`（PowerShell 5.1+ 能力）。本机实测：单个文件、含中文与空格的文件名（`路径 带空格.pdf`）都能正确写入并被 `Get-Clipboard -Format FileDropList` 读回。

### 「另存为」的两个坑

Node 侧没有跨平台的保存对话框，Windows 只能用 WinForms `SaveFileDialog`，而它：

1. **必须跑在 STA 线程** —— 默认 MTA 直接抛 `InvalidOperationException`；
2. **不给 owner 窗口时会弹到主窗口背后** —— 用户以为点了没反应，这是最容易踩的一条。

所以脚本里既加了 `-STA`，又造了一个 1×1、`Opacity=0`、`TopMost` 的隐形 owner form；对话框返回后 `finally` 里关掉它。超时给到 10 分钟（用户可能慢慢挑目录、当场新建文件夹）。

用户点「取消」时 PowerShell `exit 1`，这**不是错误**，路由返回 `reason: "cancelled"`，客户端静默不弹红字。

另外挡掉了一种会毁数据的输入：**目标路径与源路径相同**。`copyFileSync` 对同一路径会抛 `EINVAL`，极端情况可能把原文件截断，所以提前返回 `reason: "same-path"`。

### 「添加到对话框」为什么要三种写法兜底

DSH 的输入框会随版本变（`textarea` / `contenteditable` / Lexical 都出现过），所以不写死单个选择器，而是：

1. 一批候选选择器逐个试，按「宽度 ≥150px、可见、非只读」筛出最像输入区的那一个（从 DOM 末尾往前找，聊天输入框通常在最后）；
2. **优先 `document.execCommand("insertText")`** —— 走浏览器真实输入管线，React / Lexical 的受控状态能同步更新；
3. 回退到原生 `value` + `input` 事件（textarea / input）；
4. 再回退到 `textContent` 追加 + `input` 事件（contenteditable）。

三步全失败就明确提示「没找到聊天输入框」，**绝不假装成功**。

### 安全边界

- 新增路由同样只接受 loopback 请求，非回环来源一律 403；
- `/saveas` `/copyfile` 是**有副作用**的文件操作，比 reveal/open 多挡三种输入：目录、不存在的文件、目标==源；
- 路径全部经 `statOne` 先行确认，参数走 `execFile` 数组不经 shell，无命令注入面。

### 校验

五套探针共 **105 项全绿**：

```
probe-client-materialize   13/13
probe-host-apply           21/21   （路由断言同步到 8 条）
probe-regex                39/39
probe-batch2               22/22
probe-real-files           10/10
```

---

## 0.2.8 — 2026-10-28

### 修复：Windows「在资源管理器里揭示」点了没反应

`explorer.exe /select,"<路径>"` 在本机实测**根本不起作用**：命令确实发出、退出码 1、日志无异常，但资源管理器既不新开窗口、也不改变选中项。四种传参写法（整串带引号 / 裸路径 / 拆成两个 argv / 去掉 `windowsVerbatimArguments`）逐一试过，全部无效 —— 请求转交给已运行的 explorer 实例时，选中意图被丢掉了。

改为走 **Shell COM**：`Shell.Application.Explore(dir)` 打开目录，再用 `Folder.ParseName(name)` + `Document.SelectItem(item, 1)` 精确选中文件。已验证 `SelectedItems()` 能返回目标文件，中文文件名与深层路径均正常。

实现细节：

- PowerShell 脚本经 `-EncodedCommand` 以 **UTF-16LE Base64** 传入，绕开控制台代码页 —— 直接 `-Command` 传中文路径会变成 mojibake；
- `windowsHide` 只隐藏 `powershell.exe` 自身（不闪黑窗），COM 拉起的资源管理器窗口照常显示；
- 轮询等待目标窗口出现（最多约 3 秒）；失败时降级为「打开父目录」，保证不会毫无反应。

`open`（默认程序打开）不受影响，仍是 `explorer.exe <file>`，实测对中文/空格路径有效。

---

## 0.2.7 — 2026-10-28

### 文档：加上实机截图

README 中英双版各嵌入三张真实运行截图 —— 悬停高亮、右键菜单、复制路径 —— 放在仓库 `docs/` 下。

截图用 `raw.githubusercontent.com` 绝对地址引用，GitHub 与 npm 页面都能正常渲染；`files` 白名单不含 `docs`，所以**图片不进 npm 包体**，包大小不变。

---

## 0.2.6 — 2026-10-28

### 修掉两处「看不见的破窗」

1. **日志里的中文变乱码**
   `reveal` 失败分支会往 stdout 打一句含中文的说明，日志消费端按 ANSI 解码就成了 `閫€鍑虹爜 1`。现在这条日志全 ASCII，并把真实含义写清楚：explorer 收到 `/select` 后把请求转交给已运行实例、随即退出，**退出码 1 是正常现象**。

2. **正则探针静默失效**
   `probe-regex.mjs` 还在按 v0.1 的变量名（`EXT_ALT` / `RE_ABS` / `RE_NAME`）切源码。v0.2 把三条正则合并成单个 `RE` 之后锚点全断，探针直接退出 —— 等于这一层守卫早已不存在，只是没人发现。已按 v0.2 结构重写，39 项断言。

### 顺带

- `client.js` 里的 `VERSION` 之前停在 `0.2.0` 没跟版，现与 `package.json` 对齐，并加了一条探针断言 —— 以后再脱节会直接失败。
- 全部探针回归：**122 项全绿**（正则 39 / 宿主 apply 21 / 端到端 17 / 客户端物化 13 / 裸文件名 10 / 首批靶子 22）。

---

## 0.2.5 — 2026-10-28 · 首个 npm 发布

### 修掉的三个真 bug

| 现象 | 根因 | 修法 |
|---|---|---|
| 「季度报告 最终版.pdf」这类带空格的名字点了没反应 | 正则中间段把空白当分隔符，只匹配到末尾的「最终版.pdf」，拿去解析必然失败 | 中间段只排除换行与中文标点，允许空格；后端再加「从左收缩重试」兜底 |
| 深目录里的产物扫不到 | workspace 索引扫描有深度与条目预算上限，浅层先占满 | 索引改为按需深扫，预算按层分摊 |
| 多处同名文件点了跳错 | 遇到重名直接放弃 | 加歧义消解：同目录优先，其次最近修改 |

### 交互定稿

- 命中高亮：Codex 风蓝 `rgba(88,166,255,.13)` + `1px dashed` 虚线
- 左键 = 资源管理器揭示并选中；右键 = 自建三动作菜单；Ctrl / Shift + 左键 = 系统默认程序打开

---

## 0.2.4 — 2026-10-28

- 修 `reveal` 的日志误报：explorer 收到 `/select` 后转交已运行实例并立即退出、**退出码恒为 1**。旧代码把非零码当失败，日志里全是 `Command failed`，把人骗去查一个不存在的 bug。

## 0.2.3 — 2026-10-27

- 命中高亮从黄色实线改为 **Codex 风蓝 + 虚线**（用户反馈「黄色太丑」，追加「最好是虚线」）。

## 0.2.2 — 2026-10-27

- 内部迭代（未单独发布）：菜单文案与图标风格统一。

## 0.2.1 — 2026-10-27

- 修 `reveal` / `open` 静默失败：`execFile` 传单参数 + `windowsHide: true` 让 explorer 不弹窗；改为 `['/select,"<path>"']` + `windowsVerbatimArguments: true`。
- 修左键抢事件：`preventDefault` / `stopPropagation` 让宿主的侧边栏预览失效；改为延迟派发并检查 `defaultPrevented`。

---

## 0.2.0 — 2026-10-27

### 用户实测反馈驱动的重写

三条反馈，全部照办：

1. 「这插件不对劲不是我想要的效果，我希望打开的方式是从对话中的名称可以直接点击或者右键方式打开而不是悬浮球」
2. 「悬浮球你做的也有问题很多不是产物被你识别了」
3. 「而且切换窗口刷新很慢」

### 删掉的东西（v0.1 的设计错误）

- **整个悬浮球 + 产物面板**：右下角 `📎 N` 胶囊、清单面板、状态点、刷新/清缓存按钮 —— 全删
- **全量 TreeWalker 扫描**：不再遍历文档文本节点
- **MutationObserver**：不再监听 DOM 变化
- **setInterval 定时刷新 / 300ms 防抖扫描**：不再有任何常驻定时器
- 体积：832 行 / 36KB → 368 行 / 15.8KB（顺带缓解 `dsh-experimental-inspector` 的 source-frame 字节上限）

### 新增的交互

| 操作 | 效果 |
|---|---|
| 左键点产物名 | 在资源管理器里揭示并选中 |
| 右键点产物名 | 自建菜单：揭示 / 默认程序打开 / 复制完整路径 |
| 悬停命中 | 鼠标变手型（唯一视觉提示，mousemove 150ms 节流） |
| 非产物处右键 | 完全放行，宿主原生菜单照常 |
| 解析不到 | 静默放行或一次性提示，绝不假装成功 |

### 修掉的真 bug ①：面板里全是「未解析」

**根因**：客户端调 `/resolve` 没传 `base`，宿主就固定用 `process.cwd()`。那是 DSH 宿主进程的工作目录，**不是会话 workspace** → 相对路径和裸文件名全部解析失败。

**修法**：新增 `candidateBases()` —— 宿主自己列出所有可能是 workspace 的目录：

```
process.cwd()
~/.dsh/*/workspace
~/.dsh/profiles/*/workspace
```

再由 `resolveAcross()` 逐个当 base 试，命中即返回。`/info` 现在也返回 `bases` 数组，排查时可以直接看宿主认为的候选目录。

**实测 12/12**：`测试报告-2026.pdf`、`对比图.tif`、`中文名称-测试.zip`、`数据汇总表.xlsx`、`运行日志.log`、`路径 带空格.pdf` 全部解析到真实绝对路径。

### 修掉的真 bug ②：Fluent 多级扩展名被截断

`fluid.cas.h5` 以前被截成 `fluid.cas` → 撞一个不存在的文件 → 点了没反应。正则尾部加 `(?:\.[A-Za-z0-9]{1,6})*` 吃掉多级尾巴。

### 探针（全部落盘可复跑，位置：`.dsh\backups\artifact-linker-probes\`）

| 探针 | 覆盖 | 结果 |
|---|---|---|
| `probe-v2.mjs` | 识别层实跑 14 正例 + 7 反例 + 9 条禁止 + 11 条必须 + 体积红线 | 45/0 |
| `probe-client-materialize.mjs` | cordis 客户端契约（有 apply / 不碰 document / 单例守卫 / dispose 清场） | 13/0 |
| `probe-host-apply.mjs` | 宿主 apply 契约（6 路由 / prompt 段 / 403 / disposer） | 21/0 |
| `verify-resolve.mjs` | 真实文件解析 12 项 | 12/0 |

探针刻意放在包外：包内每多一个文件，`dsh-experimental-inspector` 采集的源码量就更大，撑爆 source-frame 上限会让 **host exit 1**。

### 已知边界（不是 bug）

- 只认白名单扩展名，**刻意不含 exe/msi/dll**：正文里这些多半是命令输出，不是要打开的产物
- 只在**点击瞬间**判定，不做任何预扫描 → 尚未渲染出来的内容点不到（但也不会误报）
- `Ctrl/Shift/Alt + 左键` 一律放行给宿主，方便你选中文字

## 0.1.0 — 2026-10-27

首个可运行版本。

### 宿主端

- 新增常驻 system-prompt 段 `artifact-path-rules`（order 200，约 600 字符）：要求模型把产物写成完整绝对路径、给用户看的正文只写文件名、不确定时先核实再写、绝不编造路径、路径含空格或中文用反引号包裹。
- 新增 6 条回环路由（全部 `127.0.0.1` 限定，外部来源 403）：
  - `GET /info` — 插件身份、版本、workspace、三个开关的实际生效值
  - `GET /resolve?p=` — 路径解析，三源兜底（绝对 → workspace 相对 → 裸文件名递归搜索）
  - `GET /stat?p=` — 批量 stat，10 秒 TTL 缓存
  - `GET /flush-cache` — 清空路径解析与 stat 缓存
  - `GET /reveal?p=` — 在资源管理器揭示并选中
  - `GET /open?p=` — 用系统默认关联程序打开
- `reveal` / `open` 走 `execFile(cmd, args)` 参数数组，不经 shell，路径中的 `& | ; %VAR%` 均为字面量。
- 跨平台：Windows `explorer.exe /select,`、macOS `open -R`、Linux `xdg-open`（揭示退化为打开父目录）。

### 客户端端

- 新增 `__ModuleLoader__.load` bundle（id = `dsh-artifact-linker`，与包名一致）。
- **全程只读正文，不修改任何 DOM 节点、不添加属性、不重挂 React 节点。** 可点性由 document 捕获期 `click` + `caretRangeFromPoint` 反查光标所在词实现，节点被 React 重渲染换掉也不会失效。
- 修饰键分流：左键揭示并选中 / Ctrl·Shift·Cmd 系统程序打开 / Alt 复制路径。
- 新增右下角浮动胶囊 `📎 N`（Shadow DOM 挂 `body`，不主动 `focus()`，`mousedown` 在 document 捕获期截断以避免宿主 `closeOutside` 关掉面板）。
- 产物清单：状态点（存在 / 已不存在 / 未确认）、大小、相对修改时间、每行 `📍 ↗ ⧉` 三按钮、刷新 / 清缓存 / 清空。
- 明暗主题跟随：读取 `body` 背景亮度判定，仅在切换时重设 CSS 变量，不逐帧读样式。
- **URL 排除**：渲染后的链接文本节点本身就是 `https://x.com/a.png`，里面那个 `a.png` 会被文件名正则误命中、被当成 workspace 产物。现在每段文本先算出所有 URL 区间，命中落进去一律丢弃（扫描与点击反查两条路径都做了）。
- 单例守卫 `window.__dshArtifactLinkerV1`：热重载前先 `dispose()` 旧实例，`dispose()` 摘净全部监听器、定时器、观察者与 DOM。**热重载清理不掉「修复前加载的旧实例」，改完必须完全重启 DSH。**
- 附 `scripts/probe-regex.mjs` 探针回归：从真实源码切出识别段，跑 14 条识别/排除断言 + 10 条源码静态断言（不出现 iframe、不构造绝对 URL 去 fetch、有单例守卫、dispose 摘净监听、不修改正文 DOM、不接管 markdown 图片、mousedown 闸门在 document 捕获期、浮层不主动 focus、bundle id 一致）。`node --check` 只查语法，这些边界只有探针能兜住。

### 已知边界

- 不接管 markdown 图片与链接语法（改写成芯片会导致图不显示）。
- 扩展名走白名单，不做「看起来像路径就标成产物」的猜测；`exe/lock` 之类故意不在白名单里。
- 裸文件名在 workspace 内搜到多个同名文件时返回候选，不自动选择。
- `allowOutside` 默认 `true`（产物大多在 E:/D: 项目盘，不在 workspace 内）；多用户环境建议改 `false`，否则等于允许「模型给个路径就打开任意文件」。

### 交付前按官方 14 条硬规则自查修正（未发布即改，同属 0.1.0）

- **硬规则 #6（peer range 在安装时被强制校验）**：`@deepseek-ai/dsh` 由 `>=0.1.7-rc.1` 改为 `>=0.2.1-rc.3`。semver 规定 prerelease 版本只匹配「major.minor.patch 相同、且 range 内带 prerelease 比较器」的范围，原范围对运行时 `0.2.1-rc.3` 实测为 **false** —— 不改这一条，`dsh plugin add` 会直接拒绝安装。`engines.dsh` 同步。
- **硬规则 #13（样式必须走 `--dsw-alias-*` 主题令牌）**：12 处自造颜色变量改为三层链 `var(--dsw-alias-*, var(--alXxx, <硬编码>))`，取 `bg-layer-2` / `label-primary` / `border-l2` / `interactive-bg-hover`（均在 app.asar 内实测存在，命中 120~566 次）。自算明暗降为第二层兜底。
- **硬规则 #5（tunable 不许硬编码）**：`STAT_TTL_MS` → `statTtlMs`、裸名反查深度 `2` → `searchMaxDepth`、铁律文本 → `rulesText`，三者均可由 `cordis.patch.yml` 覆盖（`searchMaxDepth` 硬上限 8 层，防止 `/resolve` 退化成全盘扫描）。
- **硬规则 #8（双语文档成对）**：`README.md` 改为英文主文档，新增 `README.zh.md` 中文完整版，两者顶部互链；`files` 白名单同步。
- 未采用的项：硬规则 #13 的「render React in a slot」—— 本插件不注册 slot，用 `document.body` + Shadow DOM 承载悬浮胶囊（与 `dsh-todo-float-ball` 同构），因为它的可点性挂在正文文本节点上、不能放进某个 slot 里。硬规则 #12「不要手写 profile package.json」—— 本机既有装机方式即手写 `dependencies` 一行 + `link:` 依赖，已在 README 标注。