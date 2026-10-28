# Changelog

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