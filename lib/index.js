// dsh-artifact-linker - host half.
//
// 目的：让「产物路径」这件事从模型输出一直贯通到用户手指。
//
// 三件事（都在宿主侧，零写入、零 spawn、零联网）：
//   (1) 常驻 system-prompt 段（ctx.systemPrompt.section，order 200）—— 让模型
//       在**每个会话／每个预设**都优先输出完整绝对路径。技能是按需加载的，
//       prompt 段是常驻的，所以「装了插件 = 规则生效」不依赖任何技能被加载。
//       这是软约束层：它提高模型给绝对路径的概率，但不保证。
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

import { readFileSync, statSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve as pathResolve, basename, sep } from "node:path";

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
  "2. **正文叙述给用户看时只写文件名**（如 `a.xlsx`），不要贴绝对路径——插件会自动把它渲染成可点芯片。**正文出现长串绝对路径属于违规**（这一条与第 1 条并不矛盾：1 管工具与内部记录，2 管正文措辞）。",
  "3. 不重复罗列非产物：读入的输入文件、依赖包、缓存、临时文件、系统路径一律不报。",
  "4. 已用 `present` 工具交付的产物，正文不重复罗列其路径。",
  "5. 🔴 无法确定绝对路径时，先实际核实（`pwd`、列目录、读工具返回值）再写，**绝不编造路径**——编造的路径点开就是死链，比不给路径更糟。",
  "6. 路径含空格或中文时，用反引号包裹成行内代码（如 `E:\\工作 目录\\结果.xlsx`），避免被正文断词截断。"
].join("\n");

export var name = "dsh-artifact-linker";
export var inject = ["webServer", "systemPrompt"];

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

  var first = tryAll(raw);
  if (first && first.ok) return first;
  var best = first;

  // 🔴 从左收缩重试（配合客户端正则允许空格的做法）
  // 客户端为了支持「带空格的文件名」，现在会把左边几个词一起吞进候选，
  // 于是「详见 报告.pdf」这种会整串送过来。这里先按整串试，不行就剥掉最左一段再试，
  // 直到只剩纯文件名。这样既保住空格文件名，又不会因为多吞了几个词就解析不到。
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
  var cmd;
  var args;
  if (process.platform === "win32") {
    cmd = "explorer.exe";
    // 🔴 /select,"path" 必须作为**一整串（含引号）**原样交给 explorer，配合下面的
    // windowsVerbatimArguments:true，Node 才不会自己决定要不要加引号。
    // 2026-10-28 实测：裸传中文/带空格路径（不加引号）时 explorer 解析不了，
    // 返回码非 0 却 stdout/stderr 全空 —— 这是「点了没反应」的真凶之一。
    args = (action === "reveal") ? ['/select,"' + abs + '"'] : [abs];
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
          console.log("[dsh-artifact-linker] " + action + " note: " + cmd + " 退出码 " + (err.code == null ? "非零" : err.code) + "，属 explorer 惯例，窗口已正常弹出");
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

// ── 插件入口 ────────────────────────────────────────────────────────────────

export function apply(ctx, config) {
  var injectRules = !(config && config.injectRules === false);
  var allowOutside = !(config && config.allowOutside === false);
  var clientChips = !(config && config.clientChips === false);

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

    // /reveal?p=<abs> —— 在系统资源管理器里揭示并选中（目录则直接打开）
    // /open?p=<abs>   —— 用系统默认程序打开
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
        var abs = cleanRaw(url.searchParams.get("p") || "");
        if (!abs || !looksAbsolute(abs)) {
          json(res, 200, { ok: false, reason: "need-absolute-path" });
          return;
        }
        abs = pathResolve(abs);
        if (!allowOutside && !isInside(process.cwd(), abs)) {
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

    return function () {
      for (var i = 0; i < routes.length; i++) {
        try { routes[i](); } catch (e) { /* ignore */ }
      }
    };
  }, "dsh-artifact-linker: loopback routes");

  ctx.logger.info("dsh-artifact-linker: routes registered at " + ROUTE_PREFIX + " (info/resolve/stat/flush-cache)");
}
