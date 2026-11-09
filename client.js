/**
 * Client half of `@local/dsh-chat-find`.
 *
 * Adds a Find control to the conversation session header. It searches the
 * ALREADY-RENDERED transcript by reading the stable anchor attributes the Chat
 * view itself uses for its own navigation
 * (`data-chat-anchor-key` / `data-chat-flow-key` / `data-chat-turn`), so it
 * needs no access to session services and cannot disturb the model path.
 *
 * Why literal matching instead of an index: DSH's SQLite FTS5 backend
 * hardcodes `tokenize = 'unicode61'`, which does not segment Chinese, so
 * two-character Chinese words score ~0 recall. A literal substring scan is
 * both correct for Chinese and cheap (measured 0.2–3.5 ms over 134 M chars).
 *
 * Trade-off, stated honestly in the UI: coverage is limited to what is
 * currently resident. Nothing unmounted is searched; the panel offers to pull
 * older history in.
 *
 * @module @local/dsh-chat-find/client
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-chat-find',
  factory(require) {
    const React = require('react');
    // The panel is portaled to `document.body`: since DSH 0.2.2 the session
    // header renders its action slot inside `.titleCluster`, which carries
    // `overflow: clip` (plus a fade mask). An in-place `position: absolute`
    // panel is therefore clipped to a ~30 px tall strip and never becomes
    // visible — the trigger looks dead even though it opens fine.
    const ReactDOM = require('react-dom');
    const h = React.createElement;

    /**
     * The client root context, captured in `apply`. `apply` is the only place
     * the framework hands it to us, and the rendered component lives in this
     * same factory closure, so the capture is what lets a component reach
     * `ctx.sessions` without threading the context through slot props.
     */
    let pluginCtx = null;

    /** Attribute selector for message rows, mirroring the Chat view's own scan. */
    const ROW_SELECTOR = '[data-chat-anchor-key]';

    // Declared before STYLE because the stylesheet interpolates them.
    /** Custom Highlight registry name used for every match. */
    const HIGHLIGHT_ALL = 'dsh-chat-find';
    /** Custom Highlight registry name used for the currently focused match. */
    const HIGHLIGHT_CURRENT = 'dsh-chat-find-current';

    /** Panel width in CSS pixels; kept in JS so the anchored position can clamp it. */
    const PANEL_WIDTH = 360;
    /** Vertical gap between the trigger and the floating panel. */
    const PANEL_GAP = 6;
    /** Minimum inset from the viewport edges. */
    const PANEL_MARGIN = 8;

    const STYLE = `
.dshfind-root{position:relative;display:inline-flex;align-items:center}
.dshfind-trigger{display:flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dshfind-trigger:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshfind-trigger[data-active="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshfind-panel{position:fixed;z-index:1000;width:360px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);padding:10px;display:flex;flex-direction:column;gap:8px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);box-shadow:0 8px 24px rgba(0,0,0,.18)}
.dshfind-row{display:flex;align-items:center;gap:6px}
.dshfind-input{flex:1 1 auto;min-width:0;height:28px;padding:0 8px;font-family:var(--dsw-font-family);font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);outline:none}
.dshfind-input:focus{border-color:var(--dsw-alias-brand-primary)}
.dshfind-btn{flex:0 0 auto;height:28px;min-width:28px;padding:0 8px;font-family:var(--dsw-font-family);font-size:12px;color:var(--dsw-alias-label-secondary);background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);cursor:pointer}
.dshfind-btn:hover:not([disabled]){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshfind-btn[disabled]{opacity:.45;cursor:default}
.dshfind-count{font-family:var(--dsw-font-family);font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dshfind-scope{display:flex;align-items:center;gap:6px;font-family:var(--dsw-font-family);font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none}
.dshfind-scope input{margin:0;cursor:pointer}
.dshfind-hits{max-height:220px;overflow-y:auto;display:flex;flex-direction:column;gap:2px}
.dshfind-hit{display:block;width:100%;text-align:left;padding:5px 7px;font-family:var(--dsw-font-family);font-size:12px;line-height:1.45;color:var(--dsw-alias-label-secondary);background:transparent;border:none;border-radius:var(--dsw-radius-xs);cursor:pointer}
.dshfind-hit:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshfind-hit[data-current="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshfind-hitTurn{color:var(--dsw-alias-label-caption);margin-right:6px}
.dshfind-empty{font-family:var(--dsw-font-family);font-size:12px;color:var(--dsw-alias-label-secondary);padding:4px 2px}
.dshfind-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:7px}
.dshfind-note{font-family:var(--dsw-font-family);font-size:11px;color:var(--dsw-alias-label-caption);line-height:1.4}
::highlight(${HIGHLIGHT_ALL}){background-color:var(--dsw-static-amber-100);color:var(--dsw-static-neutral-1000)}
::highlight(${HIGHLIGHT_CURRENT}){background-color:var(--dsw-static-amber-400);color:var(--dsw-static-neutral-1000)}
`;

    /**
     * Mount this plugin's stylesheet; returns a disposer.
     *
     * Tagged with `data-plugin` / `data-plugin-css` so the Client module system
     * attributes the tags to this package: `claimStyles` runs at materialization
     * and would otherwise hand an untagged tag to whichever plugin materializes
     * next, and `removeOwnedStyles(id)` could not clean it up on our own reload.
     * There is deliberately no id-based early return — a stale tag from a
     * previous generation must not shadow the current CSS.
     */
    function installStyles() {
      const el = document.createElement('style');
      el.setAttribute('data-plugin', '@local/dsh-chat-find');
      el.setAttribute('data-plugin-css', '');
      el.textContent = STYLE;
      document.head.appendChild(el);
      return () => {
        el.remove();
      };
    }

    /**
     * Compute the viewport coordinates for the floating panel.
     *
     * The panel is portaled to `document.body` and `position: fixed` so it
     * escapes the session header's `overflow: clip` ancestor (see the
     * `ReactDOM` comment above). Its right edge tracks the trigger's right
     * edge, then the result is clamped to the viewport so a narrow window
     * cannot push the panel off-screen. `fixed` is viewport-relative here
     * because `body` has no transformed/contained ancestors in this shell.
     * @param anchor - the trigger element.
     * @returns Left/top in viewport pixels.
     */
    function computePanelPosition(anchor) {
      if (
        anchor === null ||
        anchor === undefined ||
        typeof anchor.getBoundingClientRect !== 'function'
      ) {
        return { left: PANEL_MARGIN, top: PANEL_MARGIN };
      }
      const rect = anchor.getBoundingClientRect();
      const viewportWidth =
        typeof window.innerWidth === 'number' && window.innerWidth > 0
          ? window.innerWidth
          : PANEL_WIDTH + 2 * PANEL_MARGIN;
      const width = Math.min(PANEL_WIDTH, Math.max(240, viewportWidth - 2 * PANEL_MARGIN));
      const left = Math.max(
        PANEL_MARGIN,
        Math.min(rect.right - width, viewportWidth - width - PANEL_MARGIN),
      );
      return { left: Math.round(left), top: Math.round(rect.bottom + PANEL_GAP) };
    }

    /** True when an element is hidden in a way that removes it from the a11y tree. */
    function isHidden(el) {
      return el.closest('[hidden]') !== null;
    }

    /**
     * Collect the transcript rows currently resident, in document order.
     *
     * Two deliberate choices:
     *  1. `hidden="until-found"` subtrees (collapsed process bodies, inline
     *     reasoning) are INCLUDED. The host deliberately marks them so the
     *     browser's own find can reveal them on `beforematch`, so skipping them
     *     would search less than the platform considers findable.
     *  2. Group/container rows are skipped: a group seat carries its own
     *     `data-chat-anchor-key` AND contains member rows, so counting both
     *     would double every match in a folded group. Only leaf rows count.
     * @returns Rows with their anchor identity, owning turn, and plain text.
     */
    function collectRows() {
      const out = [];
      // Scope to chat flow containers when present; otherwise all anchored rows.
      const scope = document.querySelector('[data-chat-flow]') ?? document;
      const rows = scope.querySelectorAll(ROW_SELECTOR);
      for (const row of rows) {
        if (isHidden(row)) continue; // `hidden` without until-found: not rendered
        if (row.hasAttribute('data-chat-group-key')) continue;
        // A row that contains another anchored row is a container, not a leaf.
        if (row.querySelector(ROW_SELECTOR) !== null) continue;
        const text = row.innerText ?? row.textContent ?? '';
        if (text.trim().length === 0) continue;
        out.push({
          el: row,
          key: row.getAttribute('data-chat-anchor-key') ?? '',
          turn: Number(row.getAttribute('data-chat-turn') ?? '0'),
          text,
        });
      }
      return out;
    }

    /** Whether this shell exposes the CSS Custom Highlight API. */
    function highlightApiAvailable() {
      return typeof CSS !== 'undefined' && CSS.highlights !== undefined && typeof Highlight === 'function';
    }

    /**
     * Count the anchored transcript rows currently in the document.
     *
     * Used as a progress probe around `loadOlder()`. The session keeps `baseSeq`
     * private (it is not on `SessionSnapshot`), and `loadOlder()` returns early
     * on a non-`open` window, on `!hasMore`, and while another load is running —
     * all as a silent no-op. The rendered row count is the observable proxy for
     * "did the window actually grow".
     * @returns Number of anchored rows in the document.
     */
    function anchorRowCount() {
      return document.querySelectorAll(ROW_SELECTOR).length;
    }

    /**
     * Wait for the next paint(s) so React has committed prepended rows before the
     * caller rescans the DOM.
     * @param n - number of animation frames to wait.
     * @returns Promise resolved after those frames.
     */
    function nextFrames(n) {
      if (typeof requestAnimationFrame !== 'function') return Promise.resolve();
      return new Promise((resolve) => {
        let left = n;
        const step = () => {
          left -= 1;
          if (left <= 0) resolve();
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
    }

    /**
     * Whether the shell asks for reduced motion.
     * @returns True when the user prefers reduced motion.
     */
    function prefersReducedMotion() {
      try {
        return (
          typeof window.matchMedia === 'function' &&
          window.matchMedia('(prefers-reduced-motion: reduce)').matches
        );
      } catch {
        return false;
      }
    }

    /**
     * Whether an element scrolls its own overflow.
     *
     * Prefer DSH's explicit inner-body marker — an expanded process group
     * renders its body with `max-height:min(400px,50vh); overflow-y:auto` and
     * marks it `[data-step-process-body]` — then fall back to the computed
     * overflow so a renamed marker still degrades to the generic behaviour.
     * @param el - element to test.
     * @returns True when the element is a scroll container.
     */
    function isScrollable(el) {
      if (typeof el.hasAttribute === 'function' && el.hasAttribute('data-step-process-body')) {
        return true;
      }
      if (typeof el.scrollHeight !== 'number' || typeof el.clientHeight !== 'number') return false;
      if (el.scrollHeight <= el.clientHeight) return false;
      const style = typeof window.getComputedStyle === 'function' ? window.getComputedStyle(el) : null;
      const overflowY = style === null || style === undefined ? '' : style.overflowY;
      return overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay';
    }

    /**
     * Collect every scrollport between a match and the transcript's outer scroll
     * boundary, ordered innermost → outermost.
     *
     * DSH nests scroll boundaries: the conversation scrollport
     * (`[data-conversation-scroll]`) and, inside it, capped scrolling bodies
     * (an expanded process group's `.…_body`, marked `[data-step-process-body]`).
     * A match can live inside one of those bodies. Returning the FIRST matching
     * ancestor is wrong twice over: it skips the inner body (so the match stays
     * scrolled out inside it) and it computes the outer offset from a rect that
     * already includes the inner body's scroll. `[data-conversation-scroll]` is
     * the chain's outer end — anything above it belongs to the shell, not the
     * transcript.
     * @param node - a node inside the transcript (a match Range's start).
     * @returns Scrollports ordered inner → outer.
     */
    function scrollableAncestors(node) {
      const start =
        node === null || node === undefined ? null : node.nodeType === 1 ? node : node.parentNode;
      if (start === null) return [];
      const out = [];
      for (let el = start; el !== null; el = el.parentNode) {
        if (el.nodeType !== 1) continue;
        if (typeof el.hasAttribute === 'function' && el.hasAttribute('data-conversation-scroll')) {
          out.push(el);
          break;
        }
        if (isScrollable(el)) out.push(el);
      }
      return out;
    }

    /**
     * Read a Range's viewport rect, or null when the geometry is unusable.
     *
     * A cached Range whose nodes were replaced by a stream re-render reports a
     * zero rect; treating that as "no geometry" keeps the caller on its
     * fallback path instead of scrolling to the top of the document.
     * @param range - a match Range, or null.
     * @returns The rect, or null.
     */
    function readRangeRect(range) {
      if (
        range === null ||
        range === undefined ||
        typeof range.getBoundingClientRect !== 'function'
      ) {
        return null;
      }
      let rect;
      try {
        rect = range.getBoundingClientRect();
      } catch {
        return null;
      }
      if (rect === null || rect === undefined) return null;
      const width = typeof rect.width === 'number' ? rect.width : 0;
      const height = typeof rect.height === 'number' ? rect.height : 0;
      if (width <= 0 && height <= 0) return null;
      return rect;
    }

    /**
     * Bring a match into view — the MATCH, not its row.
     *
     * A transcript row (`data-chat-anchor-key`) is a whole turn, and one long
     * answer is a single row several screens tall. `row.scrollIntoView({
     * block:'center'})` therefore centres the ROW: on a tall row that parks the
     * viewport near the row's middle, which can land thousands of pixels away
     * from the clicked match (observed 2026-11-09).
     *
     * Scroll by the match's own Range rect instead, walking EVERY scrollport
     * between the match and the transcript's outer boundary — innermost first.
     * A match inside an expanded process group lives in a capped scrolling body
     * nested inside the conversation scrollport; scrolling only the outer one
     * would push the whole group out of view while the match stayed scrolled
     * out inside it.
     *
     * Falls back to the row-level reveal only when there is no usable geometry
     * (shells without the Custom Highlight API never build a range; a range can
     * also go stale between scan and click) or no scrollport at all.
     * @param range - the match's first Range, or null.
     * @param row - the owning row element, used as the fallback target.
     */
    function revealMatch(range, row) {
      if (row === null || row === undefined || typeof row.scrollIntoView !== 'function') return;
      /** Row-level reveal, used only when match geometry is unavailable. */
      const revealRow = () => {
        row.scrollIntoView({
          block: 'center',
          behavior: prefersReducedMotion() ? 'instant' : 'smooth',
        });
      };
      const chain = scrollableAncestors(
        range === null || range === undefined ? null : range.startContainer,
      );
      if (chain.length === 0) {
        revealRow();
        return;
      }
      // A nested match needs two scrolls (inner, then outer) that observe each
      // other's settled layout, so multi-container reveals are instant. A single
      // container keeps the smooth animation; reduced-motion users get instant.
      const behavior = chain.length === 1 && !prefersReducedMotion() ? 'smooth' : 'instant';
      let moved = false;
      for (const container of chain) {
        // Re-read after each scroll: the outer container must measure where the
        // match actually landed once the inner body has settled.
        const rect = readRangeRect(range);
        if (rect === null) break;
        const box =
          typeof container.getBoundingClientRect === 'function' ? container.getBoundingClientRect() : null;
        if (box === null || !(box.height > 0)) continue;
        const target = container.scrollTop + (rect.top - box.top) - (box.height - rect.height) / 2;
        const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
        const top = Math.max(0, Math.min(maxTop, target));
        try {
          if (typeof container.scrollTo === 'function') {
            container.scrollTo({ top, behavior });
          } else {
            container.scrollTop = top;
          }
          moved = true;
        } catch {
          /* try the next container; fall back below when nothing moved */
        }
      }
      if (!moved) revealRow();
    }

    /**
     * Drop every registered highlight range.
     *
     * HIGHLIGHTING NEVER MUTATES THE DOM. The transcript is React-owned: wrapping
     * matches in `<mark>` elements replaces React's text node, leaving React's
     * HostText fiber pointing at a detached node. React then writes text into
     * that orphan (streamed output silently stops updating) and can throw
     * `NotFoundError: The node to be removed is not a child of this node` from
     * inside its own commit, where no caller-side try/catch can reach. The CSS
     * Custom Highlight API paints ranges without touching the tree at all.
     */
    function clearMarks() {
      if (!highlightApiAvailable()) return;
      try {
        CSS.highlights.delete(HIGHLIGHT_ALL);
        CSS.highlights.delete(HIGHLIGHT_CURRENT);
      } catch {
        /* registry may be unavailable during teardown */
      }
    }

    /**
     * Escape caller text so it is matched literally, with whitespace runs
     * matching any whitespace — the same semantics as DSH's own
     * `compileSessionTextFilter`.
     * @param query - raw caller input.
     * @returns A case-insensitive Unicode regular expression.
     */
    function compileQuery(query) {
      const parts = query.trim().split(/\s+/u).filter((p) => p.length > 0);
      if (parts.length === 0) return null;
      const pattern = parts
        .map((p) => p.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
        .join('\\s+');
      return new RegExp(pattern, 'giu');
    }

    /**
     * Build a short excerpt around the first match of `re` in `text`.
     * @param text - row text.
     * @param re - compiled query.
     * @returns Excerpt with a leading/trailing ellipsis when truncated.
     */
    function excerpt(text, re) {
      re.lastIndex = 0;
      const m = re.exec(text);
      if (m === null) return text.slice(0, 100);
      const start = Math.max(0, m.index - 32);
      const end = Math.min(text.length, m.index + m[0].length + 60);
      const body = text.slice(start, end).replace(/\s+/gu, ' ').trim();
      return (start > 0 ? '…' : '') + body + (end < text.length ? '…' : '');
    }

    /**
     * Collect every text node inside a row, in document order.
     * @param row - row element.
     * @returns Live text nodes.
     */
    function textNodesOf(row) {
      const SHOW_TEXT = typeof NodeFilter === 'undefined' ? 4 : NodeFilter.SHOW_TEXT;
      const ACCEPT = typeof NodeFilter === 'undefined' ? 1 : NodeFilter.FILTER_ACCEPT;
      const REJECT = typeof NodeFilter === 'undefined' ? 2 : NodeFilter.FILTER_REJECT;
      const walker = document.createTreeWalker(row, SHOW_TEXT, {
        acceptNode(node) {
          if (node.parentNode !== null && node.parentNode.nodeType === 1) {
            const tag = node.parentNode.tagName;
            if (tag === 'SCRIPT' || tag === 'STYLE') return REJECT;
          }
          return ACCEPT;
        },
      });
      const out = [];
      for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) out.push(n);
      return out;
    }

    /**
     * Build a `Range` per match in a row and register them as highlights.
     * @param row - target row.
     * @param re - compiled query.
     * @returns Match count and the first match's range.
     */
    function highlightRow(row, re) {
      const ranges = [];
      let first = null;
      for (const node of textNodesOf(row)) {
        const value = node.nodeValue ?? '';
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(value)) !== null) {
          if (m[0].length === 0) {
            re.lastIndex += 1;
            continue;
          }
          const range = document.createRange();
          range.setStart(node, m.index);
          range.setEnd(node, m.index + m[0].length);
          if (first === null) first = range;
          ranges.push(range);
        }
      }
      return { count: ranges.length, first, ranges };
    }

    /** localStorage key holding the last-used search scope. */
    const SCOPE_KEY = 'dsh.chatfind.scope';

    /**
     * Read the persisted scope preference.
     * @returns True when the user last chose the across-sessions scope.
     */
    function readScopePreference() {
      try {
        return window.localStorage?.getItem(SCOPE_KEY) === 'all';
      } catch {
        return false;
      }
    }

    /**
     * Persist the scope preference; storage may be unavailable, so failures are
     * non-fatal.
     * @param all - whether the across-sessions scope is selected.
     */
    function writeScopePreference(all) {
      try {
        window.localStorage?.setItem(SCOPE_KEY, all ? 'all' : 'session');
      } catch {
        /* preference is best-effort */
      }
    }

    /**
     * The session-header Find control.
     * @param props - session-scoped slot props plus this plugin's injections.
     * @returns The trigger button and, when open, the find panel.
     */    function ChatFindAction(props) {
      const { session, useSession, t } = props;
      // `SessionFace` is `ISession & ObservableSnapshot<SessionSnapshot>`, so the
      // snapshot half (hasMore / openState) is read through the standard selector
      // hook and the behavior verb (loadOlder) is called directly. When the
      // standard hook seat is unavailable, fall back to the snapshot's own
      // non-reactive reader so the panel degrades instead of crashing. When the
      // session face is missing entirely (a failed inject hand-off), every read
      // reports a cold window rather than throwing inside a slot render.
      const useFaceState =
        typeof useSession === 'function'
          ? useSession
          : (selector) =>
              selector(
                session !== undefined && typeof session.getSnapshot === 'function'
                  ? session.getSnapshot()
                  : { hasMore: false, openState: 'cold' },
              );
      const hasMore = useFaceState((state) => state.hasMore);
      const openState = useFaceState((state) => state.openState);
      const [open, setOpen] = React.useState(false);
      const [query, setQuery] = React.useState('');
      const [hits, setHits] = React.useState([]);
      const [cursor, setCursor] = React.useState(0);
      const [scanning, setScanning] = React.useState(false);
      const [scopeNote, setScopeNote] = React.useState('');
      // Scope is the user's choice and persists per browser.
      const [globalScope, setGlobalScope] = React.useState(() => readScopePreference());
      const [globalHits, setGlobalHits] = React.useState([]);
      const [globalError, setGlobalError] = React.useState('');
      // The host caps cross-session results, so an unqualified count can read as
      // "exactly N" when it is really "at most N".
      const [globalHasMore, setGlobalHasMore] = React.useState(false);
      /** Wraps the trigger only; the panel itself is portaled to `body`. */
      const rootRef = React.useRef(null);
      /** The trigger button, used as the anchor for the floating panel. */
      const triggerRef = React.useRef(null);
      /** The portaled panel, needed by the outside-click check. */
      const panelRef = React.useRef(null);
      const [panelPos, setPanelPos] = React.useState({ left: PANEL_MARGIN, top: PANEL_MARGIN });
      const inputRef = React.useRef(null);
      /** Owns the in-flight cross-session request so a newer query can supersede it. */
      const globalAbort = React.useRef(null);
      /** Live highlight ranges for the current query (never DOM nodes). */
      const rangesRef = React.useRef([]);

      const label = typeof t === 'function' ? t('find.title') : 'Find in conversation';

      /** Clear highlights and reset result state. */
      const reset = React.useCallback(() => {
        clearMarks();
        rangesRef.current = [];
        setHits([]);
        setCursor(0);
        setScopeNote('');
        setGlobalHits([]);
        setGlobalError('');
        setGlobalHasMore(false);
      }, []);

      /**
       * Scan resident rows, highlight matches, and publish the hit list.
       * @param text - the query to run.
       */
      const run = React.useCallback(
        (text) => {
          clearMarks();
          rangesRef.current = [];
          const re = compileQuery(text);
          if (re === null) {
            setHits([]);
            setCursor(0);
            setScopeNote('');
            return;
          }
          const rows = collectRows();
          const next = [];
          const allRanges = [];
          const canHighlight = highlightApiAvailable();
          for (const row of rows) {
            if (!canHighlight) {
              // No Highlight API: still list the hit, just without painting it.
              re.lastIndex = 0;
              const hitsInRow = (row.text.match(re) ?? []).length;
              if (hitsInRow === 0) continue;
              next.push({
                key: row.key,
                turn: row.turn,
                count: hitsInRow,
                excerpt: excerpt(row.text, re),
                el: row.el,
                first: null,
              });
              continue;
            }
            // Count from the DOM ranges, not from innerText: innerText inserts
            // newlines at block boundaries and collapses whitespace, so its count
            // can exceed what is actually paintable (a hit listed with no range).
            const { count, first, ranges } = highlightRow(row.el, re);
            if (count === 0) continue;
            allRanges.push(...ranges);
            next.push({
              key: row.key,
              turn: row.turn,
              count,
              excerpt: excerpt(row.text, re),
              el: row.el,
              first,
            });
          }
          rangesRef.current = allRanges;
          if (canHighlight && allRanges.length > 0) {
            try {
              CSS.highlights.set(HIGHLIGHT_ALL, new Highlight(...allRanges));
            } catch (error) {
              console.error('[chat-find] highlight registration failed:', error);
            }
          }
          setHits(next);
          setCursor(0);
          setScopeNote(
            next.length === 0
              ? hasMore
                ? '已加载部分没有匹配。更早的历史尚未载入。'
                : '本会话没有匹配。'
              : hasMore
                ? `已扫描 ${String(rows.length)} 行 · 更早历史未载入`
                : `已扫描 ${String(rows.length)} 行 · 整个会话已载入${canHighlight ? '' : '（本环境不支持高亮）'}`,
          );
        },
        [hasMore],
      );

      /**
       * Re-resolve a hit against the live DOM right before revealing it.
       *
       * `hits` is a scan-time snapshot and the transcript is React-owned: a
       * streaming answer can replace text nodes between the scan and the click,
       * detaching the cached Range (and the cached row, if the row was
       * rebuilt). A detached Range has zero geometry and would fall back to the
       * row-level reveal — the very bug this change fixes — so rebuild the match
       * from the live row by anchor key. `highlightRow` rescans one row, well
       * under the 0.2–3.5 ms the full-transcript scan costs.
       * @param hit - the cached hit.
       * @param text - the current query.
       * @returns The live row plus a fresh range (or the cached pair).
       */
      function refreshHit(hit, text) {
        let liveRow = hit.el;
        if (liveRow !== null && liveRow !== undefined && liveRow.isConnected === false) {
          liveRow = null;
          for (const row of document.querySelectorAll(ROW_SELECTOR)) {
            if (row.getAttribute('data-chat-anchor-key') === hit.key) {
              liveRow = row;
              break;
            }
          }
        }
        if (liveRow === null || liveRow === undefined) return { range: null, el: hit.el };
        if (hit.first !== null && hit.first !== undefined) {
          const start = hit.first.startContainer;
          // `isConnected === false` is the only reliable staleness signal; an
          // environment without the property cannot prove detachment.
          if (start !== null && start !== undefined && start.isConnected !== false) {
            return { range: hit.first, el: liveRow };
          }
        }
        const re = compileQuery(text);
        if (re === null) return { range: hit.first, el: liveRow };
        const fresh = highlightRow(liveRow, re);
        return { range: fresh.first, el: liveRow };
      }

      /**
       * Reveal the hit at `index` and make it the current highlight.
       *
       * The scroll target is the MATCH, not the owning row: a single turn row
       * can be several screens tall, so row-level centring can park the
       * viewport far from the clicked text (see {@link revealMatch}).
       * @param index - index into `hits`.
       */
      const focusHit = React.useCallback(
        (index) => {
          const hit = hits[index];
          if (hit === undefined) return;
          setCursor(index);
          // Re-resolve first: a stream re-render may have replaced the nodes
          // the cached range points at since the scan ran.
          const live = refreshHit(hit, query);
          // Promote the live range to the "current" highlight without touching
          // the DOM.
          if (highlightApiAvailable() && live.range !== null) {
            try {
              CSS.highlights.set(HIGHLIGHT_CURRENT, new Highlight(live.range));
            } catch {
              /* a stale range must not break navigation */
            }
          }
          revealMatch(live.range, live.el);
        },
        [hits, query],
      );

      /**
       * Run the across-sessions search through the existing `session.search`
       * Remote. That endpoint returns `{sessionId, snippet}` and reports a
       * business error when no `session-query` provider is mounted, so the
       * failure is surfaced verbatim instead of being swallowed.
       * @param text - the query to run.
       */
      const runGlobal = React.useCallback(async (text) => {
        const trimmed = text.trim();
        if (trimmed.length === 0) {
          setGlobalHits([]);
          setGlobalError('');
          return;
        }
        // Supersede the previous request instead of leaving it to race: the doc
        // for `search` names `signal` as cancellation for a superseded search.
        globalAbort.current?.abort();
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        globalAbort.current = controller;
        setScanning(true);
        setGlobalError('');
        try {
          if (pluginCtx === null) throw new Error('plugin context unavailable');
          const result = await pluginCtx.sessions.search(trimmed, controller?.signal);
          // A newer query already started; drop this stale response.
          if (globalAbort.current !== controller) return;
          if (result.ok) {
            setGlobalHits(result.value.items);
            setGlobalHasMore(result.value.hasMore === true);
          } else {
            setGlobalHits([]);
            setGlobalHasMore(false);
            setGlobalError(result.error.message);
          }
        } catch (error) {
          if (globalAbort.current !== controller) return;
          setGlobalHits([]);
          setGlobalHasMore(false);
          setGlobalError(String(error));
        } finally {
          if (globalAbort.current === controller) setScanning(false);
        }
      }, []);

      /**
       * Open one hit's session. `ISessions` has no `open()`; the shipped idiom is
       * the workspace navigation face, which is what ui-chat itself calls.
       */
      const openSession = React.useCallback((sessionId) => {
        try {
          pluginCtx.uiWorkspace.openSession(sessionId);
        } catch (error) {
          setGlobalError(`打开会话失败：${String(error)}`);
          return;
        }
        setOpen(false);
      }, []);

      // Debounced rescan; a submit or a navigation button forces an immediate one.
      React.useEffect(() => {
        if (!open) return undefined;
        const timer = setTimeout(() => {
          if (globalScope) {
            // Cross-session mode has no in-page highlights to maintain.
            clearMarks();
            rangesRef.current = [];
            setHits([]);
            setScopeNote('');
            void runGlobal(query);
          } else {
            setGlobalHits([]);
            setGlobalError('');
            run(query);
          }
        }, 150);
        return () => clearTimeout(timer);
      }, [open, query, run, runGlobal, globalScope]);

      // Drop highlights when the panel closes or the component unmounts.
      React.useEffect(
        () => () => {
          clearMarks();
        },
        [],
      );

      // Close on outside pointer press and on Escape. The panel lives in a
      // `body` portal, so `rootRef` alone is not enough: a pointerdown inside
      // the panel would read as "outside" and shut it before the click lands.
      React.useEffect(() => {
        if (!open) return undefined;
        const onPointer = (event) => {
          const insideTrigger =
            rootRef.current !== null && rootRef.current.contains(event.target);
          const insidePanel = panelRef.current !== null && panelRef.current.contains(event.target);
          if (!insideTrigger && !insidePanel) setOpen(false);
        };
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            setOpen(false);
          }
        };
        document.addEventListener('pointerdown', onPointer, true);
        document.addEventListener('keydown', onKey, true);
        return () => {
          document.removeEventListener('pointerdown', onPointer, true);
          document.removeEventListener('keydown', onKey, true);
        };
      }, [open]);

      React.useEffect(() => {
        if (open) inputRef.current?.focus();
      }, [open]);

      // Keep the fixed-position panel glued to the trigger while the window
      // resizes or the transcript scrolls beneath it. `setPanelPos` returns the
      // previous object when the coordinates are unchanged, so scroll churn
      // does not cause needless re-renders.
      React.useEffect(() => {
        if (!open) return undefined;
        const update = () => {
          const next = computePanelPosition(triggerRef.current);
          setPanelPos((prev) => (prev.left === next.left && prev.top === next.top ? prev : next));
        };
        update();
        window.addEventListener('resize', update);
        window.addEventListener('scroll', update, true);
        return () => {
          window.removeEventListener('resize', update);
          window.removeEventListener('scroll', update, true);
        };
      }, [open]);

      /** Pull one older page and rescan against the enlarged window. */
      const loadOlder = React.useCallback(async () => {
        setScanning(true);
        try {
          // A missing session face means the slot's inject hand-off failed;
          // say so instead of surfacing a bare TypeError.
          if (session === undefined || typeof session.loadOlder !== 'function') {
            throw new Error(
              session === undefined
                ? '会话句柄未就绪（slot inject 未提供 session）'
                : '会话句柄缺少 loadOlder()',
            );
          }
          // `loadOlder()` returns early — WITHOUT rejecting — when the window is
          // not `open`, when `hasMore` is false, or while another load runs. It
          // swallows transport failures into console.error. So a no-op is
          // indistinguishable from success here; surface the state instead of
          // implying the page loaded.
          if (openState !== 'open') {
            throw new Error(`历史窗口当前状态为 ${openState}，无法载入更早历史`);
          }
          const before = anchorRowCount();
          await session.loadOlder();
          // Allow React to commit the prepended page before scanning.
          await nextFrames(2);
          const after = anchorRowCount();
          if (after <= before) {
            throw new Error('没有载入到更早的历史（可能已到开头，或后端未返回新分页）');
          }
          run(query);
        } catch (error) {
          setScopeNote(`载入更早历史失败：${String(error)}`);
        } finally {
          setScanning(false);
        }
      }, [session, query, run, openState]);

      const next = React.useCallback(() => {
        if (hits.length === 0) return;
        focusHit((cursor + 1) % hits.length);
      }, [cursor, hits.length, focusHit]);

      const prev = React.useCallback(() => {
        if (hits.length === 0) return;
        focusHit((cursor - 1 + hits.length) % hits.length);
      }, [cursor, hits.length, focusHit]);

      const total = hits.reduce((sum, hit) => sum + hit.count, 0);

      const panelNode = open
        ? h(
            'div',
            {
              className: 'dshfind-panel',
              role: 'dialog',
              'aria-label': label,
              ref: panelRef,
              style: {
                left: `${String(panelPos.left)}px`,
                top: `${String(panelPos.top)}px`,
              },
            },
            h(
              'div',
              { className: 'dshfind-row' },
              h('input', {
                ref: inputRef,
                className: 'dshfind-input',
                type: 'text',
                value: query,
                placeholder: '查找文字（支持中文）',
                'aria-label': label,
                onChange: (event) => setQuery(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    if (globalScope) {
                      void runGlobal(query);
                      return;
                    }
                    run(query);
                    if (hits.length > 0) focusHit(event.shiftKey ? (cursor - 1 + hits.length) % hits.length : (cursor + 1) % hits.length);
                  }
                },
              }),
              h(
                'button',
                { className: 'dshfind-btn', type: 'button', onClick: prev, disabled: hits.length === 0, title: '上一处' },
                '↑',
              ),
              h(
                'button',
                { className: 'dshfind-btn', type: 'button', onClick: next, disabled: hits.length === 0, title: '下一处' },
                '↓',
              ),
            ),
            h(
              'div',
              { className: 'dshfind-row' },
              h(
                'label',
                { className: 'dshfind-scope' },
                h('input', {
                  type: 'checkbox',
                  checked: globalScope,
                  onChange: (event) => {
                    const next = event.target.checked;
                    setGlobalScope(next);
                    writeScopePreference(next);
                  },
                }),
                '搜索所有历史会话',
              ),
            ),
            h(
              'div',
              { className: 'dshfind-row' },
              h(
                'span',
                { className: 'dshfind-count' },
                query.trim().length === 0
                  ? '输入要查找的文字'
                  : globalScope
                    ? scanning
                      ? '正在搜索历史会话…'
                      : globalHits.length === 0
                        ? '0 个会话匹配'
                        : `${String(globalHits.length)} 个会话匹配`
                    : hits.length === 0
                      ? '0 处匹配'
                      : `${cursor + 1}/${hits.length} 处 · 共 ${total} 次`,
              ),
            ),
            globalScope
              ? globalHits.length > 0
                ? h(
                    'div',
                    { className: 'dshfind-hits' },
                    globalHits.map((hit) =>
                      h(
                        'button',
                        {
                          key: hit.sessionId,
                          className: 'dshfind-hit',
                          type: 'button',
                          title: '打开这个会话',
                          onClick: () => openSession(hit.sessionId),
                        },
                        h('span', { className: 'dshfind-hitTurn' }, hit.sessionId.slice(0, 12)),
                        hit.snippet,
                      ),
                    ),
                  )
                : globalError.length > 0
                  ? h('div', { className: 'dshfind-empty' }, `跨会话搜索不可用：${globalError}`)
                  : null
              : null,
            hits.length > 0 && !globalScope
              ? h(
                  'div',
                  { className: 'dshfind-hits' },
                  hits.map((hit, index) =>
                    h(
                      'button',
                      {
                        key: `${hit.key}:${String(index)}`,
                        className: 'dshfind-hit',
                        type: 'button',
                        'data-current': index === cursor ? 'true' : 'false',
                        onClick: () => focusHit(index),
                      },
                      h('span', { className: 'dshfind-hitTurn' }, `#${String(hit.turn)}`),
                      hit.excerpt,
                    ),
                  ),
                )
              : null,
            h(
              'div',
              { className: 'dshfind-foot' },
              h(
                'span',
                { className: 'dshfind-note' },
                globalScope
                  ? globalHasMore
                    ? '跨会话搜索使用宿主索引；结果已达上限，请缩小关键词 · 中文可能漏词'
                    : '跨会话搜索使用宿主索引；中文可能漏词'
                  : openState === 'error'
                    ? '历史窗口载入失败（openState=error），无法继续向前翻页'
                    : openState !== 'open'
                      ? `历史窗口状态：${openState}`
                      : scopeNote,
              ),
              // `loadOlder()` no-ops unless the window is fully open, so only
              // offer the control when it can actually do something.
              hasMore && !globalScope && openState === 'open'
                ? h(
                    'button',
                    { className: 'dshfind-btn', type: 'button', onClick: loadOlder, disabled: scanning },
                    scanning ? '载入中…' : '载入更早',
                  )
                : null,
            ),
          )
        : null;

      // Portal the panel out of the session header. Since DSH 0.2.2 the header
      // action slot is rendered inside `.titleCluster`, which sets
      // `overflow: clip` (and a fade mask): an in-place popup is clipped to a
      // ~30 px strip, so the trigger appears to do nothing at all.
      const panel =
        panelNode === null ? null : ReactDOM.createPortal(panelNode, document.body);

      return h(
        'span',
        { className: 'dshfind-root', ref: rootRef },
        h(
          'button',
          {
            className: 'dshfind-trigger',
            ref: triggerRef,
            type: 'button',
            title: label,
            'aria-label': label,
            'data-active': open ? 'true' : 'false',
            onClick: () => {
              if (open) {
                setOpen(false);
                reset();
              } else {
                // Anchor before the first paint: a portaled panel has no
                // in-flow position of its own, so the coordinates must be
                // known by the time it renders.
                setPanelPos(computePanelPosition(triggerRef.current));
                setOpen(true);
              }
            },
          },
          h(
            'svg',
            { width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': true, fill: 'none' },
            h('circle', { cx: 7, cy: 7, r: 4.5, stroke: 'currentColor', strokeWidth: 1.4 }),
            h('path', { d: 'M10.5 10.5 14 14', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
          ),
        ),
        panel,
      );
    }

    return {
      // `sessions` MUST be declared here. Cordis resolves a service off `ctx`
      // only when the plugin's own fiber injects it; otherwise the context
      // proxy throws `cannot get property "sessions" without inject`
      // (ReflectService.handler.get). `slots` alone is not enough — this was a
      // real shipped bug that broke both paging and cross-session search.
      inject: ['slots', 'sessions'],
      /**
       * Client plugin body: install styles and register the header control.
       * @param ctx - client root context.
       */
      apply(ctx) {
        pluginCtx = ctx;
        ctx.effect(installStyles, 'chat-find: stylesheet');
        // A throw while registering would blank the host's slot entry and leave
        // only a console line behind. Catch it so a failure is attributable to
        // this plugin instead of looking like a silently missing feature.
        try {
          ctx.slots.inject('conversation.session.header.actions', () =>
            ctx.slots.register(
              {
                name: 'conversation.session.header.actions',
                id: 'chat-find',
                order: 30,
                // SLOT INJECT CONTRACT: for a session-scoped slot the inject
                // face is called with the session id and must RETURN THE PROPS.
                // The renderer spreads the returned object verbatim
                // (`runInject` -> `bindInjectSources`, which passes a face with
                // no `hooks`/`keyedHooks` straight through), so returning a
                // lookup function makes `props.session` a function and breaks
                // `session.loadOlder()` with "is not a function". Dereference
                // HERE, exactly as the shipped registrants do.
                inject: (sessionId) => {
                  let session;
                  try {
                    session = ctx.sessions.binding(sessionId)?.session;
                  } catch (error) {
                    console.error('[chat-find] session lookup failed:', error);
                  }
                  return { session };
                },
              },
              ChatFindAction,
            ),
          );
        } catch (error) {
          console.error('[chat-find] failed to register the header action:', error);
        }
      },
    };
  },
});
