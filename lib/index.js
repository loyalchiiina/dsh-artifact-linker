// dsh-artifact-linker - host half.
//
// 目的：让「产物路径」这件事从模型输出一直贯通到用户手指。
//
// 三件事（都在宿主侧，零写入、零 spawn、零联网）：
//   (1) 常驻 system-prompt 段（ctx.systemPrompt.section，order 200）—— 让模型
//       在**每个会话／每个预设**都优先输出完整绝对路径。技能是按需加载的，
//       prompt 段是常驻的，所以「装了插件 = 规则生效」不依赖任何技能被加载。
//       这是软约束层：它提高模型给绝对路径的概率，但不保证。
//   (1.5) 强制绝对路径硬门（llm/stream 瀑布）—— 代码级强制。上面 (1) 是软约束层，
//       只提高模型给绝对路径的概率；这一层直接挂在平台上，把模型吐出的正文里
//       能确定的路径改写成完整绝对路径。实现见下方 gateWrapStream / gateNormalizeText。
//       开关 forceAbsolutePaths（默认 true，关掉 = 回到只有软约束的旧行为）。
//   (2) /resolve 路由 —— 硬兜底层。哪怕模型只给了 `output.png` 这种裸文件名，
//       这里也能三源兜底解析出真实绝对路径（绝对路径直用 → 相对 base 拼接 →
//       裸名在 base 下浅层递归按 basename 反查）。
//   (3) /stat 路由 —— 批量 stat + TTL 缓存。一条 Fluent 后处理消息能有 30~50 个
//       产物路径，逐个同步 stat 会让消息区肉眼可见地卡；这里一次批量返回并缓存
//       10 秒，客户端只管渲染。
//
// 客户端半边（lib/client.js）只做「给命中文本挂属性 + 点击分流」，不修改文本
// 内容、不重挂 React 节点、不接管 markdown 图片语法 —— 见 SKILL §7.13.1。
//
// 配置开关（都在 cordis.patch.yml 的 config 行里翻）：
//   injectRules  (默认 true)  = 是否注册常驻 prompt 段
//   clientChips  (默认 true)  = 客户端是否启用芯片（此值由客户端自己读 /info 得知）
//   allowOutside (默认 false) = 是否允许解析 base 之外的绝对路径（安全闸）

import { findViolations, violationMessage } from "./path-gate.js";
import { readFileSync, statSync, readdirSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve as pathResolve, basename, extname, sep } from "node:path";

var PKG_VERSION = (function () {
  try {
    var here = dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")).version;
  } catch (e) {
    return "unknown";
  }
})();

var ROUTE_PREFIX = "/dsh-artifact-linker";

// ── 常驻 prompt 段 ──────────────────────────────────────────────────────────
// 段名沿用 dsh-taskboard(180) / dsh-todo-float-ball(190) / dsh-skill-guard(195)
// 的命名风格；order 200 排在它们之后、仍远低于 PLAN_POLICY=500 的内置边界，
// 属于「怎么干活」band 里的具体领域规则，不该抢前面。
var RULES_SECTION_NAME = "artifact-path-rules";
var RULES_SECTION_ORDER = 200;

// 字符预算：硬上限 800，实际约 600。system-prompt 段是每一轮、每个会话都发，
// 是永久 token 成本，所以只写最硬的几条，其余细节留在插件 README 与客户端行为里。
var RULES_TEXT = [
  "【产物路径铁律 · 由 dsh-artifact-linker 插件常驻注入，无需加载任何技能】",
  "1. 凡本轮**新建／写入／下载／生成／导出**的文件与目录，工具参数与内部记录一律使用**完整绝对路径**（Windows 形如 E:\\proj\\out\\a.xlsx）。",
  "2. **正文、清单、表格里向用户列产物时，每个文件都必须给出完整绝对路径**（如 `D:\\proj\\out\\a.xlsx`）；**严禁用 `...\\`、`…/`、省略号或“共用前缀”省略任何一段路径**——每行都要能直接复制粘贴使用。文件名照旧会被渲染成可点芯片，写完整路径不影响点击预览。",
  "3. 不重复罗列非产物：读入的输入文件、依赖包、缓存、临时文件、系统路径一律不报。",
  "4. 用 `present` 交付的产物，正文清单里**仍要列出其完整绝对路径**（卡片供预览，正文路径供复制）。",
  "5. 🔴 无法确定绝对路径时，先实际核实（`pwd`、列目录、读工具返回值）再写，**绝不编造路径**——编造的路径点开就是死链，比不给路径更糟。",
  "6. 路径含空格或中文时，用反引号包裹成行内代码（如 `E:\\工作 目录\\结果.xlsx`），避免被正文断词截断。"
].join("\n");

export var name = "dsh-artifact-linker";
export var inject = ["webServer", "systemPrompt", "llm", "tools"];

// ── 基础工具 ────────────────────────────────────────────────────────────────

function isLoopback(req) {
  var a = (req.socket && req.socket.remoteAddress) || "";
  var n = a.toLowerCase();
  if (n === "::1") return true;
  if (n.startsWith("::ffff:")) return n.slice(7).startsWith("127.");
  return n.startsWith("127.");
}

function json(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
}

// 绝对路径判定：盘符（C:\ / C:/）、UNC（\\server\share）、POSIX 根（/x）。
function looksAbsolute(p) {
  if (typeof p !== "string" || !p) return false;
  if (/^[A-Za-z]:[\\/]/.test(p)) return true;
  if (p.startsWith("\\\\")) return true;
  if (p.startsWith("/") && !p.startsWith("//")) return true;
  return false;
}

// 清洗模型常见包装：反引号、成对引号、末尾标点、markdown 尾巴。
function cleanRaw(raw) {
  if (typeof raw !== "string") return "";
  var s = raw.trim();
  // 去掉包裹的反引号 / 引号（可能多层）
  for (var i = 0; i < 3; i++) {
    var before = s;
    if (s.length > 1 && ((s.charAt(0) === "`" && s.charAt(s.length - 1) === "`") ||
        (s.charAt(0) === "\"" && s.charAt(s.length - 1) === "\"") ||
        (s.charAt(0) === "'" && s.charAt(s.length - 1) === "'"))) {
      s = s.slice(1, -1).trim();
    }
    if (s === before) break;
  }
  // 去掉正文里常跟在路径后的标点
  s = s.replace(/[，。；：、)】」』>,.;:!?]+$/g, "");
  return s;
}

// base 之内判定（大小写不敏感，Windows 语义）。base 为空 = 不限制。
function isInside(root, abs) {
  if (!root) return true;
  var r = root.toLowerCase().replace(/[\\/]+$/, "");
  var a = abs.toLowerCase();
  return a === r || a.startsWith(r + sep) || a.startsWith(r + "/");
}

// ── stat（带 TTL 缓存）────────────────────────────────────────────────────────
// 默认 TTL 10 秒：足够吸收一条消息里对同一路径的重复查询（DOM 重渲染会反复问），
// 又不会让「刚删掉的文件」长时间显示成存在。
// 官方硬规则 #5（Never hardcode tunables）：下面三个都可在 cordis.yml 里改。
var DEFAULT_STAT_TTL_MS = 10000;
var statTtlMs = DEFAULT_STAT_TTL_MS;
// 2026-10-28 实测教训：workspace 里有 3665 个文件时，原来「每次点击现扫、条目预算 3000」
// 会在中途把预算耗光，导致深处的文件明明存在却报 not-found（同名文件、四级深层全中招）。
// 改为「一次遍历建 basename 索引 + TTL 复用」：查询 O(1)，也不再受条目预算影响。
// 深度从 2 提到 4，覆盖「子目录/深层/二级/三级」这类真实落盘层级。
var DEFAULT_SEARCH_MAX_DEPTH = 4;
var searchMaxDepth = DEFAULT_SEARCH_MAX_DEPTH;
var DEFAULT_INDEX_TTL_MS = 30000;
var indexTtlMs = DEFAULT_INDEX_TTL_MS;
// 客户端悬停判定的节流间隔（毫秒）。40 ≈ 2.5 帧：肉眼已经跟手，
// 又不会让 mousemove 每次都触发一次 caretRangeFromPoint + /resolve。
// 原来客户端把这条写死成 150ms，用户反馈「悬停芯片延迟偏高」。
var DEFAULT_HOVER_DELAY_MS = 40;
var hoverDelayMs = DEFAULT_HOVER_DELAY_MS;
var basenameIndexCache = new Map();
var statCache = new Map();

function statOne(abs) {
  var now = Date.now();
  var hit = statCache.get(abs);
  if (hit && now - hit.at < statTtlMs) return hit.value;
  var value;
  try {
    var st = statSync(abs);
    value = {
      exists: true,
      kind: st.isDirectory() ? "dir" : "file",
      size: st.size,
      mtimeMs: st.mtimeMs
    };
  } catch (e) {
    value = { exists: false, kind: null, size: 0, mtimeMs: 0, error: (e && e.code) || "ENOENT" };
  }
  // 简单容量控制，避免长期运行后 Map 无限增长
  if (statCache.size > 4000) statCache.clear();
  statCache.set(abs, { at: now, value: value });
  return value;
}

// ── 裸文件名反查（索引版）────────────────────────────────────────────────────
// 只在「绝对路径失效 + base 拼接失效」后才用。绝不整盘扫，也绝不每次点击都重扫。
// 建一次 basename → 绝对路径的索引，TTL 内复用；对同一目录的多次点击只付一次遍历成本。
var SKIP_DIRS = new Set(["node_modules", ".git", ".svn", "__pycache__", ".cache", "dist", "build", ".next", ".venv", "venv"]);

function getBasenameIndex(base, maxDepth) {
  var now = Date.now();
  var hit = basenameIndexCache.get(base);
  if (hit && now - hit.at < indexTtlMs) return hit.map;

  var map = new Map();
  var budget = 20000; // 一次遍历的总条目上限，防病态深目录
  var queue = [{ dir: base, depth: 0 }];
  while (queue.length && budget > 0) {
    var cur = queue.shift();
    var entries;
    try { entries = readdirSync(cur.dir, { withFileTypes: true }); } catch (e) { continue; }
    for (var i = 0; i < entries.length; i++) {
      if (budget-- <= 0) break;
      var ent = entries[i];
      var full = join(cur.dir, ent.name);
      if (ent.isDirectory()) {
        if (cur.depth + 1 > maxDepth) continue;
        if (SKIP_DIRS.has(ent.name)) continue;
        if (ent.name.charAt(0) === ".") continue;
        queue.push({ dir: full, depth: cur.depth + 1 });
      } else {
        var k = ent.name.toLowerCase();
        var arr = map.get(k);
        if (!arr) { arr = []; map.set(k, arr); }
        // 同名只留前 8 个，防止某类通用名（如 index.js）把表撑爆
        if (arr.length < 8) arr.push(full);
      }
    }
  }
  if (basenameIndexCache.size > 24) basenameIndexCache.clear();
  basenameIndexCache.set(base, { at: now, map: map });
  return map;
}

function findByBasename(base, name, maxDepth) {
  if (!base || !name) return [];
  var idx = getBasenameIndex(base, maxDepth || searchMaxDepth);
  return idx.get(String(name).toLowerCase()) || [];
}

// ── 候选基准目录 ────────────────────────────────────────────────────────────
// 🔴 2026-10-27 实测教训：DSH 宿主的 process.cwd() 不是会话 workspace，
// 客户端又拿不到真实 workspace 路径 → /resolve 拿错 base → 面板里全是「未解析」。
// 治本：宿主自己列出所有可能是 workspace 的目录，逐个当 base 试，命中即返回。
var _basesCache = { at: 0, list: [] };

function candidateBases() {
  var now = Date.now();
  if (now - _basesCache.at < 30000 && _basesCache.list.length) return _basesCache.list.slice();
  var out = [];
  var add = function (p) {
    if (!p || out.indexOf(p) >= 0) return;
    try { if (statSync(p).isDirectory()) out.push(p); } catch (e) { }
  };
  add(process.cwd());
  try {
    var dshHome = process.env.DSH_HOME || join(homedir(), ".dsh");
    var ents = readdirSync(dshHome, { withFileTypes: true });
    for (var i = 0; i < ents.length; i++) {
      if (ents[i].isDirectory()) add(join(dshHome, ents[i].name, "workspace"));
    }
    var profDir = join(dshHome, "profiles");
    var pe = readdirSync(profDir, { withFileTypes: true });
    for (var j = 0; j < pe.length; j++) {
      if (pe[j].isDirectory()) add(join(profDir, pe[j].name, "workspace"));
    }
  } catch (e) { }
  // 兜底：不存在的路径也留着，让 resolveOne 自己去撞（撞不到就算了）
  if (!out.length) out.push(process.cwd());
  _basesCache = { at: now, list: out };
  return out.slice();
}

// allowOutside 关闭时的安全闸：落在**任意一个候选 workspace**里就算合法。
// 2026-10-28 修正：原来这两个守卫只拿 process.cwd() 比对，但宿主 cwd 并不是会话
// workspace（同 201 行那次的同一个坑），一旦有人为了给别人用把 allowOutside 关掉，
// workspace 内的合法文件会被误拒成 outside-base。改成逐候选 base 判定。
function insideAnyBase(abs, allowOutside) {
  if (allowOutside) return true;
  var cand = candidateBases();
  for (var i = 0; i < cand.length; i++) {
    try { if (isInside(cand[i], abs)) return true; } catch (e) { }
  }
  return false;
}

function resolveAcross(raw, extraBase, allowOutside) {
  var bases = [];
  if (extraBase) bases.push(pathResolve(extraBase));
  var cand = candidateBases();
  for (var i = 0; i < cand.length; i++) if (bases.indexOf(cand[i]) < 0) bases.push(cand[i]);

  function tryAll(s) {
    var best = null;
    for (var k = 0; k < bases.length; k++) {
      var out;
      try { out = resolveOne(s, bases[k], allowOutside); } catch (e) { continue; }
      if (out && out.ok) { out.base = bases[k]; return out; }
      if (!best && out) { out.base = bases[k]; best = out; }
    }
    return best;
  }

  var rawTrim = String(raw || "").trim();

  // 只对绝对路径做「精确 stat」的小工具：不走 basename 反查，避免把目录/同名文件误认。
  function statAbsExact(s) {
    if (!looksAbsolute(s)) return null;
    var abs = pathResolve(s);
    if (!allowOutside) {
      var okb = false;
      for (var bi = 0; bi < bases.length; bi++) { try { if (isInside(bases[bi], abs)) { okb = true; break; } } catch (e) { } }
      if (!okb) return null;
    }
    var st = statOne(abs);
    if (!st.exists) return null;
    return { ok: true, raw: s, abs: abs, exists: true, kind: st.kind, size: st.size, mtimeMs: st.mtimeMs, source: "absolute" };
  }

  // ⓪ 原样整串精确 stat（不经 cleanRaw）：真实文件名允许以 ) 】 。 结尾、也允许带空格中文，
  //    cleanRaw 会误剥这些尾部，所以先拿 raw 原样撞一次，命中即用。
  var exact = statAbsExact(rawTrim);
  if (exact) return exact;

  var first = tryAll(raw);
  if (first && first.ok) return first;
  var best = first;

  // ① 绝对路径：从右逐字符收缩，**不跨过最后一个路径分隔符**（避免把文件名砍光后退化成父目录误报）。
  //    专治「路径后紧跟中文说明/尾部标点且中间无空格」：D:\a\b.png这个图 → D:\a\b.png。
  function shrinkRightAbs(s) {
    var t = String(s || "").trim();
    if (!looksAbsolute(t)) return null;
    var lastSep = Math.max(t.lastIndexOf("\\"), t.lastIndexOf("/"));
    var lowBound = lastSep + 2;                 // 最后一个文件名至少保留 1 个字符
    var limit = Math.min(t.length, 600);
    for (var cut = t.length - 1; cut >= lowBound && (t.length - cut) <= limit; cut--) {
      var cand = t.slice(0, cut);
      var o = statAbsExact(cand);
      if (o && o.ok) { o.raw = cand; o.shrunkFrom = s; o.source = "absolute-shrunk"; return o; }
    }
    return null;
  }
  var shrunkAbs = shrinkRightAbs(rawTrim);
  if (shrunkAbs && shrunkAbs.ok) return shrunkAbs;
  if (!best && shrunkAbs) best = shrunkAbs;

  // ② 从左按空白剥（前置说明词 + 空格 + 路径）
  var segs = String(raw || "").trim().split(/\s+/);
  for (var j = 1; j < segs.length; j++) {
    var shrunk = segs.slice(j).join(" ");
    if (!shrunk) break;
    var o2 = tryAll(shrunk);
    if (o2 && o2.ok) { o2.raw = shrunk; o2.shrunkFrom = raw; return o2; }
    if (!best && o2) best = o2;
  }
  return best || { ok: false, reason: "not-found", raw: raw, abs: null };
}

// ── 单路径解析：三源兜底 ──────────────────────────────────────────────────────
function resolveOne(raw, base, allowOutside) {
  var cleaned = cleanRaw(raw);
  if (!cleaned) return { ok: false, reason: "empty" };

  var candidates = [];
  var chosen = null;

  // ① 绝对路径直用
  if (looksAbsolute(cleaned)) {
    var abs = pathResolve(cleaned);
    if (!allowOutside && base && !isInside(base, abs)) {
      var stOutside = statOne(abs);
      return {
        ok: false,
        reason: "outside-base",
        raw: cleaned,
        abs: abs,
        exists: stOutside.exists,
        kind: stOutside.kind,
        hint: "路径在 workspace 之外，allowOutside=false 时不解析"
      };
    }
    var st = statOne(abs);
    if (st.exists) {
      return { ok: true, raw: cleaned, abs: abs, exists: true, kind: st.kind, size: st.size, mtimeMs: st.mtimeMs, source: "absolute" };
    }
    // 绝对路径存在性失败：仍返回 abs 供客户端显示「文件已不存在」，但同时按裸名再兜一次
    chosen = { abs: abs, exists: false, kind: null, size: 0, mtimeMs: 0 };
  }

  // ② 相对 base 拼接
  if (!chosen || !chosen.exists) {
    if (base) {
      var rel = pathResolve(base, cleaned);
      var stRel = statOne(rel);
      if (stRel.exists) {
        return { ok: true, raw: cleaned, abs: rel, exists: true, kind: stRel.kind, size: stRel.size, mtimeMs: stRel.mtimeMs, source: "relative" };
      }
    }
  }

  // ③ 裸文件名在 base 下浅层递归反查（默认限深 2 层，由 searchMaxDepth 调）
  var nameOnly = basename(cleaned);
  if (nameOnly && base) {
    var found = findByBasename(base, nameOnly, searchMaxDepth);
    if (found.length === 1) {
      var stF = statOne(found[0]);
      return { ok: true, raw: cleaned, abs: found[0], exists: true, kind: stF.kind, size: stF.size, mtimeMs: stF.mtimeMs, source: "basename" };
    }
    if (found.length > 1) {
      // 同名歧义：不能瞎猜，但更不能「点了毫无反应」。
      // 取 mtime 最新的那个（用户刚生成的产物通常就是最新的），
      // 同时把候选一起带回去，客户端可以提示「有 N 个同名，已打开最新的那个」。
      candidates = found.slice(0, 5);
      var pick = null;
      var pickT = -1;
      for (var ci = 0; ci < found.length; ci++) {
        var stc = statOne(found[ci]);
        if (stc.exists && stc.mtimeMs > pickT) { pickT = stc.mtimeMs; pick = found[ci]; }
      }
      if (pick) {
        var stP = statOne(pick);
        return {
          ok: true, raw: cleaned, abs: pick, exists: true,
          kind: stP.kind, size: stP.size, mtimeMs: stP.mtimeMs,
          source: "basename-newest", ambiguous: true, candidates: candidates
        };
      }
    }
  }

  if (chosen) {
    return { ok: false, reason: "not-found", raw: cleaned, abs: chosen.abs, exists: false, kind: null, candidates: candidates };
  }
  return { ok: false, reason: "not-found", raw: cleaned, abs: null, exists: false, kind: null, candidates: candidates };
}

// ── Windows「揭示并选中」：Shell.Application Explore 开窗 + SelectItem 选中 ──
// 三代实现的历史（别再走回头路）：
//   ① explorer.exe /select,"path" —— 命令发出、退出码 1、日志正常，但资源管理器
//      **既不新开窗口也不改选中项**（带引号/裸路径/拆 argv/不加 verbatim 四种全无效）。
//   ② Shell.Application COM（Explore + 轮询 Windows() + SelectItem）——脚本 exit 0、
//      日志写「成功」，但**实际不选中**。跨进程 COM 里 Document.Folder.ParseName 拿到的
//      FolderItem 与目标窗口不保证落在同一 PIDL 空间，SelectItem 会静默失败。
//      （用户 2026-10-28 实测反馈：「打开了但是没有自动定位到文件位置」）
//   ③ 试过 shell32!SHOpenFolderAndSelectItems：hr=0、SelectedItems() 也确实有值，
//      但**窗口根本不弹**（用户实测：「现在都不弹窗了」）。它走的是「复用已有窗口」
//      语义，没有现成窗口时什么都不显示 —— 所以它不能当「打开」的入口，
//      只有「已开着的窗口里定位」这一半能力。
//   ④ 当前方案：Shell.Application.Explore 负责**开窗**（唯一可靠的开窗入口），
//      再 SelectItem(item, 29) 负责**选中**。两处易错点都补了轮询：
//      · Explore 之后窗口与目录项都不是立刻可用的，ParseName 会先返回 $null；
//      · SelectItem 的标志位必须带 SVSI_ENSUREVISIBLE|SVSI_FOCUSED（=29），
//        只传 SVSI_SELECT(1) 时部分窗口状态下静默无效。
//      正确性判据是 SelectedItems() 非空，不是「脚本没报错」。
//      实测（powershell.exe 5.1，与插件同款；先关掉目标目录全部窗口再跑）：
//      window_found=yes, item_found=yes, sel_count=1, sel_item=目标文件。
// 实现要点：
//   · 全程只用 Shell.Application COM，不编译 C#（Add-Type 首次编译慢，且受运行环境影响）；
//   · 脚本用 -EncodedCommand 以 UTF-16LE Base64 传入 —— 绕开控制台代码页，
//     中文/空格路径不会变成 mojibake（直接 -Command 传中文必乱）；
//   · windowsHide 只作用于 powershell.exe 自身（不闪黑窗），shell 拉起的资源管理器
//     窗口照常显示；
//   · 退出码：3 = 目录项取不到，4 = 选中失败，5 = 窗口没等出来；调用方见非 0
//     就降级为「只打开目录」，保证「至少能开」。
function psLiteral(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

function revealViaShellCom(abs, done) {
  // 「在文件夹中显示」为什么**有时**失效 —— 完整根因链（2026-10-29 实测）：
  //
  //   SelectItem 能把文件选中，但它**不会**把窗口带到最前。于是结果取决于当时的窗口状态：
  //     · 该目录本来没窗口   → Explore 新建窗口，新窗口天然在前，选中可见  ✅
  //     · 该目录窗口就在前台 → 选中立即可见                              ✅
  //     · 该目录窗口在后台   → 选中生效但被别的窗口盖住                  ❌ 看着像没定位
  //     · 该目录开过多个窗口 → Explore 复用其中一个（未必是用户在看那个）❌ 选在别处
  //
  //   实测证据：日志写「reveal selected via shell COM」成功，但同一目录当时开着 7 个窗口，
  //   选中落在 hwnd=34688214，而前台是微信；直接 SetForegroundWindow 返回 False
  //   （Windows 前台锁），必须先 AttachThreadInput 到当前前台线程才抢得到焦点。
  //
  // 所以这里做三件事：优先选「前台那个窗口」、按「选中的就是目标文件」校验、
  // 抢焦点并回读确认前台。
  var lines = [
    "$ErrorActionPreference = 'Stop'",
    "$dir = " + psLiteral(dirname(abs)),
    "$nm = " + psLiteral(basename(abs)),
    "$sig = '[DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr h);' + " +
      "'[DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();' + " +
      "'[DllImport(\"user32.dll\")] public static extern bool IsIconic(IntPtr h);' + " +
      "'[DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr h, int n);' + " +
      "'[DllImport(\"user32.dll\")] public static extern bool BringWindowToTop(IntPtr h);' + " +
      "'[DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);' + " +
      "'[DllImport(\"user32.dll\")] public static extern bool AttachThreadInput(uint a, uint b, bool f);' + " +
      "'[DllImport(\"kernel32.dll\")] public static extern uint GetCurrentThreadId();'",
    "try { Add-Type -MemberDefinition $sig -Name U -Namespace RevealWin -ErrorAction Stop } catch { }",
    // 记住 Explore 之前谁在前台 —— 若它本来就是目标目录，就别把用户从别的窗口里拽走。
    "$fgBefore = [IntPtr]::Zero",
    "try { $fgBefore = [RevealWin.U]::GetForegroundWindow() } catch { }",
    "$sh = New-Object -ComObject Shell.Application",
    // Explore 是唯一能可靠「把窗口摆到用户眼前」的入口。
    // SHOpenFolderAndSelectItems 能选中却不弹窗（复用已有窗口，没有就什么都不显示），
    // 所以开窗这一步交给 Explore，选中的事交给 SelectItem。
    "$sh.Explore($dir)",
    // 选窗策略：先挑「前台那个且目录匹配」的；没有就挑任一目录匹配的。
    "$w = $null",
    "$wFg = $null",
    "for ($i = 0; $i -lt 60; $i++) {",
    "  $w = $null; $wFg = $null",
    "  foreach ($x in @($sh.Windows())) {",
    "    try {",
    "      if ($x.Document.Folder.Self.Path -eq $dir) {",
    "        if (-not $w) { $w = $x }",
    "        if ([IntPtr]$x.HWND -eq $fgBefore) { $wFg = $x; break }",
    "      }",
    "    } catch { }",
    "  }",
    "  if ($wFg) { $w = $wFg; break }",
    "  if ($w) { break }",
    "  Start-Sleep -Milliseconds 100",
    "}",
    "if (-not $w) { exit 5 }",
    // 窗口刚 Explore 出来时目录可能还没填充完，ParseName 会返回 $null，必须轮询。
    "$it = $null",
    "for ($i = 0; $i -lt 60; $i++) {",
    "  $it = $w.Document.Folder.ParseName($nm)",
    "  if ($it) { break }",
    "  Start-Sleep -Milliseconds 100",
    "}",
    "if (-not $it) { exit 3 }",
    // 29 = SVSI_SELECT(1) | SVSI_DESELECTOTHERS(4) | SVSI_ENSUREVISIBLE(8) | SVSI_FOCUSED(16)。
    // 旧代码只传 1，在某些窗口状态下静默无效；带上 ENS|FOCUSED 才保证滚到可视区并高亮。
    "$okName = $false",
    "for ($i = 0; $i -lt 25; $i++) {",
    "  $w.Document.SelectItem($it, 29)",
    "  Start-Sleep -Milliseconds 120",
    // 判据必须是「选中的就是目标文件」，不能只看 SelectedItems() 有没有值 ——
    // 窗口里本来就选着别的东西时，旧的判据会假阳性（真实事故）。
    "  $okName = $false",
    "  foreach ($s in @($w.Document.SelectedItems())) { if ($s.Name -eq $nm) { $okName = $true; break } }",
    "  if ($okName) { break }",
    "}",
    "if (-not $okName) { exit 4 }",
    // ── 抢焦点 ────────────────────────────────────────────────────────────
    // 直接 SetForegroundWindow 会被前台锁拒绝（返回 False，焦点纹丝不动），
    // 必须先 AttachThreadInput 到当前前台线程，共享输入队列后才能改前台。
    "$h = [IntPtr]$w.HWND",
    "$fgOk = $false",
    "try {",
    "  if ([RevealWin.U]::IsIconic($h)) { [void][RevealWin.U]::ShowWindow($h, 9) }",
    "  $fg = [RevealWin.U]::GetForegroundWindow()",
    "  if ($fg -ne $h) {",
    "    $fgPid = 0",
    "    $fgT = [RevealWin.U]::GetWindowThreadProcessId($fg, [ref]$fgPid)",
    "    $me = [RevealWin.U]::GetCurrentThreadId()",
    "    if ($fgT -ne 0 -and $fgT -ne $me) { [void][RevealWin.U]::AttachThreadInput($me, $fgT, $true) }",
    "    [void][RevealWin.U]::BringWindowToTop($h)",
    "    [void][RevealWin.U]::SetForegroundWindow($h)",
    "    if ($fgT -ne 0 -and $fgT -ne $me) { [void][RevealWin.U]::AttachThreadInput($me, $fgT, $false) }",
    "  }",
    "  Start-Sleep -Milliseconds 150",
    "  $fgOk = ([RevealWin.U]::GetForegroundWindow() -eq $h)",
    "} catch { }",
    // exit 0 = 选中且已在前台（用户确实看得见）；exit 6 = 选中了但没抢到前台（仍可用 alt-tab 找到）。
    "if ($fgOk) { exit 0 }",
    "exit 6",
  ];
  runPwshEncoded(lines, { timeout: 30000 }, done);
}

// ── 另存为 / 复制文件到剪贴板 ────────────────────────────────────────────────
// 这两件事都得借 PowerShell，原因各不相同：
//
//   saveas  —— Node 没有跨平台的「选个目标位置」原生接口。Windows 上只有
//              WinForms 的 SaveFileDialog，且它有两个坑：
//                (a) 必须跑在 STA 线程（默认 MTA 会抛 InvalidOperationException）；
//                (b) 不给 owner 窗口时对话框可能弹到主窗口背后，用户以为没反应。
//              所以下面既加了 -STA，又造了一个 1×1 的隐形 TopMost owner form。
//
//   copyfile —— 「复制文件」不是把路径字符串塞进剪贴板，而是写 CF_HDROP
//              （文件列表），这样粘到资源管理器里得到的是文件本身。
//              PowerShell 5.1+ 的 Set-Clipboard -LiteralPath 正是干这个的。
//
// 两者统一用 -EncodedCommand + UTF-16LE 传脚本（与 revealViaShellCom 同款），
// 中文/空格路径不会因控制台代码页变成乱码。

function runPwshEncoded(lines, opts, done) {
  var b64 = Buffer.from(lines.join("\n"), "utf16le").toString("base64");
  var args = ["-NoProfile", "-EncodedCommand", b64];
  if (opts && opts.sta) args.splice(1, 0, "-STA");
  var pw = execFile(
    "powershell.exe",
    args,
    {
      windowsHide: true,
      timeout: (opts && opts.timeout) || 30000,
      maxBuffer: 1024 * 1024
    },
    function (err, stdout) { done(err, stdout); }
  );
  if (pw && typeof pw.unref === "function") pw.unref();
}

// 回调契约：done(err, dest)
//   dest === null  → 用户主动取消（不是错误，调用方应静默返回）
function saveAsViaDialog(abs, done) {
  var dir = dirname(abs);
  var name = basename(abs);
  var ext = extname(name);
  // 过滤器第一项锁定原扩展名，第二项兜底「所有文件」
  var psFilter = ext
    ? "*" + ext + "|*" + ext + "|所有文件 (*.*)|*.*"
    : "所有文件 (*.*)|*.*";

  var lines = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "$d = New-Object System.Windows.Forms.SaveFileDialog",
    "$d.Title = " + psLiteral("另存为"),
    "$d.FileName = " + psLiteral(name),
    "$d.InitialDirectory = " + psLiteral(dir),
    "$d.Filter = " + psLiteral(psFilter),
    "$d.FilterIndex = 1",
    "$d.OverwritePrompt = $true",
    "$d.AddExtension = $false",
    "$d.RestoreDirectory = $true",
    // 隐形 owner：只为把对话框顶到前台。没有它，用户切到别的窗口再回来时会找不到框。
    "$o = New-Object System.Windows.Forms.Form",
    "$o.TopMost = $true",
    "$o.ShowInTaskbar = $false",
    "$o.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None",
    "$o.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen",
    "$o.Width = 1",
    "$o.Height = 1",
    "$o.Opacity = 0",
    "$o.Show()",
    "try { $r = $d.ShowDialog($o) } finally { $o.Close(); $o.Dispose() }",
    "if ($r -eq [System.Windows.Forms.DialogResult]::OK) {",
    "  [Console]::Out.Write($d.FileName)",
    "  exit 0",
    "}",
    "exit 1"
  ];

  // 超时给足 10 分钟：用户可能在对话框里慢慢挑目录、甚至去新建文件夹
  runPwshEncoded(lines, { sta: true, timeout: 600000 }, function (err, stdout) {
    var dest = String(stdout || "").trim();
    if (dest) { done(null, dest); return; }
    if (!err) { done(new Error("no-path")); return; }
    // 退出码 1 = 用户点了「取消」，属于正常路径，绝不当失败弹红字
    if (err.code === 1) { done(null, null); return; }
    done(err);
  });
}

function copyFileToClipboard(abs, done) {
  var lines = [
    "$ErrorActionPreference = 'Stop'",
    "Set-Clipboard -LiteralPath " + psLiteral(abs),
    "exit 0"
  ];
  runPwshEncoded(lines, { timeout: 20000 }, function (err) { done(err); });
}

// ── 打开动作（唯一一处 spawn 进程的地方）─────────────────────────────────────
// 安全设计：
//   1) 只接受**绝对路径**且必须**当前存在**（先 statOne 确认，避免拿路径去撞文件系统）；
//   2) 用 execFile（参数数组）而不是 exec/shell —— 参数不经过 shell 解析，
//      路径里的 " & | ; %VAR% 全是字面量，不存在命令注入面；
//   3) 路由本身有 loopback 检查，外部来源一律 403。
// reveal = 在系统资源管理器里揭示并选中；open = 用系统默认程序打开。
function launchPath(abs, action, res) {
  var st = statOne(abs);
  if (!st.exists) {
    json(res, 200, { ok: false, reason: "not-found", abs: abs });
    return;
  }
  var isDir = st.kind === "dir";

  // Windows 的 reveal 走 Shell COM，不经过 explorer 命令行（原因见 revealViaShellCom 上方注释）
  if (process.platform === "win32" && action === "reveal") {
    revealViaShellCom(abs, function (err) {
      var code = err && err.code != null ? Number(err.code) : (err ? null : 0);
      if (!err) {
        try { console.log("[dsh-artifact-linker] reveal selected & focused (exit 0) -> " + abs); } catch (e) { }
        return;
      }
      // exit 6 = 选中成功但没抢到前台（窗口仍被别的程序盖着）。此时**不要**再降级开一次文件夹，
      // 否则会多开一个窗口，反而更乱；只要如实记下来，让用户能 alt-tab 找到。
      if (code === 6) {
        try { console.log("[dsh-artifact-linker] reveal selected but window stayed in background (exit 6, foreground lock) -> " + abs); } catch (e) { }
        return;
      }
      // 其余失败：至少把父目录打开，避免「完全没反应」
      try { console.log("[dsh-artifact-linker] reveal COM failed (exit " + (code == null ? "unknown" : code) + "); falling back to opening the folder -> " + abs); } catch (e) { }
      var fb = execFile("explorer.exe", [isDir ? abs : dirname(abs)], {}, function () { });
      if (fb && typeof fb.unref === "function") fb.unref();
    });
    json(res, 200, { ok: true, abs: abs, action: action, kind: st.kind, method: "shell-com" });
    return;
  }

  var cmd;
  var args;
  if (process.platform === "win32") {
    cmd = "explorer.exe";
    // 仅剩 open（reveal 已在上面由 COM 分支处理）：explorer.exe <file> 实测对
    // 中文/空格路径有效（会调起默认程序），退出码 1 是移交实例的常态，不是失败。
    args = [abs];
  } else if (process.platform === "darwin") {
    cmd = "open";
    args = (action === "reveal" && !isDir) ? ["-R", abs] : [abs];
  } else {
    cmd = "xdg-open";
    // Linux 下没有通用的「揭示并选中」，退化为打开父目录
    args = [(action === "reveal" && !isDir) ? dirname(abs) : abs];
  }
  try {
    // 🔴🔴 绝不能带 windowsHide —— 它会置 CREATE_NO_WINDOW，而 explorer.exe 是 GUI
    // 程序，被这么创建出来窗口**根本不显示**。命令照样执行、退出码也不报错、日志
    // 一行不缺，所以从任何日志都看不出问题。这就是「点了没反应」的第一真凶
    // （2026-10-28 用 pwsh Start-Process 对照实测确认：去掉该标志后窗口正常弹出）。
    // windowsVerbatimArguments 则保证 /select,"path" 整串原样到达 explorer。
    var opts = (process.platform === "win32" && action === "reveal")
      ? { windowsVerbatimArguments: true }
      : {};
    var child = execFile(cmd, args, opts, function (err) {
      // 🔴 实测校准（2026-10-28 用户亲测确认）：explorer.exe /select 成功弹出窗口并选中
      // 文件时，进程退出码**仍然是 1** —— 它把请求转交给已存在的 explorer 实例后立刻退出。
      // 所以退出码不能当成功判据，必须分类：
      //   · ENOENT / EACCES → 真的调不起来（可执行文件缺失、权限拒绝），要当失败报；
      //   · 其它非零退出码   → Windows 惯例，**不代表失败**，降级成 note，
      //                        免得日志里一句 "Command failed" 把人（包括我自己）骗去查假 bug。
      if (!err) return;
      try {
        if (err.code === "ENOENT" || err.code === "EACCES") {
          console.log("[dsh-artifact-linker] " + action + " FAILED (cannot spawn " + cmd + "): " + String(err.message || err).split("\n")[0]);
        } else {
          // explorer.EXE hands the request to the already-running instance and exits with 1.
      // Keep this line ASCII-only: log consumers may decode as ANSI and turn CJK into mojibake.
      console.log("[dsh-artifact-linker] " + action + " note: " + cmd + " exited with code " + (err.code == null ? "non-zero" : err.code) + " (explorer hands off to the running instance; the window opened normally)");
        }
      } catch (e) { }
    });
    if (child && typeof child.unref === "function") child.unref();
    // 动作级日志：证明「命令已发出」。注意它**不代表窗口一定出现了**（见上面 windowsHide 的坑），
    // 所以措辞用 dispatched 而不是 ok，免得再被自己的日志骗一次。
    try { console.log("[dsh-artifact-linker] " + action + " dispatched -> " + abs); } catch (e) { }
    json(res, 200, { ok: true, abs: abs, action: action, kind: st.kind, method: cmd });
  } catch (e) {
    json(res, 200, { ok: false, reason: "spawn-failed", message: String(e && e.message || e) });
  }
}

// ── 强制绝对路径硬门（llm/stream 瀑布） ─────────────────────────────────────
// 上面那段 prompt 是软约束层：它只提高模型给绝对路径的「概率」。
// 这一层是代码级强制：挂在平台自己的 `llm/stream` 瀑布上，把模型吐出的**正文**
// 里能确定的路径改写成完整绝对路径，再把改好的文本重新发出去。
//
// 注册方式是照平台自己的写法抄的（@deepseek-ai/dsh-llm/lib/invariant.js:63）：
//   ctx.on("llm/stream", (_options, next) => ..., { global: true, prepend: true })
// 且必须给 llm 服务依赖（见本文件顶部 inject 数组的 "llm"），否则收不到事件。
//
// 三条设计红线：
//   1) 只碰 text 块。reasoning-delta / tool-call-delta / block-start / usage / finish
//      一律原样透传——平台有一套严格流语法校验（text-delta 必须落在已打开的
//      text 块内、block-end 的 block.type 必须与该块类型一致、finish 之后不许再发
//      chunk），我们发出的每一帧都必须合法。
//   2) 只改「能确定的」。绝对路径 / URL / UNC 不动；相对路径必须在候选 workspace 里
//      **真的存在**才改（找不到就原样留着）——宁可漏改，绝不改错。
//   3) 任何异常都退化为原样透传。硬门坏了可以让路径不完美，绝不能让模型的话消失。
//
// 已知代价：正文要攒到块结束才能改，所以打字机效果从「逐字流」变成「一块一块出」。
// 已知不覆盖：``` 围栏代码块内的路径不改（那里是给人看的源码，改了反而坏）。
var GATE_FENCE_RE = /^\s*(```|~~~)/;
// 行内「路径候选」的头部特征。刻意做成「锚头 + 向右扩展」两步，
// 而不是用 \S+ 切词——中文和路径常常紧贴没有空格（实测踩过：`省略式：D:\...\a.flac`
// 会被当成一个词，整串被替换掉，中文前缀直接消失）。
var GATE_HEAD_RE = /[A-Za-z]:[\\/]|\\\\|[^\\/\s，。；：、)\]】」』"'`<>|?*,;]+[\\/]|\.{3}[\\/]|…[\\/]/g;
// 路径向右扩展时的停止字符（空白与各类中英标点）
var GATE_SPAN_STOP_RE = /[\s，。；：、)\]】」』"'`<>|?*]/;
// 候选前面紧挨着这些字符 = 我们其实在某个更长串的中间（URL 的 "s:/"、标识符的 "a\b"）
var GATE_PREV_BAD_RE = /[A-Za-z0-9_\-.:/\\]/;
var GATE_TRAIL_RE = /[.,;:]+$/;
// 尾部 / 前导「非路径字符」（中文等），用于把紧贴路径的中文还回去
var GATE_NONPATH_TAIL_RE = /[^A-Za-z0-9_\-.\\/:]+$/;
var GATE_NONPATH_HEAD_RE = /^[^A-Za-z0-9_\-.\\/:]+/;
var GATE_EXT_RE = /\.[A-Za-z0-9]{1,8}$/;
// 滚动放出时保留的尾部回看窗口（字符）。作用是防止「相对路径的前导段」正好跨在
// 放出边界上——那时该块还没出现过任何分隔符，看不出后面会跟一个路径。
var GATE_LOOKBACK = 128;

function gateIsUrl(t) {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(t) || /^www\./i.test(t) || /^mailto:/i.test(t);
}

function gateHasEllipsis(t) {
  return t.indexOf("...") !== -1 || t.indexOf("…") !== -1;
}

// 省略号路径：D:\...\a.flac、…/x/a.mp3 → 取尾段文件名，在候选 base 里按 basename 反查。
// 盘符能对上才认；对不上或查到多个不明确时，宁可不改。
function gateResolveEllipsis(tok) {
  try {
    var s = tok.replace(/…/g, "...");
    var segs = s.replace(/\\/g, "/").split("/");
    var tail = "";
    for (var i = segs.length - 1; i >= 0; i--) {
      var seg = segs[i];
      if (seg && seg !== "..." && seg !== "." && seg !== "..") { tail = seg; break; }
    }
    if (!tail || !GATE_EXT_RE.test(tail)) return null;
    var drive = null;
    var dm = s.match(/^([A-Za-z]):/);
    if (dm) drive = dm[1].toUpperCase();
    var bases = candidateBases();
    var found = [];
    for (var b = 0; b < bases.length && found.length < 8; b++) {
      var hits = findByBasename(bases[b], tail, searchMaxDepth);
      for (var h = 0; h < hits.length && found.length < 8; h++) {
        if (found.indexOf(hits[h]) === -1) found.push(hits[h]);
      }
    }
    if (!found.length) return null;
    if (drive) {
      for (var k = 0; k < found.length; k++) {
        if (found[k].charAt(0).toUpperCase() === drive) return found[k];
      }
      return null;
    }
    return found[0];
  } catch (e) {
    return null;
  }
}

// 裸相对路径：outputs\x\a.flac、./a.pptx → 拼到候选 base 上，**真存在**才认。
function gateResolveRelative(tok) {
  try {
    if (!GATE_EXT_RE.test(tok)) return null;
    if (tok.indexOf("\\") === -1 && tok.indexOf("/") === -1) return null;
    if (gateIsUrl(tok)) return null;
    var bases = candidateBases();
    for (var i = 0; i < bases.length; i++) {
      var abs;
      try { abs = pathResolve(bases[i], tok); } catch (e) { continue; }
      var st = statOne(abs);
      if (st && st.exists) return abs;
    }
    return null;
  } catch (e) {
    return null;
  }
}

// 判一个路径核心要不要改、能改成什么。
// 返回 undefined = 本来就不该动（URL / 已是绝对 / 不像路径）；
// 返回 null      = 想改但没改成（计入 miss）；
// 返回字符串      = 改写结果。
function gateResolveCore(core, stats) {
  try {
    if (!core || core.length < 3) return undefined;
    if (gateIsUrl(core)) return undefined;
    var hasSep = core.indexOf("\\") !== -1 || core.indexOf("/") !== -1;
    if (!hasSep) return undefined;
    // 已是绝对路径 / UNC → 原样放行，绝不动
    if (!gateHasEllipsis(core) && looksAbsolute(core)) return undefined;
    var fixed = gateHasEllipsis(core) ? gateResolveEllipsis(core) : gateResolveRelative(core);
    return fixed || null;
  } catch (e) {
    stats.errors++;
    return null;
  }
}

// 解析「候选核心」。直接解析失败时再尝试削掉紧贴的中文——尾部（`...a.flac里`）
// 与前导（`结果在outputs\a.flac` 里多吃的 `结果在`）都削。裁判是「这个文件在磁盘上
// 真的存在吗」，只有真解出来了才动，所以削多削少都不会凭空造出一条路径。
function gateResolveWithTrim(core, stats) {
  var direct = gateResolveCore(core, stats);
  if (typeof direct === "string") return { fixed: direct };
  var headKeep = "";
  var cur = core;
  var triedHead = false;
  for (;;) {
    // ① 在当前串上削尾，每削一段就试一次
    var t = cur;
    for (;;) {
      var mt = t.match(GATE_NONPATH_TAIL_RE);
      if (!mt || t.length - mt[0].length <= 3) break;
      t = t.slice(0, t.length - mt[0].length);
      var ft = gateResolveCore(t, stats);
      if (typeof ft === "string") {
        return { fixed: ft, headKeep: headKeep, suffix: cur.slice(t.length) };
      }
    }
    // ② 削掉一段前导非路径字符，回到 ① 继续
    var mh = cur.match(GATE_NONPATH_HEAD_RE);
    if (!mh || cur.length - mh[0].length <= 3) break;
    headKeep += mh[0];
    cur = cur.slice(mh[0].length);
    triedHead = true;
    var fh = gateResolveCore(cur, stats);
    if (typeof fh === "string") return { fixed: fh, headKeep: headKeep };
  }
  return { fixed: triedHead ? null : direct, headKeep: "" };
}

// 逐行扫描并**只替换路径那一段**，行内其余文字（含紧贴的中文前缀）原样保留。
// guardFirst=true 表示这一行的第 0 个字符可能是「半个词」（滚动放出的边界落在词中间），
// 此时禁止在位置 0 起新候选——宁可漏改，绝不把半个词当路径解析后拼出垃圾。
function gateRewriteLine(line, stats, guardFirst) {
  try {
    var out = "";
    var last = 0;
    var m;
    GATE_HEAD_RE.lastIndex = 0;
    while ((m = GATE_HEAD_RE.exec(line)) !== null) {
      var start = m.index;
      if (start < last) continue; // 落在上一段已替换区间内，跳过
      if (guardFirst && start === 0) continue;
      // 边界闸：前面紧挨着标识符/路径字符 → 这是更长串的中间，不动
      if (start > 0 && GATE_PREV_BAD_RE.test(line.charAt(start - 1))) continue;
      var end = start + m[0].length;
      while (end < line.length && !GATE_SPAN_STOP_RE.test(line.charAt(end))) end++;
      var span = line.slice(start, end);
      var mt = span.match(GATE_TRAIL_RE);
      var trail = mt ? mt[0] : "";
      var core = trail ? span.slice(0, span.length - trail.length) : span;
      var res = gateResolveWithTrim(core, stats);
      var fixed = res.fixed;
      if (typeof fixed === "string" && fixed !== core) {
        out += line.slice(last, start) + (res.headKeep || "") + fixed + (res.suffix || "") + trail;
        last = end;
        stats.rewritten++;
      } else if (fixed === null) {
        stats.miss++;
      }
      GATE_HEAD_RE.lastIndex = end; // 别在同一个 span 里反复匹配
    }
    if (last === 0) return line;
    return out + line.slice(last);
  } catch (e) {
    stats.errors++;
    return line;
  }
}

// 整块正文逐行改写；围栏代码块整段跳过。
function gateNormalizeText(text, stats, midWordStart) {
  try {
    if (typeof text !== "string" || text === "") return text;
    if (text.indexOf("\\") === -1 && text.indexOf("/") === -1) return text;
    var lines = text.split("\n");
    var inFence = false;
    var changed = false;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (GATE_FENCE_RE.test(line)) { inFence = !inFence; continue; }
      if (inFence) continue;
      var nl = (i === 0 && midWordStart) ? gateRewriteLine(line, stats, true) : gateRewriteLine(line, stats);
      if (nl !== line) { lines[i] = nl; changed = true; }
    }
    return changed ? lines.join("\n") : text;
  } catch (e) {
    stats.errors++;
    return text;
  }
}

// 包装流：正文攒到 block-end 再改写；其余帧原样透传。
function gateWrapStream(source, stats) {
  return (async function* () {
    // 每个 block index 一份：deltas = 尚未放出的原文分片（保留分片粒度，这样不需要
    // 改写时能逐帧原样放回，不无谓打散流）；released = 已经放出的原文；
    // sepSeen = 这一块到现在为止出现过路径分隔符没有。
    var buf = new Map();
    var order = [];
    var finished = false;
    function stateOf(i) {
      var st = buf.get(i);
      if (!st) { st = { deltas: [], released: "", sepSeen: false }; buf.set(i, st); order.push(i); }
      return st;
    }
    function held(st) {
      var s = "";
      for (var j = 0; j < st.deltas.length; j++) s += st.deltas[j];
      return s;
    }
    function passthroughDeltas(st, i) {
      var out = [];
      for (var j = 0; j < st.deltas.length; j++) out.push({ type: "text-delta", index: i, text: st.deltas[j] });
      st.deltas = [];
      return out;
    }
    function drainAll() {
      var out = [];
      for (var j = 0; j < order.length; j++) {
        var oi = order[j];
        var st = buf.get(oi);
        if (!st) continue;
        for (var k = 0; k < st.deltas.length; k++) out.push({ type: "text-delta", index: oi, text: st.deltas[k] });
        st.deltas = [];
      }
      return out;
    }
    try {
      for await (var chunk of source) {
        if (!chunk || typeof chunk !== "object") { yield chunk; continue; }
        if (chunk.type === "text-delta") {
          var ti = chunk.index;
          var stt = stateOf(ti);
          stt.deltas.push(chunk.text == null ? "" : String(chunk.text));
          if (!stt.sepSeen) {
            var joined = held(stt);
            if (joined.indexOf("\\") !== -1 || joined.indexOf("/") !== -1) {
              // 出现分隔符了 → 这一块可能含路径，从此整块攒到 block-end 才动
              stt.sepSeen = true;
            } else {
              // 到现在一个分隔符都没有 → 这段不可能含完整路径，安全滚动放出，
              // 只留尾部 GATE_LOOKBACK 字回看窗口（防相对路径的前导段跨在边界上）。
              while (stt.deltas.length > 1) {
                var restLen = 0;
                for (var q = 1; q < stt.deltas.length; q++) restLen += stt.deltas[q].length;
                if (restLen < GATE_LOOKBACK) break;
                var head = stt.deltas.shift();
                stt.released += head;
                yield { type: "text-delta", index: ti, text: head };
              }
            }
          }
          continue;
        }
        if (chunk.type === "block-end") {
          var bi = chunk.index;
          var bst = buf.get(bi);
          if (bst && chunk.block && chunk.block.type === "text") {
            var tailText = held(bst);
            // 放出的最后一个字符不是边界字符 = 边界落在词中间，尾段首字可能是「半个词」
            var midWord = bst.released.length > 0 && !GATE_SPAN_STOP_RE.test(bst.released.slice(-1));
            var fixedTail = gateNormalizeText(tailText, stats, midWord);
            if (fixedTail === tailText) {
              // 无需改写：把攒着的分片原样逐帧放回，再原样放行 block-end（做到逐帧不变）
              var back = passthroughDeltas(bst, bi);
              for (var p = 0; p < back.length; p++) yield back[p];
              yield chunk;
            } else {
              // 真改了才重发。整块文本 = 已放出的前缀 + 改写后的尾部，
              // 保证两边（delta 流 与 block-end 携带的块）内容一致。
              var fullText = bst.released + fixedTail;
              yield { type: "text-delta", index: bi, text: fixedTail };
              yield { type: "block-end", index: bi, block: Object.assign({}, chunk.block, { text: fullText }) };
              bst.deltas = [];
            }
            buf.delete(bi);
            continue;
          }
          if (bst) {
            var lost = passthroughDeltas(bst, bi);
            for (var w = 0; w < lost.length; w++) yield lost[w];
            buf.delete(bi);
          }
          yield chunk;
          continue;
        }
        if (chunk.type === "finish") finished = true;
        yield chunk;
      }
    } catch (e) {
      // 传输层炸了：先把攒着的正文吐回去（块仍开着，text-delta 合法），别让模型的话消失
      var dc = drainAll();
      for (var a = 0; a < dc.length; a++) yield dc[a];
      stats.errors++;
      throw e;
    } finally {
      // 正常收尾但没见到 finish（异常路径）：同样把攒着的吐回去；
      // 已经 finish 过的绝不能补发，平台明确规定 finish 之后不许再有 chunk。
      if (!finished) {
        var fc = drainAll();
        for (var b = 0; b < fc.length; b++) yield fc[b];
      }
    }
  })();
}

// ── 插件入口 ────────────────────────────────────────────────────────────────

export function apply(ctx, config) {
  var injectRules = !(config && config.injectRules === false);
  var allowOutside = !(config && config.allowOutside === false);
  var clientChips = !(config && config.clientChips === false);
  // 强制绝对路径硬门总开关（默认 true）。关掉时行为与加这个功能之前完全一致。
  var forceAbsolutePaths = !(config && config.forceAbsolutePaths === false);

  // 官方硬规则 #5：全部 tunable 走 config，不许写死在代码里。
  if (config && typeof config.statTtlMs === "number" && config.statTtlMs >= 0) {
    statTtlMs = config.statTtlMs;
  }
  if (config && typeof config.searchMaxDepth === "number" && config.searchMaxDepth >= 0) {
    // 上限 8 层：再深就是全盘扫，会把 /resolve 拖成秒级响应
    searchMaxDepth = Math.min(Math.floor(config.searchMaxDepth), 8);
  }
  if (config && typeof config.indexTtlMs === "number" && config.indexTtlMs >= 0) {
    indexTtlMs = config.indexTtlMs;
  }
  // 悬停判定的节流间隔（毫秒）。客户端半边不写死默认值，一律以这里为准：
  // 0 = 不节流（每次都判定，mousemove 频繁时 IO 会略多），默认 40（≈2.5 帧）。
  // 上限 1000：再大就等于「悬停不响应」了，不是配置而是坏掉。
  if (config && typeof config.hoverDelayMs === "number" && isFinite(config.hoverDelayMs) && config.hoverDelayMs >= 0) {
    hoverDelayMs = Math.min(Math.floor(config.hoverDelayMs), 1000);
  }
  // 铁律文本也可整体替换（治「用户想自己改措辞」的场景）
  var rulesText = RULES_TEXT;
  if (config && Array.isArray(config.rulesText) && config.rulesText.length > 0) {
    rulesText = config.rulesText;
  } else if (config && typeof config.rulesText === "string" && config.rulesText.trim() !== "") {
    rulesText = config.rulesText.split("\n");
  }

  ctx.logger.info("dsh-artifact-linker: host half mounted (v" + PKG_VERSION + ", allowOutside=" + allowOutside + ")");

  // (1) 常驻 prompt 段
  if (injectRules) {
    var disposeSection = ctx.systemPrompt.section({
      name: RULES_SECTION_NAME,
      order: RULES_SECTION_ORDER,
      text: rulesText
    });
    ctx.effect(function () { return disposeSection; }, "dsh-artifact-linker: artifact path rules section");
    ctx.logger.info("dsh-artifact-linker: artifact path rules registered (order " + RULES_SECTION_ORDER + ", " + rulesText.length + " lines)");
  } else {
    ctx.logger.info("dsh-artifact-linker: prompt rules disabled by config (injectRules: false)");
  }

  // (1.5) 强制绝对路径硬门：软约束不够，这里做代码级强制。
  if (forceAbsolutePaths) {
    var gateStats = { rewritten: 0, miss: 0, errors: 0, streams: 0 };
    try {
      var disposeGate = ctx.on("llm/stream", function (_options, next) {
        var inner;
        try {
          inner = next();
        } catch (e) {
          gateStats.errors++;
          throw e;
        }
        if (!inner || typeof inner[Symbol.asyncIterator] !== "function") return inner;
        gateStats.streams++;
        return gateWrapStream(inner, gateStats);
      }, { global: true });
      ctx.effect(function () { return disposeGate; }, "dsh-artifact-linker: force-absolute-paths gate");
      ctx.logger.info("dsh-artifact-linker: force-absolute-paths gate mounted on llm/stream");
    } catch (e) {
      // 硬门挂不上不能拖垮插件本体：prompt 段和路由照常工作。
      ctx.logger.warn("dsh-artifact-linker: force-absolute-paths gate FAILED to mount: " + String(e && e.message || e));
    }
  } else {
    ctx.logger.info("dsh-artifact-linker: force-absolute-paths gate disabled by config (forceAbsolutePaths: false)");
  }


  // ── (1.6) 路径硬门 · 拒绝式（第二层，与上面 (1.5) 互补）─────────────────────
  // (1.5) 是「能确定就改写」：被动补救、零模型成本，但解析不到就静默漏改。
  // 这一层是「不该出现就拒绝」：主动强制，覆盖 (1.5) 漏掉的那部分。
  //   a) 工具参数门：write/edit/present 的 file_path / path / files[].path 出现相对或省略路径 → deny
  //   b) 正文门：本轮助手正文出现「带产物扩展名的相对/省略路径」→ 要求模型重发（同一 turn 最多一次）
  // 两个开关默认 true；写 config.pathGateTools: false / pathGateReply: false 可单独关掉。
  // 判定核见 lib/path-gate.js（纯函数）。离线测试：D:\YuE2\_test_artifactgate.mjs、D:\YuE2\_audit_pathgate.mjs
  var pathGateTools = !(config && config.pathGateTools === false);
  var pathGateReply = !(config && config.pathGateReply === false);
  var pathGateArtifactTools = { write: 1, edit: 1, present: 1, apply_patch: 1, univer_export: 1, univer_print_pdf: 1 };
  // 只认「写盘目标」这一类参数名。刻意不深扫全部字符串参数——工具参数里的正文/命令内容不该按路径判。
  // 独立审计 P7 实测：原来只查 file_path / path / files[].path 三键，univer_export 的 output=out\b.xlsx 直接绕过。
  var pathGatePathKeys = ["file_path", "path", "output", "output_path", "save_path", "target_path", "dest"];
  // 独立审计 P8：没有跨 turn 总量上限时，模型顽固就会无限重发、白烧 token。同一会话累计最多要求 5 次。
  var pathGateMaxSteer = 5;

  function pathGateToolViolations(exec) {
    var args = (exec && exec.arguments) || {};
    var out = [];
    function pick(v, at) {
      if (typeof v !== "string") return;
      var vs = findViolations(v);
      for (var k = 0; k < vs.length; k++) { vs[k].at = at; out.push(vs[k]); }
    }
    for (var ki = 0; ki < pathGatePathKeys.length; ki++) {
      pick(args[pathGatePathKeys[ki]], pathGatePathKeys[ki]);
    }
    if (Array.isArray(args.files)) {
      for (var fi = 0; fi < args.files.length; fi++) {
        var ff = args.files[fi];
        if (ff && typeof ff.path === "string") pick(ff.path, "files[" + fi + "].path");
      }
    }
    return out;
  }

  if (pathGateTools) {
    var disposeToolsGate = ctx.on("tools/pre-execute", async function (exec, next) {
      try {
        if (!exec || !pathGateArtifactTools[exec.name]) return next();
        var badArgs = pathGateToolViolations(exec);
        if (!badArgs.length) return next();
        var tagged = [];
        for (var ti = 0; ti < badArgs.length; ti++) {
          tagged.push({ token: badArgs[ti].token + "  [" + badArgs[ti].at + "]", reason: badArgs[ti].reason });
        }
        return { kind: "deny", reason: violationMessage(tagged, "工具 " + exec.name + " 的参数") };
      } catch (gateErr) {
        ctx.logger.warn("dsh-artifact-linker: path gate pre-execute error: " + (gateErr && gateErr.message));
        return next();
      }
    });
    // 独立审计 P6：第二层三个钩子此前都没登记 effect，热重载会悬挂（第一层已登记，同插件内不一致）
    ctx.effect(function () { return disposeToolsGate; }, "dsh-artifact-linker: path gate (tool args)");
  }

  // 正文取证：记住每个会话**最新**一条助手正文（只取 text 块），并带自增序号。
  // 🔴 独立审计 P5 实测：不带序号时，一个只发 tool-call、没有正文的回合会拿上一轮的旧正文
  //    反复要求重发（turn5 steer=4 → 本轮无 text → turn6 steer=5）。序号让「这段正文已要求过一次」可判。
  var pathGateLastReply = new WeakMap();
  var pathGateSteerCount = new WeakMap();
  var pathGateReplySeq = 0;
  var pathGateMsgSeq = 0; // 每收到一条 assistant/message 自增（**无论有没有 text 块**），用来判「旧正文是否已过期」
  var disposeReplyTap = ctx.on("session/event", function (session, event) {
    try {
      if (!event || event.type !== "assistant/message") return;
      pathGateMsgSeq++;
      var gateMsg = event.data && event.data.message;
      var gateContent = gateMsg && gateMsg.content;
      if (!Array.isArray(gateContent)) return;
      var gateText = "";
      for (var gi = 0; gi < gateContent.length; gi++) {
        var gb = gateContent[gi];
        if (gb && gb.type === "text" && typeof gb.text === "string") gateText += gb.text + "\n";
      }
      if (gateText) pathGateLastReply.set(session, { seq: ++pathGateReplySeq, msgSeq: pathGateMsgSeq, text: gateText });
    } catch (gateErr2) { /* 取证失败不影响主流程 */ }
  });
  ctx.effect(function () { return disposeReplyTap; }, "dsh-artifact-linker: path gate (reply tap)");

  // 惰性拿 createUserMessage：拿不到就只降级正文门，绝不让插件加载失败
  var pathGateMessageFactory = null;
  var pathGateMessageLoading = null;
  function pathGateEnsureMessageFactory() {
    if (pathGateMessageFactory) return Promise.resolve(pathGateMessageFactory);
    if (!pathGateMessageLoading) {
      pathGateMessageLoading = import("@deepseek-ai/dsh-llm").then(function (m) {
        pathGateMessageFactory = m && m.createUserMessage ? m.createUserMessage : null;
        return pathGateMessageFactory;
      }).catch(function (gateErr3) {
        ctx.logger.warn("dsh-artifact-linker: createUserMessage unavailable, reply gate off: " + (gateErr3 && gateErr3.message));
        return null;
      });
    }
    return pathGateMessageLoading;
  }

  if (pathGateReply) {
    var disposeReplyGate = ctx.on("agent/turn-stopping", async function (payload) {
      try {
        var gateAgent = payload && payload.agent;
        var gateTurn = payload && payload.turn;
        var gateSession = gateAgent && gateAgent.session;
        if (!gateSession) return;
        var gateReply = pathGateLastReply.get(gateSession);
        if (!gateReply) return;
        var gateRec = pathGateSteerCount.get(gateSession);
        // 这段正文已要求过一次，且此后又来了一条 assistant/message（内容里没有 text 块）→ 旧正文不再复用（审计 P5）
        if (gateRec && gateRec.seq === gateReply.seq && pathGateMsgSeq > gateRec.msgSeq) return;
        if (gateRec && gateRec.turn === gateTurn && gateRec.n >= 1) return; // 同一个 turn 最多要求一次
        if (gateRec && gateRec.total >= pathGateMaxSteer) return;           // 会话累计上限，防模型顽固空转烧 token
        var gateBad = findViolations(gateReply.text);
        if (!gateBad.length) return;
        pathGateSteerCount.set(gateSession, {
          turn: gateTurn,
          n: (gateRec && gateRec.turn === gateTurn ? gateRec.n : 0) + 1,
          total: (gateRec ? gateRec.total : 0) + 1,
          seq: gateReply.seq,
          msgSeq: pathGateMsgSeq
        });
        var gateMake = await pathGateEnsureMessageFactory();
        if (!gateMake) return;
        gateAgent.steer(gateMake({
          content: [{ type: "text", text: violationMessage(gateBad, "本轮回复正文") }],
          source: { kind: "ptc-mode" }
        }));
      } catch (gateErr4) {
        ctx.logger.warn("dsh-artifact-linker: path gate turn-stopping error: " + (gateErr4 && gateErr4.message));
      }
    });
    ctx.effect(function () { return disposeReplyGate; }, "dsh-artifact-linker: path gate (reply)");
  }

  // (2) 只读回环路由
  ctx.effect(function () {
    var routes = [];

    // /info —— 客户端启动时问一次：版本、开关、默认 base
    routes.push(ctx.webServer.register({
      kind: "exact",
      path: ROUTE_PREFIX + "/info",
      handler: function (req, res) {
        if (!isLoopback(req)) { res.writeHead(403); res.end(); return; }
        json(res, 200, {
          ok: true,
          plugin: "dsh-artifact-linker",
          version: PKG_VERSION,
          clientChips: clientChips,
          injectRules: injectRules,
          allowOutside: allowOutside,
          hoverDelayMs: hoverDelayMs,
          cwd: process.cwd(),
          bases: candidateBases()
        });
      }
    }));

    // /resolve?p=<raw>&base=<dir> —— 三源兜底解析
    routes.push(ctx.webServer.register({
      kind: "exact",
      path: ROUTE_PREFIX + "/resolve",
      handler: function (req, res) {
        if (!isLoopback(req)) { res.writeHead(403); res.end(); return; }
        var url;
        try {
          url = new URL(req.url || "/", "http://127.0.0.1");
        } catch (e) {
          json(res, 400, { ok: false, reason: "bad-url" });
          return;
        }
        var raw = url.searchParams.get("p") || "";
        var baseParam = url.searchParams.get("base") || "";
        try {
          // 2026-10-27 修复：不再固定用 process.cwd()，
          // 而是把「所有可能是 workspace 的目录」逐个当 base 试，命中即返回。
          var out = resolveAcross(raw, baseParam, allowOutside);
          json(res, 200, out);
        } catch (e) {
          json(res, 200, { ok: false, reason: "error", message: String(e && e.message || e) });
        }
      }
    }));

    // /stat?p=<abs>&p=<abs>... —— 批量 stat（客户端懒加载时一次问一批）
    routes.push(ctx.webServer.register({
      kind: "exact",
      path: ROUTE_PREFIX + "/stat",
      handler: function (req, res) {
        if (!isLoopback(req)) { res.writeHead(403); res.end(); return; }
        var url;
        try {
          url = new URL(req.url || "/", "http://127.0.0.1");
        } catch (e) {
          json(res, 400, { ok: false, reason: "bad-url" });
          return;
        }
        var list = url.searchParams.getAll("p").slice(0, 120);
        var items = list.map(function (raw) {
          var abs = cleanRaw(raw);
          if (!abs) return { p: raw, exists: false, kind: null, size: 0, mtimeMs: 0, error: "empty" };
          if (!looksAbsolute(abs)) return { p: raw, exists: false, kind: null, size: 0, mtimeMs: 0, error: "not-absolute" };
          var st = statOne(pathResolve(abs));
          return { p: abs, exists: st.exists, kind: st.kind, size: st.size, mtimeMs: st.mtimeMs, error: st.error || null };
        });
        json(res, 200, { ok: true, items: items });
      }
    }));

    // /flush-cache —— 用户手工删了文件后强制刷新（客户端右键菜单可调用）
    routes.push(ctx.webServer.register({
      kind: "exact",
      path: ROUTE_PREFIX + "/flush-cache",
      handler: function (req, res) {
        if (!isLoopback(req)) { res.writeHead(403); res.end(); return; }
        var n = statCache.size;
        var m = basenameIndexCache.size;
        statCache.clear();
        // basename 索引必须一起清：用户手工删/挪了文件后，不清索引还会命中老路径
        basenameIndexCache.clear();
        json(res, 200, { ok: true, cleared: n, indexes: m });
      }
    }));

    // 5A：让动作路由既能接受绝对路径（旧行为），也能接受原始文本（裸名/相对路径），
    // 内部自己 resolveAcross 解析——这样客户端「点击动作」可以一次 Host 调用直达，
    // 不必先单独打一发 /resolve。绝对路径走精确 stat 分支，行为与旧版完全一致。
    function absFromParam(pRaw, baseParam) {
      var s = cleanRaw(pRaw || "");
      if (!s) return null;
      if (looksAbsolute(s)) return pathResolve(s);
      var r = resolveAcross(s, baseParam, allowOutside);
      if (r && r.ok && r.abs) return r.abs;
      return null;
    }

    // /reveal?p=<abs|raw> —— 在系统资源管理器里揭示并选中（目录则直接打开）
    // /open?p=<abs|raw>   —— 用系统默认程序打开（也接受原始文本，宿主内部解析）
    function makeLauncher(action) {
      return function (req, res) {
        if (!isLoopback(req)) { res.writeHead(403); res.end(); return; }
        var url;
        try {
          url = new URL(req.url || "/", "http://127.0.0.1");
        } catch (e) {
          json(res, 400, { ok: false, reason: "bad-url" });
          return;
        }
        var abs = absFromParam(url.searchParams.get("p") || "", url.searchParams.get("base") || "");
        if (!abs) {
          json(res, 200, { ok: false, reason: "unresolved" });
          return;
        }
        if (!insideAnyBase(abs, allowOutside)) {
          json(res, 200, { ok: false, reason: "outside-base", abs: abs });
          return;
        }
        try {
          launchPath(abs, action, res);
        } catch (e) {
          json(res, 200, { ok: false, reason: "error", message: String(e && e.message || e) });
        }
      };
    }

    routes.push(ctx.webServer.register({ kind: "exact", path: ROUTE_PREFIX + "/reveal", handler: makeLauncher("reveal") }));
    routes.push(ctx.webServer.register({ kind: "exact", path: ROUTE_PREFIX + "/open", handler: makeLauncher("open") }));

    // /saveas?p=<abs>   —— 弹系统「另存为」对话框，把文件复制到用户选的位置
    // /copyfile?p=<abs> —— 把文件本身（不是路径字符串）写入剪贴板，可直接粘到资源管理器
    //
    // 与 reveal/open 的区别：这两个是**有副作用**的文件操作，所以额外挡了三种输入：
    //   目录（另存为目录无意义）、不存在的文件、以及目标路径 == 源路径（会自覆盖）。
    function makeFileOp(op) {
      return function (req, res) {
        if (!isLoopback(req)) { res.writeHead(403); res.end(); return; }
        var url;
        try {
          url = new URL(req.url || "/", "http://127.0.0.1");
        } catch (e) {
          json(res, 400, { ok: false, reason: "bad-url" });
          return;
        }
        var abs = absFromParam(url.searchParams.get("p") || "", url.searchParams.get("base") || "");
        if (!abs) {
          json(res, 200, { ok: false, reason: "unresolved" });
          return;
        }
        if (!insideAnyBase(abs, allowOutside)) {
          json(res, 200, { ok: false, reason: "outside-base", abs: abs });
          return;
        }
        var st = statOne(abs);
        if (!st.exists) {
          json(res, 200, { ok: false, reason: "not-found", abs: abs });
          return;
        }
        if (st.kind === "dir") {
          json(res, 200, { ok: false, reason: "is-directory", abs: abs });
          return;
        }
        if (process.platform !== "win32") {
          json(res, 200, { ok: false, reason: "unsupported-platform" });
          return;
        }

        if (op === "copyfile") {
          copyFileToClipboard(abs, function (err) {
            if (err) {
              try { console.log("[dsh-artifact-linker] copyfile failed -> " + (err.message || err)); } catch (e) { }
              json(res, 200, { ok: false, reason: "clipboard-failed", message: String(err.message || err) });
              return;
            }
            try { console.log("[dsh-artifact-linker] copyfile ok (CF_HDROP) -> " + abs); } catch (e) { }
            json(res, 200, { ok: true, abs: abs, action: "copyfile" });
          });
          return;
        }

        saveAsViaDialog(abs, function (err, dest) {
          if (err) {
            try { console.log("[dsh-artifact-linker] saveas dialog failed -> " + (err.message || err)); } catch (e) { }
            json(res, 200, { ok: false, reason: "dialog-failed", message: String(err.message || err) });
            return;
          }
          if (!dest) {
            // 用户取消：静默，客户端不该弹「失败」
            json(res, 200, { ok: false, reason: "cancelled" });
            return;
          }
          var target = pathResolve(dest);
          // 同一路径复制到自己会抛 EINVAL / 把文件截断，必须提前拦
          if (target.toLowerCase() === abs.toLowerCase()) {
            json(res, 200, { ok: false, reason: "same-path", dest: target });
            return;
          }
          try {
            copyFileSync(abs, target);
          } catch (e) {
            json(res, 200, { ok: false, reason: "copy-failed", message: String(e && e.message || e) });
            return;
          }
          var nst = statOne(target);
          try { console.log("[dsh-artifact-linker] saveas ok -> " + target); } catch (e) { }
          json(res, 200, { ok: true, abs: abs, dest: target, size: nst.size, action: "saveas" });
        });
      };
    }

    routes.push(ctx.webServer.register({ kind: "exact", path: ROUTE_PREFIX + "/saveas", handler: makeFileOp("saveas") }));
    routes.push(ctx.webServer.register({ kind: "exact", path: ROUTE_PREFIX + "/copyfile", handler: makeFileOp("copyfile") }));

    // ── 客户端 bundle 兜底投递（v0.5.3）─────────────────────────────────────
    // 为什么需要：DSH 的客户端 module graph 可能整包跳过本插件。实测 2026-11-13：
    // 宿主半边 4 条日志全绿、/info 200、/resolve 200，但客户端从未挂载 ——
    // 同批插件（todo-float-ball / font-enhancer）都有 "CLIENT-ALIVE ping"，
    // 本插件一条也没有；正文文件芯片的右键接管因此从未绑定，用户右键只看到
    // 宿主官方菜单（在侧边栏打开 / 在浮窗中打开 / …），表现就是「插件失效」。
    // 兜底 = 自己把 bundle 吐出来，再让 shell 的 index-inject 往 <head> 插 <script>。
    // client.js 顶部有 GUARD 幂等保护，被注入两次也只会 apply 一次。
    routes.push(ctx.webServer.register({
      kind: "exact",
      path: ROUTE_PREFIX + "/client.bundle.js",
      handler: function (req, res) {
        try {
          var here = dirname(fileURLToPath(import.meta.url));
          var buf = readFileSync(join(here, "client.js"));
          res.writeHead(200, { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-store" });
          res.end(buf);
        } catch (error) {
          try {
            res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
            res.end(String((error && error.message) || error));
          } catch (e) { /* ignore */ }
        }
      }
    }));

    // 客户端存活探针：客户端每次 apply 会 ping 一次，宿主日志因此可判定
    // 「bundle 到底加载了没有」，不必再靠猜。
    routes.push(ctx.webServer.register({
      kind: "exact",
      path: ROUTE_PREFIX + "/client-alive",
      handler: function (req, res) {
        try { ctx.logger.info("dsh-artifact-linker: CLIENT-ALIVE ping received from browser"); } catch (e) { /* ignore */ }
        try {
          res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(JSON.stringify({ ok: true, version: PKG_VERSION }));
        } catch (e) { /* ignore */ }
      }
    }));

    // v0.5.5 修复（2026-11-13）：这条 index-inject 兜底与宿主 dsh.client 通道**同时生效**，
    // 导致同一个 bundle 被执行两次，renderer 抛
    //   Uncaught Error: client-modules: duplicate factory registration for "dsh-artifact-linker"
    // （宿主日志 2026-11-13T02:53:10Z 与 04:06:23Z 各一次），客户端模块链当场中断，
    // 右键接管、胶囊等后续注册全部失效 —— 这就是「右键很多功能没反应、侧栏打不开」的真病根。
    // 上面那条 GUARD 幂等保护救不了：duplicate 是在 __ModuleLoader__ 注册 factory 阶段抛的，
    // 早于 apply()，GUARD 根本来不及执行（0.5.3 写兜底时的误判）。
    // 结论见下方 v0.5.6：兜底**默认开启**，两条通道并存无害 —— 真正拦 duplicate 的是
    // client.js 最外层的脚本级幂等守卫（注册 factory 之前就拦住第二份脚本）。
    var _fallbackCfg = null;
    try { _fallbackCfg = ctx.config; } catch (e) { _fallbackCfg = null; }
    // v0.5.6：兜底恢复**默认开启**。0.5.5 曾把兜底改成需要显式打开才注入，但实测重启后客户端仍没挂上
    // （宿主侧只剩 dsh.client 一条通道，而它在这一版里并不总能投递到），表现为「右键没反应」。
    // 现在双通道都保留，靠 client.js 的脚本级幂等守卫保证只注册一次 → duplicate 不会再发生。
    // 如需彻底关掉兜底，在 cordis.patch.yml 里配 clientFallback: false 即可。
    if (!_fallbackCfg || _fallbackCfg.clientFallback !== false) {
      try {
        ctx.on("webserver/index-inject", function (table) {
          try {
            table.push({ kind: "script-src", placement: "head", src: ROUTE_PREFIX + "/client.bundle.js" });
          } catch (e) { /* ignore */ }
        });
        ctx.logger.info("dsh-artifact-linker: client fallback: index-inject hook armed (default on, disable with clientFallback:false)");
      } catch (error) {
        try { ctx.logger.warn("dsh-artifact-linker: client fallback: index-inject hook failed: " + ((error && error.message) || String(error))); } catch (e) { /* ignore */ }
      }
    }

    return function () {
      for (var i = 0; i < routes.length; i++) {
        try { routes[i](); } catch (e) { /* ignore */ }
      }
    };
  }, "dsh-artifact-linker: loopback routes");

  ctx.logger.info("dsh-artifact-linker: routes registered at " + ROUTE_PREFIX + " (info/resolve/stat/flush-cache/reveal/open/saveas/copyfile)");
}
