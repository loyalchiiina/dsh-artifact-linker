# dsh-artifact-linker 开发日志

## 2026-11-13 06:52 · v0.5.4（未发版，仅本地）· 修复「在浮窗中打开」失败

### 起因
用户报「浮窗打开总是失败」。

### 定位
`lib/client.js` 的 `openFloating(abs)` 原来只有一条打开路径：

```js
var w = window.open(addr, "_blank", "width=960,height=720,noopener,noreferrer");
return !!w;
```

`addr` 是宿主的自定义协议地址 `dsh-resource://file/session/<sid>/<path>`。在 Electron 宿主里
这条路**必然失败**：
1. 宿主对 `window.open` 有 `setWindowOpenHandler` 管控（桌面端默认不放行任意弹窗）；
2. `dsh-resource://` 需要宿主注册 protocol handler，独立 BrowserWindow 里没有 → 即使弹出来也是白屏。

### 宿主官方通道（asar 实测）
宿主自己右键菜单里的「在浮窗中打开」（`menu.openInFloat`）实现是：

```js
const openIn = (destination) => () => {
  const cwd = ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd;
  ctx.sidebarRight.openResourceIn(sessionId, fileAddressFor(sessionId, cwd, path), {
    destination,                       // "sidebar" | "float"
    ...line === void 0 ? {} : { params: { line } }
  });
};
```

文档亦写明：「文件菜单提供『在侧栏打开』与『在浮窗中打开』，以 `destination: 'sidebar'` 或
`'float'` 和目标行号调用 `ctx.sidebarRight.openResourceIn`」。

### 落点
- `openFloating()`：改为
  `sidebar.openResourceIn(sid, addr, { destination: "float" })`；
  宿主无 `openResourceIn` 时回退 `openResource(addr, { destination: "float" })`；
  两者都不可用才返回 `false`。删除 `window.open` 整条路径。
- `openInSidebar()`：优先 `openResourceIn(sid, addr, { destination: "sidebar" })`，
  老接口 `openResource` 作兜底；守卫放宽为「两者有其一即可」。
- 失败提示改为「宿主未提供浮窗能力或当前会话未就绪」（原因已不是弹窗拦截）。
- `VERSION` 常量与 `package.json` 同步 0.5.3 → 0.5.4。

### 验证
- `nnode --check lib/client.js` / `lib/index.js` 均 exit=0
- BOM：client.js `47,47,32,100` / index.js `47,47,32,100` / package.json `123,10,32,32` / dev-log `35,32,100,115`（全无）
- `package.json` version = 0.5.4

### 生效方式
本次只改客户端 `lib/client.js` → **Ctrl+Shift+R 硬刷新**即可。
但 0.5.3 还改了宿主 `lib/index.js`（bundle 兜底投递 + client-alive 探针），
所以本轮总体仍需**彻底退出 DSH 再启动**一次；之后单纯改客户端才可用硬刷新。

## 2026-11-13 06:45 · v0.5.3（未发版，仅本地）· 修复右键接管整体失效

### 起因
用户报「右键文件链接插件失效」。实测现象：正文里右键文件芯片（`C:...console-sentinel-推送任务书.md`），
弹出的是**浅色白底、6 项**的菜单（在侧边栏打开 / 在浮窗中打开 / 在文件夹显示 /
使用默认应用打开〔灰色〕/ 复制文件路径 / 另存为…），而本插件的菜单是**深色 `#22242a`
+ 顶部文件名行 + 8 项**。→ 弹出的是**宿主官方 contextMenus**，插件菜单从未出现。

### 定位（机器事实，非推断）
1. 宿主半边全绿：`/dsh-artifact-linker/info` 200、`/resolve` 200（`exists:true`），启动日志 4 条齐全
   （host half mounted v0.5.2 / path rules registered / force-absolute gate / routes registered）。
   → 不是宿主服务坏了。
2. 客户端从未加载的旁证：
   - `/dsh-artifact-linker/client.bundle.js` → **404**
     （对比 `/dsh-console-sentinel/client.bundle.js` → 200，len=91383）
   - 日志里同批插件有 `CLIENT-ALIVE ping received from browser`（todo-float-ball / font-enhancer），
     本插件**一条都没有**。
3. **代码级根因**：`lib/client.js` 的 `apply()` 开头（0.5.2 引入）：
   ```js
   if (__safeSvc(ctx, "sidebarRight") === undefined) {
     // 30s 轮询 … 等不到就静默跳过
     return;
   }
   ```
   拿不到 `sidebarRight` 就 `return` → 右键监听、浮动胶囊、点击接管**全都不绑**。
   而 `sidebarRight` 实际只影响「在侧栏打开」一项，`openInSidebar()` 自己已有
   `if (!sidebar || typeof sidebar.openResource !== "function") return false` 的降级。
   对应 CHANGELOG 0.5.2「服务从 declared inject 移除，改为安全取值器 + 最多 30s 轮询」——
   **就是这次改动把插件改死的**。
4. **第二成因**：`chipPathAt()` 只从 chip 的 `title` 取路径。宿主 asar 实测
   `title: src === undefined ? file.path : void 0` —— 宿主一旦给 file chip 补上 `src`，
   `title` 就是 `undefined` → 旧版 `return null` → 不抢 → 交回宿主菜单。

### 落点
- `lib/client.js`
  - ① `apply()` 开头先 `fetch(ROUTE + "/client-alive")` 探针，**再直接挂载**，删除 sidebarRight 硬 return。
  - ② `chipPathAt()` 加 `textContent` 兜底；截断文本（含 `…` / `...`）不认，避免半截路径打开失败。
  - ③ `VERSION` 常量 0.5.2 → 0.5.3。
- `lib/index.js`
  - ① 新增 `/client.bundle.js` 路由（读 `lib/*.js` 里的 client.js 原样吐出）。
  - ② 新增 `/client-alive` 路由（打日志 `CLIENT-ALIVE ping received from browser`）。
  - ③ 新增 `webserver/index-inject` hook，往 `<head>` 插 `<script src=.../client.bundle.js>`。
  - ④ 复用已有 `PKG_VERSION` 常量，未新增变量。
- `package.json`：version 0.5.2 → **0.5.3**（description 未动）。

### 为什么加"兜底投递"
DSH 的客户端 module graph 会整包跳过某些插件（console-sentinel 的源码注释里也写了这一条，
它正是用同一个 fallback 保住的）。自己吐 bundle + index-inject 是双保险；
`client.js` 顶部有 `GUARD = "__dshArtifactLinkerV1"` 幂等保护，被注入两次也只会 apply 一次。

### 验证
- `nnode --check lib/client.js`、`nnode --check lib/index.js` 均 exit=0
- BOM：client.js `47,47,32,100` / index.js `47,47,32,100` / package.json `123,10,32,32`（全部无 BOM）
- `package.json` 解析 version = `0.5.3`；`lib/client.js` L32 `var VERSION = "0.5.3";`
- **待重启后复核两条日志**：`client fallback: index-inject hook armed` +
  `CLIENT-ALIVE ping received from browser`；以及右键菜单是否变成深色 8 项。

### 生效方式
宿主 `lib/index.js` 与客户端 `lib/client.js` 都改了 → **彻底退出 DSH 再启动**（Ctrl+Shift+R 不够）。

## 2026-11-25 19:0x · v0.5.8 · 修复「输入框里的路径文字一点就跳侧边栏」

### 起因
用户报：复制到聊天输入框里的路径文字，鼠标一划变手型、点一下被跳侧边栏，想改字 / 定位光标全被抢走。
原话：「复制到输入框内的文字就不要出现跳转侧边栏的情况了不然影响输入，可以加个识别限制」。

### 定位（改哪份、看哪份）
- 在跑的是 DeepSeek Harness.exe（官方版），数据根 ~.dsh-official；
  源码仓库 <本机 local-plugins>\dsh-artifact-linker（实体目录，v0.5.7）。
- 实装 ~\.dsh-official\profiles\desktop\node_modules\dsh-artifact-linker\lib\client.js
  是 **pnpm 硬链接**（fsutil hardlink list 指向 C 盘全局 pnpm store 的 v11 files 分片）
  → 绝不能在实装目录原地写（会污染 store 与其它 profile），必须先破链接再换文件。
- 根因：事件链 (onMove / onClick / onContext / hoverProbe) 一律先 hitAt(x,y) 用
  caretRangeFromPoint 反查鼠标下的文字，**完全不区分只读正文与可写输入框** —— 输入框里的路径字符串
  与正文里的路径长得一样，于是同样被识别成产物芯片。

### 修法（lib/client.js 单文件，宿主端不动）
1. 新增 EDIT_NODE_SELECTOR + editNodeOf(el) + inEditZone(target)：
   命中点或任一祖先落在 textarea,input,select,[role="textbox"],[contenteditable],[data-lexical-editor],.ProseMirror
   里（再以 isContentEditable 兜底继承语义）即判为输入区。
   **踩坑记录**：初稿把 .composer / [data-composer] 也算进来，配合 closest() 会顺藤爬到外层
   容器 → 正文任意外层一旦命中就整片拖死链接功能。改回只认真正的可编辑/输入节点。
2. onMove：进输入区当场收摊（hideHover + setCursor("")），不点 40ms 节流；记 hoverInEdit。
3. hoverProbe：延迟回调再用 document.elementFromPoint 读一次现场，双条件任一命中即不画高亮
   （避免 40ms 内移入/移出的竞态）。
4. onClick：inEditZone(ev.target) → 直接 return（不解析、不请求、不跳侧栏、不抢修饰键语义）。
5. onContext：同样在最前面 return，原生编辑菜单（粘贴 / 剪切 / 拼写检查）完整归用户。
6. findComposer：「添加到对话框」的候选必须过 isEditableElement()，排除只读的 [role="textbox"] 渲染层。
7. copy 动作后置 hoverInEdit = true + hideHover()，光标仍在输入框时不残留高亮。
8. 版本：package.json 0.5.8；lib/client.js var VERSION = "0.5.8"；CHANGELOG 0.5.8 条目。

### 装进实装目录（破硬链接的正确做法）
```powershell
$tmp = "lib\__new-<rand>"      # 同目录
Copy-Item "<源仓库>\lib\client.js" $tmp
Move-Item -LiteralPath $tmp -Destination "<实装包>\lib\client.js" -Force   # 原子换名，旧硬链接条目消失
```

**踩坑**：第一次把副本放到了包根（package__new-....js 这类临时文件），必须删掉并确认
lib\client.js 的 LinkType 从 HardLink 变成普通文件；随后用 SHA256 与源码逐字节对账。

### 验证（机器事实）
- node --check：源码与实装两份 lib/client.js 均 exit=0。
- SHA256：源码 = 实装 = 7490DC15...A1487；package.json / CHANGELOG.md 同样逐字节一致。
- fsutil hardlink list 实装 lib/client.js：现在只剩自身一条（已脱离 pnpm store）。
- 无 BOM：client.js 47,47,32 / package.json 123,10,32。
- 行为测试 `test/edit-zone.test.cjs`（无依赖假 DOM）：12/12 PASS，覆盖「正文 span/文本节点不放行」
  与「contenteditable/textarea/[role=textbox]/Lexical/ProseMirror 一律放行」，`isEditableElement` 双向正确。
- 静态判据：inEditZone 出现在 L885(click) / L957(contextmenu) / L1061+L1070(move+probe)，
  isEditableElement 出现在 L476(findComposer)。
- **待人工验收**（客户端侧，无法脚本化）：复制一条路径进输入框 → 悬停不变手型、左键落光标、
  右键出系统编辑菜单；正文里点同一路径仍然跳侧边栏。

### 生效方式
只改了 lib/client.js（客户端 bundle）+ 包元数据，宿主 lib/index.js 未动 →
**Ctrl+Shift+R 硬刷新即可**（Ctrl+R 只从内存缓存重载、不重新读盘）。看版本号：bundle 内 VERSION = "0.5.8"。
