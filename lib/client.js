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
//   悬停命中时鼠标变手型  → 唯一的视觉提示，靠 mousemove 150ms 节流，几乎无开销
//
// 硬约束（踩过的坑，别再犯）：
//   * 必须有 exports.apply —— 只写 dispose/version 会让 cordis 判 invalid plugin，
//     连崩四次 → Renderer recovery exhausted → 整个桌面端起不来。
//   * fetch 一律用**根相对路径**，绝不拼宿主绝对 origin（CSP + 换端口立刻死）。
//   * 自建浮层的 mousedown 必须在 document 捕获期拦下，否则宿主 closeOutside 抢先关掉。
//   * 绝不改正文 DOM（不改字、不包节点、不接管 markdown 图片），只在事件里读坐标。

window.__ModuleLoader__.load({
  id: "dsh-artifact-linker",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;

    var GUARD = "__dshArtifactLinkerV1";
    var VERSION = "0.2.7";
    // 路由前缀必须与宿主的 ROUTE_PREFIX 一致；永远根相对，绝不拼宿主 origin
    var ROUTE = "/dsh-artifact-linker";

    // 产物扩展名白名单。刻意**不含 exe/msi/dll** 之类可执行体：
    // 正文里出现这些名字多半是命令输出/报错文本，不是「要打开看的产物」。
    var EXT = [
      "pdf", "docx?", "xlsx?", "pptx?", "csv", "tsv",
      "png", "jpe?g", "gif", "webp", "bmp", "tiff?", "svg",
      "zip", "7z", "rar", "gz", "tar",
      "log", "txt", "md", "json", "ya?ml", "ini", "toml", "xml", "html?",
      "py", "js", "mjs", "cjs", "ts", "tsx", "ipynb", "ps1", "sh",
      "cas", "dat", "h5", "hsf", "cxa", "trn", "rfile", "plt", "flprj", "jou", "set", "out",
      "scdocx?", "pmdb", "unv", "msh", "stp", "step", "igs", "iges", "dwg", "dxf", "inp"
    ].join("|");

    // 一段文本里「像产物路径」的片段：
    //   可选的前缀（盘符 或 UNC）+ 中间任意非分隔字符 + 点 + 白名单扩展名
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
      "[^\\t\\r\\n`\"'<>|*?（）()【】\\[\\]{}，；、]{1,200}?\\." +
      "(?:" + EXT + ")(?:\\.[A-Za-z0-9]{1,6})*(?![A-Za-z0-9_])",
      "gi"
    );
    // URL 里天然带 .png/.pdf，全部要排除，否则网页链接会被当成文件产物。
    var RE_URL = /https?:\/\/[^\s`"'<>）)】\]]+/gi;

    var mounted = false;
    var disposed = false;
    var hoverTimer = null;
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
      var from = Math.max(0, off - 200);
      var to = Math.min(text.length, off + 200);
      var win = text.slice(from, to);
      var rel = off - from;
      var urls = urlRanges(win);
      var m;
      RE.lastIndex = 0;
      while ((m = RE.exec(win))) {
        var s = m.index;
        var e = m.index + m[0].length;
        if (rel < s || rel > e) continue;         // 鼠标必须落在这个片段上
        if (inRanges(urls, s, e)) continue;       // URL 里的 .png 不算
        var raw = cleanRaw(m[0]);
        if (!raw || raw.length < 4) continue;
        return { raw: raw, rect: rectFor(range.startContainer, from + s, from + e) };
      }
      return null;
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
        copy: '<rect x="9.2" y="9.2" width="10.8" height="10.8" rx="2.2"/><path d="M15 5.8A1.8 1.8 0 0 0 13.2 4H5.8A1.8 1.8 0 0 0 4 5.8v7.4A1.8 1.8 0 0 0 5.8 15"/>'
      };
      // 文案要说人话：「资源管理器」这个词很多用户不认识，改成「文件夹窗口」。
      var items = [
        ["reveal", "在文件夹中显示", "打开 Windows 文件夹窗口，并选中这个文件"],
        ["open", "用默认程序打开", "按文件类型用对应软件打开：PDF 用阅读器、表格用 Excel 那类"],
        ["copy", "复制文件路径", "把完整路径复制到剪贴板"]
      ];
      for (var i = 0; i < items.length; i++) {
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
            if (action === "copy") {
              try {
                navigator.clipboard.writeText(abs);
                toast("已复制路径");
              } catch (e) { toast("复制失败"); }
              return;
            }
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

    function act(raw, mode, x, y) {
      hostGet("/resolve", { p: raw }).then(function (d) {
        if (disposed) return;
        if (!d || !d.ok || !d.abs) {
          // 解析不到就当普通文字，绝不装作成功
          if (mode === "menu") toast("没解析到这个文件");
          return;
        }
        if (mode === "reveal") {
          hostGet("/reveal", { p: d.abs }).then(function (r) {
            if (disposed) return;
            if (!r || !r.ok) toast("打开失败：" + ((r && r.reason) || "未知原因"));
          });
          return;
        }
        showMenu(x, y, d.abs);
      });
    }

    function onClick(ev) {
      if (disposed) return;
      if (ev.button !== 0 || ev.ctrlKey || ev.metaKey || ev.altKey || ev.shiftKey) return;
      if (menuEl && menuEl.contains && menuEl.contains(ev.target)) return;
      var hit = hitAt(ev.clientX, ev.clientY);
      if (!hit) return;
      // 🔴 这里**绝不 preventDefault / stopPropagation**：用户明确要求不能破坏宿主自带的
      // 「点文件路径 → 侧边栏预览」。上一版把它们拦了，结果宿主预览没了、我们的 explorer
      // 又弹不出窗口，两头落空 —— 表现就是「左键点了没反应」。
      // 现在改成让事件照常冒泡给宿主；只有等这一轮事件跑完、确认没人接管
      // （defaultPrevented 仍为 false）时才补一次 reveal。
      setTimeout(function () {
        if (ev.defaultPrevented) return;   // 宿主已经处理（例如开了侧边栏预览）→ 让路，不抢
        act(hit.raw, "reveal", ev.clientX, ev.clientY);
      }, 0);
    }

    function onContext(ev) {
      if (disposed) return;
      if (menuEl && menuEl.contains && menuEl.contains(ev.target)) {
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
      var hit = hitAt(ev.clientX, ev.clientY);
      if (!hit) return;                    // 非产物处右键 → 放行宿主原生菜单
      ev.preventDefault();
      ev.stopPropagation();
      act(hit.raw, "menu", ev.clientX, ev.clientY);
    }

    // ── 悬停高亮：让「这几个字是可以点的产物」一眼看得出来 ──────────────────
    // 做法是用一个 fixed 浮层盖在文字上（淡蓝底 + 底部蓝色虚​线），**不动 DOM**——
    // 原文一个节点都不改，就不会跟宿主 React 的重渲染打架；滚动时立刻隐藏，
    // 免得浮层跟着滚动跟文字脱位。
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
      // 配色对齐 Codex 那一档蓝（#58a6ff），底色压得很淡只做暗示；
      // 主信号是底下那条**虚线**：实线在深色正文里太抢眼，还会跟正文分隔线混，
      // 虚线更像编辑器里的「可跳转标记」，一眼能认出但不刺眼。
      hoverBox.style.background = "rgba(88,166,255,.13)";
      hoverBox.style.borderBottom = "1px dashed rgba(88,166,255,.85)";
      hoverBox.style.boxShadow = "none";
      hoverBox.style.borderRadius = "3px";
    }
    function hideHover() { if (hoverBox) hoverBox.style.display = "none"; }

    function onMove(ev) {
      if (disposed || hoverTimer) return;
      var x = ev.clientX;
      var y = ev.clientY;
      hoverTimer = setTimeout(function () {
        hoverTimer = null;
        if (disposed || !document || !document.body) return;
        var hit = hitAt(x, y);
        var want = hit ? "pointer" : "";
        if (want !== lastCursor) {
          lastCursor = want;
          document.body.style.cursor = want;
        }
        drawHover(hit && hit.rect);
      }, 150);
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

    function apply(ctx) {
      // 单例守卫：热重载会堆实例，先摘旧的那个
      try {
        if (window[GUARD] && typeof window[GUARD].dispose === "function") window[GUARD].dispose();
      } catch (e) { /* 旧实例已经废了就废了 */ }

      disposed = false;
      mounted = false;
      api = { apply: apply, dispose: dispose, version: VERSION };
      try { window[GUARD] = api; } catch (e) { /* 极端沙箱下挂不上，不影响本实例 */ }

      mount();

      // 问一次宿主是否在线（顺带取回 bases：排查「未解析」时直接看 api.host.bases）
      try {
        hostGet("/info").then(function (d) {
          if (!disposed && d && api) api.host = d;
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
    exports.inject = [];       // 不依赖任何宿主服务，纯 DOM 事件
    return module.exports;
  }
});
