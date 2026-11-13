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
- `node --check lib/client.js` / `lib/index.js` 均 exit=0
- BOM：client.js `47,47,32,100` / index.js `47,47,32,100` / package.json `123,10,32,32` / dev-log `35,32,100,115`（全无）
- `package.json` version = 0.5.4

### 生效方式
本次只改客户端 `lib/client.js` → **Ctrl+Shift+R 硬刷新**即可。
但 0.5.3 还改了宿主 `lib/index.js`（bundle 兜底投递 + client-alive 探针），
所以本轮总体仍需**彻底退出 DSH 再启动**一次；之后单纯改客户端才可用硬刷新。

## 2026-11-13 06:45 · v0.5.3（未发版，仅本地）· 修复右键接管整体失效

### 起因
用户报「右键文件链接插件失效」。实测现象：正文里右键文件芯片（`C:\...\console-sentinel-推送任务书.md`），
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
- `node --check lib/client.js`、`node --check lib/index.js` 均 exit=0
- BOM：client.js `47,47,32,100` / index.js `47,47,32,100` / package.json `123,10,32,32`（全部无 BOM）
- `package.json` 解析 version = `0.5.3`；`lib/client.js` L32 `var VERSION = "0.5.3";`
- **待重启后复核两条日志**：`client fallback: index-inject hook armed` +
  `CLIENT-ALIVE ping received from browser`；以及右键菜单是否变成深色 8 项。

### 生效方式
宿主 `lib/index.js` 与客户端 `lib/client.js` 都改了 → **彻底退出 DSH 再启动**（Ctrl+Shift+R 不够）。
