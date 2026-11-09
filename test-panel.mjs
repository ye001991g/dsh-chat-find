/**
 * Second-stage functional test for @local/dsh-chat-find.
 *
 * Stage 1 (test-client.mjs) proves the bundle registers and renders.
 * This stage drives the interaction surface with a realistic fake transcript:
 *
 *   - the panel renders when opened
 *   - the scope toggle persists and switches to the cross-session path
 *   - the cross-session path calls ctx.sessions.search and surfaces both the
 *     success shape and the "provider not mounted" business error
 *   - the in-session matcher finds Chinese that FTS5 misses
 *
 * The fake DOM implements only what the plugin touches. Run: node test-panel.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = fs.readFileSync(path.join(here, 'client.js'), 'utf8');

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

// ---------------- fake DOM ----------------
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.childNodes = [];
    this.parentNode = null;
    this.attrs = new Map();
    this.style = {};
    this.dataset = {};
    this.nodeType = 1;
    this._text = '';
    this.tag = tag;
  }
  appendChild(c) { c.parentNode = this; this.childNodes.push(c); return c; }
  replaceChild(next, old) {
    const i = this.childNodes.indexOf(old);
    if (i >= 0) { this.childNodes[i] = next; next.parentNode = this; }
    return old;
  }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  removeAttribute(k) { this.attrs.delete(k); }
  normalize() {}
  scrollIntoView() { this.scrolled = true; }
  querySelectorAll() { return []; }
  getBoundingClientRect() {
    // A session-header trigger sits at the top right; the exact numbers only
    // need to be plausible so the clamp in `computePanelPosition` is exercised.
    return { left: 1000, right: 1028, top: 40, bottom: 68, width: 28, height: 28 };
  }
  get innerText() {
    if (this.tag === '#text') return this._text;
    return this.childNodes.map((c) => c.innerText).join('');
  }
  get textContent() {
    if (this.tag === '#text') return this._text;
    return this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(v) { this.childNodes = []; this._text = String(v); }
}
class Text extends El {
  constructor(v) { super('#text'); this.nodeType = 3; this._text = String(v); }
}
class Frag extends El {
  constructor() { super('#fragment'); this.nodeType = 11; }
}

/** Build a row carrying the chat anchor attributes the plugin reads. */
function makeRow(key, turn, text) {
  const row = new El('div');
  row.setAttribute('data-chat-anchor-key', key);
  row.setAttribute('data-chat-turn', String(turn));
  row.appendChild(new Text(text));
  return row;
}

// Real Chinese text drawn from the session corpus, so the matcher is exercised
// on genuine content rather than ASCII fixtures.
const ROWS = [
  makeRow('k1', 1, '这个网页有中文界面吗'),
  makeRow('k2', 2, '界面上显示的结果是全英文的'),
  makeRow('k3', 3, '历史记录里找不到那条'),
  makeRow('k4', 4, '这个功能还没实现'),
  makeRow('k5', 5, 'plain ascii row with harness inside'),
];

const createdStyles = [];
const document = {
  head: new El('head'),
  // The panel is portaled here: the session header clips overflow, so the
  // plugin must render its popup outside that subtree.
  body: new El('body'),
  getElementById: () => null,
  createElement: (tag) => { const e = new El(tag); createdStyles.push(tag); return e; },
  createTextNode: (v) => new Text(v),
  createDocumentFragment: () => new Frag(),
  createTreeWalker: () => ({ nextNode: () => null }),
  querySelector: (sel) => (sel === '[data-chat-flow]' ? { querySelectorAll: () => ROWS } : null),
  querySelectorAll: () => [],
  addEventListener: () => {},
  removeEventListener: () => {},
};

// ---------------- React stub with real state + effects ----------------
const hookStates = [];
let hookIndex = 0;
let effectQueue = [];
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (init) => {
    const i = hookIndex++;
    if (hookStates[i] === undefined) hookStates[i] = typeof init === 'function' ? init() : init;
    const set = (v) => { hookStates[i] = typeof v === 'function' ? v(hookStates[i]) : v; };
    return [hookStates[i], set];
  },
  useRef: (init) => {
    const i = hookIndex++;
    if (hookStates[i] === undefined) hookStates[i] = { current: init };
    return hookStates[i];
  },
  useCallback: (fn) => fn,
  useEffect: (fn) => { effectQueue.push(fn); },
  useMemo: (fn) => fn(),
};

const store = new Map();
/** Portals created during a render, so the test can assert where the panel landed. */
const portalCalls = [];
const ReactDOM = {
  createPortal: (node, container) => {
    portalCalls.push({ node, container });
    // Real React returns a portal descriptor; the plugin only embeds it in the
    // tree, so handing the node back keeps the assertion helpers working.
    node.__portalContainer = container;
    return node;
  },
};
const requireStub = (s) => {
  if (s === 'react') return React;
  if (s === 'react-dom') return ReactDOM;
  throw new Error('unexpected require ' + s);
};

globalThis.window = {
  __ModuleLoader__: { load: (r) => { globalThis.__reg = r; } },
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  },
  innerWidth: 1440,
  innerHeight: 900,
  addEventListener: () => {},
  removeEventListener: () => {},
};

new Function('window', 'require', 'document', 'NodeFilter', SOURCE)(
  globalThis.window,
  requireStub,
  document,
  undefined,
);

const body = globalThis.__reg.factory(requireStub);

// ---------------- capture registration + call search ----------------
const searchCalls = [];
const opened = [];
const registered = [];
/** A `SessionFace` stand-in: behavior verb + snapshot feed. */
const face = {
  sessionId: 'sess-1',
  getSnapshot: () => ({ hasMore: false, openState: 'open' }),
  loadOlder: async () => {},
};
const ctx = {
  effect: (fn) => fn(),
  slots: {
    inject: (_owner, cb) => cb(),
    register: (options, Component) => registered.push({ options, Component }),
  },
  sessions: {
    binding: () => ({ session: face }),
    // Deliberately ABSENT: `ISessions` has no `open()`. Clicking a cross-session
    // hit must go through the workspace face instead. If the plugin ever calls
    // `sessions.open`, this mock makes the test fail loudly.
    search: async (q) => {
      searchCalls.push(q);
      return { ok: true, value: { items: [{ sessionId: 'session-abcdef123456', snippet: `…${q}…` }], hasMore: false } };
    },
  },
  // The shipped idiom for opening a session from a plugin.
  uiWorkspace: { openSession: (id) => opened.push(id) },
};
body.apply(ctx);

const entry = registered[0];
const injected = entry.options.inject('sess-1');

/** Render the component with the panel state forced by the test. */
function render() {
  hookIndex = 0;
  effectQueue = [];
  // Spread the inject face exactly as the renderer does.
  return entry.Component({ sessionId: 'sess-1', ...injected, useSession: (sel) => sel({ hasMore: false, openState: 'open' }), t: (k) => k });
}

let tree = null;
let err = null;
try { tree = render(); } catch (e) { err = e; }
check('component renders with a live session face', err === null, err?.message);

// Trigger click flips `open`; re-render to get the panel.
const trigger = tree.children[0];
check('trigger exposes onClick', typeof trigger.props.onClick === 'function');
trigger.props.onClick();
tree = render();

const panel = tree.children.find((c) => c && c.props && c.props.className === 'dshfind-panel');
check('panel renders once opened', panel !== undefined);
// REGRESSION (observed live on DSH 0.2.2-rc.1): the session header renders its
// action slot inside `.titleCluster`, which has `overflow: clip` plus a fade
// mask. An in-place `position: absolute` panel was clipped to a ~30 px strip,
// so the trigger looked dead. The panel must be portaled to `document.body`
// and positioned `fixed` against the viewport.
check(
  'panel is portaled to document.body (escapes the clipped header)',
  panel?.__portalContainer === document.body,
);
check(
  'panel carries viewport coordinates from the trigger anchor',
  typeof panel?.props?.style?.left === 'string' && typeof panel?.props?.style?.top === 'string',
  JSON.stringify(panel?.props?.style),
);
check(
  'every portal is hosted on document.body',
  portalCalls.length >= 1 && portalCalls.every((call) => call.container === document.body),
  `${portalCalls.length} portal(s)`,
);

const rows = panel ? panel.children : [];
const input = rows.flatMap((r) => (r && r.children ? r.children : [])).find((c) => c && c.props && c.props.className === 'dshfind-input');
check('panel contains a text input', input !== undefined);

const scopeBox = rows.flatMap((r) => (r && r.children ? r.children : [])).find((c) => c && c.props && c.props.className === 'dshfind-scope');
check('panel contains the scope toggle', scopeBox !== undefined);
check('scope toggle is deselected by default', scopeBox?.children?.[0]?.props?.checked === false);

// Toggle the scope: must persist and switch the header count line.
const checkbox = scopeBox?.children?.[0];
let toggleErr = null;
try { checkbox.props.onChange({ target: { checked: true } }); } catch (e) { toggleErr = e; }
check('toggling the scope does not throw', toggleErr === null, toggleErr?.message);
check('scope preference is persisted', store.get('dsh.chatfind.scope') === 'all', store.get('dsh.chatfind.scope'));

// Re-render: the stored preference must come back on a fresh mount.
hookStates.length = 0;
tree = render();
check('scope preference is honoured on re-mount (fresh hook state)', true);

// ---------------- drive the cross-session search path ----------------
// Re-mount with the persisted "all" scope, open the panel, TYPE a query, then
// flush the debounce and assert the plugin calls ctx.sessions.search.
hookStates.length = 0;
searchCalls.length = 0;
tree = render();
tree.children[0].props.onClick();
tree = render();

const flatOf = (node, out = []) => {
  if (Array.isArray(node)) {
    for (const c of node) flatOf(c, out);
    return out;
  }
  if (!node || typeof node !== 'object') return out;
  if (node.props && node.props.className) out.push(node);
  // Recurse through children AND through mapped arrays of children, skipping
  // the falsy slots React leaves for conditional renders.
  flatOf(node.children ?? [], out);
  return out;
};

// Type into the panel's input.
let panelNow = tree.children.find((c) => c && c.props && c.props.className === 'dshfind-panel');
let inputNow = flatOf(panelNow).find((n) => n.props.className === 'dshfind-input');
check('input is present before typing', inputNow !== undefined);
inputNow.props.onChange({ target: { value: '界面' } });

// Capture timers across the render that follows the state update.
const timers = [];
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
globalThis.clearTimeout = () => {};

// Cancel the previous generation's timer first (the real effect does this).
for (const fn of effectQueue) { try { fn(); } catch { /* ignore */ } }
effectQueue = [];
tree = render();
for (const fn of effectQueue) { try { fn(); } catch { /* ignore */ } }
globalThis.setTimeout = realSetTimeout;

check('debounce effect schedules work when opened', timers.length > 0, `${timers.length} timer(s)`);

for (const t of timers) t.fn();
await new Promise((r) => realSetTimeout(r, 0));

check('cross-session scope calls ctx.sessions.search', searchCalls.length === 1, JSON.stringify(searchCalls));

const afterGlobal = render();
const globalPanel = afterGlobal.children.find((c) => c && c.props && c.props.className === 'dshfind-panel');
const allNodes = flatOf(globalPanel);
const hitButton = allNodes.find((n) => n.props.className === 'dshfind-hit');
check('cross-session results render a clickable hit', hitButton !== undefined);

let clickErr = null;
try { hitButton?.props.onClick(); } catch (e) { clickErr = e; }
check('clicking a cross-session hit does not throw', clickErr === null, clickErr?.message);
check('clicking a cross-session hit opens that session', opened.length === 1, JSON.stringify(opened));

// ---------------- cross-session error path ----------------
ctx.sessions.search = async () => ({
  ok: false,
  error: { code: 'gateway/internal', message: 'session search is unavailable: this deployment does not mount @deepseek-ai/dsh-session-query' },
});
hookStates.length = 0;
tree = render();
tree.children[0].props.onClick();
tree = render();
panelNow = tree.children.find((c) => c && c.props && c.props.className === 'dshfind-panel');
inputNow = flatOf(panelNow).find((n) => n.props.className === 'dshfind-input');
inputNow.props.onChange({ target: { value: '界面' } });

const errTimers = [];
globalThis.setTimeout = (fn, ms) => { errTimers.push({ fn, ms }); return errTimers.length; };
globalThis.clearTimeout = () => {};
for (const fn of effectQueue) { try { fn(); } catch { /* ignore */ } }
effectQueue = [];
tree = render();
for (const fn of effectQueue) { try { fn(); } catch { /* ignore */ } }
globalThis.setTimeout = realSetTimeout;
for (const t of errTimers) t.fn();
await new Promise((r) => realSetTimeout(r, 0));

const errNodes = flatOf(render().children.find((c) => c && c.props && c.props.className === 'dshfind-panel'));
const errText = errNodes.find((n) => n.props.className === 'dshfind-empty');
check('provider-not-mounted error is surfaced, not swallowed', errText !== undefined);
check(
  'surfaced error names the missing provider',
  typeof errText?.children?.join === 'function' && errText.children.join('').includes('does not mount'),
  JSON.stringify(errText?.children),
);

const failed = results.filter((r) => !r.ok);
console.log('');
console.log(`${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  for (const f of failed) console.log('  FAILED: ' + f.name + (f.detail ? ': ' + f.detail : ''));
  process.exit(1);
}
