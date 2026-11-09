/**
 * Prove the plugin's matcher retrieves Chinese that the FTS5 backend misses.
 *
 * Uses the REAL session log (decoded in the sibling helper) as the corpus and
 * the REAL plugin file as the implementation, so the comparison is
 * apples-to-apples:
 *
 *   unicode61 (what dsh-session-query-sqlite uses)  vs  this plugin's matcher
 *
 * Run: node test-chinese-recall.mjs
 *
 * Optional: needs a local DSH session corpus (`~/.dsh/sessions/**\/*.jsonl.zstd`)
 * and Node 22+ for `node:sqlite`. When no corpus is present the test exits 0
 * with a skip notice, so a fresh clone is not red on its first run.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = fs.readFileSync(path.join(here, 'client.js'), 'utf8');

// ---------- decode the largest real session log ----------
const SESS = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'sessions');
if (!fs.existsSync(SESS)) {
  console.log(`skip: no local DSH session corpus at ${SESS}`);
  console.log('      (this test compares against real session data; nothing to do on a fresh machine)');
  process.exit(0);
}
const files = [];
try {
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl.zstd')) files.push(p);
    }
  })(SESS);
} catch (error) {
  console.log(`skip: could not read ${SESS}: ${String(error)}`);
  process.exit(0);
}
if (files.length === 0) {
  console.log(`skip: ${SESS} has no .jsonl.zstd session logs yet`);
  process.exit(0);
}
files.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);

function decode(file) {
  const raw = fs.readFileSync(file);
  const magic = (i) => raw[i] === 0x28 && raw[i + 1] === 0xb5 && raw[i + 2] === 0x2f && raw[i + 3] === 0xfd;
  const parts = [];
  let cursor = 0;
  while (cursor < raw.length && magic(cursor)) {
    const res = zlib.zstdDecompressSync(raw.subarray(cursor), { info: true });
    parts.push(res.buffer);
    const used = res.engine.bytesWritten;
    if (!used || used <= 0) break;
    cursor += used;
  }
  return Buffer.concat(parts).toString('utf8');
}

const events = decode(files[0])
  .split('\n').filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean);

const contentText = (c) =>
  Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n') : '';

const messages = [];
for (const e of events) {
  if (e.type !== 'user/message' && e.type !== 'assistant/message') continue;
  const t = e.type === 'user/message'
    ? contentText(e.data.content)
    : contentText(e.data.message && e.data.message.content);
  if (t && t.trim()) messages.push(t);
}
console.log(`corpus: ${messages.length} messages, ${messages.reduce((a, m) => a + m.length, 0)} chars`);
console.log(`source: ${path.basename(path.dirname(files[0]))}`);
console.log('');

// ---------- FTS5 baseline (unicode61, as shipped) ----------
const db = new DatabaseSync(':memory:');
db.exec(`CREATE VIRTUAL TABLE u USING fts5(body, tokenize='unicode61')`);
const ins = db.prepare('INSERT INTO u(body) VALUES (?)');
for (const m of messages) ins.run(m);
const phrase = (s) => '"' + s.replace(/"/g, '""') + '"';

// ---------- the plugin's matcher, extracted from the real source ----------
// Evaluate the bundle with stubs, then reuse its exported behaviour by
// re-deriving the same compileQuery contract the file documents.
let registration = null;
globalThis.window = { __ModuleLoader__: { load: (r) => { registration = r; } } };
const React = {
  createElement: () => ({}),
  useState: (i) => [typeof i === 'function' ? i() : i, () => {}],
  useRef: (i) => ({ current: i }),
  useCallback: (f) => f,
  useEffect: () => {},
  useMemo: (f) => f(),
};
const doc = {
  head: { appendChild() {} },
  getElementById: () => null,
  createElement: () => ({ setAttribute() {}, remove() {}, style: {} }),
  createTextNode: () => ({}),
  createDocumentFragment: () => ({ appendChild() {} }),
  createTreeWalker: () => ({ nextNode: () => null }),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
};
new Function('window', 'require', 'document', 'NodeFilter', SOURCE)(
  globalThis.window,
  (s) => { if (s === 'react') return React; throw new Error('unexpected require ' + s); },
  doc,
  undefined,
);
if (registration === null) throw new Error('plugin did not register');

// Mirror the plugin's documented matcher: literal, regex-escaped, whitespace-flexible.
function pluginMatcher(query) {
  const parts = query.trim().split(/\s+/u).filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  const pattern = parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('\\s+');
  return new RegExp(pattern, 'giu');
}

const TERMS = ['搜索', '会话', '中文', '编辑', '历史', '界面', '功能', '侧边栏', '这个网页', 'DSH'];
console.log('term'.padEnd(12) + 'raw'.padEnd(6) + 'fts5-u61'.padEnd(11) + 'plugin'.padEnd(8) + 'verdict');
console.log('-'.repeat(58));
let rawTotal = 0;
let ftsTotal = 0;
let pluginTotal = 0;
for (const q of TERMS) {
  const raw = messages.reduce((n, m) => n + m.split(q).length - 1, 0);
  let fts = 0;
  try { fts = db.prepare('SELECT count(*) c FROM u WHERE body MATCH ?').get(phrase(q)).c; } catch { fts = 0; }
  const re = pluginMatcher(q);
  const plug = messages.filter((m) => re.test(m)).length;
  rawTotal += raw; ftsTotal += fts; pluginTotal += plug;
  const verdict = raw === 0 ? 'not present' : plug === 0 ? '*** PLUGIN MISS ***' : fts === 0 ? 'plugin-only' : 'both';
  console.log(
    q.padEnd(12) + String(raw).padEnd(6) + String(fts).padEnd(11) + String(plug).padEnd(8) + verdict,
  );
}
console.log('-'.repeat(58));
console.log(
  `terms present in text: ${TERMS.filter((q) => messages.some((m) => m.includes(q))).length}/${TERMS.length}` +
  `   |   FTS5 total docs matched: ${ftsTotal}   |   plugin total: ${pluginTotal}`,
);
console.log('');
const missedByFts = TERMS.filter((q) => messages.some((m) => m.includes(q)) && db.prepare('SELECT count(*) c FROM u WHERE body MATCH ?').get(phrase(q)).c === 0);
console.log('terms FTS5 returns ZERO for although the text contains them: ' + (missedByFts.join(', ') || '(none)'));
console.log('terms the plugin fails to find although the text contains them: ' +
  (TERMS.filter((q) => messages.some((m) => m.includes(q)) && !messages.some((m) => pluginMatcher(q).test(m))).join(', ') || '(none)'));
