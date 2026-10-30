# Changelog

## 0.4.2 — 2026-10-30

### 改：识别层重写为「存在性驱动」——不再靠扩展名/排除字符集猜边界，任意绝对路径、任意文件名都能打开

病根：0.4.1 仍是「正则按扩展名 + 排除字符集猜文件边界」。而 Windows 合法文件名字符几乎覆盖所有可见字符（括号、`【】`、中文标点、含空格、无扩展名、名字里带 `.数字`），排除法必然有漏；每漏一类就得再打一次补丁，不可收敛。真正的文件边界只有**磁盘真实存在性**能裁决。

### 改（`lib/client.js` 识别层 + `lib/index.js` 解析层）

| 位置 | 旧 | 新 |
|---|---|---|
| 客户端识别（`hitAt`） | 用带扩展名+排除字符集的正则猜文件边界 | 新增绝对路径通道：`ABS_ANCHOR`（盘符 `X:\` 或 UNC `\\host\share\`）锁定起点 → 贪心截到**本行行尾**，不再猜扩展名；返回 `absStart` 供精确高亮；识别层不去尾（真实文件可能以 `)` `】` `。` 结尾） |
| 高亮（`onMove`） | 用整块 rect | 命中后用后端返回的真实文件名 `rec.abs.length` 收窄精确高亮 |
| 宿主解析（`resolveAcross`） | 整串 → 从左按空白剥 | ⓪原样整串精确 stat（救「文件名真以 (2024) 结尾」）→ 整串 tryAll → ①从右逐字符收缩 `shrinkRightAbs`（**不跨最后一个路径分隔符**、下界 `lastSep+2`、只做绝对精确 stat，避免砍成父目录/同名误报，`source:"absolute-shrunk"`）→ ②从左按空白剥兜底 |
| `VERSION` | `0.4.1` | `0.4.2` |

### 验证（探针 `probe_v042.cjs`，复刻真实 resolveAcross + shrinkRightAbs + clientHitAt）

- 24 项断言全 PASS / 0 FAIL；`node --check` 双文件 exit 0；无 BOM。
- 覆盖：上轮 146 字 `inratio1.8D` 原样命中、路径紧跟中文说明（无空格）、路径+空格+说明、文件名含 `(最终)【v2】`、无扩展名 `README`、多级 `.cas.h5`+说明、文件名真以 `(2024)` 结尾(+说明)、前置说明词、**防误报（不存在文件不退化成父目录 `D:\a`）**、正文假路径不命中、相对裸名不误判；`hitAt` 取全路径吃到行尾、`absStart` 指向盘符、行尾不跨行、无盘符不进入绝对通道、无扩展名绝对路径可识别。
- 回归：host `/resolve` 契约未变；旧版识别不到的路径变可识别，已能识别的仍可识别。

## 0.4.1 — 2026-10-30

### 修：目录名里带「.数字/字母」（如 `inratio1.8D`）时，路径芯片只识别到该级目录、后半段文件丢失

病根：`lib/client.js` 路径识别正则的中间段是**非贪婪**匹配（`{1,200}?` 后紧跟一个点），一遇到目录名里的点（`.../7-VTD-qianzhuijiao15-19-inratio1.8D/...`）就当作文件扩展名边界，把 `inratio1.8D` 里的 `.8D` 误判成扩展名 → 路径被截断在 `...inratio1.8D`（第 3 级目录），其后的 `comparison\...\*.png` 全部丢失，表现为用户所说「只能选到上几级的路径」。

### 改（`lib/client.js` 三处 + `VERSION`）

| 位置 | 旧 | 新 |
|---|---|---|
| RE 末尾前瞻 | 只排除字母数字下划线 | 增加两条排除：①扩展名后紧跟路径分隔符（斜杠/反斜杠）②扩展名后又接「点+扩展名」段。强迫正则跨过目录名里的伪扩展名，一路吃到真正的文件扩展名 |
| 中间段长度上限 | `{1,200}?` | `{1,1024}?` |
| `hitAt` 取词窗口 | 鼠标前后各 200 字 | 鼠标前后各 1024 字（长路径整体落入匹配窗口） |
| `VERSION` 常量 | `0.4.0` | `0.4.1` |

### 验证（从真实修复文件提取 RE + hitAt 窗口探针）

- 用户路径 146 字 `...inratio1.8D\comparison\...\VTD-...-静压.png` → 整段匹配；hitAt 鼠标落在偏移 0/20/74/90/120/146 均返回完整路径
- 不退化：`data.cas.h5` / `a.tar.gz` / `case.dat.h5` / 带空格中文名 `季度报告 最终版.pdf` / UNC 路径
- 多点目录 `2024.10.30\file.png`、`run.v1.3.2d\a.png` 均完整（旧版会截断）
- 不误报：散文 `版本 v1.2 已发布` → 无匹配
- `node --check` 通过；文件无 BOM

## 0.4.0 — 2026-10-30

### 改：彻底去掉扩展名白名单，所有文件类型都能识别、都能走侧边栏预览

病根：旧版有两张手写白名单——`PREVIEWABLE`（决定右键菜单里「在侧边栏预览」显不显示）和 `EXT`（决定正文里哪段文字算文件名）。两者都是**对宿主渲染能力的静态猜测**，问题一样：

1. 宿主每加一个渲染器就得回来补一次清单，漏一次就表现为「正文里明明有文件名，右键毫无反应」；
2. 用户装了 `dsh-video-preview` / `@huanlin/...-audio` 这类插件后宿主能力早变了，白名单却停在旧结论上 —— 于是 **mp4 / mp3 / wav 右键完全没有预览入口**，本次就是这条报上来的。

### 三处改动

| 位置 | 旧 | 新 |
|---|---|---|
| `PREVIEWABLE` | 正则白名单，`canPreview` 为 false 就不 push 菜单项 | **整条删除**，「在侧边栏预览」对所有类型无条件显示 |
| `EXT` | 手写约 130 项扩展名数组，拼进 `RE` | **整条删除**，改为通用扩展名匹配 + `EXEC_EXT` 可执行体黑名单 |
| 预览点击反馈 | 成功/失败无区分 | 成功 `toast("已在侧边栏打开（.xxx）")`，失败 `toast("侧边栏打不开 .xxx，可改用「用默认程序打开」")` |

新的识别规则：**任意 1–12 位扩展名都算候选**，字母开头或数字开头都收（`7z` / `3mf` / `3gp` 这类数字开头的真实格式以前被漏掉）。唯一还刻意排除的是可执行体 / 系统二进制（`EXEC_EXT`：`exe msi msp mst dll sys com scr cpl ocx drv vxd efi so dylib ko elf`）——正文里出现 `xxx.exe` 九成是命令输出或报错原文，而「用默认程序打开」对它们等于**直接运行**，误点代价太大。

### 误报怎么兜：不靠白名单，靠存在性闸门

候选片段必须先在宿主 `/resolve` 真的解析到磁盘文件，才会变成可点目标。所以散文里的 `e.g.` / `v1.2` / `Node.js` 即使被正则当成候选也没关系：解析不到就静默，用户完全看不出它曾被识别过。这比维护一张永远追不上现实的清单可靠得多。

### 验证

新增 `_verify/test-ext-regex.mjs`，36 项断言全过：
- 旧白名单已支持的（`mp4`/`mp3`/`wav`/`pdf`/`xlsx`/`md`/`py`/`cas.h5`/`dat.h5`/带空格文件名）不退化；
- 旧白名单漏掉的（`mov`/`mkv`/`webm`/`flac`/`m4a`/`7z`/`heic`/`avif`/`mcap`/`parquet`/`3mf`/`usdz`/任意未知扩展名）现在都能命中；
- 可执行体（`exe`/`msi`/`dll`/`sys`/`so`/`dylib`/`ko`/`elf`/`com`/`scr`/`ocx`/`cpl`）全部不命中。

### 顺手修

`lib/client.js` 的 `VERSION` 常量一直停在 `0.3.8`，落后 `package.json` 两个版本，现统一为 `0.4.0`。

### 已知代价（用户已明确接受）

极少数类型点「在侧边栏预览」会得到一句「打不开」。这是刻意的取舍：宁可点了没反应，也不要靠限制类型来回避未来的 bug —— 这样侧边栏以后补了什么能力，本插件零改动自动跟上。

## 0.3.9 — 2026-10-29

### 修：插件市场看不到下载量 / 版本号 / 搜不到

根因不在市场，在**本包 npm 元数据缺 `repository` 字段**。

市场目录（awesome-dsh-plugin / dsh-plugin-catalog）用 `scripts/probe-npm.mjs` 判定「这个 GitHub 仓库有没有对应的 npm 包」，判据是一行硬守卫：

```js
const linked = repoField.toLowerCase().includes(repo.toLowerCase())
if (!linked) return { npm: null, version: null, checkedAt: today }
```

而本包此前的 packument 里 `repository` 是空串，`''.includes('loyalchiiina/dsh-artifact-linker')` 恒为 false → 每次探测都被判成「没发布到 npm」→ 目录里 `npm: null, version: null, downloads: null` → 市场前端 `downloadStatsText()` 见 null 直接 `return null`，整块统计不渲染。

连带后果：
- 卡片上没有 `· ↓ N`、没有 `· v0.3.9`；
- 官方发现索引 `index.json`（只收有 npm 包+版本+发布时间的条目）里**完全搜不到**这个插件。

目录方的这条规则是**故意的防冒领**（contributing.md：「The published package's `repository` field must point back at the repository listed here, or the two are not linked.」）。

### 改：补齐 npm 元数据

`package.json` 新增三个字段：

```json
"repository": { "type": "git", "url": "git+https://github.com/loyalchiiina/dsh-artifact-linker.git" },
"homepage": "https://github.com/loyalchiiina/dsh-artifact-linker#readme",
"bugs": { "url": "https://github.com/loyalchiiina/dsh-artifact-linker/issues" }
```

发布后，目录侧 `probe-npm.mjs` 的 `RECHECK_DAYS = 1` 规则（`entry.npm === null && ageDays(entry) > 1`）会**自动重探**，无需提 PR。重探通过后 npm / version / downloads 三个字段自动回填，下载量与版本号即出现在市场卡片上，插件也会进入官方发现索引。

## 0.3.8 — 2026-10-29

### 修：「在文件夹中显示」有时不给定位

`SelectItem` 一直是能选中的，问题是它**不会把窗口带到最前**。于是结果取决于调用瞬间的窗口状态：该目录没窗口时 Explore 会新建一个、天然在前，看着正常；但如果该目录早已开着窗口（尤其同时开着好几个），选中会落在后台那个窗口上——用户眼前没有反应，观感就是「打开了但没定位」。

实测证据：日志一直写 `reveal selected via shell COM` 成功，而同一目录当时开着 7 个资源管理器窗口，选中确实落在 `hwnd=34688214`，但前台是别的程序；直接 `SetForegroundWindow` 返回 `False`（Windows 前台锁），焦点纹丝不动。

三处改动：

1. **抢焦点**：先 `AttachThreadInput` 到当前前台线程，再 `BringWindowToTop` + `SetForegroundWindow`，最后 detach；窗口最小化时先 `ShowWindow(SW_RESTORE)`。
2. **校验判据收紧**：原来只看 `SelectedItems().Count >= 1`，窗口里本来就选着别的东西就会假阳性；改为逐项比对**选中的文件名是否等于目标文件**。
3. **选窗优先前台**：同目录有多个窗口时，优先选「Explore 之前就在前台的那个」，避免把选中扔到用户没在看的窗口。

退出码也随之细化：`0` = 选中且已在前台（用户真看得见），`6` = 选中成功但没抢到前台（可 alt-tab 找到）。
## 0.3.7 — 2026-10-29

### 改：README 主文件改为中文

npm 页面和 GitHub 首页默认渲染 `README.md`，而它此前是英文版 —— 中文用户打开仓库第一眼看到的是英文介绍。现在主文件为中文，英文完整版移到 `README.en.md`，两份顶部互链；`package.json` 的 `files` 同步更新。

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