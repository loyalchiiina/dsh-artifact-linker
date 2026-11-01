// probe-hover.cjs —— 悬停判定的节流间隔与坐标新鲜度探针（0.4.3 / issue #1）
//
// 为什么要有这一套：0.4.2 的 bug 是「150ms 写死 + 坐标在 setTimeout 外面取值」，
// 两者都不会报错、不会抛异常，只在真人鼠标划过时表现为「慢半拍 + 落点不准」。
// 光靠 node --check 一个字都测不出来，所以在 Node 里搭一个最小 DOM 假环境，
// 把 client.js 整个跑起来，直接对 setTimeout 的间隔、以及回调里实际用的坐标
// 做断言。
//
// 跑法：node test/probe-hover.cjs

'use strict';

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8');

const PASS = [];
const FAIL = [];
function check(ok, msg, detail) {
  if (ok) PASS.push(msg);
  else FAIL.push(msg + (detail ? '  << ' + detail : ''));
}
function eq(actual, expected, msg) {
  check(actual === expected, msg, 'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
}

// ── 最小 DOM 假环境 ────────────────────────────────────────────────────────
function makeEnv() {
  const timers = [];
  let timerSeq = 0;

  const created = [];
  function makeEl(tag) {
    const el = {
      tag: tag || 'div',
      style: {},
      children: [],
      attrs: {},
      textContent: '',
      parentNode: null,
      setAttribute: function (k, v) { el.attrs[k] = v; },
      appendChild: function (c) { c.parentNode = el; el.children.push(c); return c; },
      removeChild: function (c) {
        el.children = el.children.filter(function (x) { return x !== c; });
        c.parentNode = null;
        return c;
      },
      contains: function (n) { return el.children.indexOf(n) >= 0; },
    };
    created.push(el);
    return el;
  }

  const body = makeEl('body');

  const listeners = Object.create(null);
  const doc = {
    body: body,
    readyState: 'complete',
    createElement: makeEl,
    addEventListener: function (type, fn, opts) {
      (listeners[type] || (listeners[type] = [])).push({ fn: fn, opts: opts });
    },
    removeEventListener: function (type, fn) {
      if (!listeners[type]) return;
      listeners[type] = listeners[type].filter(function (e) { return e.fn !== fn; });
    },
    querySelectorAll: function () { return []; },
    execCommand: function () { return false; },
    // 由测试控制：谁在鼠标底下
    caretRangeFromPoint: null,
    createRange: function () {
      const r = {
        _n: null, _s: 0, _e: 0,
        setStart: function (n, i) { r._n = n; r._s = i; },
        setEnd: function (n, i) { r._e = i; },
        getBoundingClientRect: function () {
          return { left: 100, top: 200, width: 40, height: 14 };
        },
      };
      return r;
    },
  };

  const fetchCalls = [];
  let resolvePayload = null;   // null = 永远 pending（模拟慢解析）
  const infoPayload = { ok: true, plugin: 'dsh-artifact-linker', version: 'X', bases: [] };
  let def = null;              // __ModuleLoader__.load 收到的插件定义

  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: function (d) { def = d; },
      },
      getComputedStyle: function () { return {}; },
      innerWidth: 1200,
      innerHeight: 800,
    },
    document: doc,
    fetch: function (url) {
      fetchCalls.push(url);
      if (url.indexOf('/info') >= 0) {
        return Promise.resolve({ ok: true, json: function () { return Promise.resolve(JSON.parse(JSON.stringify(infoPayload))); } });
      }
      if (resolvePayload === null) return new Promise(function () { /* 永不 settle */ });
      return Promise.resolve({ ok: true, json: function () { return Promise.resolve(resolvePayload); } });
    },
    setTimeout: function (fn, ms) {
      const id = ++timerSeq;
      timers.push({ id: id, fn: fn, ms: ms });
      return id;
    },
    clearTimeout: function (id) {
      const i = timers.findIndex(function (t) { return t.id === id; });
      if (i >= 0) timers.splice(i, 1);
    },
    encodeURIComponent: encodeURIComponent,
    console: console,
  };

  // client.js 是 `window.__ModuleLoader__.load({...})` 形式的脚本体，
  // 用 new Function 注入假全局跑起来，等于把真实源码原样加载。
  const factory = new Function(
    'window', 'document', 'fetch', 'setTimeout', 'clearTimeout', 'encodeURIComponent', 'console',
    SRC + '\n'
  );
  factory(
    sandbox.window, sandbox.document, sandbox.fetch, sandbox.setTimeout,
    sandbox.clearTimeout, sandbox.encodeURIComponent, console
  );
  if (!def) throw new Error('client.js never called window.__ModuleLoader__.load');
  const exportsObj = def.factory(function () { throw new Error('no require expected'); });

  return {
    doc: doc,
    body: body,
    created: created,
    timers: timers,
    listeners: listeners,
    fetchCalls: fetchCalls,
    exports: exportsObj,
    setResolve: function (v) { resolvePayload = v; },
    setInfo: function (patch) {
      for (const k in patch) infoPayload[k] = patch[k];
    },
    pendingTimers: function () { return timers.length; },
    // 取最近一次排程的延迟
    lastDelay: function () { return timers.length ? timers[timers.length - 1].ms : undefined; },
    fireTimer: function () {
      if (!timers.length) return false;
      const t = timers.shift();
      t.fn();
      return true;
    },
    emit: function (type, ev) {
      const ls = listeners[type] || [];
      for (const e of ls) e.fn(ev);
      return ls.length;
    },
    // 让鼠标停在一段文字上
    pointAt: function (text, offset) {
      const node = { nodeType: 3, nodeValue: text };
      doc.caretRangeFromPoint = function () { return { startContainer: node, startOffset: offset }; };
      return node;
    },
    offText: function () {
      doc.caretRangeFromPoint = function () { return null; };
    },
    hoverBox: function () {
      return created.filter(function (el) {
        return el.attrs && el.attrs['data-dsh-artifact-hover'] === '1';
      })[0] || null;
    },
    cursor: function () { return body.style.cursor; },
  };
}

const TEXT = 'D:\\proj\\out\\result.cas.h5 已生成';
const PROJECT = fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8');

(async function main() {
  // ── 0. 静态断言：写死的 150 必须已经消失 ────────────────────────────────
  check(!/\},\s*150\)/.test(SRC), 'no hard-coded 150ms timer literal remains in client.js');
  check(SRC.indexOf('HOVER_DELAY_DEFAULT_MS = 40') >= 0, 'client.js declares a 40ms default for the hover delay');
  check(!/API_PLACEHOLDER/.test(SRC), 'source loads (no placeholder leakage)');

  const env = makeEnv();
  const ctx = { effect: function (fn) { ctx._disposer = fn; } };
  env.exports.apply(ctx);

  check(env.fetchCalls.some(function (u) { return u.indexOf('/info') >= 0; }), 'apply() asks the host for /info once');

  // ── 1. 默认延迟 = 40ms，且节流期内只排一次 ─────────────────────────────
  env.pointAt(TEXT, 20);
  env.emit('mousemove', { clientX: 110, clientY: 205 });
  eq(env.lastDelay(), 40, 'first mousemove schedules the probe at 40ms (not 150)');

  env.emit('mousemove', { clientX: 115, clientY: 206 });
  env.emit('mousemove', { clientX: 120, clientY: 207 });
  eq(env.pendingTimers(), 1, 'moves inside the throttle window do not queue extra timers');

  // ── 2. 回调用的是「最新」坐标，不是排程那一刻的坐标 ──────────────────────
  // 上面三次移动把坐标更新到 (120,207)；现在让 caretRangeFromPoint 记录收到的参数。
  let askedAt = null;
  const node = { nodeType: 3, nodeValue: TEXT };
  env.doc.caretRangeFromPoint = function (x, y) { askedAt = [x, y]; return { startContainer: node, startOffset: 20 }; };
  env.setResolve({ ok: true, abs: 'D:\\proj\\out\\result.cas.h5' });

  env.fireTimer();
  eq(askedAt && askedAt[0], 120, 'probe reads the latest x captured during throttling');
  eq(askedAt && askedAt[1], 207, 'probe reads the latest y captured during throttling');

  // verify 是异步的，等待 microtask 排空
  await new Promise(function (r) { setImmediate(r); });
  await new Promise(function (r) { setImmediate(r); });

  eq(env.cursor(), 'pointer', 'a resolved hit switches the cursor to pointer');
  const box1 = env.hoverBox();
  check(!!box1, 'hover overlay element was created');
  eq(box1 && box1.style.display, 'block', 'hover overlay is shown for a resolved hit');
  eq(box1 && box1.style.left, '97px', 'overlay is placed at the measured rect (left - 3)');
  eq(box1 && box1.style.top, '199px', 'overlay is placed at the measured rect (top - 1)');

  // ── 3. 鼠标离开后立刻收摊 ──────────────────────────────────────────────
  env.offText();
  env.emit('mousemove', { clientX: 900, clientY: 700 });
  env.fireTimer();
  eq(env.cursor(), '', 'leaving the text resets the cursor');
  eq(env.hoverBox().style.display, 'none', 'leaving the text hides the overlay');

  // ── 4. 异步竞态：verify 回来时鼠标已经移走，不能把高亮画回去 ─────────────
  const env2 = makeEnv();
  env2.exports.apply({ effect: function () {} });
  env2.pointAt(TEXT, 20);
  env2.setResolve({ ok: true, abs: 'D:\\proj\\out\\result.cas.h5' });
  env2.emit('mousemove', { clientX: 110, clientY: 205 });
  env2.fireTimer();                                   // 排程 → 起 verify（pending）
  env2.offText();                                     // 鼠标移走
  env2.emit('mousemove', { clientX: 900, clientY: 700 });
  await new Promise(function (r) { setImmediate(r); });
  await new Promise(function (r) { setImmediate(r); });
  eq(env2.hoverBox(), null, 'a stale async hit does not create an overlay after the pointer left');

  // ── 5. 鼠标停住时，异步命中仍然要画出来 ────────────────────────────────
  const env3 = makeEnv();
  env3.exports.apply({ effect: function () {} });
  env3.pointAt(TEXT, 20);
  env3.setResolve({ ok: true, abs: 'D:\\proj\\out\\result.cas.h5' });
  env3.emit('mousemove', { clientX: 110, clientY: 205 });
  env3.fireTimer();
  await new Promise(function (r) { setImmediate(r); });
  await new Promise(function (r) { setImmediate(r); });
  check(!!env3.hoverBox(), 'a hit that stays under the pointer is painted after verify resolves');
  eq(env3.cursor(), 'pointer', 'pointer cursor accompanies the painted overlay');

  // ── 6. 文件不存在 → 静默，不画高亮、不变光标 ────────────────────────────
  const env4 = makeEnv();
  env4.exports.apply({ effect: function () {} });
  env4.pointAt(TEXT, 20);
  env4.setResolve({ ok: false, abs: null });
  env4.emit('mousemove', { clientX: 110, clientY: 205 });
  env4.fireTimer();
  await new Promise(function (r) { setImmediate(r); });
  await new Promise(function (r) { setImmediate(r); });
  eq(env4.hoverBox(), null, 'a non-existent path paints nothing');
  // setCursor 自带「值没变就不写」的短路，所以“没动过光标”表现为 undefined，
  // 而不是显式的 ""。两者都算「没变手型」。
  check(env4.cursor() === '' || env4.cursor() === undefined, 'a non-existent path leaves the cursor alone', String(env4.cursor()));

  // ── 7. /info 下发的 hoverDelayMs 生效，并且夹在 [0, 1000] ───────────────
  const env5 = makeEnv();
  env5.setInfo({ hoverDelayMs: 0 });
  env5.exports.apply({ effect: function () {} });
  await new Promise(function (r) { setImmediate(r); });
  await new Promise(function (r) { setImmediate(r); });
  env5.offText();
  env5.emit('mousemove', { clientX: 5, clientY: 5 });
  eq(env5.lastDelay(), 0, 'host hoverDelayMs: 0 is honoured (no throttling)');

  const env6 = makeEnv();
  env6.setInfo({ hoverDelayMs: 10000 });
  env6.exports.apply({ effect: function () {} });
  await new Promise(function (r) { setImmediate(r); });
  await new Promise(function (r) { setImmediate(r); });
  env6.offText();
  env6.emit('mousemove', { clientX: 5, clientY: 5 });
  eq(env6.lastDelay(), 1000, 'hoverDelayMs above the ceiling is clamped to 1000');

  const env7 = makeEnv();
  env7.setInfo({ hoverDelayMs: -5 });
  env7.exports.apply({ effect: function () {} });
  await new Promise(function (r) { setImmediate(r); });
  await new Promise(function (r) { setImmediate(r); });
  env7.offText();
  env7.emit('mousemove', { clientX: 5, clientY: 5 });
  eq(env7.lastDelay(), 40, 'a negative hoverDelayMs is ignored, default stays 40');

  const env8 = makeEnv();
  env8.setInfo({ hoverDelayMs: '80' });
  env8.exports.apply({ effect: function () {} });
  await new Promise(function (r) { setImmediate(r); });
  await new Promise(function (r) { setImmediate(r); });
  env8.offText();
  env8.emit('mousemove', { clientX: 5, clientY: 5 });
  eq(env8.lastDelay(), 40, 'a non-numeric hoverDelayMs is ignored, default stays 40');

  // ── 8. dispose 清掉在途 timer，卸载后不再判定 ──────────────────────────
  const env9 = makeEnv();
  env9.exports.apply({ effect: function () {} });
  env9.pointAt(TEXT, 20);
  env9.emit('mousemove', { clientX: 110, clientY: 205 });
  eq(env9.pendingTimers(), 1, 'timer armed before dispose');
  env9.exports.dispose();
  eq(env9.pendingTimers(), 0, 'dispose() clears the pending hover timer');
  eq((env9.listeners['mousemove'] || []).length, 0, 'dispose() removes the mousemove listener');

  // ── 9. 版本号自洽（避免只改 CHANGELOG 忘了 VERSION） ────────────────────
  eq(env.exports.version, '0.4.3', 'client VERSION matches the release being built');
  check(/"version":\s*"0\.4\.3"/.test(PROJECT), 'package.json version matches VERSION');

  // ── 汇总 ───────────────────────────────────────────────────────────────
  for (const m of PASS) console.log('  PASS  ' + m);
  for (const m of FAIL) console.log('  FAIL  ' + m);
  console.log('');
  console.log('  pass: ' + PASS.length);
  console.log('  fail: ' + FAIL.length);
  console.log('');
  console.log(FAIL.length === 0 ? 'ALL GREEN' : 'HAS FAILURES');
  process.exit(FAIL.length === 0 ? 0 : 1);
})().catch(function (e) {
  console.error('probe crashed:', e && e.stack || e);
  process.exit(2);
});
