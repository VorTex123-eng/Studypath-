/* Gemini free-tier disclosure regression tests (2026-10-03).
 *
 * Covers the compliance brief: config switch, privacy page (static free
 * paragraph + paid swap), Create-page notice visibility rules, Settings
 * sentence, and structural no-overflow guards. Label: local tests against
 * the real module code with stubbed DOM/backend — no real deployment.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');
const privacySrc = fs.readFileSync(path.join(ROOT, 'privacy.html'), 'utf8');

/* ------------------------------------------------------------------ */
/* 1. Config switch                                                    */
/* ------------------------------------------------------------------ */

test('config: geminiPlan switch exists and defaults to free', () => {
  const src = fs.readFileSync(path.join(ROOT, 'js', 'site-config.js'), 'utf8');
  assert.ok(src.includes("geminiPlan: 'free'"), 'switch present, set to free');
  nodeCheck(src);
});

function nodeCheck(src) {
  // site-config.js must stay a plain script (no modules) so every page can load it.
  assert.ok(!src.includes('import ') && !src.includes('export '), 'plain script, no module syntax');
}

/* ------------------------------------------------------------------ */
/* 2. Privacy page                                                     */
/* ------------------------------------------------------------------ */

function geminiParagraph() {
  const m = privacySrc.match(/<p id="geminiPlanNote">[\s\S]*?<\/p>/);
  assert.ok(m, 'geminiPlanNote paragraph exists');
  return m[0];
}

test('privacy: free paragraph present in static HTML (JS-disabled baseline)', () => {
  const p = geminiParagraph();
  assert.ok(p.includes('<b>Free Gemini plan.</b>'), 'free heading');
  assert.ok(p.includes('Google may use the text we send and the questions it returns to improve its products and machine-learning technologies'), 'data-use disclosure');
  assert.ok(p.includes('people at Google may review it'), 'human review disclosure');
  assert.ok(p.includes('Please do not upload material that is private, confidential'), 'private-material warning');
  assert.ok(p.includes('If we move to Google&rsquo;s paid tier'), 'paid-tier forward note');
  assert.ok(!/EEA|Switzerland/.test(p), 'no EEA/Switzerland claims');
  assert.ok(!/\bUK\b/.test(p.replace(/Google&rsquo;s/g, '')), 'no UK claims');
  assert.ok(privacySrc.includes('Last updated: 3 October 2026'), 'date updated');
});

test('privacy: free paragraph sits right after the Gemini API paragraph', () => {
  const apiIdx = privacySrc.indexOf('Google handles that data under its own terms and privacy policy for the Gemini API.');
  const noteIdx = privacySrc.indexOf('id="geminiPlanNote"');
  assert.ok(apiIdx !== -1 && noteIdx !== -1 && noteIdx > apiIdx, 'ordering');
  assert.ok(noteIdx - apiIdx < 120, 'directly after (no other content between)');
});

function runPaidSwap(plan) {
  const m = privacySrc.match(/<script>\s*\/\/ Gemini plan disclosure[\s\S]*?<\/script>/);
  assert.ok(m, 'paid swap script exists');
  const body = m[0].replace(/^<script>/, '').replace(/<\/script>$/, '');
  const el = { innerHTML: geminiParagraph() };
  const sandbox = {
    window: { STUDYPATH_SITE: { geminiPlan: plan } },
    document: { getElementById: (id) => (id === 'geminiPlanNote' ? el : null) },
  };
  vm.createContext(sandbox);
  vm.runInContext(body, sandbox, { filename: 'privacy-swap.js' });
  return el.innerHTML;
}

test('privacy: paid plan swaps in the paid paragraph', () => {
  const html = runPaidSwap('paid');
  assert.ok(html.includes('<b>Paid Gemini plan.</b>'), 'paid heading');
  assert.ok(html.includes('Google does not use the text we send, or the questions it returns, to improve its products'), 'paid wording');
  assert.ok(!html.includes('Free Gemini plan'), 'free paragraph gone');
  assert.ok(!html.includes('may use the text'), 'no free-tier disclosure remains');
});

test('privacy: free plan (or missing config) keeps the static paragraph', () => {
  assert.ok(runPaidSwap('free').includes('Free Gemini plan'), 'free keeps static copy');
  assert.ok(runPaidSwap(undefined).includes('Free Gemini plan'), 'missing config keeps static copy');
});

/* ------------------------------------------------------------------ */
/* 3 & 4. Create-page notice + Settings sentence (sandboxed app.js)   */
/* ------------------------------------------------------------------ */

function memStore() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

function fakeEl() {
  const el = {
    innerHTML: '',
    textContent: '',
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    getAttribute() { return null; },
    click() {},
    querySelector() { return fakeEl(); },
    querySelectorAll() { return []; },
  };
  return el;
}

function loadApp({ plan = 'free', loggedIn = false } = {}) {
  const localStorage = memStore();
  const sessionStorage = memStore();
  const els = {};
  const sandbox = {
    console,
    localStorage,
    sessionStorage,
    navigator: {},
    location: { href: '' },
    window: null,
    document: {
      addEventListener() {},
      querySelector(sel) { return els[sel] || (els[sel] = fakeEl()); },
      querySelectorAll() { return []; },
      createElement() { return fakeEl(); },
      getElementById(id) { return els['#' + id] || (els['#' + id] = fakeEl()); },
      documentElement: { dataset: {} },
    },
    Material: { get: () => ({ status: 'empty' }), isReady: () => false, reset() {}, escapeHtml: (s) => String(s == null ? '' : s) },
    Auth: { isLoggedIn: () => loggedIn, getToken: () => null },
    QuizGen: { sampleBankSize: () => 10 },
    Convex: {
      query: async () => ({ ok: true, data: { ok: true, materials: [] } }),
      mutation: async () => ({ ok: true, data: { ok: true } }),
    },
  };
  sandbox.window = sandbox;
  sandbox.window.STUDYPATH_SITE = { geminiPlan: plan, contactEmail: 't@t.t' };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8'), ctx, { filename: 'app.js' });
  return { ctx, els };
}

const NOTICE_SNIPPET = 'Your text is sent to Google';

function renderCreateHtml(opts, tab, mode) {
  const { ctx, els } = loadApp(opts);
  vm.runInContext(`draft = defaultDraft(); draft.tab = ${JSON.stringify(tab)}; draft.mode = ${JSON.stringify(mode)};`, ctx);
  vm.runInContext('renderCreate()', ctx);
  return els.main.innerHTML;
}

test('create: no Google AI notice paragraph on any tab (intentionally removed 2026-10-06)', () => {
  for (const tab of ['file', 'paste', 'library', 'sample']) {
    for (const mode of ['study', 'flashcards']) {
      const html = renderCreateHtml({ plan: 'free', loggedIn: true }, tab, mode);
      assert.ok(!html.includes('data-gemini-notice'), `no notice element (${tab}/${mode})`);
      assert.ok(!html.includes(NOTICE_SNIPPET), `no notice copy (${tab}/${mode})`);
    }
  }
});

test('create: geminiNoticeMarkup helper is gone (no dead code)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
  assert.ok(!/function geminiNoticeMarkup/.test(src), 'helper removed');
});

test('settings: Your-data sentence gains the free-plan addition', () => {
  const { ctx, els } = loadApp({ plan: 'free' });
  vm.runInContext('renderAccountPanel = function () {};', ctx); // stub async account lookup
  vm.runInContext('settings()', ctx);
  const html = els.main.innerHTML;
  assert.ok(html.includes('On our current free plan, Google may use it to improve its products.'), 'addition present on free plan');
  assert.ok(html.includes('Privacy Policy'), 'privacy link kept');
});

test('settings: sentence unchanged on the paid plan', () => {
  const { ctx, els } = loadApp({ plan: 'paid' });
  vm.runInContext('renderAccountPanel = function () {};', ctx);
  vm.runInContext('settings()', ctx);
  const html = els.main.innerHTML;
  assert.ok(!html.includes('On our current free plan'), 'no free-plan addition on paid plan');
  assert.ok(html.includes('sent to an AI service to write the questions'), 'base sentence intact');
});

/* ------------------------------------------------------------------ */
/* 5. Structural no-overflow guards (static; real-device check is      */
/*    Eghosa-side — see report)                                       */
/* ------------------------------------------------------------------ */

test('css: .sub (the notice class) is a wrapping, theme-aware block', () => {
  const css = fs.readFileSync(path.join(ROOT, 'css', 'styles.css'), 'utf8');
  const m = css.match(/\.sub\{[^}]*\}/);
  assert.ok(m, '.sub rule exists');
  assert.ok(!/nowrap/.test(m[0]), '.sub does not nowrap');
  assert.ok(/var\(--muted\)/.test(m[0]), '.sub uses the theme-aware muted color (dark mode safe)');
});

test('create/settings pages load the config script before app.js', () => {
  for (const p of ['create.html', 'settings.html', 'privacy.html']) {
    const html = fs.readFileSync(path.join(ROOT, p), 'utf8');
    const cfg = html.indexOf('js/site-config.js');
    const app = html.indexOf('js/app.js');
    assert.ok(cfg !== -1 && app !== -1 && cfg < app, `${p}: site-config.js loads before app.js`);
  }
});
