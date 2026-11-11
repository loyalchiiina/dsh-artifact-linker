// dsh-artifact-linker 第二层硬门 · 路径判定核（纯函数，零依赖，可离线测试）
//
// 定位：第一层（已由并发者在 lib/index.js 落地）是 llm/stream **改写**：把能确定存在的
// 相对/省略路径改成绝对路径。它的边界是「只改能确定的」，解析不到就静默漏改。
// 本判定核服务于第二层：**判定并拒绝**——识别正文/工具参数里的不合规产物路径，
// 交给 (a) tools/pre-execute 拒绝工具调用、(b) agent/turn-stopping 要求模型重发。
//
// 判定哲学（与第一层互补，不是替代）：
//   - 只判「像产物路径」的 token（带已知产物扩展名），避免把源码引用/普通词误判；
//   - URL / 已绝对（含 UNC）/ 围栏代码块内 / 行内代码内 → 一律不算违规；
//   - 相对路径与省略号路径 → 违规（这正是要拒绝并要求重发的对象）。

// 刻意只收「交付物/产物」类扩展名：源码类（js/ts/py/sh…）与配置类（ini/toml/xml）**不计**，
// 因为正文里提一个源码相对路径是常态，算进来会大量误报（宁可少判，不可错拒）。
export const ARTIFACT_EXT_RE = /\.(?:xlsx?|xlsm|docx?|pptx?|pdf|csv|tsv|zip|7z|rar|tar|gz|tgz|png|jpe?g|gif|bmp|webp|tiff?|svg|ico|mp3|mp4|wav|flac|m4a|mkv|mov|avi|srt|lrc|txt|md|markdown|log|json|jsonl|ya?ml|h5|cas|dat|scdocx?|pmdb|stl|step|stp|iges|igs|x_t|x_b|sat|jou|set|out|trn|rfile|xy|unv|msh|res|fig|html?)$/i;

const URL_RE = /^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|www\.|mailto:|file:\/\/)/i;
const ABS_WIN_RE = /^[A-Za-z]:[\\/]/;     // E:\...
const ABS_UNC_RE = /^\\\\[^\\]/;          // \\server\share
const ABS_POSIX_RE = /^\/(?:[^\/\s]+\/)*[^\/\s]*$/; // /home/x/a.png（含单斜杠）
// 省略号必须紧贴路径分隔符才算「省略式路径」，避免把 `a...b` 这类普通文本误判
const ELLIPSIS_RE = /(?:\.{3}|…)[\\/]/;
// 🔴 变量/占位符/家目录简写不是「交付物路径」。独立审计实测这五条都会被误判违规：
//    %TEMP%\a.txt、$env:TEMP\a.xlsx、${WORKDIR}/out/a.txt、%USERPROFILE%\Desktop\a.docx、~/docs/a.pdf
// 它们是命令里的正常写法，判违规会直接拒掉工具调用 → 一律放行（宁可漏，不可错拒）。
const PLACEHOLDER_RE = /(?:%[^%\s]+%|\$\{[^}\n]*\}|\$env:|%~|^~[\\/]|^~$)/i;
// 「路径开头」判据：盘符 / UNC / POSIX 根。用于识别「含空格的绝对路径被空白切成两半」。
const PATH_HEAD_RE = /^(?:[A-Za-z]:[\\/]|\\\\[^\\]|\/)/;

/** 单个 token 的分类。返回 'url' | 'absolute' | 'unc' | 'ellipsis' | 'relative' | 'ignore' */
export function classifyToken(raw) {
  const tok = String(raw || "").trim().replace(/^[`"'（(【「『]+/, "").replace(/[`"'）)】」』]+$/, "");
  if (!tok) return "ignore";
  if (URL_RE.test(tok)) return "url";
  if (PLACEHOLDER_RE.test(tok)) return "ignore";
  // 🔴 省略号必须排在「绝对」之前：`E:\...\a.flac` 以盘符开头，先判绝对会被放过（本核实测踩过）。
  if (ELLIPSIS_RE.test(tok)) return "ellipsis";
  if (ABS_WIN_RE.test(tok)) return "absolute";
  if (ABS_UNC_RE.test(tok)) return "unc";
  // 以 / 开头且含至少一个 / 分隔 → 视作 posix 绝对（保守：单斜杠根路径不判违规）
  if (tok.startsWith("/") && tok.length > 1) return "absolute";
  // `3/4.xlsx`、`比率3/4.xlsx` 这类「数字打头的斜杠串」更可能是分数/比例而不是相对路径 → 放行。
  // 先削掉紧贴的中文说明词再判。只对无反斜杠的形态生效（`11/2026\a.xlsx` 不受影响）。宁可漏，不可错拒。
  if (!tok.includes("\\")) {
    const core = tok.replace(/^[^\x00-\x7F]+/, "");
    if (/^\d+\//.test(core)) return "ignore";
  }
  // 必须含路径分隔符才是「路径候选」
  if (tok.includes("\\") || tok.includes("/")) return "relative";
  return "ignore";
}

/** 剥掉 Markdown 围栏代码块与行内代码，返回 { text, masked } —— masked 中这些区域被等长空白替换 */
export function maskCode(text) {
  const s = String(text ?? "");
  const out = s.split("");
  let inFence = false;
  const lines = s.split("\n");
  let cursor = 0;
  for (const line of lines) {
    const isFence = /^\s*(```|~~~)/.test(line);
    if (inFence || isFence) {
      for (let i = cursor; i < cursor + line.length; i++) out[i] = " ";
    }
    if (isFence) inFence = !inFence;
    cursor += line.length + 1;
  }
  // 行内代码 `...`
  const masked = out.join("");
  const inline = masked.replace(/`[^`\n]*`/g, (m) => " ".repeat(m.length));
  return { text: masked, inline };
}

/** 取「最长的、以已知产物扩展名结尾」的前缀（治尾部粘着说明词，如 `a.xlsx请查收`） */
export function stripTailToExt(t) {
  for (let i = t.length; i > 0; i--) {
    const s = t.slice(0, i);
    if (ARTIFACT_EXT_RE.test(s)) return s;
  }
  return null;
}

/** 削掉开头的非 ASCII 字符（治中文紧贴，如 `产物在out\报告.xlsx` → `out\报告.xlsx`） */
export function stripHeadToPath(s) {
  const m = String(s).match(/^[^\x00-\x7F]+/);
  return m ? s.slice(m[0].length) : s;
}

/**
 * 中文紧贴恢复：`产物在out\报告最终版.xlsx请查收` → `out\报告最终版.xlsx`。
 * 只在含反斜杠时尝试（避免把 `3/4.xlsx` 这类分数样式误判成路径）。
 * 恢复结果仍要过 classifyToken：恢复出来是绝对路径的一律放行（宁可漏，不可错拒）。
 */
export function recoverArtifactPath(tok) {
  const t = String(tok || "");
  if (!t.includes("\\")) return null;
  const tail = stripTailToExt(t);
  if (!tail) return null;
  const core = stripHeadToPath(tail);
  if (!core || core === t) return null;
  const kind = classifyToken(core);
  if (kind !== "relative" && kind !== "ellipsis") return null;
  return core;
}

/** 扫描文本中的路径候选 token，返回 [{ token, kind, index }]（已剔除代码区域） */
export function scanText(text) {
  const { inline } = maskCode(text);
  const hits = [];
  const re = /[^\s，。；：、)\]】」』"'`<>|?*,;]+/g;
  let m;
  let prevTok = null;
  let prevEnd = -1;
  while ((m = re.exec(inline)) !== null) {
    const raw = m[0];
    // 裁掉句末标点后再判
    const tok = raw.replace(/[.,;:!?]+$/, "");
    const gap = prevEnd >= 0 ? inline.slice(prevEnd, m.index) : "";
    // 前一 token 是「路径开头、自己又不是完整产物」→ 它可能是被空白切开的绝对路径前半截
    const prevWasPathHead =
      prevTok !== null && /^\s*$/.test(gap) && PATH_HEAD_RE.test(prevTok) && !ARTIFACT_EXT_RE.test(prevTok);
    prevTok = tok;
    prevEnd = m.index + raw.length;
    if (!tok) continue;
    const kind = classifyToken(tok);
    if (kind === "ignore") continue;
    // `E:\我的 文件夹\a.xlsx`：含空格的绝对路径被空白切开，合并后必然是绝对路径 → 不算违规。
    // 独立审计 P1 实测：不挡这条会把带空格的正常路径全部误拒。
    if (prevWasPathHead && kind === "relative") continue;
    hits.push({ token: tok, kind, index: m.index });
  }
  return hits;
}

/** 是否「像产物」：带已知产物扩展名，或调用方给的额外判据 */
export function looksLikeArtifact(token, extra) {
  if (ARTIFACT_EXT_RE.test(token)) return true;
  if (typeof extra === "function") return !!extra(token);
  return false;
}

/**
 * 找出不合规产物路径（第二层要拒绝/要求重发的对象）。
 * @returns [{ token, kind, reason, index }]
 */
export function findViolations(text, opts = {}) {
  const hits = scanText(text);
  const out = [];
  for (const h of hits) {
    if (h.kind !== "relative" && h.kind !== "ellipsis") continue;
    // 省略号形态本身即不合规（用户明确要求：含 … 或 ...\ 的省略式不算完整路径）
    const isEll = h.kind === "ellipsis";
    if (!isEll && !looksLikeArtifact(h.token, opts.looksLike)) {
      // 中文紧贴时整段粘连（`产物在out\报告.xlsx请查收`），再试一次「削尾 + 削头」恢复。
      // 独立审计 P4 实测：不做恢复则这种最典型的写法整条漏拦。
      const rec = recoverArtifactPath(h.token);
      if (!rec || !looksLikeArtifact(rec, opts.looksLike)) continue;
      out.push({ token: rec, kind: "relative", index: h.index, reason: "相对路径，不是完整绝对路径" });
      continue;
    }
    out.push({
      token: isEll ? stripHeadToPath(h.token) : h.token,
      kind: h.kind,
      index: h.index,
      reason: isEll
        ? "路径含省略号（… 或 ...），不是完整绝对路径"
        : "相对路径，不是完整绝对路径",
    });
  }
  return out;
}

/** 深扫任意 JSON 值里的字符串，找出不合规产物路径（用于工具参数） */
export function findViolationsDeep(value, opts = {}) {
  const out = [];
  const seen = new Set();
  const walk = (v, path) => {
    if (v === null || v === undefined) return;
    if (typeof v === "string") {
      for (const x of findViolations(v, opts)) out.push({ ...x, path });
      return;
    }
    if (typeof v !== "object") return;
    if (seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) { v.forEach((item, i) => walk(item, path + "[" + i + "]")); return; }
    for (const k of Object.keys(v)) walk(v[k], path ? path + "." + k : k);
  };
  walk(value, "");
  return out;
}

/** 生成给模型的拒绝文案（拒绝工具调用 / 要求重发共用） */
export function violationMessage(violations, where) {
  const lines = violations.slice(0, 5).map((v) => "  - " + v.token + "（" + v.reason + "）");
  return [
    "路径硬门拒绝：" + (where || "本次输出") + " 里出现了非完整绝对路径的产物路径，不能放行。",
    ...lines,
    "要求：所有产物/交付文件一律给出完整绝对路径（Windows 形如 E:\\proj\\out\\a.xlsx），",
    "不得使用相对路径、不得使用 ... 或 … 省略中间目录段。请修正后重新输出。",
  ].join("\n");
}
