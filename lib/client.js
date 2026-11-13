// dsh-artifact-linker · 客户端半边（v0.2 极简版）
//
// v0.1 的设计被用户否掉了：右下角悬浮球 + 面板 + 全量 TreeWalker 扫描 + 定时刷新
//   → 误报一堆、切窗口卡、面板里全是「未解析」。
//
// v0.2 的取舍：**零常驻 UI、零扫描、零定时器**。
//   1) 不建任何常驻 DOM（没有浮球、没有面板、没有徽标）；
//   2) 不遍历文档、不装 MutationObserver、不 setInterval；
//   3) 只在用户**真的点了**（click / contextmenu）时才用 caretRangeFromPoint
//      反查鼠标底下那几个字，交给宿主 /resolve 判定是不是真文件；
//   4) 解析失败一律静默放行 —— 误报的代价从「一堆假链接」降为「点了没反应」。
//
// 交互（用户 2026-10-27 明确要求）：
//   左键点正文里的产物名  → 在资源管理器里揭示并选中
//   右键点正文里的产物名  → 自建菜单（揭示 / 默认程序打开 / 复制完整路径）
//   悬停命中时鼠标变手型  → 唯一的视觉提示，靠 mousemove 40ms 节流（可配），几乎无开销
//
// 硬约束（踩过的坑，别再犯）：
//   * 必须有 exports.apply —— 只写 dispose/version 会让 cordis 判 invalid plugin，
//     连崩四次 → Renderer recovery exhausted → 整个桌面端起不来。
//   * fetch 一律用**根相对路径**，绝不拼宿主绝对 origin（CSP + 换端口立刻死）。
//   * 自建浮层的 mousedown 必须在 document 捕获期拦下，否则宿主 closeOutside 抢先关掉。
//   * 绝不改正文 DOM（不改字、不包节点、不接管 markdown 图片），只在事件里读坐标。

// v0.5.6：脚本级幂等守卫（必须在 __ModuleLoader__.load 之前，也就是 factory 注册之前）。
// 实测 2026-11-13：宿主 dsh.client 正常通道与 index-inject 兜底通道各投递一份 client.js，
// 脚本执行两次 → __ModuleLoader__.load 调两次 → renderer 抛
//   Uncaught Error: client-modules: duplicate factory registration for "dsh-artifact-linker"
// → 客户端模块链当场中断，右键接管等注册全部丢失。
// apply() 里的 GUARD 判断救不了：duplicate 是在注册 factory 阶段抛的，早于 apply。
// 所以在脚本最外层拦：第二份脚本直接不注册任何东西，功能与日志都只出现一次。
// v0.5.6 追加：置位必须发生在 load() **成功返回之后**。若第一份脚本到达时 window.__ModuleLoader__
// 还没就绪（兜底 <script> 在 <head>、loader 可能后加载），此时直接跳过且**不置位**，把机会留给
// 后到的那条通道；否则一次 TypeError 就会把标记永久置 true → 客户端再也不注册。
if (window.__dshArtifactLinkerV1_BUNDLE__ !== true
    && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === "function") {
  try {
  window.__ModuleLoader__.load({
  id: "dsh-artifact-linker",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;

    var GUARD = "__dshArtifactLinkerV1";
    var VERSION = "0.5.7";
    // 路由前缀必须与宿主的 ROUTE_PREFIX 一致；永远根相对，绝不拼宿主 origin
    var ROUTE = "/dsh-artifact-linker";

    // ── 侧边栏预览：地址构造 ────────────────────────────────────────────────
    // 宿主 __safeSvc(ctx, "sidebarRight").openResource 只认 dsh-resource:// 地址，不认裸绝对路径。
    // 下面这组函数与官方 @deepseek-ai/dsh-util-workspace-path 的实现逐字对齐
    // （见 dsh-client-ui-reference/lib/client.js），自己抄一份是为了不新增运行时依赖。
    var FILE_ADDRESS_PREFIX = "dsh-resource://file/";
    function encodeSegment(segment) {
      return encodeURIComponent(segment).replace(/%3A/gi, ":");
    }
    function encodePath(p) {
      return p.split("/").map(encodeSegment).join("/");
    }
    function sessionFileAddress(sessionId, p) {
      var normalized = p.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
      return FILE_ADDRESS_PREFIX + "session/" + encodeSegment(sessionId) + "/" + encodePath(normalized);
    }
    function isWinAbs(p) {
      return /^[A-Za-z]:[/\\]/.test(p) || p.indexOf("\\\\") === 0;
    }
    // 绝对路径判定（与宿主 looksAbsolute 对齐）：盘符 / UNC / POSIX 根。
    // 命中即可「直通」——侧栏预览 0 次 /resolve，动作路由也由宿主内部解析。
    function looksAbsoluteClient(p) {
      if (isWinAbs(p)) return true;
      return typeof p === "string" && p.charAt(0) === "/" && p.charAt(1) !== "/";
    }
    function fileAddressFor(sessionId, cwd, p) {
      var normalized = p.replace(/\\/g, "/");
      if (!(normalized.charAt(0) === "/" || isWinAbs(normalized))) return sessionFileAddress(sessionId, normalized);
      var root = cwd === undefined || cwd === null ? "" : String(cwd).replace(/\\/g, "/").replace(/\/+$/, "");
      if (root !== "" && normalized === root) return sessionFileAddress(sessionId, "");
      if (root !== "" && normalized.indexOf(root + "/") === 0) return sessionFileAddress(sessionId, normalized.slice(root.length + 1));
      // 工作区外的绝对路径：原样保留在 session 地址里，宿主按 Session 读权限解析
      return sessionFileAddress(sessionId, normalized);
    }

    // 🔴 「在侧边栏预览」不再有类型白名单（2026-10-30 用户明确要求）。
    //
    // 旧版这里有一张 PREVIEWABLE 白名单，只放「宿主 documentpreview 当时能渲染」的
    // 扩展名，音视频/压缩包被排除，右键它们根本没有预览入口。那个设计错在：
    //   1) 白名单是**对宿主渲染能力的静态猜测**。宿主每加一个渲染器就得回来改一次；
    //      用户装了 video-preview / audio-preview 这类插件后宿主能力早变了，
    //      白名单却停在旧结论上 → 视频、mp3、wav 右键毫无入口（本次的直接病根）。
    //   2) 「能不能渲染」本就不该由客户端猜。判定方是宿主
    //      sidebarRight.openResource：能认领就渲染，认领不了它自己退回默认程序。
    //
    // 现在的契约：**菜单项对所有类型一律显示，点了才见真章**。
    //   openInSidebar 返回 true  → toast「已在侧边栏打开」
    //   openInSidebar 返回 false → toast「侧边栏打不开这个文件（.xxx）」
    // 这样以后侧边栏补了什么能力，本插件零改动自动跟上，不会被旧白名单漏掉。
    // 代价：极少数类型点了会得到一句「打不开」——用户已明确接受。

    function extOf(p) {
      var base = String(p).split(/[\\/]/).pop() || "";
      var dot = base.lastIndexOf(".");
      return dot > 0 ? base.slice(dot + 1) : "";
    }


    // ── 正文里「长得像文件名」的判定 ────────────────────────────────────────
    //
    // 🔴 2026-10-30 起**不再维护扩展名白名单**（用户明确要求：所有文件类型都要能识别、
    // 都能走侧边栏预览）。旧版是一张手写清单，问题是它永远追不上现实：
    //   新格式（heic / avif / mcap / parquet / 3mf / usdz…）每出现一个就得回来补一次，
    //   漏掉的表现就是「正文里明明有文件名，右键毫无反应」——本次音视频/压缩包
    //   的抱怨就是这么来的。
    //
    // 现在的规则：**任意 1–8 位、以字母开头的扩展名都算**，只用一个黑名单挡掉
    // 可执行体与系统二进制。为什么只挡这些：
    //   * 正文里出现 xxx.exe / xxx.dll 九成是命令输出、报错原文、依赖清单，
    //     不是「要打开看的产物」；
    //   * 「用默认程序打开」对它们等于**直接运行**，误点代价太大。
    // 真要放开，把下面对应的词删掉即可。
    //
    // 误报怎么兜？——不靠白名单，靠**存在性闸门**：候选片段必须先在宿主
    // /resolve 真的解析到磁盘文件，才会变成可点目标（见下方 verify()）。
    // 所以把 e.g. / v1.2 这种散文里的点号误当成扩展名也没关系：解析不到就静默，
    // 用户完全看不出它曾被识别过。这比维护一张永远不全的清单可靠得多。
    var EXEC_EXT = /^(exe|msi|msp|mst|dll|sys|com|scr|cpl|ocx|drv|vxd|efi|so|dylib|ko|elf)$/i;

    // 一段文本里「像产物路径」的片段：
    //   可选的前缀（盘符 或 UNC）+ 中间任意非分隔字符 + 点 + 扩展名
    //   + 可选的多级尾巴（Fluent 的 xxx.cas.h5 / xxx.dat.h5 必须整体吃掉，
    //     否则会被截成 xxx.cas 去撞一个不存在的文件 → 点了没反应）
    // 末尾 (?![A-Za-z0-9_]) 防止 package.lock / a.python 这种半截匹配。
    //
    // 🔴 中间段**允许空格**（文件名带空格太常见了），但禁止跨行、禁止跨中文标点与括号。
    // 代价：正文里「详见 报告.pdf」会被整串吃掉，候选变成「详见 报告.pdf」。
    // 这不该在正则层兜——交给后端 resolveAcross 的「从左收缩重试」：
    // 先拿整串解析，不存在就剥掉最左一段再试，直到只剩纯文件名。
    // （2026-10-28 修：原来用 \\s 排除，导致「季度报告 最终版.pdf」只匹配到「最终版.pdf」，
    //   解析必然失败 → 点上去毫无反应。这是「带空格文件名点了没反应」的真正根因。）
    var RE = new RegExp(
      "(?:[A-Za-z]:[\\\\/]|\\\\\\\\[^\\\\/\\s]+[\\\\/][^\\\\/\\s]+)?" +
      "[^\\t\\r\\n`\"'<>|*?（）()【】\\[\\]{}，；、]{1,1024}?\\." +
      // 扩展名两种写法都收：
      //   字母开头 1–12 位（pdf / mp4 / catproduct / properties…）
      //   数字开头 2–12 位（7z / 3mf / 3gp / 8bf…）—— 必须 ≥2 位，否则
      //   散文里的 v1.2 会贡献一个「扩展名 2」，虽然最后也会被存在性闸门静默掉，
      //   但没必要让它进候选池。
      "([A-Za-z][A-Za-z0-9_]{0,11}|[0-9][A-Za-z0-9_]{1,11})" +
      "(?:\\.[A-Za-z0-9]{1,12})*(?![A-Za-z0-9_\\\\/]|\\.[A-Za-z0-9])",
      "gi"
    );
    // URL 里天然带 .png/.pdf，全部要排除，否则网页链接会被当成文件产物。
    var RE_URL = /https?:\/\/[^\s`"'<>）)】\]]+/gi;

    var mounted = false;
    var disposed = false;
    var hoverTimer = null;
    // 悬停判定节流间隔（毫秒）。40ms ≈ 2.5 帧，肉眼已经「跟手」。
    //
    // 原来是写死的 150ms，用户反馈「悬停芯片延迟偏高」：150ms 相当于人眼能
    // 明显察觉的滞后（约 9 帧），鼠标划过一行字时高亮总是慢半拍追上来。
    // 现在改成默认 40ms，并且**可以从 cordis.yml 覆盖**（官方硬规则 #5：
    // 一切 tunable 必须能配置，不许写死）。宿主半边的 `apply()` 读
    // `config.hoverDelayMs`，再通过 /info 下发到这一侧。
    var HOVER_DELAY_DEFAULT_MS = 40;
    var HOVER_DELAY_MAX_MS = 1000;
    var hoverDelayMs = HOVER_DELAY_DEFAULT_MS;
    // 最近一次 mousemove 的坐标。节流期间**每次移动都要记账**，
    // 否则回调只能拿「排程那一刻」的位置去判定：鼠标已经移走或还没移到位，
    // 高亮就落在旧地方（用户反馈的第二个问题：落点不准）。
    var hoverX = 0;
    var hoverY = 0;
    var toastTimer = null;
    var toastEl = null;
    var menuEl = null;
    var hoverBox = null;
    var lastCursor = "";
    var api = null;

    // ── 小工具 ──────────────────────────────────────────────────────────────

    function urlRanges(text) {
      var out = [];
      var m;
      RE_URL.lastIndex = 0;
      while ((m = RE_URL.exec(text))) out.push([m.index, m.index + m[0].length]);
      return out;
    }

    function inRanges(ranges, start, end) {
      for (var i = 0; i < ranges.length; i++) {
        if (start < ranges[i][1] && end > ranges[i][0]) return true;
      }
      return false;
    }

    // 去掉包裹符号与首尾标点，剩下纯路径
    function cleanRaw(s) {
      if (!s) return "";
      return s
        .replace(/^[\s`"'（(【\[]+/, "")
        .replace(/[\s`"'）)】\],;:：。；]+$/, "")
        .replace(/[（(][^）)]*[）)]\s*$/, "")
        .trim();
    }

    // ── 宿主通讯 ────────────────────────────────────────────────────────────
    function hostGet(path, params) {
      var q = [];
      if (params) {
        for (var k in params) {
          if (Object.prototype.hasOwnProperty.call(params, k) && params[k] != null) {
            q.push(encodeURIComponent(k) + "=" + encodeURIComponent(params[k]));
          }
        }
      }
      var url = ROUTE + path + (q.length ? "?" + q.join("&") : "");
      return fetch(url, { credentials: "same-origin" })
        .then(function (r) { return r && r.ok ? r.json() : null; })
        .catch(function () { return null; });
    }

    // 给命中的那段文字算出屏幕矩形，用来画悬停高亮。
    // 关键：**不改 DOM**——用 Range 量尺寸，再用一个 fixed 定位的浮层盖上去，
    // 原文一个节点都不动，宿主 React 重渲染时不会打架。
    function rectFor(node, start, end) {
      try {
        var r = document.createRange();
        r.setStart(node, start);
        r.setEnd(node, end);
        var b = r.getBoundingClientRect();
        if (b && b.width > 0 && b.height > 0) return b;
      } catch (e) { }
      return null;
    }

    // ── 命中判定：鼠标底下那几个字是不是产物名 ──────────────────────────────
    function hitAt(x, y) {
      if (!document || typeof document.caretRangeFromPoint !== "function") return null;
      var range;
      try { range = document.caretRangeFromPoint(x, y); } catch (e) { return null; }
      if (!range || !range.startContainer || range.startContainer.nodeType !== 3) return null;
      var text = range.startContainer.nodeValue || "";
      if (!text) return null;
      var off = range.startOffset;
      var from = Math.max(0, off - 1024);
      var to = Math.min(text.length, off + 1024);
      var win = text.slice(from, to);
      var rel = off - from;
      var urls = urlRanges(win);

      // ★ 绝对路径通道（v0.4.2）：只要鼠标位置左侧有「盘符 X:\ 或 UNC \\host\share\」起点，
      //   就从该起点一路**贪心吃到本行行尾**，不再用「扩展名 + 排除字符集」去猜边界。
      //   这样任何名称都敢认：带空格、带 ()（）[]【】{}、中文标点、无扩展名、超长、
      //   目录名里带点（inratio1.8D / 2024.10.30）全都不影响 —— 真正的边界交给宿主
      //   resolveAcross 的「原样 stat → 从右逐字符收缩（不跨分隔符）」按真实磁盘裁决。
      //   识别层刻意**不做 cleanRaw 去尾**：真实文件也可能以 ) 】 。 结尾，不能被误剥。
      var ABS_ANCHOR = /(?:[A-Za-z]:[\\/]|\\\\[^\\/\r\n]+[\\/][^\\/\r\n]+[\\/]?)/g;
      var lastStart = -1;
      var ma;
      ABS_ANCHOR.lastIndex = 0;
      while ((ma = ABS_ANCHOR.exec(win))) {
        if (ma.index > rel) break;            // 只看鼠标左侧（含）的起点
        lastStart = ma.index;
      }
      if (lastStart >= 0) {
        var nl = win.indexOf("\n", lastStart);
        var lineEnd = nl < 0 ? win.length : nl;
        if (rel <= lineEnd) {
          var seg = win.slice(lastStart, lineEnd).replace(/\s+$/, "");
          if (seg && seg.length >= 4 && !inRanges(urls, lastStart, lastStart + seg.length)) {
            var exts = seg.match(/\.[A-Za-z0-9]{1,12}/g) || [];
            var isExec = false;
            for (var ei = 0; ei < exts.length; ei++) {
              if (EXEC_EXT.test(exts[ei].slice(1))) { isExec = true; break; }
            }
            if (!isExec) {
              return {
                raw: seg,
                rect: rectFor(range.startContainer, from + lastStart, from + lineEnd),
                node: range.startContainer,
                absStart: from + lastStart,
                matchStartFrom: from + lastStart,
                matchText: seg
              };
            }
          }
        }
      }

      // ── 兜底：裸文件名 / 相对路径（无盘符），仍用扩展名形状识别，交后端 ①②③ 兜 ──
      var m;
      RE.lastIndex = 0;
      while ((m = RE.exec(win))) {
        var s = m.index;
        var e = m.index + m[0].length;
        if (rel < s || rel > e) continue;         // 鼠标必须落在这个片段上
        if (inRanges(urls, s, e)) continue;       // URL 里的 .png 不算
        // 可执行体黑名单：这是唯一还刻意不认的类型（理由见上方 EXEC_EXT 注释）。
        // 多级后缀取第一段判断，xxx.exe.bak 也算可执行体，宁可漏认不误点。
        if (m[1] && EXEC_EXT.test(m[1])) continue;
        var raw = cleanRaw(m[0]);
        if (!raw || raw.length < 4) continue;
        // 带上 node / 匹配起点 / 原文，供上层用解析结果把高亮收窄
        // （否则中文前缀会被一起涂蓝 —— 用户报的蓝色越界就是这条路径）
        return {
          raw: raw,
          rect: rectFor(range.startContainer, from + s, from + e),
          node: range.startContainer,
          matchStartFrom: from + s,
          matchText: m[0]
        };
      }
      return null;
    }

    // ── 宿主「文件芯片 / 交付卡片」路径读取（2026-11-07 修复）──────────────────
    // 背景：宿主把 markdown 文件链接渲染成
    //   <button class="…fileMention …fileLink" title="<路径>">，
    // 把 present 交付卡片渲染成
    //   <div data-presented-file><button class="cardPreview" title="<绝对路径>">。
    // 这两类节点的右键由宿主 contextMenus 的官方 provider 接管，正文里**没有**能
    // 被 caretRangeFromPoint 命中的「含路径文本节点」→ 老版 hitAt 只能看到裸文件名、
    // 解析失败 → 放行 → 用户只看到官方默认菜单（本次病根）。这里直接从 title 取真路径。
    var FILE_LINK_SELECTOR = 'button[class*="fileMention"],button[class*="fileLink"]';
    function chipPathAt(target) {
      try {
        var el = null;
        if (target && target.closest) {
          el = target.closest(FILE_LINK_SELECTOR);
          if (!el) {
            var card = target.closest("[data-presented-file]");
            if (card && card.querySelector) el = card.querySelector("button[title]");
          }
        }
        if (!el) return null;
        var t = el.getAttribute && el.getAttribute("title");
        // 兜底（v0.5.3，2026-11-13）：宿主给芯片的 title 只在 src 为空时才写路径 ——
        // 实测 asar 里是 `title: src === undefined ? file.path : void 0`。一旦宿主给
        // file chip 补上 src，title 就是 undefined，旧版在此 `return null` → 不抢 →
        // 用户只看到宿主官方菜单（「插件失效」的第二个成因）。芯片可见文本本身就是
        // 路径，退一步从 textContent 取；截断过的（含 … 或 ...）不认，避免用半截
        // 路径去打开文件。
        if (!t && el.textContent) {
          var tx = String(el.textContent).trim();
          if (tx && tx.length <= 1024 && !/[\r\n]/.test(tx) &&
              tx.indexOf("\u2026") < 0 && tx.indexOf("...") < 0) t = tx;
        }
        if (!t) return null;
        t = String(t).trim();
        if (!t || t.length > 1024 || /[\r\n]/.test(t)) return null;
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return null; // 排除 http(s):// 等 URL 协议头
        if (looksAbsoluteClient(t)) return t;
        if (/\.[A-Za-z0-9]{1,12}$/.test(t)) return t;        // 相对路径，须带扩展名
        return null;
      } catch (e) { return null; }
    }

    // 当前会话工作区根目录（把芯片上的相对路径补成绝对路径；拿不到就返回空串）
    function currentCwd() {
      try {
        if (!rootCtx || typeof rootCtx.get !== "function") return "";
        var sessions = rootCtx.get("sessions");
        if (!sessions || !sessions.list || typeof sessions.list.getSnapshot !== "function") return "";
        var snap = sessions.list.getSnapshot();
        var byId = (snap && snap.byId) || {};
        var sid = null;
        var sidebar = rootCtx.get("sidebarRight");
        var mounted = sidebar && sidebar.mounted;
        if (mounted && typeof mounted.get === "function") {
          var m = mounted.get();
          if (m && m.sessionId) sid = m.sessionId;
        } else if (mounted && mounted.sessionId) {
          sid = mounted.sessionId;
        }
        if (!sid) { for (var k in byId) { if (byId[k] && byId[k].cwd) { sid = k; break; } } }
        return sid && byId[sid] ? String(byId[sid].cwd || "") : "";
      } catch (e) { return ""; }
    }
    function joinCwd(p) {
      if (looksAbsoluteClient(p)) return p;
      var cwd = currentCwd();
      if (!cwd) return p;
      var sep = cwd.indexOf("\\") >= 0 ? "\\" : "/";
      return cwd.replace(/[/\\]+$/, "") + sep + String(p).replace(/^(?:\.?[/\\])+/, "");
    }

    // ── 提示与菜单 ──────────────────────────────────────────────────────────
    function toast(msg) {
      if (!document || !document.body) return;
      if (!toastEl) {
        toastEl = document.createElement("div");
        toastEl.setAttribute("data-dsh-artifact-toast", "1");
        toastEl.style.cssText = [
          "position:fixed", "left:50%", "bottom:36px", "transform:translateX(-50%)",
          "z-index:2147483001", "padding:8px 14px", "border-radius:8px",
          "background:rgba(22,24,29,.94)", "color:#eaeaea", "border:1px solid #3a3d45",
          "font:13px/1.5 system-ui,'Microsoft YaHei',sans-serif",
          "box-shadow:0 6px 20px rgba(0,0,0,.45)", "pointer-events:none", "display:none"
        ].join(";");
        document.body.appendChild(toastEl);
      }
      toastEl.textContent = msg;
      toastEl.style.display = "block";
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(function () {
        toastTimer = null;
        if (toastEl) toastEl.style.display = "none";
      }, 2200);
    }

    function hideMenu() {
      if (menuEl && menuEl.parentNode) menuEl.parentNode.removeChild(menuEl);
      menuEl = null;
    }

    // ── 「添加到对话框」：把路径插进 DSH 的聊天输入框 ────────────────────────
    // DSH 的输入框实现会随版本变（textarea / contenteditable / Lexical 都出现过），
    // 所以这里不写死单个选择器，而是「一批候选 → 挑最像输入区的那个 → 三种写入方式兜底」。
    // 任何一步都失败就返回 false，由调用方明确提示 —— 绝不假装成功。
    var INPUT_SELECTORS = [
      'textarea[placeholder]',
      '[contenteditable="true"]',
      '[role="textbox"]',
      '[data-lexical-editor="true"]',
      '.composer [contenteditable]',
      'textarea'
    ];

    function findComposer() {
      for (var s = 0; s < INPUT_SELECTORS.length; s++) {
        var list;
        try { list = document.querySelectorAll(INPUT_SELECTORS[s]); } catch (e) { continue; }
        // 从后往前：聊天输入框通常位于 DOM 末尾
        for (var k = list.length - 1; k >= 0; k--) {
          var el = list[k];
          if (!el) continue;
          if (el.disabled || el.readOnly) continue;
          var r = el.getBoundingClientRect();
          // 太窄太矮多半是搜索框 / 标签栏；真正的输入区宽度都在 150px 以上
          if (r.width < 150 || r.height < 18) continue;
          var cs = window.getComputedStyle ? window.getComputedStyle(el) : null;
          if (cs && (cs.display === "none" || cs.visibility === "hidden")) continue;
          return el;
        }
      }
      return null;
    }

    function quoteToComposer(abs) {
      var el = findComposer();
      if (!el) return false;
      var text = " " + abs;
      try { el.focus(); } catch (e) { }

      // ① 首选 execCommand：走浏览器真实输入管线，React / Lexical 的受控状态
      //    能同步更新；直接改 textContent 会让框架内部状态与 DOM 脱档。
      try {
        if (document.execCommand && document.execCommand("insertText", false, text)) return true;
      } catch (e) { }

      // ② 原生 value 控件（textarea / input）
      try {
        if (typeof el.value === "string") {
          var a = el.selectionStart == null ? el.value.length : el.selectionStart;
          var b = el.selectionEnd == null ? el.value.length : el.selectionEnd;
          el.value = el.value.slice(0, a) + text + el.value.slice(b);
          el.selectionStart = el.selectionEnd = a + text.length;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          return true;
        }
      } catch (e) { }

      // ③ 最后兜底：contenteditable 直接追加。极端情况下框架状态会不同步，
      //    但用户至少看得见路径已经进去，可以自己删改，比「点了没反应」强。
      try {
        el.textContent = (el.textContent || "") + text;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      } catch (e) { }

      return false;
    }

    // 客户端根 ctx，apply 时存下来；侧边栏预览要用它取 sessions / sidebarRight。
    var rootCtx = null;

    // 当前「已挂载」会话 id —— 唯一权威来源是 sidebarRight.mounted（宿主内部 Signal；
    // 宿主 require() 里写的就是 const sessionId = this.mounted.getSnapshot()）。
    // 注意 getSnapshot() 返回的是 sessionId 字符串本身，不是 { sessionId } 对象；
    // 旧版读 m.sessionId 永远 undefined，于是退回「byId 里第一个有 cwd 的」，
    // 拿到别的历史会话 → openResourceIn 内部 actionsFor(sid) 为 undefined
    // → 宿主静默不做事，表现就是「浮窗中打开」点了没反应。
    function currentSid(sidebar, byId) {
      try {
        var mounted = sidebar && sidebar.mounted;
        if (mounted) {
          if (typeof mounted.getSnapshot === "function") {
            var v = mounted.getSnapshot();
            if (typeof v === "string" && v) return v;
            if (v && typeof v.sessionId === "string" && v.sessionId) return v.sessionId;
          }
          if (typeof mounted.get === "function") {
            var v2 = mounted.get();
            if (typeof v2 === "string" && v2) return v2;
            if (v2 && typeof v2.sessionId === "string" && v2.sessionId) return v2.sessionId;
          }
          if (typeof mounted === "string" && mounted) return mounted;
        }
      } catch (e) { /* 服务形态变了就退回下面的兜底 */ }
      for (var k in byId) { if (byId[k] && byId[k].cwd) return k; }
      return null;
    }

    // 在右侧边栏打开一个文件。
    // 用的是官方导航入口 __safeSvc(ctx, "sidebarRight").openResource(address)，和聊天里点文件链接
    // 走的是同一条路，所以不会和宿主自己的预览行为打架。
    // 返回 false 表示「这次开不了」，调用方据此给提示，绝不假装成功。
    function openInSidebar(abs) {
      try {
        if (!rootCtx || typeof rootCtx.get !== "function") return false;
        var sidebar = rootCtx.get("sidebarRight");
        if (!sidebar) return false;
        if (typeof sidebar.openResource !== "function" && typeof sidebar.openResourceIn !== "function") return false;
        var sessions = rootCtx.get("sessions");
        if (!sessions || !sessions.list || typeof sessions.list.getSnapshot !== "function") return false;
        var snap = sessions.list.getSnapshot();
        var byId = (snap && snap.byId) || {};
        // 找当前会话：优先 mounted（屏幕上那个），否则取第一个带 cwd 的
        var sid = currentSid(sidebar, byId);
        if (!sid) return false;
        var cwd = byId[sid] ? byId[sid].cwd : undefined;
        // v0.5.6：侧栏**回退到老接口 openResource(addr)**。0.5.4 把它改成优先 openResourceIn 之后，
        // 用户实测「右键 → 在侧边栏打开」点了没反应；而 0.5.3 的 openResource 与聊天里点文件链接
        // 走的是同一条路、已被实测验证可用，所以这里以它为主，openResourceIn 只作回退。
        var addr = fileAddressFor(sid, cwd, abs);
        if (typeof sidebar.openResource === "function") {
          sidebar.openResource(addr);
        } else if (typeof sidebar.openResourceIn === "function") {
          sidebar.openResourceIn(sid, addr, { destination: "sidebar" });
        } else {
          return false;
        }
        return true;
      } catch (e) {
        // 服务缺失、地址不被任何 tab 类型认领、会话还没就绪 —— 一律当作开不了
        return false;
      }
    }

    // 浮窗打开：走宿主官方通道 sidebarRight.openResourceIn(sid, addr, { destination: "float" })。
    // 早期版本用 window.open 开新窗口，在 Electron 下必然失败（见下方注释），故已废弃。
    // 拿不到会话/地址/该能力时返回 false，调用方如实提示，绝不静默当成功。
    function openFloating(abs) {
      try {
        if (!rootCtx || typeof rootCtx.get !== "function") return false;
        var sidebar = rootCtx.get("sidebarRight");
        var sessions = rootCtx.get("sessions");
        if (!sessions || !sessions.list || typeof sessions.list.getSnapshot !== "function") return false;
        var snap = sessions.list.getSnapshot();
        var byId = (snap && snap.byId) || {};
        var sid = currentSid(sidebar, byId);
        if (!sid) return false;
        var cwd = byId[sid] ? byId[sid].cwd : undefined;
        var addr = fileAddressFor(sid, cwd, abs);
        if (!addr) return false;

        // v0.5.4 修复（2026-11-13）：旧版这里用
        //   window.open(addr, "_blank", "width=960,height=720,noopener,noreferrer")
        // 在 Electron 里**必然失败**：①宿主对 window.open 有 setWindowOpenHandler 管控，
        // ②dsh-resource:// 是宿主自己的自定义协议，独立 BrowserWindow 里没有对应的
        // protocol handler，即便弹出也是白屏。所以「浮窗打开」以前每次都只弹一句
        // 「浮窗打开失败」。
        // 宿主的官方浮窗通道是 sidebarRight.openResourceIn(sessionId, address,
        // { destination: "float" }) —— asar 实测：宿主自己右键菜单里的「在浮窗中打开」
        // 就是 `ctx.sidebarRight.openResourceIn(sessionId, fileAddressFor(...), { destination })`。
        // 这里改走官方通道；宿主连这个能力都没有时才如实返回 false。
        if (!sidebar) return false;
        if (typeof sidebar.openResourceIn === "function") {
          sidebar.openResourceIn(sid, addr, { destination: "float" });
          // 幂等补投一次：宿主对「已在浮窗里的文件」是揭示语义（已开则揭示、不重复开），
          // 所以多调一次无害；首调若撞上浮窗 pane 正在创建会落空，这次补投能接上。
          try {
            setTimeout(function () {
              try { sidebar.openResourceIn(sid, addr, { destination: "float" }); } catch (e) { /* 已开 */ }
            }, 320);
          } catch (e) { /* 无 setTimeout 环境就只投一次 */ }
          return true;
        }
        if (typeof sidebar.openResource === "function") {
          try { sidebar.openResource(addr, { destination: "float" }); return true; } catch (e) { /* 落到下一行 */ }
        }
        return false;
      } catch (e) {
        return false;
      }
    }

    // 只复制路径文字（修饰键 / 菜单共用）。失败如实提示，不装作成功。
    function copyPathText(text, okMsg) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text);
          toast(okMsg || "已复制路径");
          return true;
        }
      } catch (e) { }
      toast("复制失败");
      return false;
    }

    function showMenu(x, y, abs) {
      hideMenu();
      if (!document || !document.body) return;
      var box = document.createElement("div");
      box.setAttribute("data-dsh-artifact-menu", "1");
      box.style.cssText = [
        "position:fixed", "z-index:2147483000", "min-width:212px", "padding:4px",
        "border-radius:9px", "background:#22242a", "color:#e6e6e6",
        "border:1px solid #3a3d45", "box-shadow:0 8px 24px rgba(0,0,0,.5)",
        "font:13px/1.5 system-ui,'Microsoft YaHei',sans-serif", "user-select:none"
      ].join(";");

      // 顶部一行写清「这个菜单在操作哪个文件」。没有它，用户不知道点的是不是想要的那个。
      var head = document.createElement("div");
      var baseName = String(abs).split(/[\\/]/).pop() || abs;
      head.textContent = baseName;
      head.title = abs;
      head.style.cssText = "padding:5px 10px 7px;margin-bottom:3px;border-bottom:1px solid #33363e;color:#9aa0aa;font-size:12px;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
      box.appendChild(head);

      // 图标统一用同一套线性 SVG（stroke=currentColor）。不用 emoji ——
      // emoji 在 Windows 上是彩色位图，三个混在一起风格直接炸裂。
      var ICON = {
        reveal: '<path d="M3 7.2A1.7 1.7 0 0 1 4.7 5.5h3.9l1.8 2.1h8.9A1.7 1.7 0 0 1 21 9.3v8A1.7 1.7 0 0 1 19.3 19H4.7A1.7 1.7 0 0 1 3 17.3Z"/><path d="M9 13.6h6"/>',
        open: '<path d="M14.5 4.5h5v5"/><path d="M19.7 4.3 11 13"/><path d="M18 13.8v4.5A1.7 1.7 0 0 1 16.3 20H5.7A1.7 1.7 0 0 1 4 18.3V7.7A1.7 1.7 0 0 1 5.7 6h4.4"/>',
        copy: '<rect x="9.2" y="9.2" width="10.8" height="10.8" rx="2.2"/><path d="M15 5.8A1.8 1.8 0 0 0 13.2 4H5.8A1.8 1.8 0 0 0 4 5.8v7.4A1.8 1.8 0 0 0 5.8 15"/>',
        // 另存为：向下箭头入托盘
        saveas: '<path d="M12 3.5v9.5"/><path d="m8.6 9.6 3.4 3.4 3.4-3.4"/><path d="M4.5 16.2v2.1a1.8 1.8 0 0 0 1.8 1.8h11.4a1.8 1.8 0 0 0 1.8-1.8v-2.1"/>',
        // 复制文件：两张纸 + 中间的文件线，和「复制路径」区分开
        copyfile: '<rect x="8.6" y="3.4" width="11" height="13" rx="2"/><path d="M5.4 7.4h-.7A1.7 1.7 0 0 0 3 9.1v9.4a1.7 1.7 0 0 0 1.7 1.7h8.4a1.7 1.7 0 0 0 1.7-1.7v-.7"/><path d="M11.6 8.2h5"/><path d="M11.6 11.4h5"/>',
        // 添加到对话框：带横线的气泡
        quote: '<path d="M20.5 11.6a8.3 8.3 0 0 1-8.3 8.3H7.4L3.5 21.9l1-4.1A8.3 8.3 0 1 1 20.5 11.6Z"/><path d="M9 11h6"/><path d="M9 14.2h3.6"/>',
        // 侧边栏预览：一块面板 + 右侧分栏
        preview: '<rect x="3.2" y="4.4" width="17.6" height="15.2" rx="2.2"/><path d="M14.4 4.4v15.2"/>',
        // 浮窗：面板 + 向外箭头（弹出独立窗口）
        float: '<rect x="3.2" y="4.6" width="13.4" height="11.2" rx="2"/><path d="M16.8 9.6v9h-5.4"/><path d="M13.8 6.4h4.8v4.8"/>'
      };
      // 文案要说人话：「资源管理器」这个词很多用户不认识，改成「文件夹窗口」。
      // 顺序按「最常做的动作」排，并用 "sep" 占位分成三组：
      //   看（侧边栏预览 / 打开 / 定位）→ 搬运（另存为 / 复制文件 / 复制路径）→ 喂给 AI（添加到对话框）
      //
      // 🔴 「在侧边栏预览」对所有文件类型**无条件出现**（2026-10-30 用户明确要求）。
      // 旧版按 PREVIEWABLE 白名单决定显不显示，音视频/压缩包因此完全没有入口。
      // 现在一律显示，点下去由宿主 sidebarRight.openResource 决定能不能认领：
      // 认领得了就渲染，认领不了 openInSidebar 返回 false，我们照实提示「打不开」。
      var items = [];
      items.push(["preview", "在侧栏打开", "在右侧边栏里直接看，不用切出去；这个类型如果侧边栏渲染不了会如实提示"]);
      items.push(["float", "在浮窗中打开", "在一个独立浮窗里打开预览（增强项；若浏览器拦截弹窗，请改用「在侧栏打开」）"]);
      items.push(["reveal", "在文件夹中显示", "打开 Windows 文件夹窗口，并选中这个文件"]);
      items.push(["open", "用默认程序打开", "按文件类型用对应软件打开：PDF 用阅读器、表格用 Excel 那类"]);
      items.push(["sep", "", ""]);
      items.push(["saveas", "另存为…", "另存一份到别的位置（会弹出系统保存窗口）"]);
      items.push(["copyfile", "复制文件", "把文件本身放进剪贴板，可直接粘到任意文件夹"]);
      items.push(["copy", "复制文件路径", "只复制路径文字，不复制文件本身"]);
      items.push(["sep", "", ""]);
      items.push(["quote", "添加到对话框", "把完整路径插入上方的聊天输入框"]);
      for (var i = 0; i < items.length; i++) {
        // 分隔线：一个 1px 的 div，左右留白对齐文字缩进，不加任何可点区域
        if (items[i][0] === "sep") {
          var hr = document.createElement("div");
          hr.style.cssText = "height:1px;margin:4px 8px;background:#33363e";
          box.appendChild(hr);
          continue;
        }
        (function (action, label, tip) {
          var row = document.createElement("div");
          row.title = tip;
          row.style.cssText = "display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:6px;cursor:pointer;white-space:nowrap;background:transparent;color:#e6e6e6";
          var ic = document.createElement("span");
          ic.style.cssText = "display:inline-flex;width:15px;height:15px;flex:0 0 15px;color:#9aa0aa";
          ic.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + ICON[action] + "</svg>";
          var tx = document.createElement("span");
          tx.textContent = label;
          row.appendChild(ic);
          row.appendChild(tx);
          row.addEventListener("mouseenter", function () { row.style.background = "#33363e"; ic.style.color = "#e6e6e6"; });
          row.addEventListener("mouseleave", function () { row.style.background = "transparent"; ic.style.color = "#9aa0aa"; });
          row.addEventListener("click", function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            hideMenu();

            // ⓪ 浮窗打开 —— 增强项，纯客户端弹独立小窗；被拦截就如实提示改用侧栏
            if (action === "float") {
              if (openFloating(abs)) toast("已在浮窗中打开");
              else toast("浮窗打开失败：宿主未提供浮窗能力或当前会话未就绪，可改用「在侧栏打开」");
              return;
            }

            // ① 侧边栏预览 —— 纯客户端，走宿主导航入口
            if (action === "preview") {
              // 对所有类型都尝试，成败照实说。带扩展名，用户才知道是哪个类型没成。
              var pext = extOf(abs);
              if (openInSidebar(abs)) toast("已在侧边栏打开" + (pext ? "（." + pext + "）" : ""));
              else toast("侧边栏打不开" + (pext ? " ." + pext : "这个文件") + "，可改用「用默认程序打开」");
              return;
            }

            // ② 只复制路径文字 —— 纯客户端，不必过宿主
            if (action === "copy") {
              try {
                navigator.clipboard.writeText(abs);
                toast("已复制路径");
              } catch (e) { toast("复制失败"); }
              return;
            }

            // ② 添加到对话框 —— 也是纯客户端：找输入框、把路径插进去
            if (action === "quote") {
              if (quoteToComposer(abs)) toast("已添加到对话框");
              else toast("没找到聊天输入框");
              return;
            }

            // ③ 另存为 —— 宿主会弹系统保存窗，用户挑位置期间不能提前报成功
            if (action === "saveas") {
              toast("请在弹出窗口里选择保存位置…");
              hostGet("/saveas", { p: abs }).then(function (r) {
                if (!r || !r.ok) {
                  // 用户自己点取消不是失败，别弹红字打扰
                  if (r && r.reason === "cancelled") return;
                  if (r && r.reason === "same-path") { toast("不能存回原文件"); return; }
                  toast("另存为失败：" + ((r && r.reason) || "未知原因"));
                  return;
                }
                var short = String(r.dest).split(/[\\/]/).pop() || r.dest;
                toast("已另存为 " + short);
              });
              return;
            }

            // ④ 复制文件本体（CF_HDROP），粘到文件夹里得到的是文件
            if (action === "copyfile") {
              hostGet("/copyfile", { p: abs }).then(function (r) {
                if (!r || !r.ok) { toast("复制失败：" + ((r && r.reason) || "未知原因")); return; }
                toast("已复制文件，可直接粘贴");
              });
              return;
            }

            // ⑤ 打开 / 在文件夹中显示
            hostGet("/" + action, { p: abs }).then(function (r) {
              if (!r || !r.ok) toast("打开失败：" + ((r && r.reason) || "未知原因"));
            });
          });
          box.appendChild(row);
        })(items[i][0], items[i][1], items[i][2]);
      }

      document.body.appendChild(box);
      menuEl = box;
      var rect = box.getBoundingClientRect();
      var left = Math.min(x, (window.innerWidth || 1200) - rect.width - 8);
      var top = Math.min(y, (window.innerHeight || 800) - rect.height - 8);
      box.style.left = Math.max(8, left) + "px";
      box.style.top = Math.max(8, top) + "px";
    }

    // ── 事件处理 ────────────────────────────────────────────────────────────

    // 产物存在性缓存：raw → { ok, abs, at, pending, waiters }
    // 为什么需要这一层：正文里长得像文件名的片段太多了（日志摘录、示例路径、报错原文，
    // 甚至我自己贴出来的乱码文件名）。只看「形状」就画成可点芯片，用户点开只会得到
    // 一句「没解析到这个文件」——那比根本不认识更糟。现在改成：
    // **先确认文件真的存在，才允许它变成芯片**。不存在的，就当普通文字，静默。
    var vcache = Object.create(null);
    var VCACHE_TTL = 30000;

    function verify(raw, cb) {
      var now = Date.now();
      var c = vcache[raw];
      if (c && c.pending) { c.waiters.push(cb); return; }
      if (c && (now - c.at) < VCACHE_TTL) { cb(c); return; }

      var rec = { ok: false, abs: null, at: now, pending: true, waiters: [cb] };
      vcache[raw] = rec;
      function settle(ok, abs) {
        rec.ok = ok;
        rec.abs = abs;
        rec.at = Date.now();
        rec.pending = false;
        var ws = rec.waiters;
        rec.waiters = [];
        for (var i = 0; i < ws.length; i++) { try { ws[i](rec); } catch (e) { } }
      }
      hostGet("/resolve", { p: raw }).then(function (d) {
        var ok = !!(d && d.ok && d.abs);
        settle(ok, ok ? d.abs : null);
      }).catch(function () { settle(false, null); });
    }

    // 只有「已有结论且未过期」时才返回，pending 一律当没有 → 调用方自己决定等不等
    function cached(raw) {
      var c = vcache[raw];
      if (!c || c.pending) return null;
      if ((Date.now() - c.at) >= VCACHE_TTL) return null;
      return c;
    }

    function setCursor(v) {
      if (v === lastCursor) return;
      lastCursor = v;
      document.body.style.cursor = v;
    }

    function act(raw, mode, x, y) {
      verify(raw, function (rec) {
        if (disposed) return;
        // 解析不到就当普通文字，静默收场：不弹提示、不装作成功。
        if (!rec.ok || !rec.abs) return;
        // 左键默认：在侧边栏打开（与官方 present 卡片语义统一）；侧栏认领不了的类型再退化系统默认打开
        if (mode === "preview") {
          if (openInSidebar(rec.abs)) { toast("已在侧边栏打开"); return; }
          hostGet("/open", { p: rec.abs }).then(function (r) {
            if (disposed) return;
            if (!r || !r.ok) toast("打开失败：" + ((r && r.reason) || "未知原因"));
          });
          return;
        }
        if (mode === "reveal") {
          hostGet("/reveal", { p: rec.abs }).then(function (r) {
            if (disposed) return;
            if (!r || !r.ok) toast("打开失败：" + ((r && r.reason) || "未知原因"));
          });
          return;
        }
        showMenu(x, y, rec.abs);
      });
    }

    function onClick(ev) {
      if (disposed) return;
      if (ev.button !== 0) return;
      if (menuEl && menuEl.contains && menuEl.contains(ev.target)) return;
      // 宿主文件芯片 / 交付卡片：左键交给宿主自己的 openFile / onPreview，避免双开
      if (chipPathAt(ev.target) !== null) return;
      var hit = hitAt(ev.clientX, ev.clientY);
      if (!hit) return;
      // 官方 present 交付卡片本身已内置「点卡片 → 侧边栏预览」，交给官方自己开，避免双开
      try {
        var tEl = ev.target;
        if (tEl && tEl.closest && tEl.closest('[data-tool="present"]')) return;
      } catch (e2) { }
      var clean = cleanRaw(hit.raw);

      // ── 修饰键语义（与官方一致）：Alt=复制绝对路径；Shift/Ctrl/Cmd=系统默认程序打开 ──
      if (ev.altKey) {
        ev.preventDefault();
        ev.stopPropagation();
        if (looksAbsoluteClient(clean)) { copyPathText(clean); return; }
        verify(hit.raw, function (rec) {
          if (disposed) return;
          if (rec && rec.ok && rec.abs) copyPathText(rec.abs);
          else toast("没解析到这个文件，无法复制路径");
        });
        return;
      }
      if (ev.ctrlKey || ev.metaKey || ev.shiftKey) {
        ev.preventDefault();
        ev.stopPropagation();
        // 系统默认程序打开：直接把原始文本交给宿主，宿主内部解析（一次往返，不先 /resolve）
        hostGet("/open", { p: hit.raw }).then(function (r) {
          if (disposed) return;
          if (!r || !r.ok) toast("打开失败：" + ((r && r.reason) || "未知原因"));
        });
        return;
      }

      // ── 普通左键：侧边栏预览 ──
      // 🔴 绝不 preventDefault / stopPropagation：让事件照常冒泡给宿主；宿主若已接管（defaultPrevented）就让路。
      setTimeout(function () {
        if (ev.defaultPrevented) return;   // 宿主已经处理（例如开了侧边栏预览）→ 让路，不抢
        var c = cached(hit.raw);
        if (c && !c.ok) return;            // 已确认「根本不是产物」→ 什么都不做
        // 绝对路径直通：不经 /resolve，直接侧栏打开（验收①：Network 无 /resolve）
        if (looksAbsoluteClient(clean)) {
          if (openInSidebar(clean)) { toast("已在侧边栏打开"); return; }
          hostGet("/open", { p: hit.raw }).then(function (r) {
            if (disposed) return;
            if (!r || !r.ok) toast("打开失败：" + ((r && r.reason) || "未知原因"));
          });
          return;
        }
        // 已有解析结论（裸名缓存命中）→ 直接侧栏开，省一次往返
        if (c && c.ok) {
          if (openInSidebar(c.abs)) { toast("已在侧边栏打开"); return; }
          hostGet("/open", { p: c.abs }).then(function (r) {
            if (disposed) return;
            if (!r || !r.ok) toast("打开失败：" + ((r && r.reason) || "未知原因"));
          });
          return;
        }
        // 裸名首次：act 内部走一次 verify(/resolve) 再侧栏开（验收②：1 次解析）
        act(hit.raw, "preview", ev.clientX, ev.clientY);
      }, 0);
    }

    function onContext(ev) {
      if (disposed) return;
      if (menuEl && menuEl.contains && menuEl.contains(ev.target)) {
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
      // ① 宿主渲染的文件芯片 / 交付卡片：直接从 title 取真实路径，弹自己的完整菜单，
      //    并在捕获期拦下事件、阻止宿主 contextMenus 的官方菜单（这是 2026-11-07 的修复点）。
      var chipRaw = chipPathAt(ev.target);
      if (chipRaw !== null) {
        var chipAbs = joinCwd(chipRaw);
        if (looksAbsoluteClient(chipAbs)) {
          ev.preventDefault();
          ev.stopPropagation();
          showMenu(ev.clientX, ev.clientY, chipAbs);
          return;
        }
        // 相对路径且拿不到会话 cwd → 补不成绝对路径，不抢，交给宿主官方菜单兜底
      }

      // ② 正文里的纯文本路径：沿用原有 caretRangeFromPoint 命中逻辑
      var hit = hitAt(ev.clientX, ev.clientY);
      if (!hit) return;                    // 非产物处右键 → 放行宿主原生菜单
      var c = cached(hit.raw);
      // 已确认不是产物 → 同样放行宿主原生菜单，绝不抢
      if (c && !c.ok) return;
      // 有结论且确实存在 → 直接弹自己的菜单，省一次往返
      if (c && c.ok) {
        ev.preventDefault();
        ev.stopPropagation();
        showMenu(ev.clientX, ev.clientY, c.abs);
        return;
      }
      // 🔴 还没有结论时**绝不先 preventDefault**。
      // 旧版在这里无条件拦下原生菜单，然后异步去解析；一旦解析失败（正文里
      // 形状像文件名、实际不存在的那类片段），act() 直接静默返回 ——
      // 结果是原生菜单被拦掉、自己的菜单也没弹出，右键**彻底无反应**。
      // 宁可让原生菜单先闪一下，也不能让右键失灵。
      verify(hit.raw, function (rec) {
        if (disposed) return;
        if (!rec.ok || !rec.abs) return;
        showMenu(ev.clientX, ev.clientY, rec.abs);
      });
    }

    // ── 悬停高亮：让「这几个字是可以点的产物」一眼看得出来 ──────────────────
    // 做法是用一个 fixed 浮层盖在文字上（淡蓝底 + 底部蓝色虚​线），**不动 DOM**——
    // 原文一个节点都不改，就不会跟宿主 React 的重渲染打架；滚动时立刻隐藏，
    // 免得浮层跟着滚动跟文字脱位。
    // 把高亮收窄到「解析结果真正对应的那段文字」。
    // 背景：识别层为了敢认各种怪名字，会刻意多带一点前缀/后缀（如 `现在排在 screenshots.json`、
    // `D:\proj\out\a.xlsx 说明文字`）。直接把 rect 盖上去就会把说明文字一起涂蓝（用户报的蓝色越界）。
    // 做法：先用解析结果里的**文件名**在原文中定位，再向左逐字符与绝对路径的尾部对齐扩，绝不超出原文范围。
    function narrowByAbs(matchText, abs) {
      try {
        if (!matchText || !abs) return null;
        var full = String(abs);
        var base = full.split(/[\\/]/).pop();
        if (!base) return null;
        var hay = matchText.toLowerCase();
        var i = hay.lastIndexOf(base.toLowerCase());
        if (i < 0) return null;
        var k = i, j = full.length - base.length;
        var back = full.toLowerCase();
        while (k > 0 && j > 0 && hay.charAt(k - 1) === back.charAt(j - 1)) { k--; j--; }
        return { start: k, end: i + base.length };
      } catch (e) { return null; }
    }

    function drawHover(rect) {
      if (!rect) { hideHover(); return; }
      if (!hoverBox) {
        hoverBox = document.createElement("div");
        hoverBox.setAttribute("data-dsh-artifact-hover", "1");
        hoverBox.style.cssText = "position:fixed;pointer-events:none;z-index:2147482900;border-radius:4px;display:none;box-sizing:border-box";
        document.body.appendChild(hoverBox);
      }
      hoverBox.style.display = "block";
      hoverBox.style.left = (rect.left - 3) + "px";
      hoverBox.style.top = (rect.top - 1) + "px";
      hoverBox.style.width = (rect.width + 6) + "px";
      hoverBox.style.height = (rect.height + 2) + "px";
      // 配色对齐 Codex 那一档蓝（#58a6ff），底色压得很淡只做暗示。
      // 用户 2026-11-10 定稿：不要下划线、不要虚线，高亮就只有这一层底色 ——
      // 所以不画 border、不画任何 background 图形。
      hoverBox.style.background = "rgba(88,166,255,.13)";
      hoverBox.style.border = "none";
      hoverBox.style.backgroundImage = "none";
      hoverBox.style.boxShadow = "none";
      hoverBox.style.borderRadius = "3px";
    }
    function hideHover() { if (hoverBox) hoverBox.style.display = "none"; }

    // 节流窗口内只排一次 timer，窗口结束时用**最新**坐标判定。
    //
    // 这里有两处曾经的毛病（issue #1 报的就是这两条）：
    //   1) 间隔写死 150ms → 高亮慢半拍，鼠标划过一行字时明显能看出滞后；
    //   2) 坐标在 setTimeout **外面**就取好了（`var x = ev.clientX` 在排程那
    //      一刻执行），于是 150ms 后判定的是「150ms 之前鼠标在哪」。鼠标已经
    //      移开就画到旧位置，移得慢就还没到位 —— 落点不准。
    // 现在：坐标在回调里从 hoverX/hoverY 读，永远是当前值；间隔由
    // HOVER_DELAY_DEFAULT_MS（40ms）/ config.hoverDelayMs 决定。
    function onMove(ev) {
      if (disposed) return;
      // 每一次移动都记账，哪怕这一格被节流掉：回调要读的就是这份最新账。
      hoverX = ev.clientX;
      hoverY = ev.clientY;
      if (hoverTimer) return;
      hoverTimer = setTimeout(hoverProbe, hoverDelayMs);
    }

    function hoverProbe() {
      hoverTimer = null;
      if (disposed || !document || !document.body) return;
      var hit = hitAt(hoverX, hoverY);
      if (!hit) { setCursor(""); hideHover(); return; }
      // 先确认文件真的存在，再给「可点」的视觉信号：
      // 不存在的片段不画虚线、不变手型，用户根本看不出它曾被识别过。
      verify(hit.raw, function (rec) {
        if (disposed) return;
        if (!rec.ok) { setCursor(""); hideHover(); return; }
        // 这一次 verify 可能是异步回来的（首次解析要走 /resolve），那时鼠标
        // 早就动了 —— 按**此刻**的位置重算命中，命中换了就收摊，绝不把高亮
        // 留在已经离开的那段文字上。
        var liveHit = hitAt(hoverX, hoverY);
        if (!liveHit || liveHit.raw !== hit.raw) { setCursor(""); hideHover(); return; }
        setCursor("pointer");
        // 绝对路径通道可能把「路径 + 尾随说明」整段当候选，粗略 rect 会盖到说明文字上。
        // 命中后按宿主返回的真实 abs 长度把高亮收窄到路径本身（起点对齐，abs 是候选的前缀）。
        var rr = liveHit.rect;
        // 用解析结果把高亮收窄到路径本身。旧写法按 `absStart + rec.abs.length` 切，
        // 前提是「abs 恰好等于候选的字面长度」；候选带中文前缀（如 `现在排在 screenshots.json`）
        // 或路径里带空格时这个前提不成立，会向左/向右越界（用户报的蓝色区域就是这个）。
        if (liveHit.node && rec.abs) {
          var nw = narrowByAbs(liveHit.matchText, rec.abs);
          var anchor = (liveHit.matchStartFrom != null) ? liveHit.matchStartFrom : liveHit.absStart;
          if (nw && anchor != null) {
            var precise = rectFor(liveHit.node, anchor + nw.start, anchor + nw.end);
            if (precise) rr = precise;
          }
        }
        drawHover(rr);
      });
    }

    // 菜单内的 mousedown 必须在捕获期拦下：宿主的 closeOutside 挂在 document 层，
    // 不拦就会被判定「点外面了」→ 菜单还没点到就自己关了。
    function onDownCapture(ev) {
      if (!menuEl) return;
      var path = typeof ev.composedPath === "function" ? ev.composedPath() : null;
      var inside = path && path.indexOf(menuEl) >= 0;
      if (inside) {
        ev.stopPropagation();
        return;
      }
      hideMenu();
    }

    // ── 生命周期 ────────────────────────────────────────────────────────────

    function mount() {
      if (disposed || mounted) return;
      if (!document) return;
      if (!document.body) {
        if (document.readyState === "loading" && document.addEventListener) {
          document.addEventListener("DOMContentLoaded", function () { mount(); }, { once: true });
        } else {
          setTimeout(function () { mount(); }, 50);
        }
        return;
      }
      mounted = true;
      document.addEventListener("click", onClick, true);
      document.addEventListener("contextmenu", onContext, true);
      document.addEventListener("mousemove", onMove, { capture: true, passive: true });
      document.addEventListener("mousedown", onDownCapture, true);
      // 滚动立刻收起悬停高亮（passive + capture，几乎零成本）
      document.addEventListener("scroll", hideHover, { capture: true, passive: true });
    }

    function dispose() {
      disposed = true;
      mounted = false;
      try {
        document.removeEventListener("click", onClick, true);
        document.removeEventListener("contextmenu", onContext, true);
        document.removeEventListener("mousemove", onMove, true);
        document.removeEventListener("mousedown", onDownCapture, true);
        document.removeEventListener("scroll", hideHover, true);
      } catch (e) { /* 文档都没了就无所谓 */ }
      if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
      if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
      hideMenu();
      hideHover();
      if (hoverBox && hoverBox.parentNode) hoverBox.parentNode.removeChild(hoverBox);
      hoverBox = null;
      if (toastEl && toastEl.parentNode) toastEl.parentNode.removeChild(toastEl);
      toastEl = null;
      lastCursor = "";
      try { if (document && document.body) document.body.style.cursor = ""; } catch (e) { }
      try { if (window[GUARD] === api) window[GUARD] = null; } catch (e) { }
    }

    // 2026-11-12：cordis 在服务未就绪时裸读 ctx.<service> 会抛，直接导致本 entry 判
    // "failed"；shared 服务名统一走这个安全取值器（取不到返回 undefined）。
    function __safeSvc(ctx, name) {
      try { return ctx[name]; } catch (e) { return undefined; }
    }
    function apply(ctx) {
      // 客户端存活探针：bundle 一到就先告诉宿主（宿主日志会出现
      // "CLIENT-ALIVE ping received from browser"），这样「客户端到底加载了没」
      // 不必再靠猜。必须放在所有 return 之前。
      try { fetch(ROUTE + "/client-alive").catch(function () {}); } catch (e) { /* ignore */ }

      // v0.5.3 修复（2026-11-13）：旧版在这里对 sidebarRight 做硬依赖检查，拿不到
      // 就 `return` —— 结果是该服务一旦缺失/晚到，整个插件（右键接管 + 胶囊）一连
      // 都不挂，用户看到的就是「右键只弹宿主官方菜单」，即本插件「失效」。
      // sidebarRight 只影响「在侧栏打开」一项，而 openInSidebar 自己已有
      // `if (!sidebar || typeof sidebar.openResource !== "function") return false`
      // 的优雅降级。所以这里不再阻塞挂载。
      // 单例守卫：热重载会堆实例，先摘旧的那个
      try {
        if (window[GUARD] && typeof window[GUARD].dispose === "function") window[GUARD].dispose();
      } catch (e) { /* 旧实例已经废了就废了 */ }

      disposed = false;
      mounted = false;
      rootCtx = ctx || null;
      api = { apply: apply, dispose: dispose, version: VERSION };
      try { window[GUARD] = api; } catch (e) { /* 极端沙箱下挂不上，不影响本实例 */ }

      mount();

      // 问一次宿主是否在线（顺带取回 bases：排查「未解析」时直接看 api.host.bases）
      try {
        hostGet("/info").then(function (d) {
          if (disposed || !d || !api) return;
          api.host = d;
          // 悬停节流间隔由宿主半边下发（config.hoverDelayMs），这里只做
          // 上下限兜底，绝不自己另立一个默认值。
          if (typeof d.hoverDelayMs === "number" && isFinite(d.hoverDelayMs) && d.hoverDelayMs >= 0) {
            hoverDelayMs = Math.min(Math.max(Math.floor(d.hoverDelayMs), 0), HOVER_DELAY_MAX_MS);
          }
        });
      } catch (e) { /* 宿主没起来也不影响本地事件 */ }

      if (ctx && typeof ctx.effect === "function") {
        ctx.effect(function () { return function () { dispose(); }; });
      }
      return function () { dispose(); };
    }

    exports.apply = apply;
    exports.dispose = dispose;
    exports.version = VERSION;
    // 侧边栏预览要 sessions + sidebarRight。两个服务由官方 bundle 提供，
    // 桌面端与 web 端都在；万一某个组合没有，cordis 会跳过本插件而不影响其它插件。
    exports.inject = ["sessions"];
    return module.exports;
  }
});
  window.__dshArtifactLinkerV1_BUNDLE__ = true;
  } catch (e) {
    try { console.error("[dsh-artifact-linker] client bundle load failed", e); } catch (e2) {}
  }
}
