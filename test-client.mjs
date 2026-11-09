/**
 * Standalone functional test for the client half of @local/dsh-chat-find.
 *
 * The plugin is a browser bundle: it calls `window.__ModuleLoader__.load(...)`
 * and renders React. This harness stubs exactly those two surfaces (plus a
 * minimal DOM) so the REAL plugin file can be exercised without DSH.
 *
 * What it proves:
 *   - the bundle registers under the right id and exports { inject, apply }
 *   - apply() registers into the expected slot with the expected options
 *   - the inject face resolves a session face
 *   - the component renders and returns a trigger button
 *
 * Mocks are hand-written rather than jsdom so the test has no install step.
 * Run: node test-client.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, 'client.js');
const SOURCE = fs.readFileSync(SRC, 'utf8');

// ---------- minimal DOM ----------
class FakeNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.style = {};
    this.textContent = '';
    this.nodeValue = null;
    this.nodeType = 1;
  }
  appendChild(child) { child.parentNode = this; this.childNodes.push(child); return child; }
  setAttribute(k, v) { this.attributes.set(k, String(v)); }
  getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
  removeAttribute(k) { this.attributes.delete(k); }
  get innerText() { return this.childNodes.map((c) => c.innerText ?? c.textContent ?? '').join(''); }
}
class FakeText extends FakeNode {
  constructor(value) { super('#text'); this.nodeType = 3; this.nodeValue = value; }
  get textContent() { return this.nodeValue; }
  get innerText() { return this.nodeValue; }
}
class FakeFragment extends FakeNode {
  constructor() { super('#fragment'); this.nodeType = 11; }
}

const created = { style: [], elements: [] };
const document = {
  head: new FakeNode('head'),
  // The panel is portaled here (the session header clips overflow).
  body: new FakeNode('body'),
  getElementById: () => null,
  createElement: (tag) => { const el = new FakeNode(tag); created.elements.push(tag); return el; },
  createTextNode: (v) => new FakeText(v),
  createDocumentFragment: () => new FakeFragment(),
  createTreeWalker: () => ({ nextNode: () => null }),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
  removeEventListener: () => {},
};

// ---------- React stub ----------
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useRef: (init) => ({ current: init }),
  useCallback: (fn) => fn,
  useEffect: () => {},
  useMemo: (fn) => fn(),
  memo: (c) => c,
};

// ---------- capture the bundle registration ----------
let registration = null;
globalThis.window = {
  __ModuleLoader__: {
    load(reg) { registration = reg; },
  },
};

const requireShim = (spec) => {
  if (spec === 'react') return React;
  if (spec === 'react-dom') return { createPortal: (node) => node };
  throw new Error(`unexpected require(${JSON.stringify(spec)})`);
};

// ---------- evaluate the real plugin source ----------
const run = new Function('window', 'require', 'document', 'NodeFilter', SOURCE);
run(globalThis.window, requireShim, document, { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 });

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

check('bundle registered via window.__ModuleLoader__.load', registration !== null);
check('registration id equals package name', registration?.id === '@local/dsh-chat-find', registration?.id);

const body = registration.factory(requireShim);
check('factory returns an object', body !== null && typeof body === 'object');
check('declares inject including slots', Array.isArray(body.inject) && body.inject.includes('slots'), JSON.stringify(body.inject));
// REGRESSION: Cordis resolves a service off `ctx` only when the plugin's own
// fiber injects it. Accessing `ctx.sessions` without declaring it throws
// `cannot get property "sessions" without inject` — which broke both
// older-history paging and cross-session search in a shipped build.
check(
  'declares inject: [sessions] (required to touch ctx.sessions)',
  Array.isArray(body.inject) && body.inject.includes('sessions'),
  JSON.stringify(body.inject),
);
check(
  'every service the plugin reads off ctx is declared in inject',
  (() => {
    const used = new Set();
    for (const m of SOURCE.matchAll(/\bctx\.([a-zA-Z_$][\w$]*)\b/g)) used.add(m[1]);
    // `ctx.effect`, `ctx.slots.inject`, `ctx.on` etc. are core methods, not
    // injected services; `sessions` is the only service this plugin consumes.
    const services = [...used].filter((n) => n === 'sessions');
    return services.every((n) => body.inject.includes(n));
  })(),
  JSON.stringify(body.inject),
);
check('exports apply()', typeof body.apply === 'function');

// ---------- exercise apply() ----------
const registered = [];
const injections = [];
let styleDisposer = null;
/** Minimal stand-in for a `SessionFace` (behavior verbs + snapshot feed). */
const fakeSessionFace = {
  sessionId: 'sess-1',
  getSnapshot: () => ({ hasMore: true, openState: 'open' }),
  loadOlder: async () => {},
};
const ctx = {
  effect: (fn, name) => { const d = fn(); if (name === 'chat-find: stylesheet') styleDisposer = d; return d; },
  slots: {
    inject: (owner, cb) => { injections.push(owner); cb(); },
    register: (options, Component) => { registered.push({ options, Component }); },
  },
  sessions: {
    binding: (id) => (id === 'sess-1' ? { session: fakeSessionFace } : undefined),
  },
  uiWorkspace: { openSession: () => {} },
};

let applyError = null;
try { body.apply(ctx); } catch (error) { applyError = error; }
check('apply() runs without throwing', applyError === null, applyError?.message);

check('injects into conversation.session.header.actions', injections.includes('conversation.session.header.actions'), JSON.stringify(injections));
check('registers exactly one component', registered.length === 1, String(registered.length));

const entry = registered[0];
check('registration name targets the header actions slot', entry?.options?.name === 'conversation.session.header.actions', entry?.options?.name);
check('registration id is chat-find', entry?.options?.id === 'chat-find', entry?.options?.id);
check('provides an inject face', typeof entry?.options?.inject === 'function');

// THE CONTRACT THAT SHIPPED BROKEN. The renderer spreads the inject face's
// return value VERBATIM into props (`runInject` -> `bindInjectSources`, which
// passes a face with no `hooks`/`keyedHooks` straight through). So the face must
// already contain the resolved SessionFace — it must NOT be a lookup function.
// The previous version of this test called `injected.session('sess-1')` itself
// and fed the result to the component, fabricating a shape the runtime never
// produces; that is why `session.loadOlder is not a function` reached a user.
let injected = null;
let injectError = null;
try { injected = entry.options.inject('sess-1', undefined); } catch (error) { injectError = error; }
check('inject(sessionId) does not throw', injectError === null, injectError?.message);
check(
  'inject face returns the session FACE, not a lookup function',
  injected?.session !== undefined && typeof injected.session !== 'function',
  typeof injected?.session,
);
check(
  'the returned session exposes loadOlder (what the panel calls)',
  typeof injected?.session?.loadOlder === 'function',
);
check(
  'a lookup function would have been the bug (guard against regression)',
  !(typeof injected?.session === 'function'),
);
// An unknown session must degrade, not throw.
let unknown = null;
try { unknown = entry.options.inject('nope', undefined); } catch (error) { unknown = { threw: String(error) }; }
check('inject for an unknown session returns without throwing', unknown?.threw === undefined && unknown?.session === undefined);

// ---------- render the component ----------
// Spread the face exactly as the renderer does — no manual dereference.
const props = {
  sessionId: 'sess-1',
  ...injected,
  t: (k) => k,
};
let tree = null;
let renderError = null;
try { tree = entry.Component(props); } catch (error) { renderError = error; }
check('component renders without throwing', renderError === null, renderError?.message);
check('component returns a span root', tree?.type === 'span', tree?.type);
check('root carries the plugin class', tree?.props?.className === 'dshfind-root', tree?.props?.className);

// REGRESSION (observed live on DSH 0.2.2-rc.1): the session header now renders
// its action slot inside `.titleCluster`, which sets `overflow: clip` (plus a
// fade mask). The panel used to be `position: absolute` inside that subtree, so
// it was clipped to a ~30 px strip and clicking the trigger looked like a no-op.
// The panel must be portaled to `document.body` and positioned `fixed`.
check(
  'panel is positioned fixed, outside the clipped header subtree',
  SOURCE.includes('.dshfind-panel{position:fixed'),
  'CSS must keep position:fixed on the panel',
);
check(
  'panel is portaled to document.body',
  SOURCE.includes('ReactDOM.createPortal(') && SOURCE.includes(', document.body'),
  'the panel must be portaled out of the header',
);
check(
  'root keeps a positioning context for the trigger',
  SOURCE.includes('.dshfind-root{position:relative'),
  'CSS must keep position:relative on the root',
);
check(
  'root is not display:contents (which would break anchoring)',
  !SOURCE.includes('.dshfind-root{display:contents}'),
);

// REGRESSION: the transcript is React-rendered. Calling normalize() while
// clearing highlights can merge away a text node React still tracks by
// reference, which crashes the next render ("The node to be removed is not a
// child of this node"). Highlights must be unwrapped without normalizing.
// Match an actual CALL only — the explanatory JSDoc mentions the method name.
check(
  'highlight cleanup never calls normalize() on React-owned DOM',
  !/\bnor?malize\s*\(\)\s*;/.test(SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\*.*$/gm, '')),
);

// REGRESSION: Cordis resolves a service off `ctx` only when the plugin's own
// fiber injects it. Reading ctx.sessions without declaring it throws
// `cannot get property "sessions" without inject`.
check(
  'declares sessions in inject (service access off ctx)',
  Array.isArray(body.inject) && body.inject.includes('sessions'),
  JSON.stringify(body.inject),
);

const children = tree?.children ?? [];
check('root has a trigger plus a (null) panel', children.length === 2, String(children.length));
const trigger = children[0];
check('trigger is a button', trigger?.type === 'button', trigger?.type);
check('trigger has an aria-label', typeof trigger?.props?.['aria-label'] === 'string');
check('trigger exposes data-active for styling', trigger?.props?.['data-active'] === 'false');

// ---------- stylesheet ----------
check('stylesheet installer returned a disposer', typeof styleDisposer === 'function');

const failed = results.filter((r) => !r.ok);
console.log('');
console.log(`${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.log('FAILED:');
  for (const f of failed) console.log('  - ' + f.name + (f.detail ? ': ' + f.detail : ''));
  process.exit(1);
}
