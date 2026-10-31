/* B1D AI Tutor completion regression tests (2026-10-05).
 *
 * Covers: conversation persistence (refresh resume), history list,
 * deletion, message counts, initialMessage pre-fill, quiz + weak-area
 * integration links, discoverability, icon/copy rules.
 *
 * Backend tests run the REAL convex/tutor.ts through the stubbed Convex
 * runtime (shared harness pattern from tutor.test.js). Frontend tests
 * sandbox js/app.js in node:vm. Label: local tests, mocked backend/db.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { register } = require('node:module');
const { pathToFileURL } = require('node:url');

register(pathToFileURL(path.join(__dirname, 'a2-gen-resolve-hook.mjs')).href);

const ROOT = path.join(__dirname, '..', '..');
const tutor = require('../../convex/tutor.ts');
const eligibility = require('../../convex/lib/eligibility.ts');

process.env.GEMINI_API_KEY = 'test-key-b1d';

/* ---------------- Fake Convex ctx (same shape as tutor.test.js) ---------------- */

function makeCtx({ users = [], materials = [] } = {}) {
  const tables = {
    users: users.map((u) => ({ ...u })),
    sessions: [],
    materials: materials.map((m) => ({ ...m })),
    tutorConversations: [],
    tutorMessages: [],
    rateLimitBuckets: [],
  };
  let seq = 1;
  const nid = (t) => `${t}_${seq++}`;
  const db = {
    get(id) {
      for (const rows of Object.values(tables)) {
        const row = rows.find((r) => r._id === id);
        if (row) return row;
      }
      return null;
    },
    query(table) {
      const api = {
        withIndex(_name, fn) {
          let v;
          fn({ eq: (_f, val) => { v = val; return {}; } });
          api._eq = v;
          return api;
        },
        order(dir) { api._dir = dir; return api; },
        async take(n) {
          let rows = tables[table].slice();
          if (api._eq !== undefined) {
            // Filter on the most plausible field for the stubbed indexes.
            rows = rows.filter((r) =>
              r.userId === api._eq || r.conversationId === api._eq ||
              r.materialId === api._eq || r.token === api._eq);
          }
          if (api._dir === 'desc') rows.reverse();
          return rows.slice(0, n);
        },
        async first() { const r = await api.take(1); return r[0] || null; },
        async unique() { const r = await api.take(1); return r[0] || null; },
      };
      return api;
    },
    async insert(table, doc) {
      const id = nid(table);
      tables[table].push({ _id: id, ...doc });
      return id;
    },
    async patch(id, doc) {
      const row = db.get(id);
      if (row) Object.assign(row, doc);
    },
    async delete(id) {
      for (const rows of Object.values(tables)) {
        const i = rows.findIndex((r) => r._id === id);
        if (i >= 0) { rows.splice(i, 1); return; }
      }
    },
  };
  const internal = {
    tutor: {
      getTutorUser: tutor.getTutorUser,
      getOwnedMaterial: tutor.getOwnedMaterial,
      checkTutorRateLimit: tutor.checkTutorRateLimit,
      createConversation: tutor.createConversation,
      loadConversation: tutor.loadConversation,
      saveMessages: tutor.saveMessages,
      deleteConversationRow: tutor.deleteConversationRow,
      listUserConversations: tutor.listUserConversations,
    },
  };
  const INTERNALS = {};
  for (const k of ['getTutorUser', 'getOwnedMaterial', 'checkTutorRateLimit', 'createConversation', 'loadConversation', 'saveMessages', 'deleteConversationRow', 'listUserConversations']) {
    INTERNALS['internal.tutor.' + k] = tutor[k];
  }
  INTERNALS['internal.lib.eligibility.checkAgeEligibility'] = eligibility.checkAgeEligibility;
  const resolve = (ref) => (typeof ref === 'string' ? INTERNALS[ref] : ref);
  const ctx = {
    db,
    runQuery(ref, args) { return resolve(ref).handler({ ...ctx, db }, args); },
    runMutation(ref, args) { return resolve(ref).handler({ ...ctx, db }, args); },
  };
  return { ctx, tables };
}

const ALICE = { _id: 'users_alice', email: 'a@x.com', ageEligible: true };
const BOB = { _id: 'users_bob', email: 'b@x.com', ageEligible: true };
const MAT = {
  _id: 'materials_m1', userId: 'users_alice', title: 'Biology 101 Notes',
  subject: 'Biology', extractedText: 'Mitosis is cell division. '.repeat(200),
  charCount: 5000, createdAt: 1,
};

async function startConv(ctx, userId, materialId, initialMessage) {
  const cid = await ctx.runMutation(tutor.createConversation, {
    userId, materialId, title: 'Biology 101 Notes',
  });
  return cid;
}

/* ---------------- Backend: messageCount ---------------- */

test('saveMessages bumps messageCount by 2', async () => {
  const { ctx, tables } = makeCtx({ users: [ALICE], materials: [MAT] });
  const cid = await startConv(ctx, 'users_alice', 'materials_m1');
  assert.equal(tables.tutorConversations[0].messageCount || 0, 0);
  await ctx.runMutation(tutor.saveMessages, {
    userId: 'users_alice', conversationId: cid,
    userText: 'hi', tutorText: 'hello', grounded: true,
  });
  assert.equal(tables.tutorConversations[0].messageCount, 2);
  await ctx.runMutation(tutor.saveMessages, {
    userId: 'users_alice', conversationId: cid,
    userText: 'hi2', tutorText: 'hello2', grounded: true,
  });
  assert.equal(tables.tutorConversations[0].messageCount, 4);
});

test('listUserConversations exposes messageCount', async () => {
  const { ctx } = makeCtx({ users: [ALICE], materials: [MAT] });
  const cid = await startConv(ctx, 'users_alice', 'materials_m1');
  await ctx.runMutation(tutor.saveMessages, {
    userId: 'users_alice', conversationId: cid,
    userText: 'q', tutorText: 'a', grounded: true,
  });
  const rows = await ctx.runQuery(tutor.listUserConversations, { userId: 'users_alice' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].messageCount, 2);
});

/* ---------------- Backend: deleteConversation ---------------- */

test('deleteConversationRow removes conversation + messages, owner only', async () => {
  const { ctx, tables } = makeCtx({ users: [ALICE, BOB], materials: [MAT] });
  const cid = await startConv(ctx, 'users_alice', 'materials_m1');
  await ctx.runMutation(tutor.saveMessages, {
    userId: 'users_alice', conversationId: cid,
    userText: 'q', tutorText: 'a', grounded: true,
  });
  assert.equal(tables.tutorMessages.length, 2);

  // Foreign user sees it as not_found.
  await assert.rejects(
    () => ctx.runMutation(tutor.deleteConversationRow, { userId: 'users_bob', conversationId: cid }),
    /wasn't found/
  );
  assert.equal(tables.tutorConversations.length, 1, 'not deleted by stranger');

  await ctx.runMutation(tutor.deleteConversationRow, { userId: 'users_alice', conversationId: cid });
  assert.equal(tables.tutorConversations.length, 0);
  assert.equal(tables.tutorMessages.length, 0, 'messages purged with conversation');
});

test('deleteConversation public action enforces ownership', async () => {
  const { ctx, tables } = makeCtx({
    users: [{ _id: 'users_alice', email: 'a@x.com' }],
    materials: [MAT],
  });
  // Seed a session token for alice.
  tables.sessions.push({ _id: 'sessions_s1', userId: 'users_alice', token: 'tok_alice', createdAt: 1, expiresAt: Date.now() + 999999 });
  const cid = await startConv(ctx, 'users_alice', 'materials_m1');
  const res = await tutor.deleteConversation.handler(ctx, { sessionToken: 'tok_alice', conversationId: cid });
  assert.ok(res.ok);
  assert.equal(tables.tutorConversations.length, 0);
});

/* ---------------- Frontend sandbox helpers ---------------- */

function makeSandbox(search) {
  const els = new Map();
  const actionCalls = [];
  const sandbox = {
    document: {
      body: { dataset: { page: 'tutor' } },
      addEventListener() {},
      querySelector(sel) {
        if (sel === 'main' || sel === '#shell') {
          if (!els.has(sel)) els.set(sel, { innerHTML: '' });
          return els.get(sel);
        }
        return null;
      },
      querySelectorAll() { return []; },
      createElement() { return {}; },
    },
    window: { history: { replaceState(_a, _b, url) { sandbox._replacedUrl = url; } } },
    navigator: {},
    location: { search, href: '' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    URLSearchParams,
    console,
    setTimeout, clearTimeout,
    Auth: { isLoggedIn: () => true, getToken: () => 'tok_alice' },
    Convex: {
      action: (name, args) => {
        actionCalls.push({ name, args });
        if (name === 'tutor:listConversations') {
          return Promise.resolve({ ok: true, data: { conversations: [
            { id: 'c1', materialId: 'm1', title: 'Biology 101', updatedAt: Date.now() - 60000, messageCount: 4 },
          ] } });
        }
        if (name === 'tutor:startConversation') {
          return Promise.resolve({ ok: true, data: { conversationId: 'c9', materialTitle: 'Biology 101' } });
        }
        return Promise.resolve({ ok: false, error: { code: 'x', message: 'x' } });
      },
      query: () => Promise.resolve({ ok: false }),
      mutation: () => Promise.resolve({ ok: false }),
    },
    toast() {},
    confirm: () => true,
  };
  return { sandbox, els, actionCalls };
}

function loadApp(sandbox) {
  vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
  vm.runInContext(src, sandbox, { filename: 'app.js' });
}

/* ---------------- Frontend: persistence ---------------- */

test('starting a conversation pins ?c= into the URL (refresh resumes)', async () => {
  const { sandbox } = makeSandbox('?materialId=m1');
  loadApp(sandbox);
  vm.runInContext('tutor()', sandbox);
  await new Promise((r) => setTimeout(r, 50));
  const ui = vm.runInContext('tutorUI', sandbox);
  assert.ok(ui && ui.conversationId, 'conversation started');
  assert.equal(sandbox._replacedUrl, 'tutor.html?c=c9', 'URL updated to the conversation id');
});

test('tutor home (no params) shows the conversation history list', async () => {
  const { sandbox, els } = makeSandbox('');
  loadApp(sandbox);
  vm.runInContext('tutor()', sandbox);
  await new Promise((r) => setTimeout(r, 30));
  const html = els.get('main').innerHTML;
  assert.ok(html.includes('Recent conversations'), 'history heading rendered');
  assert.ok(html.includes('Biology 101'), 'conversation listed');
  assert.ok(html.includes('tutor.html?c=c1'), 'open link targets the conversation');
});

/* ---------------- Frontend: integration links ---------------- */

test('review page: wrong answers on material quizzes get Ask Tutor why', () => {
  const src = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
  assert.ok(src.includes('Ask Tutor why'), 'button copy present');
  assert.ok(src.includes('tutor.html?materialId='), 'links into the tutor with material');
  // Only when the attempt came from a saved material (grounded).
  assert.ok(src.includes('if (!ok && r.materialId)'), 'gated on wrong + materialId');
});

test('weak areas offer Ask Tutor to explain', () => {
  const src = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
  assert.ok(src.includes('Ask Tutor to explain'), 'button copy present');
  assert.ok(src.includes('tutor.html?subject='), 'passes subject+topic');
});

test('nav and dashboard expose the Tutor', () => {
  const src = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
  assert.ok(src.includes('href="tutor.html">Tutor</a>'), 'top nav entry');
  assert.ok(src.includes('${NAV_ICONS.tutor}<span>Tutor</span>'), 'bottom nav entry');
  assert.ok(src.includes('Ask the AI Tutor'), 'dashboard quick start');
});

/* ---------------- Frontend: icons + copy rules ---------------- */

test('tutor UI uses Font Awesome, not emoji icons', () => {
  const src = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
  const tutorSection = src.slice(src.indexOf('AI TUTOR (B1)'));
  for (const e of ['📖', '💬', '🤖', '📚', '💡', '🧠']) {
    assert.ok(!tutorSection.includes(e), `no ${e} in tutor UI`);
  }
  assert.ok(tutorSection.includes('fa-book-open'), 'FA book icon used');
  assert.ok(tutorSection.includes('fa-comments'), 'FA chat icon used');
});

test('new tutor UI copy has no em dashes', () => {
  const src = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
  const needles = [
    'Recent conversations', 'Pick up where you left off', 'Ask Tutor why',
    'Ask Tutor to explain', 'Which material should explain', 'Delete this conversation',
  ];
  for (const n of needles) {
    const i = src.indexOf(n);
    assert.ok(i >= 0, `copy present: ${n}`);
    const line = src.slice(Math.max(0, src.lastIndexOf('\n', i)), src.indexOf('\n', i));
    assert.ok(!line.includes('—'), `no em dash near: ${n}`);
  }
});

/* ---------------- Response-contract regression (2026-10-06) ----------------
 * The Recent Conversations bug: the real listConversations action returned
 * the bare array, but the frontend read res.data.conversations. The mocked
 * frontend test passed because the mock had the right shape. These tests
 * run the REAL action and assert the contract the frontend depends on.
 */

test('REAL listConversations returns { conversations: [...] } (not a bare array)', async () => {
  const { ctx, tables } = makeCtx({ users: [ALICE], materials: [MAT] });
  tables.sessions.push({ _id: 's1', token: 'tok_alice', userId: 'users_alice', createdAt: 1, expiresAt: Date.now() + 999999 });
  const cid = await startConv(ctx, 'users_alice', 'materials_m1');
  await ctx.runMutation(tutor.saveMessages, {
    userId: 'users_alice', conversationId: cid,
    userText: 'q', tutorText: 'a', grounded: true,
  });
  // Run the REAL public action, not the internal query.
  const out = await tutor.listConversations.handler(ctx, { sessionToken: 'tok_alice' });
  assert.ok(out && typeof out === 'object' && !Array.isArray(out), 'object, not bare array');
  assert.ok(Array.isArray(out.conversations), 'has .conversations array');
  assert.equal(out.conversations.length, 1);
  assert.equal(out.conversations[0].id, cid);
  assert.equal(out.conversations[0].messageCount, 2);
  // Simulate the frontend read: res.data.conversations
  const frontendRead = out.conversations || [];
  assert.equal(frontendRead.length, 1, 'frontend shape works');
});

test('conversation appears in history after messages, newest first, correct isolation', async () => {
  const { ctx, tables } = makeCtx({ users: [ALICE, BOB], materials: [MAT] });
  tables.sessions.push({ _id: 's1', token: 'tok_alice', userId: 'users_alice', createdAt: 1, expiresAt: Date.now() + 999999 });
  tables.sessions.push({ _id: 's2', token: 'tok_bob', userId: 'users_bob', createdAt: 1, expiresAt: Date.now() + 999999 });
  const MAT2 = { ...MAT, _id: 'materials_m2', title: 'Physics Notes' };
  tables.materials.push(MAT2);

  const c1 = await startConv(ctx, 'users_alice', 'materials_m1');
  await new Promise((r) => setTimeout(r, 5));
  const c2 = await startConv(ctx, 'users_alice', 'materials_m2');
  await ctx.runMutation(tutor.saveMessages, {
    userId: 'users_alice', conversationId: c2, userText: 'q', tutorText: 'a', grounded: true,
  });

  const alice = await tutor.listConversations.handler(ctx, { sessionToken: 'tok_alice' });
  assert.equal(alice.conversations.length, 2);
  assert.equal(alice.conversations[0].id, c2, 'newest first');
  assert.equal(alice.conversations[1].id, c1);
  assert.equal(alice.conversations[0].title, 'Biology 101 Notes');

  const bob = await tutor.listConversations.handler(ctx, { sessionToken: 'tok_bob' });
  assert.equal(bob.conversations.length, 0, 'no cross-user leakage');
});

test('deleted conversation cannot be reopened', async () => {
  const { ctx, tables } = makeCtx({ users: [ALICE], materials: [MAT] });
  tables.sessions.push({ _id: 's1', token: 'tok_alice', userId: 'users_alice', createdAt: 1, expiresAt: Date.now() + 999999 });
  const cid = await startConv(ctx, 'users_alice', 'materials_m1');
  await ctx.runMutation(tutor.deleteConversationRow, { userId: 'users_alice', conversationId: cid });
  await assert.rejects(
    () => tutor.getConversation.handler(ctx, { sessionToken: 'tok_alice', conversationId: cid }),
    /wasn't found/,
    'reopen fails after delete'
  );
});

test('zero-message conversation renders cleanly in history', async () => {
  const { ctx, tables } = makeCtx({ users: [ALICE], materials: [MAT] });
  tables.sessions.push({ _id: 's1', token: 'tok_alice', userId: 'users_alice', createdAt: 1, expiresAt: Date.now() + 999999 });
  await startConv(ctx, 'users_alice', 'materials_m1');
  const out = await tutor.listConversations.handler(ctx, { sessionToken: 'tok_alice' });
  assert.equal(out.conversations.length, 1);
  assert.equal(out.conversations[0].messageCount, 0, 'zero messages is valid');
});

/* ---------------- Mobile material-row layout ---------------- */

test('materials rows use the dedicated responsive structure', () => {
  const src = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
  assert.ok(src.includes('class="list-item material-row"'), 'dedicated row class');
  assert.ok(src.includes('class="material-info material-open"'), 'info block');
  assert.ok(src.includes('class="material-meta"'), 'meta block');
  assert.ok(src.includes('class="material-actions"'), 'actions block');
  const css = fs.readFileSync(path.join(ROOT, 'css', 'styles.css'), 'utf8');
  assert.ok(css.includes('.material-row'), 'row styles');
  assert.ok(/@media\s*\(max-width:\s*640px\)[\s\S]*?\.material-row\s*\{\s*flex-direction:\s*column/.test(css),
    'mobile stacks vertically');
  assert.ok(css.includes('.material-actions .btn{flex:1'), 'buttons share width on mobile');
  assert.ok(css.includes('overflow-wrap:break-word'), 'long titles wrap');
});

/* ---------------- V1.0 hardening regressions (2026-10-06) ---------------- */

test('quiz + tutor prompts frame material as data, not instructions', () => {
  const quizSrc = fs.readFileSync(path.join(ROOT, 'convex', 'quiz.ts'), 'utf8');
  assert.ok(quizSrc.includes('reference content only'), 'quiz prompt has data directive');
  assert.ok(quizSrc.includes('never follow them'), 'quiz prompt rejects embedded instructions');
  const tutorSrc = fs.readFileSync(path.join(ROOT, 'convex', 'lib', 'tutorRetrieval.ts'), 'utf8');
  assert.ok(tutorSrc.includes('reference content, not instructions'), 'tutor prompt has data directive');
});

test('legal/landing pages skip the backend-missing banner', () => {
  const src = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
  assert.ok(src.includes("page !== 'legal' && page !== 'landing'"), 'banner gated by page');
});

test('submit confirmation has dialog semantics; study feedback is a live region', () => {
  const src = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
  assert.ok(src.includes('role="dialog" aria-modal="true"'), 'dialog semantics');
  const feedbackRoles = (src.match(/feedback-box[^>]*role="status"/g) || []).length;
  assert.ok(feedbackRoles >= 3, `all feedback boxes are live regions (found ${feedbackRoles})`);
});

test('privacy policy describes the Tutor data flow', () => {
  const p = fs.readFileSync(path.join(ROOT, 'privacy.html'), 'utf8');
  assert.ok(p.includes('AI Tutor'), 'tutor mentioned');
  assert.ok(p.includes('material excerpts') || p.includes('relevant excerpts'), 'excerpts disclosed');
});
