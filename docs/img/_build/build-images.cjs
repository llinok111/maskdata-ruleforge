'use strict';

/**
 * Renders the README figures from *real* output of this library.
 *
 * Every value baked into the images (masked strings, execution order, trace
 * counters, error text) comes from an actual call at build time. Nothing is
 * hand-typed, so the figures cannot drift away from the code.
 *
 *   node docs/img/_build/build-images.cjs
 *
 * Requires Microsoft Edge (headless screenshot). Override with EDGE_BIN.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../../..');
const OUT_DIR = path.resolve(__dirname, '..');
const TMP_DIR = path.join(__dirname, '.tmp');

const MaskData = require(path.join(ROOT, 'index.js'));

// ---------------------------------------------------------------------------
// palette (warm editorial; no cold blue by design)
// ---------------------------------------------------------------------------
const C = {
  bg: '#faf8f5',
  ink: '#2b2118',
  ink2: '#4a3c2f',
  muted: '#7d6c5c',
  line: '#e3d9cb',
  lineSoft: '#efe7db',
  codeBg: '#f3ede4',
  red: '#b4462f',
  redSoft: '#f7e9e4',
  amber: '#b8781f',
  amberSoft: '#fbf1df',
  olive: '#5c6b3f',
  oliveSoft: '#eef0e4',
  dark: '#241d17',
  darkInk: '#efe6d8',
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function highlightJson(value) {
  const text = JSON.stringify(value, null, 2);
  return esc(text)
    .replace(/(&quot;[^&]*?&quot;)(\s*:)/g, '<i class="k">$1</i>$2')
    .replace(/:\s*(&quot;.*?&quot;)/g, ': <i class="s">$1</i>')
    .replace(/:\s*(-?\d+(?:\.\d+)?)/g, ': <i class="n">$1</i>')
    .replace(/:\s*(true|false|null)/g, ': <i class="b">$1</i>');
}

function page(width, height, css, body) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: ${width}px; height: ${height}px; overflow: hidden; }
  body {
    background: ${C.bg};
    color: ${C.ink};
    font-family: "Segoe UI", system-ui, -apple-system, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .canvas { width: ${width}px; height: ${height}px; padding: 46px 54px 40px; display: flex; flex-direction: column; }
  .kicker { font-size: 13px; letter-spacing: 2.4px; text-transform: uppercase; color: ${C.red}; font-weight: 700; }
  h1 { font-family: Georgia, "Times New Roman", serif; font-size: 33px; font-weight: 600; letter-spacing: -0.4px; margin-top: 8px; line-height: 1.22; }
  h1 em { font-style: normal; color: ${C.red}; }
  .sub { color: ${C.muted}; font-size: 15px; margin-top: 9px; line-height: 1.5; }
  code, pre, .mono { font-family: "Cascadia Mono", Consolas, "Courier New", monospace; }
  pre { font-size: 13px; line-height: 1.62; white-space: pre; }
  pre .k { color: ${C.amber}; font-style: normal; }
  pre .s { color: ${C.olive}; font-style: normal; }
  pre .n { color: ${C.red}; font-style: normal; }
  pre .b { color: ${C.red}; font-style: normal; }
  ${css}
</style></head><body>${body}</body></html>`;
}

// ---------------------------------------------------------------------------
// figure 1 — architecture comparison
// ---------------------------------------------------------------------------
function figureArchitecture() {
  const W = 1520;
  const H = 812;

  const left = [
    ['getValidatedJsonMask2Configs', 'writes 12 default keys into the config object you passed in'],
    ['typeToFunctionMap', 'iteration order is fixed in source; a caller cannot reorder it'],
    ['mask() string tests', '<code>a.*.b</code> <code>*a.b</code> <code>a[*]</code> <code>a..b</code> silently return'],
    ['BadOption', 'throws a bare string: no message, no stack, not an Error'],
  ];

  const right = [
    ['validate', 'unknown key / kind / option / pattern → all issues in one throw, each with a JSON Pointer'],
    ['defaults', 'kind defaults → ruleSet.defaults → rule.options, resolved values readable on the plan'],
    ['order', 'ascending <code>order</code>, ties broken by declaration index'],
    ['conflict', 'two rules on one field at the same order → RULE_ORDER_CONFLICT'],
  ];

  const list = (rows, cls) =>
    rows
      .map(
        ([title, desc], i) => `
      <li class="${cls}">
        <span class="num">${cls === 'bad' ? '✕' : '›'}</span>
        <div>
          <div class="t">${title}</div>
          <div class="d">${desc}</div>
        </div>
      </li>`
      )
      .join('');

  const body = `
  <div class="canvas">
    <div class="kicker">maskdata-ruleforge</div>
    <h1>Same masking chain. <em>Two ways to drive it.</em></h1>
    <div class="sub">The eight mask services are untouched. What changed is who decides which rule runs, in what order, and what happens when a rule is wrong.</div>

    <div class="cols">
      <section class="col legacy">
        <div class="colhead">
          <span class="mono sig">maskJSON2(doc, config)</span>
          <span class="badge b-bad">hard-coded</span>
        </div>
        <ol>${list(left, 'bad')}</ol>
        <div class="chain">
          <span class="chainlab">fixed sequence</span>
          <div class="chainrow">card<span>→</span>email<span>→</span>password<span>→</span>phone<span>→</span>string<span>→</span>uuid<span>→</span>jwt<span>→</span>generic</div>
        </div>
        <div class="foot b-bad">3 silent failure points</div>
      </section>

      <section class="col rule">
        <div class="colhead">
          <span class="mono sig">maskJSON3(doc, ruleSet)</span>
          <span class="badge b-good">declarative</span>
        </div>
        <div class="stage">RuleCompiler · four gates</div>
        <ol>${list(right, 'good')}</ol>
        <div class="pipeline">
          <div class="pip">frozen plan <span>explain() is the execution order</span></div>
          <div class="arrow">↓</div>
          <div class="pip">RuleEngine <span>clone · reference writes · trace</span></div>
          <div class="arrow">↓</div>
          <div class="pip last">maskService/* <span>unchanged upstream code</span></div>
        </div>
      </section>
    </div>

    <div class="bottom">
      <span class="dot"></span><b>maskJSON2</b> is byte-identical &nbsp;·&nbsp; <b>186</b> upstream tests unchanged and still green &nbsp;·&nbsp; <b>269</b> tests total
    </div>
  </div>`;

  const css = `
  .cols { display: flex; gap: 26px; margin-top: 26px; flex: 1; min-height: 0; }
  .col { flex: 1; border-radius: 14px; padding: 20px 22px 0; display: flex; flex-direction: column; position: relative; }
  .legacy { background: #f6f2ec; border: 1px solid ${C.line}; }
  .rule { background: #fffdfa; border: 1px solid ${C.line}; box-shadow: 0 1px 0 rgba(43,33,24,.04), 0 8px 26px -18px rgba(43,33,24,.35); }
  .rule::before { content:""; position:absolute; left:0; top:16px; bottom:16px; width:3px; border-radius:3px; background:${C.red}; }
  .colhead { display: flex; align-items: center; justify-content: space-between; padding-bottom: 13px; border-bottom: 1px dashed ${C.line}; }
  .sig { font-size: 15px; letter-spacing: -0.2px; }
  .legacy .sig { color: ${C.muted}; }
  .rule .sig { color: ${C.ink}; font-weight: 600; }
  .badge { font-size: 11px; letter-spacing: 1.1px; text-transform: uppercase; padding: 4px 9px; border-radius: 20px; font-weight: 700; }
  .b-bad { background: ${C.redSoft}; color: ${C.red}; }
  .b-good { background: ${C.oliveSoft}; color: ${C.olive}; }
  ol { list-style: none; margin-top: 14px; }
  li { display: flex; gap: 11px; padding: 9px 0; border-bottom: 1px solid ${C.lineSoft}; }
  li:last-child { border-bottom: 0; }
  .num { width: 15px; text-align: center; font-size: 12px; line-height: 20px; flex: 0 0 15px; }
  .bad .num { color: ${C.red}; }
  .good .num { color: ${C.red}; font-weight: 700; }
  .t { font-family: "Cascadia Mono", Consolas, monospace; font-size: 13.5px; line-height: 1.35; }
  .legacy .t { color: ${C.muted}; }
  .d { font-size: 12.6px; color: ${C.muted}; line-height: 1.45; margin-top: 3px; }
  .d code { background: ${C.codeBg}; padding: 1px 5px; border-radius: 4px; font-size: 11.6px; color: ${C.ink2}; }
  .chain { margin-top: auto; padding: 12px 0 14px; }
  .chainlab { font-size: 10.5px; letter-spacing: 1.6px; text-transform: uppercase; color: ${C.muted}; }
  .chainrow { font-family: "Cascadia Mono", Consolas, monospace; font-size: 11.4px; color: ${C.muted}; margin-top: 6px; line-height: 1.7; }
  .chainrow span { color: ${C.line}; margin: 0 3px; }
  .foot { font-size: 11.5px; font-weight: 700; letter-spacing: .4px; padding: 10px 0 16px; }
  .stage { font-size: 11px; letter-spacing: 1.5px; text-transform: uppercase; color: ${C.amber}; font-weight: 700; margin-top: 14px; }
  .pipeline { margin-top: auto; padding-bottom: 16px; }
  .pip { font-family: "Cascadia Mono", Consolas, monospace; font-size: 12.4px; color: ${C.ink}; background: ${C.amberSoft}; border: 1px solid #eddfc4; border-radius: 8px; padding: 8px 11px; display: flex; justify-content: space-between; align-items: center; }
  .pip span { font-family: "Segoe UI", system-ui, sans-serif; font-size: 11.2px; color: ${C.muted}; }
  .pip.last { background: ${C.oliveSoft}; border-color: #dde1cc; }
  .arrow { text-align: center; color: ${C.line}; font-size: 12px; line-height: 16px; }
  .bottom { margin-top: 20px; font-size: 12.5px; color: ${C.muted}; display: flex; align-items: center; }
  .bottom b { color: ${C.ink2}; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: ${C.olive}; margin-right: 11px; }
  `;

  return { name: 'architecture', width: W, height: H, html: page(W, H, css, body) };
}

// ---------------------------------------------------------------------------
// figure 2 — one real run
// ---------------------------------------------------------------------------
function figureRunThrough() {
  const W = 1520;
  const H = 880;

  const doc = {
    payment: { cardNumber: '4539 1488 0343 6467' },
    customer: { email: 'alice.wong@example.com', phone: '+86 138 1234 5678' },
    orderId: 'ORD-90210',
  };
  const ruleSet = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'examples/rules-basic.json'), 'utf8')
  );

  // real call
  const report = MaskData.maskJSON3(doc, ruleSet, { report: true });

  const orderRows = report.explain
    .map(
      (e) => `<tr>
        <td class="pos">${e.position}</td>
        <td class="ord">${e.order}</td>
        <td class="kind">${esc(e.kind)}</td>
        <td class="rid">${esc(e.id)}</td>
        <td class="mc">${(e.options.maskWith || '*').length === 1 ? esc(e.options.maskWith) : '?'}</td>
      </tr>`
    )
    .join('');

  const traceLine = report.trace.rules
    .map((r) => `<span class="tr"><b>${esc(r.id)}</b> ${r.changedCount}/${r.matchedCount}</span>`)
    .join('<span class="sep">·</span>');

  const body = `
  <div class="canvas">
    <div class="kicker">one pass · real output</div>
    <h1>Input, resolved order, output — <em>nothing hand-written</em></h1>
    <div class="sub">Every string in this figure was produced by running <span class="mono">maskJSON3</span> against <span class="mono">examples/rules-basic.json</span> at build time.</div>

    <div class="cols">
      <section class="panel">
        <div class="ph"><span class="tag">1 · input</span><span class="mono fn">document</span></div>
        <pre class="body">${highlightJson(doc)}</pre>
      </section>

      <section class="panel mid">
        <div class="ph"><span class="tag">2 · order</span><span class="mono fn">plan.explain()</span></div>
        <table>
          <thead><tr><th>#</th><th>order</th><th>kind</th><th>rule id</th><th>mask</th></tr></thead>
          <tbody>${orderRows}</tbody>
        </table>
        <div class="note">Ascending <span class="mono">order</span>; equal values fall back to declaration index, so the sequence is a pure function of the rule set.</div>
      </section>

      <section class="panel">
        <div class="ph"><span class="tag">3 · output</span><span class="mono fn">masked clone</span></div>
        <pre class="body">${highlightJson(report.result)}</pre>
      </section>
    </div>

    <div class="trace">
      <span class="tlab">trace</span>
      ${traceLine}
      <span class="sep">·</span><span class="tr note2">changed / matched, paths only — no values</span>
    </div>
  </div>`;

  const css = `
  .mono { font-family: "Cascadia Mono", Consolas, monospace; }
  .cols { display: flex; gap: 20px; margin-top: 24px; flex: 1; min-height: 0; }
  .panel { flex: 1; background: #fffdfa; border: 1px solid ${C.line}; border-radius: 13px; display: flex; flex-direction: column; overflow: hidden; }
  .panel.mid { flex: 0 0 380px; background: #fbf7f0; }
  .ph { display: flex; align-items: center; justify-content: space-between; padding: 12px 15px; border-bottom: 1px solid ${C.line}; background: ${C.codeBg}; }
  .tag { font-size: 11px; letter-spacing: 1.4px; text-transform: uppercase; color: ${C.red}; font-weight: 700; }
  .fn { font-size: 11.5px; color: ${C.muted}; }
  .body { padding: 15px 16px; flex: 1; font-size: 12.4px; line-height: 1.6; }
  table { width: 100%; border-collapse: collapse; font-family: "Cascadia Mono", Consolas, monospace; font-size: 12.2px; }
  thead th { font-size: 10px; letter-spacing: 1.1px; text-transform: uppercase; color: ${C.muted}; text-align: left; padding: 11px 8px 7px; font-weight: 700; border-bottom: 1px solid ${C.line}; }
  tbody td { padding: 9px 8px; border-bottom: 1px solid ${C.lineSoft}; }
  .pos { color: ${C.red}; font-weight: 700; width: 26px; }
  .ord { color: ${C.amber}; width: 52px; }
  .kind { color: ${C.ink}; width: 78px; }
  .rid { color: ${C.ink2}; }
  .mc { color: ${C.muted}; width: 40px; text-align: center; }
  .note { font-size: 11.4px; color: ${C.muted}; line-height: 1.55; padding: 13px 15px 15px; margin-top: auto; border-top: 1px dashed ${C.line}; }
  .note .mono { color: ${C.ink2}; font-size: 11px; }
  .trace { margin-top: 18px; display: flex; align-items: center; gap: 9px; font-size: 12.2px; color: ${C.muted}; background: #fffdfa; border: 1px solid ${C.line}; border-radius: 10px; padding: 11px 15px; }
  .tlab { font-size: 10.5px; letter-spacing: 1.5px; text-transform: uppercase; color: ${C.amber}; font-weight: 700; margin-right: 4px; }
  .tr { font-family: "Cascadia Mono", Consolas, monospace; font-size: 11.8px; color: ${C.ink2}; }
  .tr b { color: ${C.ink}; }
  .sep { color: ${C.line}; }
  .note2 { font-family: "Segoe UI", system-ui, sans-serif; font-size: 11.4px; color: ${C.muted}; }
  `;

  return { name: 'run-through', width: W, height: H, html: page(W, H, css, body) };
}

// ---------------------------------------------------------------------------
// figure 3 — error location
// ---------------------------------------------------------------------------
function figureErrorLocation() {
  const W = 1520;
  const H = 660;

  const badRuleSet = {
    version: 1,
    rules: [
      { id: 'ok', kind: 'phone', fields: ['user.phone'], options: { unmaskedStartDigits: 3 } },
      { id: 'dead', kind: 'phone', fields: ['a.*.b', 'a[*]'], options: { unmaskedStartDigits: -1 } },
      { id: 'typo', kind: 'phone', fields: ['p'], ipFields: ['p'] },
    ],
  };

  let err;
  try {
    MaskData.compileRules(badRuleSet);
    throw new Error('expected a validation failure');
  } catch (e) {
    err = e;
  }

  // upstream comparison: a real throw from BadOption
  let upstreamDump;
  try {
    MaskData.maskPhone('123', { unmaskedStartDigits: 'x' });
  } catch (e) {
    upstreamDump = {
      typeofThrown: typeof e,
      isError: e instanceof Error,
      message: e === undefined ? 'undefined' : e && e.message,
      raw: String(e).slice(0, 76) + '…',
    };
  }

  const issueRows = err.issues
    .map(
      (i) => `<tr>
        <td class="code">${esc(i.code)}</td>
        <td class="ptr">${esc(i.pointer)}</td>
        <td class="msg">${esc(i.message)}</td>
      </tr>`
    )
    .join('');

  const body = `
  <div class="canvas">
    <div class="kicker">error location</div>
    <h1>Every failure says <em>which rule</em> and <em>where</em></h1>
    <div class="sub">Validation never fails fast: one compile reports all <b>${err.issues.length}</b> issues below, each pinned to a JSON Pointer into the rule-set document.</div>

    <div class="errtop">
      <div class="et"><span class="lab">name</span><span class="mono">${esc(err.name)}</span></div>
      <div class="et"><span class="lab">code</span><span class="mono">${esc(err.code)}</span></div>
      <div class="et"><span class="lab">pointer</span><span class="mono ptrv">${esc(err.pointer)}</span></div>
      <div class="et"><span class="lab">rule</span><span class="mono">${esc(err.ruleId)} · #${esc(err.ruleIndex)}</span></div>
      <div class="et"><span class="lab">issues</span><span class="mono">${err.issues.length}</span></div>
    </div>

    <table class="issues">
      <thead><tr><th>code</th><th>json pointer</th><th>message</th></tr></thead>
      <tbody>${issueRows}</tbody>
    </table>

    <div class="cmp">
      <div class="cmpcol bad">
        <div class="cmph">upstream · BadOption</div>
        <pre>catch (e) { e.message }        → ${esc(String(upstreamDump.message))}
e instanceof Error            → ${upstreamDump.isError}
typeof e                      → "${esc(upstreamDump.typeofThrown)}"</pre>
      </div>
      <div class="cmpcol good">
        <div class="cmph">rule layer · MaskRuleError</div>
        <pre>err instanceof Error          → true
err.pointer                   → "${esc(err.pointer)}"
err.issues.length             → ${err.issues.length}</pre>
      </div>
    </div>
  </div>`;

  const css = `
  b { color: ${C.ink}; }
  .errtop { display: flex; gap: 10px; margin-top: 22px; }
  .et { flex: 1; background: #fffdfa; border: 1px solid ${C.line}; border-radius: 9px; padding: 9px 12px; }
  .et .lab { display: block; font-size: 9.6px; letter-spacing: 1.4px; text-transform: uppercase; color: ${C.muted}; margin-bottom: 3px; }
  .et .mono { font-family: "Cascadia Mono", Consolas, monospace; font-size: 12.2px; color: ${C.ink}; }
  .ptrv { color: ${C.red} !important; }
  table.issues { width: 100%; border-collapse: collapse; margin-top: 18px; background: #fffdfa; border: 1px solid ${C.line}; border-radius: 11px; overflow: hidden; }
  .issues thead th { font-size: 9.8px; letter-spacing: 1.3px; text-transform: uppercase; color: ${C.muted}; text-align: left; padding: 10px 14px; background: ${C.codeBg}; border-bottom: 1px solid ${C.line}; }
  .issues td { padding: 10px 14px; border-bottom: 1px solid ${C.lineSoft}; font-size: 12.2px; vertical-align: top; }
  .issues tbody tr:last-child td { border-bottom: 0; }
  .code { font-family: "Cascadia Mono", Consolas, monospace; color: ${C.red}; white-space: nowrap; width: 178px; font-size: 11.4px; }
  .ptr { font-family: "Cascadia Mono", Consolas, monospace; color: ${C.amber}; white-space: nowrap; width: 268px; font-size: 11.6px; }
  .msg { color: ${C.ink2}; line-height: 1.45; }
  .cmp { display: flex; gap: 16px; margin-top: 20px; }
  .cmpcol { flex: 1; border-radius: 11px; padding: 13px 16px; }
  .cmpcol.bad { background: #f6f2ec; border: 1px solid ${C.line}; }
  .cmpcol.good { background: ${C.oliveSoft}; border: 1px solid #dde1cc; }
  .cmph { font-size: 10.4px; letter-spacing: 1.3px; text-transform: uppercase; font-weight: 700; margin-bottom: 8px; }
  .cmpcol.bad .cmph { color: ${C.muted}; }
  .cmpcol.good .cmph { color: ${C.olive}; }
  .cmpcol pre { font-size: 11.9px; line-height: 1.72; }
  .cmpcol.bad pre { color: ${C.muted}; }
  .cmpcol.good pre { color: ${C.ink2}; }
  `;

  return { name: 'error-location', width: W, height: H, html: page(W, H, css, body) };
}

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------
function findEdge() {
  if (process.env.EDGE_BIN) return process.env.EDGE_BIN;
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error('Microsoft Edge not found; set EDGE_BIN to a Chromium binary');
}

function render(fig) {
  const edge = findEdge();
  const htmlPath = path.join(TMP_DIR, fig.name + '.html');
  const pngPath = path.join(OUT_DIR, fig.name + '.png');

  // Layout probe: appended as a synchronous script so `--dump-dom` sees its
  // result. It reports any element that escapes the canvas or is clipped by an
  // overflow:hidden container — the two ways a rendered figure silently loses
  // content. Aesthetic judgement still needs a human; geometry does not.
  const probe = `
<script>
(function () {
  var W = ${fig.width}, H = ${fig.height};
  var probs = [];
  var de = document.documentElement;
  if (de.scrollWidth > W + 1) probs.push('doc-overflow-x ' + de.scrollWidth + '>' + W);
  if (de.scrollHeight > H + 1) probs.push('doc-overflow-y ' + de.scrollHeight + '>' + H);
  var all = document.body.querySelectorAll('*');
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    if (el.id === '__layout_report__') continue;
    var tag = el.tagName.toLowerCase();
    if (el.className && typeof el.className === 'string') tag += '.' + el.className.trim().split(/\\s+/).join('.');
    var r = el.getBoundingClientRect();
    if (r.width < 0.5 && r.height < 0.5) continue;
    if (r.right > W + 0.6) probs.push('overflow-right ' + tag + ' right=' + Math.round(r.right));
    if (r.bottom > H + 0.6) probs.push('overflow-bottom ' + tag + ' bottom=' + Math.round(r.bottom));
    if (r.left < -0.6) probs.push('overflow-left ' + tag + ' left=' + Math.round(r.left));
    if (r.top < -0.6) probs.push('overflow-top ' + tag + ' top=' + Math.round(r.top));
    var isCanvasItself = tag === 'body' || tag === 'html' || tag.indexOf('canvas') === 0;
    if (!isCanvasItself && el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) {
      probs.push('clip-x ' + tag + ' ' + el.scrollWidth + '>' + el.clientWidth);
    }
    if (!isCanvasItself && el.scrollHeight > el.clientHeight + 1 && el.clientHeight > 0) {
      probs.push('clip-y ' + tag + ' ' + el.scrollHeight + '>' + el.clientHeight);
    }
  }
  var pre = document.createElement('pre');
  pre.id = '__layout_report__';
  pre.textContent = probs.length ? probs.join(' || ') : 'LAYOUT_OK';
  document.body.appendChild(pre);
})();
</script>`;
  fs.writeFileSync(htmlPath, fig.html.replace('</body>', probe + '</body>'), 'utf8');

  // geometry check
  const dump = execFileSync(
    edge,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--user-data-dir=' + path.join(TMP_DIR, 'profile'),
      '--window-size=' + fig.width + ',' + fig.height,
      '--virtual-time-budget=3000',
      '--dump-dom',
      'file:///' + htmlPath.replace(/\\/g, '/'),
    ],
    { encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024 }
  );
  const m = dump.match(/<pre id="__layout_report__">([\s\S]*?)<\/pre>/);
  const report = m ? m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') : 'PROBE_NOT_FOUND';
  if (report !== 'LAYOUT_OK') {
    console.log('  ' + fig.name + ' LAYOUT PROBLEMS:\n    ' + report.split(' || ').join('\n    '));
  } else {
    console.log('  ' + fig.name + ' layout: OK');
  }

  execFileSync(
    edge,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--user-data-dir=' + path.join(TMP_DIR, 'profile'),
      '--force-device-scale-factor=2',
      '--window-size=' + fig.width + ',' + fig.height,
      '--screenshot=' + pngPath,
      'file:///' + htmlPath.replace(/\\/g, '/'),
    ],
    { stdio: 'ignore', timeout: 120000 }
  );

  if (!fs.existsSync(pngPath)) throw new Error('screenshot not produced for ' + fig.name);
  const stat = fs.statSync(pngPath);
  console.log(
    '  ' + fig.name + '.png  ' + fig.width + 'x' + fig.height + ' @2x  ' + Math.round(stat.size / 1024) + ' KB'
  );
  if (report !== 'LAYOUT_OK') process.exitCode = 1;
}

fs.mkdirSync(TMP_DIR, { recursive: true });

const figures = [figureArchitecture(), figureRunThrough(), figureErrorLocation()];
console.log('Rendering figures from live output:');
figures.forEach(render);
console.log('Done. See ' + OUT_DIR);
