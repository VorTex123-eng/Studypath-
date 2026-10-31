/* Material Library save — CONVEX_URL production failure regression tests (2026-10-04).
 *
 * Root cause (audited, not guessed): the "CONVEX_URL is not set" error comes
 * from exactly one place — js/convex-client.js callConvex(), when
 * window.CONVEX_URL is falsy at call time. The save-to-library flow
 * (saveMaterialToLibrary in js/app.js) uses the single shared global Convex
 * client; there is no second config path, no bypass, no shadowing, and
 * nothing overwrites window.CONVEX_URL. So the failure meant the deployed
 * page load never executed js/convex-config.js with a URL (missing from the
 * deploy / stale placeholder / blocked script) — a deployment issue the old
 * code let surface in one flow instead of announcing app-wide.
 *
 * These tests lock in: (a) the client works when configured (functional vm
 * test), (b) the save flow uses the shared client, (c) there is exactly one
 * config path, (d) a missing config now fails loudly on every page via the
 * boot banner. Label: local tests — no real deployment.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');
const clientSrc = fs.readFileSync(path.join(ROOT, 'js', 'convex-client.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
const configSrc = fs.readFileSync(path.join(ROOT, 'js', 'convex-config.js'), 'utf8');

function loadClient(convexUrl) {
  const fetchCalls = [];
  const sandbox = {
    window: {},
    fetch: (url, opts) => {
      fetchCalls.push({ url, opts });
      return Promise.resolve({ json: () => Promise.resolve({ status: 'success', value: { id: 'm1' } }) });
    },
    console,
  };
  if (convexUrl !== undefined) sandbox.window.CONVEX_URL = convexUrl;
  vm.createContext(sandbox);
  vm.runInContext(clientSrc, sandbox, { filename: 'convex-client.js' });
  return { sandbox, fetchCalls, Convex: sandbox.window.Convex };
}

test('client: configured CONVEX_URL reaches the backend (mutation + query + action)', async () => {
  const { fetchCalls, Convex } = loadClient('https://demo-123.convex.cloud');
  const m = await Convex.mutation('materials:saveMaterial', { title: 'T' });
  assert.equal(m.ok, true);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, 'https://demo-123.convex.cloud/api/mutation');
  const body = JSON.parse(fetchCalls[0].opts.body);
  assert.equal(body.path, 'materials:saveMaterial');
  const q = await Convex.query('materials:listMaterials', {});
  assert.equal(fetchCalls[1].url, 'https://demo-123.convex.cloud/api/query');
  assert.equal(q.ok, true);
  const a = await Convex.action('tutor:sendMessage', {});
  assert.equal(fetchCalls[2].url, 'https://demo-123.convex.cloud/api/action');
  assert.equal(a.ok, true);
});

test('client: missing CONVEX_URL fails as not_configured with an actionable message, no fetch', async () => {
  const { fetchCalls, Convex } = loadClient(undefined);
  const res = await Convex.mutation('materials:saveMaterial', { title: 'T' });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'not_configured');
  assert.ok(res.error.message.includes('js/convex-config.js'), 'message names the file to check');
  assert.equal(fetchCalls.length, 0, 'no network attempt without a URL');
});

test('save flow uses the single shared Convex client (no second config path)', () => {
  const m = appSrc.match(/function saveMaterialToLibrary\(\)[\s\S]*?\n}\n/);
  assert.ok(m, 'saveMaterialToLibrary exists');
  assert.ok(m[0].includes("Convex.mutation('materials:saveMaterial'"), 'uses the shared global client');
  assert.ok(!m[0].includes('CONVEX_URL'), 'does not read config directly');
  assert.ok(!m[0].includes('fetch('), 'does not bypass the client with raw fetch');
});

test('exactly one Convex client and one config writer in the codebase', () => {
  const jsDir = path.join(ROOT, 'js');
  const files = fs.readdirSync(jsDir).filter((f) => f.endsWith('.js'));
  const definers = files.filter((f) => {
    const s = fs.readFileSync(path.join(jsDir, f), 'utf8');
    return /global\.Convex\s*=/.test(s);
  });
  assert.deepEqual(definers, ['convex-client.js'], 'one client definition');
  const writers = files.filter((f) => {
    const s = fs.readFileSync(path.join(jsDir, f), 'utf8');
    return /window\.CONVEX_URL\s*=/.test(s);
  });
  assert.deepEqual(writers, ['convex-config.js'], 'one config writer');
  assert.ok(/window\.CONVEX_URL\s*=\s*'https:\/\//.test(configSrc), 'config file carries a real URL');
});

test('boot check: missing config shows an app-wide banner (init fails loudly)', () => {
  assert.ok(appSrc.includes('if (!window.CONVEX_URL)'), 'init checks the config');
  assert.ok(appSrc.includes('js/convex-config.js</b> was deployed'), 'banner names the deployed file');
});

/* ---------------- Malformed script tags (2026-10-04 root cause) ----------------
 * An unclosed <script src="..."> swallows every following <script> tag as
 * inline text until the next </script>, so convex-config.js never executes
 * and window.CONVEX_URL stays undefined — while the URL sits correctly in
 * the file. This shipped on create.html + settings.html via the disclosure
 * change and broke Save to Library (and would break all Convex calls on
 * those pages). These guards parse every HTML page like a browser would.
 */

const { execSync } = require('node:child_process');

function scriptTags(html) {
  // Returns [{attrs, closed}] for each <script ...> open tag: closed is
  // true only when </script> comes before any other <script> open tag,
  // mirroring the HTML parser's script-data state.
  const out = [];
  const re = /<script\b([^>]*)>/g;
  let m;
  while ((m = re.exec(html))) {
    const rest = html.slice(m.index + m[0].length);
    const close = rest.indexOf('</script>');
    const nextOpen = rest.search(/<script\b/);
    out.push({
      tag: m[0].slice(0, 80),
      hasSrc: /src=/.test(m[1]),
      properlyClosed: close !== -1 && (nextOpen === -1 || close < nextOpen),
    });
  }
  return out;
}

test('every HTML page: all external scripts are properly closed', () => {
  const pages = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'));
  assert.ok(pages.length >= 10, `expected all pages, found ${pages.length}`);
  const bad = [];
  for (const p of pages) {
    const html = fs.readFileSync(path.join(ROOT, p), 'utf8');
    for (const t of scriptTags(html)) {
      if (t.hasSrc && !t.properlyClosed) bad.push(`${p}: ${t.tag}`);
    }
  }
  assert.deepEqual(bad, [], 'no swallowed script tags on any page');
});

test('create.html + settings.html: convex scripts load in dependency order', () => {
  for (const p of ['create.html', 'settings.html']) {
    const html = fs.readFileSync(path.join(ROOT, p), 'utf8');
    const srcs = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
    for (const need of ['js/convex-config.js', 'js/convex-client.js', 'js/app.js']) {
      assert.ok(srcs.includes(need), `${p} loads ${need}`);
    }
    assert.ok(
      srcs.indexOf('js/convex-config.js') < srcs.indexOf('js/convex-client.js') &&
      srcs.indexOf('js/convex-client.js') < srcs.indexOf('js/app.js'),
      `${p}: config -> client -> app order`
    );
  }
});
