/**
 * Reproduce the host's own package-resolution path for this bundle.
 *
 * WHY THIS EXISTS — it caught a real, silent failure:
 * `dsh-client-modules.locatePkgJson()` resolves the mounted row's specifier as
 * `${specifier}/package.json` through Node's `exports` map. A manifest without
 * a `"./package.json"` export therefore makes the CLIENT-module scan fail with
 * ERR_PACKAGE_PATH_NOT_EXPORTED — after the host half has already loaded. The
 * result is a plugin that runs on the host and renders nothing, with no
 * user-visible error. `exports` is enforced, so shipping the file is not enough.
 *
 * The official decoration template omits that export, which is why copying it
 * verbatim is not sufficient for a real package.
 *
 * Run: node test-host-resolution.mjs
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const pkg = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8'));
const spec = pkg.name;

// A `require` anchored at this directory mirrors the loader's resolution base
// (the row's host half is imported from this package's own root).
const req = createRequire(path.join(here, 'index.js'));

// 1) the loader must be able to resolve the row's module specifier
let hostEntry = null;
try { hostEntry = req.resolve(spec); } catch (e) { hostEntry = null; }
check('host half resolves from the package specifier', hostEntry !== null, hostEntry ?? 'unresolved');

// 2) THE REGRESSION: the client scan resolves `${spec}/package.json`
let manifest = null;
let manifestError = null;
try { manifest = req.resolve(`${spec}/package.json`); } catch (e) { manifestError = e; }
check(
  'client scan can resolve <package>/package.json (exports must list it)',
  manifest !== null,
  manifestError ? manifestError.code ?? manifestError.message : manifest,
);

// 3) the declaration the scan reads must be present and web-platform
check('manifest declares dsh.client.platform', pkg.dsh?.client?.platform === 'web', pkg.dsh?.client?.platform);

// 4) the scan throws if dsh.client exists without a ./client export
const clientRel = pkg.exports?.['./client'];
check('manifest exports ./client', typeof clientRel === 'string', String(clientRel));
check(
  'client bundle file exists next to the manifest',
  typeof clientRel === 'string' && fs.existsSync(path.join(here, clientRel)),
);

// 5) the bundle patch the loader applies must exist and insert this package
const patchRel = pkg.dsh?.bundle?.patch;
check('manifest declares dsh.bundle.patch', typeof patchRel === 'string', String(patchRel));
if (typeof patchRel === 'string') {
  const patchPath = path.join(here, patchRel);
  check('bundle patch file exists', fs.existsSync(patchPath), patchRel);
  if (fs.existsSync(patchPath)) {
    const patch = fs.readFileSync(patchPath, 'utf8');
    check('bundle patch inserts this package name', patch.includes(`'${spec}'`), spec);
  }
}

// 6) the client bundle must register under an id equal to the package name,
//    because the loader keys factories by that id.
const bundle = fs.readFileSync(path.join(here, clientRel), 'utf8');
check('client bundle loads via window.__ModuleLoader__', bundle.includes('window.__ModuleLoader__.load('));
check(
  'client bundle registration id equals the package name',
  bundle.includes(`id: '${spec}'`) || bundle.includes(`id: "${spec}"`),
  spec,
);

// 7) REGRESSION: a slot registers exactly once per (name, id, priority).
//    `conversation.session.header.actions` is kind:"list" and throws
//    `already has an entry with id "..."` on a second registration — so this
//    bundle must be mounted EXACTLY ONCE. Two mounts happened in practice: the
//    package was listed in the profile's `dsh.profile.bundles` (which applies
//    the package's own patch) *and* the same row was hand-inserted into the
//    profile's `cordis.patch.yml`. The managed bundle route is authoritative;
//    nothing should also hand-insert the row.
check(
  'bundle patch inserts exactly one row',
  (() => {
    // Count only uncommented list entries: one `- id:` plus its `name:` line.
    const active = fs
      .readFileSync(path.join(here, patchRel), 'utf8')
      .split('\n')
      .filter((l) => /^\s+(?:-\s+id:|name:)/.test(l));
    return active.length === 2;
  })(),
  'one id + one name line expected',
);

const failed = results.filter((r) => !r.ok);
console.log('');
console.log(`${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  for (const f of failed) console.log('  FAILED: ' + f.name + (f.detail ? ': ' + f.detail : ''));
  process.exit(1);
}
