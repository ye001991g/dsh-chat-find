/**
 * Regression test for the scroll target of a clicked search hit.
 *
 * Bug (reported 2026-11-09): clicking a result in the find panel scrolled the
 * transcript to the wrong place. Root cause: `focusHit` called
 * `hit.el.scrollIntoView({ block: 'center' })` on the ROW element
 * (`data-chat-anchor-key`), and one turn row can be many screens tall — a long
 * assistant reply is a single row. Centering a 4000 px row parks the viewport
 * near the row's middle, hundreds of pixels away from the clicked match.
 *
 * The fix reveals the match itself: take the match `Range`'s rect and scroll
 * every scrollport between it and the transcript's outer boundary, innermost
 * first. DSH nests a capped scrolling body (`[data-step-process-body]`,
 * `max-height:min(400px,50vh); overflow-y:auto`) inside the conversation
 * scrollport (`[data-conversation-scroll]`), and a match can live inside that
 * inner body — scrolling only the outer one is a regression that pushes the
 * whole group off-screen.
 *
 * Scenarios covered here:
 *   A. single scrollport: exact centring, smooth, clamped to the scroll range;
 *   B. nested scrollport: inner then outer scroll, instant, final match centred
 *      in the conversation scrollport;
 *   C. shell without the Custom Highlight API: the click rebuilds the match
 *      range from the live row, so it still centres exactly;
 *   D. unusable geometry (zero rect): falls back to the row-level reveal;
 *   E. no `data-conversation-scroll` marker: detected via computed overflow;
 *   F. a target past the scroll range clamps to the deepest scrollable offset;
 *   G. a stream re-render replaced the matched text node: the click re-matches;
 *   H. a stream re-render replaced the whole anchor row: found again by key;
 *   I. prefers-reduced-motion: instant instead of smooth.
 *
 * Run: node test-scroll.mjs
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
    this.nodeType = 1;
    this._text = '';
    this.tag = tag;
    this.isConnected = true;
    // Scrolling surface (only containers fill these in).
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
    this.rect = { top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 };
    this.scrollCalls = [];
    this.scrollIntoViewCalls = [];
  }
  appendChild(child) { child.parentNode = this; this.childNodes.push(child); return child; }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  hasAttribute(k) { return this.attrs.has(k); }
  removeAttribute(k) { this.attrs.delete(k); }
  /** Only the ancestor selectors the plugin asks about. */
  closest(selector) {
    for (let node = this; node !== null && node.nodeType === 1; node = node.parentNode) {
      if (selector === '[hidden]' && node.attrs.has('hidden')) return node;
      if (selector === '[data-conversation-scroll]' && node.attrs.has('data-conversation-scroll')) return node;
      if (selector === '[data-chat-flow]' && node.attrs.has('data-chat-flow')) return node;
    }
    return null;
  }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  getBoundingClientRect() { return this.rect; }
  scrollTo(options) {
    this.scrollCalls.push(options);
    // Real smooth scrolling is asynchronous; the fake settles every behavior
    // immediately so assertions stay deterministic (behavior is still recorded).
    this.scrollTop = options.top;
  }
  scrollIntoView(options) { this.scrollIntoViewCalls.push(options); }
  focus() {}
  normalize() {}
  get innerText() { return this.tag === '#text' ? this._text : this.childNodes.map((c) => c.innerText).join(''); }
  get textContent() { return this.tag === '#text' ? this._text : this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(value) { this.childNodes = []; this._text = String(value); }
}
class Text extends El {
  constructor(value) {
    super('#text');
    this.nodeType = 3;
    this.nodeValue = String(value);
    this._text = String(value);
  }
}

function textNodesUnder(root) {
  const out = [];
  const walk = (node) => {
    if (node.nodeType === 3) { out.push(node); return; }
    for (const child of node.childNodes ?? []) walk(child);
  };
  walk(root);
  return out;
}

/**
 * One harness = one independent fake shell + a fresh copy of the plugin.
 *
 * @param {object} options
 * @param {boolean} [options.withHighlightApi] - expose CSS.highlights/Highlight.
 * @param {'single'|'nested'|'unmarked'} [options.layout] - scrollport topology.
 * @param {{top:number,height:number,width:number}|null} [options.matchRect] -
 *        fixed viewport rect for the match (zero rect simulates stale geometry).
 */
function createHarness(options = {}) {
  const withHighlightApi = options.withHighlightApi !== false;
  const layout = options.layout ?? 'single';
  const fixedMatchRect = options.matchRect ?? null;
  const reduceMotion = options.reduceMotion === true;

  // --- geometry (viewport px) ---
  const OUTER_TOP = 100;
  const OUTER_HEIGHT = 600;
  const OUTER_SCROLL_HEIGHT = 5000;
  const INNER_CONTENT_TOP = 2000; // inner body's position in the outer content
  const INNER_HEIGHT = 400;
  const INNER_SCROLL_HEIGHT = 1200;
  const MATCH_IN_INNER_TOP = 800; // match offset inside the inner body content
  const MATCH_IN_SINGLE_TOP = 2600; // match offset inside a single scroller
  const MATCH_HEIGHT = 20;

  const outer = new El('div');
  if (layout !== 'unmarked') outer.setAttribute('data-conversation-scroll', '');
  outer.scrollHeight = OUTER_SCROLL_HEIGHT;
  outer.clientHeight = OUTER_HEIGHT;
  outer.rect = {
    top: OUTER_TOP,
    left: 0,
    right: 1200,
    bottom: OUTER_TOP + OUTER_HEIGHT,
    width: 1200,
    height: OUTER_HEIGHT,
  };

  const inner = layout === 'nested' ? new El('div') : null;
  if (inner !== null) {
    inner.setAttribute('data-step-process-body', '');
    inner.scrollHeight = INNER_SCROLL_HEIGHT;
    inner.clientHeight = INNER_HEIGHT;
  }

  const flow = new El('div');
  flow.setAttribute('data-chat-flow', '');
  const row = new El('div');
  row.setAttribute('data-chat-anchor-key', 'k1');
  row.setAttribute('data-chat-turn', '1');
  const matchText = new Text('这个网页有中文界面吗');
  row.appendChild(matchText);
  /** The live anchor rows as `document.querySelectorAll` sees them. */
  const currentRows = [row];

  // Simulate a stream re-render replacing the matched text node in place.
  const replaceTextNode = () => {
    matchText.isConnected = false;
    const fresh = new Text('这个网页有中文界面吗');
    row.childNodes = [];
    row.appendChild(fresh);
    return fresh;
  };
  // Simulate a stream re-render replacing the whole anchor row (same key).
  const replaceRow = () => {
    matchText.isConnected = false;
    row.isConnected = false;
    const freshRow = new El('div');
    freshRow.setAttribute('data-chat-anchor-key', 'k1');
    freshRow.setAttribute('data-chat-turn', '1');
    freshRow.appendChild(new Text('这个网页有中文界面吗'));
    // Swap the row into the same DOM slot so the replacement row still has the
    // scrollport chain (a real re-render keeps the element in the tree).
    const parent = row.parentNode;
    const index = parent === null ? -1 : parent.childNodes.indexOf(row);
    if (parent !== null && index >= 0) {
      freshRow.parentNode = parent;
      parent.childNodes[index] = freshRow;
    }
    currentRows.length = 0;
    currentRows.push(freshRow);
    return freshRow;
  };

  if (inner !== null) {
    inner.appendChild(row);
    outer.appendChild(inner);
  } else {
    flow.appendChild(row);
    outer.appendChild(flow);
  }
  if (inner === null) outer.appendChild(flow); // keep flow under outer for the querySelector scope
  flow.querySelectorAll = (selector) =>
    selector === '[data-chat-anchor-key]' ? currentRows.slice() : [];

  // Inner body's viewport rect moves with the outer scroll.
  if (inner !== null) {
    inner.rect = { top: 0, left: 0, right: 1000, bottom: 0, width: 1000, height: INNER_HEIGHT };
  }

  const scrollerTop = () => OUTER_TOP - outer.scrollTop;
  // Viewport top of the match, modelling both scrollports.
  const matchViewportTop = () => {
    if (fixedMatchRect !== null) return fixedMatchRect.top;
    if (inner !== null) {
      const innerTop = scrollerTop() + INNER_CONTENT_TOP;
      return innerTop + (MATCH_IN_INNER_TOP - inner.scrollTop) - 0;
    }
    return scrollerTop() + MATCH_IN_SINGLE_TOP;
  };
  const updateInnerRect = () => {
    if (inner === null) return;
    const top = scrollerTop() + INNER_CONTENT_TOP;
    inner.rect = { top, left: 0, right: 1000, bottom: top + INNER_HEIGHT, width: 1000, height: INNER_HEIGHT };
  };

  const rangeRect = () => {
    const top = matchViewportTop();
    return {
      top,
      left: 100,
      right: fixedMatchRect?.width ?? 180,
      bottom: top + (fixedMatchRect?.height ?? MATCH_HEIGHT),
      width: fixedMatchRect?.width ?? 80,
      height: fixedMatchRect?.height ?? MATCH_HEIGHT,
    };
  };

  class FakeRange {
    setStart(node) { this.startContainer = node; }
    setEnd() {}
    getBoundingClientRect() {
      // A range whose start node was replaced by a stream re-render reports no
      // geometry in a real browser; model that so the rebuild path is required.
      if (this.startContainer && this.startContainer.isConnected === false) {
        return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
      }
      return rangeRect();
    }
  }

  const document = {
    head: new El('head'),
    body: new El('body'),
    createElement: (tag) => new El(tag),
    createTextNode: (value) => new Text(value),
    createTreeWalker: (root) => {
      const nodes = textNodesUnder(root);
      let index = 0;
      return { nextNode: () => (index < nodes.length ? nodes[index++] : null) };
    },
    createRange: () => new FakeRange(),
    getElementById: () => null,
    querySelector: (selector) => (selector === '[data-chat-flow]' ? flow : null),
    querySelectorAll: (selector) =>
      selector === '[data-chat-anchor-key]' ? currentRows.slice() : [],
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  // Real transcripts always have the scrollport under body/html; wire that so
  // `scrollableAncestors` exercises the full climb instead of stopping early.
  document.body.appendChild(outer);

  if (withHighlightApi) {
    globalThis.CSS = { highlights: new Map() };
    globalThis.Highlight = class Highlight {
      constructor(...ranges) { this.ranges = ranges; }
    };
  } else {
    delete globalThis.CSS;
    delete globalThis.Highlight;
  }

  // --- React stub ---
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
  const ReactDOM = { createPortal: (node) => node };
  const requireStub = (spec) => {
    if (spec === 'react') return React;
    if (spec === 'react-dom') return ReactDOM;
    throw new Error('unexpected require ' + spec);
  };

  const store = new Map();
  globalThis.window = {
    __ModuleLoader__: { load: (registration) => { globalThis.__reg = registration; } },
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
    },
    innerWidth: 1440,
    innerHeight: 900,
    addEventListener: () => {},
    removeEventListener: () => {},
    matchMedia: () => ({ matches: reduceMotion }),
    getComputedStyle: (el) => ({
      overflowY: layout === 'unmarked' && el === outer ? 'auto' : 'visible',
    }),
  };

  new Function('window', 'require', 'document', 'NodeFilter', SOURCE)(
    globalThis.window,
    requireStub,
    document,
    { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
  );
  const plugin = globalThis.__reg.factory(requireStub);

  // --- mount + drive an in-session search ---
  const registered = [];
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
    sessions: { binding: () => ({ session: face }) },
    uiWorkspace: { openSession: () => {} },
  };
  plugin.apply(ctx);
  const entry = registered[0];
  const injected = entry.options.inject('sess-1');

  const flatOf = (node, out = []) => {
    if (Array.isArray(node)) { for (const child of node) flatOf(child, out); return out; }
    if (!node || typeof node !== 'object') return out;
    if (node.props && node.props.className) out.push(node);
    flatOf(node.children ?? [], out);
    return out;
  };

  let tree = null;
  const render = () => {
    hookIndex = 0;
    effectQueue = [];
    tree = entry.Component({
      sessionId: 'sess-1',
      ...injected,
      useSession: (selector) => selector({ hasMore: false, openState: 'open' }),
      t: (key) => key,
    });
    return tree;
  };
  const flushEffects = () => {
    for (const fn of effectQueue) { try { fn(); } catch { /* fake DOM gaps */ } }
    effectQueue = [];
  };
  const timers = [];
  const realSetTimeout = globalThis.setTimeout;
  const openPanel = () => {
    render();
    tree.children[0].props.onClick();
    tree = render();
    return tree.children.find((c) => c && c.props && c.props.className === 'dshfind-panel');
  };
  /**
   * Type a query, flush the debounce, then click hit `index`.
   * @param text - query to type.
   * @param index - hit to click.
   * @param beforeClick - optional DOM mutation between scan and click (stream
   *        re-render simulation).
   */
  const clickHit = (text, index = 0, beforeClick = null) => {
    globalThis.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
    globalThis.clearTimeout = () => {};
    const panel = openPanel();
    const input = flatOf(panel).find((n) => n.props.className === 'dshfind-input');
    input.props.onChange({ target: { value: text } });
    flushEffects();
    tree = render();
    flushEffects();
    for (const timer of timers) { try { timer.fn(); } catch { /* ignore */ } }
    timers.length = 0;
    tree = render();
    globalThis.setTimeout = realSetTimeout;
    const panelNow = tree.children.find((c) => c && c.props && c.props.className === 'dshfind-panel');
    const hits = flatOf(panelNow).filter((n) => n.props.className === 'dshfind-hit');
    if (hits.length <= index) throw new Error(`no hit ${index} (got ${hits.length})`);
    updateInnerRect();
    if (typeof beforeClick === 'function') beforeClick();
    hits[index].props.onClick();
    return hits;
  };

  // Record cross-container scroll order: the fix must scroll inner → outer.
  const callOrder = [];
  const wrap = (name, el) => {
    const original = el.scrollTo.bind(el);
    el.scrollTo = (options) => {
      callOrder.push({ name, top: options.top, behavior: options.behavior });
      original(options);
    };
  };
  wrap('outer', outer);
  if (inner !== null) wrap('inner', inner);

  return {
    outer,
    inner,
    row,
    matchText,
    callOrder,
    matchViewportTop,
    updateInnerRect,
    replaceTextNode,
    replaceRow,
    clickHit,
    openPanel,
    render,
    MATCH_HEIGHT,
    OUTER_TOP,
    OUTER_HEIGHT,
  };
}

// ---------------- Scenario A: single scrollport ----------------
{
  const h = createHarness({ layout: 'single' });
  h.clickHit('界面');
  // Physical invariant: after the reveal the match is centred in the
  // conversation scrollport (top 100, height 600) → its centre sits at y=400.
  const matchCentre = h.matchViewportTop() + h.MATCH_HEIGHT / 2;
  const portCentre = h.OUTER_TOP + h.OUTER_HEIGHT / 2;
  check(
    'A: single scrollport centres the match in the transcript',
    Math.abs(matchCentre - portCentre) <= 1,
    `matchCentre=${matchCentre} portCentre=${portCentre} scrollTop=${h.outer.scrollTop}`,
  );
  check(
    'A: scrollTop is the hand-computed 2310 px (not a formula re-run)',
    h.outer.scrollTop === 2310,
    String(h.outer.scrollTop),
  );
  check(
    'A: one smooth scroll on the conversation scrollport',
    h.outer.scrollCalls.length === 1 && h.outer.scrollCalls[0].behavior === 'smooth',
    JSON.stringify(h.outer.scrollCalls[0] ?? null),
  );
  check('A: the tall row is not used as the scroll target', h.row.scrollIntoViewCalls.length === 0);
}

// ---------------- Scenario B: nested scrollport (process group body) ----------------
{
  const h = createHarness({ layout: 'nested' });
  h.clickHit('界面');
  const matchCentre = h.matchViewportTop() + h.MATCH_HEIGHT / 2;
  const portCentre = h.OUTER_TOP + h.OUTER_HEIGHT / 2;
  check(
    'B: nested body and conversation scrollport are BOTH scrolled',
    h.inner.scrollCalls.length === 1 && h.outer.scrollCalls.length === 1,
    `inner=${h.inner.scrollCalls.length} outer=${h.outer.scrollCalls.length}`,
  );
  check(
    'B: inner body is scrolled BEFORE the conversation scrollport',
    h.callOrder.map((call) => call.name).join(',') === 'inner,outer',
    h.callOrder.map((call) => call.name).join(','),
  );
  check(
    'B: inner body lands at the hand-computed 610 px',
    h.inner.scrollTop === 610,
    String(h.inner.scrollTop),
  );
  check(
    'B: outer scrollport lands at the hand-computed 1900 px',
    h.outer.scrollTop === 1900,
    String(h.outer.scrollTop),
  );
  check(
    'B: final match is centred in the transcript (physical invariant)',
    Math.abs(matchCentre - portCentre) <= 1,
    `matchCentre=${matchCentre} portCentre=${portCentre}`,
  );
  check(
    'B: multi-container reveal is instant (no async smooth race between layers)',
    h.inner.scrollCalls[0]?.behavior === 'instant' && h.outer.scrollCalls[0]?.behavior === 'instant',
    `inner=${h.inner.scrollCalls[0]?.behavior} outer=${h.outer.scrollCalls[0]?.behavior}`,
  );
}

// ---------------- Scenario C: no Custom Highlight API ----------------
{
  const h = createHarness({ layout: 'single', withHighlightApi: false });
  h.clickHit('界面');
  check(
    'C: without the Highlight API the click still centres the match exactly',
    h.outer.scrollTop === 2310,
    String(h.outer.scrollTop),
  );
  check(
    'C: the rebuild path (range made at click time) is what scrolled',
    h.outer.scrollCalls.length === 1 && h.row.scrollIntoViewCalls.length === 0,
    `scrolls=${h.outer.scrollCalls.length} rowCalls=${h.row.scrollIntoViewCalls.length}`,
  );
}

// ---------------- Scenario D: unusable geometry → row fallback ----------------
{
  const h = createHarness({
    layout: 'single',
    matchRect: { top: 0, width: 0, height: 0 },
  });
  h.clickHit('界面');
  check(
    'D: zero-rect (stale range) falls back to the row-level reveal',
    h.row.scrollIntoViewCalls.length === 1 && h.outer.scrollCalls.length === 0,
    `rowCalls=${h.row.scrollIntoViewCalls.length} scrolls=${h.outer.scrollCalls.length}`,
  );
}

// ---------------- Scenario E: no data marker → computed overflow ----------------
{
  const h = createHarness({ layout: 'unmarked' });
  h.clickHit('界面');
  check(
    'E: an unmarked scrollport is still found through computed overflow',
    h.outer.scrollCalls.length === 1 && h.outer.scrollTop === 2310,
    `scrolls=${h.outer.scrollCalls.length} scrollTop=${h.outer.scrollTop}`,
  );
}

// ---------------- Scenario F: clamping ----------------
{
  const h = createHarness({ layout: 'single', matchRect: { top: 999999, width: 80, height: 20 } });
  h.clickHit('界面');
  check(
    'F: a target past the bottom clamps to scrollHeight - clientHeight',
    h.outer.scrollTop === h.outer.scrollHeight - h.outer.clientHeight,
    `scrollTop=${h.outer.scrollTop} max=${h.outer.scrollHeight - h.outer.clientHeight}`,
  );
}

// ---------------- Scenario G: stream replaced the matched text node ----------------
// `hits` holds a scan-time Range. A streaming answer can replace the text node,
// detaching that Range (zero geometry) — the click must re-match the live row
// instead of falling back to the row-level scroll.
{
  const h = createHarness({ layout: 'single' });
  h.clickHit('界面', 0, () => h.replaceTextNode());
  check(
    'G: a re-rendered text node is re-matched at click time (exact centring)',
    h.outer.scrollTop === 2310 && h.row.scrollIntoViewCalls.length === 0,
    `scrollTop=${h.outer.scrollTop} rowCalls=${h.row.scrollIntoViewCalls.length}`,
  );
}

// ---------------- Scenario H: stream replaced the whole anchor row ----------------
{
  const h = createHarness({ layout: 'single' });
  h.clickHit('界面', 0, () => h.replaceRow());
  check(
    'H: a re-rendered anchor row is found again by key',
    h.outer.scrollTop === 2310 && h.row.scrollIntoViewCalls.length === 0,
    `scrollTop=${h.outer.scrollTop} rowCalls=${h.row.scrollIntoViewCalls.length}`,
  );
}

// ---------------- Scenario I: prefers-reduced-motion ----------------
{
  const h = createHarness({ layout: 'single', reduceMotion: true });
  h.clickHit('界面');
  check(
    'I: prefers-reduced-motion downgrades the reveal to instant',
    h.outer.scrollCalls.length === 1 && h.outer.scrollCalls[0]?.behavior === 'instant',
    JSON.stringify(h.outer.scrollCalls[0] ?? null),
  );
}

const failed = results.filter((result) => !result.ok);
console.log('');
console.log(`${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  for (const failure of failed) console.log('  FAILED: ' + failure.name + (failure.detail ? ': ' + failure.detail : ''));
  process.exit(1);
}
