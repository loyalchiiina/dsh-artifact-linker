// v0.5.8 输入区识别闸门的无依赖行为测试。
// 目的：证明 inEditZone / isEditableElement 在真实代码块上「只放行输入区、不误伤正文」。
// 做法：从 lib/client.js 里切出 EDIT_NODE_SELECTOR → isEditableElement 片段，
//       用最小假 Element 树（实现 closest / nodeType / parentNode / isContentEditable）
//       驱动它，逐例比对期望值。不引 jsdom（本机没有，也不为一次测试装依赖）。
const fs = require("fs");
const path = require("path");

const CLIENT = path.join(__dirname, "..", "lib", "client.js");
const src = fs.readFileSync(CLIENT, "utf8");
const startMark = "// ── 输入区识别限制（v0.5.8）";
const endMark = "// ── 命中判定";
const s = src.indexOf(startMark);
const e = src.indexOf(endMark);
if (s < 0 || e < 0 || e <= s) {
  console.log("FAIL 无法从 client.js 切出闸门代码块");
  process.exit(1);
}
const body = src.slice(s, e);

// 把切出来的片段挂到 globalThis 上（片段内是 var + function，作用域无关紧要）
const runner = new Function(
  "host",
  body + "\nreturn { EDIT_NODE_SELECTOR: EDIT_NODE_SELECTOR, editNodeOf: editNodeOf, inEditZone: inEditZone, isEditableElement: isEditableElement };"
);
const g = runner({});

// ── 假 Element 树 ──────────────────────────────────────────────────────────
function el(tag, attrs, parent, ce) {
  attrs = attrs || {};
  const node = {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    attrs: attrs,
    parentNode: parent || null,
    isContentEditable: ce === true,
    closest: function (sel) {
      const parts = String(sel).split(",").map((x) => x.trim());
      let n = node;
      while (n && n.nodeType === 1) {
        for (let i = 0; i < parts.length; i++) {
          const p = parts[i];
          if (p.charAt(0) === ".") {
            const cls = String(n.attrs.class || "").split(/\s+/);
            if (cls.indexOf(p.slice(1)) >= 0) return n;
            continue;
          }
          const m = /^([a-zA-Z]+)?(\[[^\]]+\])?$/.exec(p);
          if (!m) continue;
          let ok = true;
          if (m[1]) ok = ok && n.tagName === m[1].toUpperCase();
          if (m[2]) {
            const am = /^\[([^\]=\s]+)(?:="([^"]*)")?\]$/.exec(m[2]);
            if (!am) { ok = false; } else {
              ok = ok && Object.prototype.hasOwnProperty.call(n.attrs, am[1]);
              if (ok && am[2] !== undefined) ok = String(n.attrs[am[1]]) === am[2];
            }
          }
          if (ok && (m[1] || m[2])) return n;
        }
        n = n.parentNode;
      }
      return null;
    }
  };
  return node;
}
function text(nodeValue, parent) {
  return { nodeType: 3, nodeValue: nodeValue, parentNode: parent || null };
}

// ── 场景 ───────────────────────────────────────────────────────────────────
const composer = el("div", { class: "composer" });
const editable = el("div", { contenteditable: "true" }, composer, true);
const spanInEdit = el("span", {}, editable);
const textInEdit = text("C:\\a\\b.xlsx", spanInEdit);

const article = el("article", {});
const spanInBody = el("span", {}, article);
const textInBody = text("C:\\a\\b.xlsx", spanInBody);

const ta = el("textarea", {}, composer);
const roleRo = el("div", { role: "textbox" });
const lexical = el("div", { "data-lexical-editor": "true" }, null, true);
const prosemirror = el("div", { class: "ProseMirror" }, null, true);
const plainOuter = el("section", {});
const spanPlain = el("span", {}, plainOuter);

const cases = [
  ["正文 span（只读）", spanInBody, false],
  ["正文文本节点", textInBody, false],
  ["输入框内 span（contenteditable 祖先）", spanInEdit, true],
  ["输入框文本节点", textInEdit, true],
  ["textarea 本体", ta, true],
  ["[role=textbox] 渲染层", roleRo, true],
  ["Lexical 编辑器", lexical, true],
  ["ProseMirror 编辑器", prosemirror, true],
  ["正文 span（无编辑祖先）", spanPlain, false],
  ["body 级普通容器", plainOuter, false]
];

let bad = 0;
for (const [name, node, expect] of cases) {
  const got = g.inEditZone(node);
  if (got !== expect) bad++;
  console.log((got === expect ? "PASS" : "FAIL") + "  " + name + "  expect=" + expect + " got=" + got);
}
const fe = g.isEditableElement(ta);
const fp = g.isEditableElement(spanInBody);
if (fe !== true) bad++;
if (fp !== false) bad++;
console.log((fe === true ? "PASS" : "FAIL") + "  isEditableElement(textarea)=" + fe);
console.log((fp === false ? "PASS" : "FAIL") + "  isEditableElement(正文 span)=" + fp);
console.log("VERDICT " + (bad === 0 ? "ALL-PASS" : "HAS-FAIL:" + bad));
process.exit(bad === 0 ? 0 : 1);