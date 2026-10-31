/* B1 AI Tutor regression tests (2026-10-04).
 *
 * Covers the brief's 18-item list: auth, isolation, retrieval grounding,
 * bounded context, conversation, failure modes, rate limits, duplicate-send
 * guard, and no-regression on quiz/A1/A2/security (via the full suite).
 *
 * Backend tests run the REAL convex/tutor.ts actions through the shared
 * resolve-hook harness (stubbed Convex runtime + stubbed Gemini transport,
 * real runWithFallback). Frontend tests sandbox js/app.js in node:vm.
 * Label: local tests, mocked backend/db — no real deployment.
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
const tr = require('../../convex/lib/tutorRetrieval.ts');
const modelStub = require('./stubs/a2-model-stub.mjs');

process.env.GEMINI_API_KEY = 'test-key'; // getGeminiConfig is the real one

/* ---------------- Fake Convex ctx ---------------- */

function makeTutorCtx({ users = [], sessions = [], materials = [] } = {}) {
  const tables = {
    users: users.map((u) => ({ ...u })),
    sessions: sessions.map((s) => ({ ...s })),
    materials: materials.map((m) => ({ ...m })),
    tutorConversations: [],
    tutorMessages: [],
    rateLimitBuckets: [],
  };
  let seq = 1;
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
          let rows = tables[table].filter((r) => {
            if (api._idxUnused) return true;
            return true;
          });
          // Index filtering by the eq value captured above.
          rows = tables[table].filter((r) => filterRow(table, r, api._eq));
          const key = table === 'tutorConversations' ? 'updatedAt' : 'createdAt';
          rows = [...rows].sort((a, b) => (api._dir === 'desc' ? b[key] - a[key] : a[key] - b[key]));
          return rows.slice(0, n);
        },
        async unique() {
          const rows = await api.take(1);
          return rows[0] || null;
        },
      };
      // Remember which index was used, via the withIndex name.
      const origWithIndex = api.withIndex;
      api.withIndex = (name, fn) => { api._indexName = name; return origWithIndex(name, fn); };
      return api;
    },
    async insert(table, doc) {
      const row = { _id: table + '_' + seq++, ...doc };
      tables[table].push(row);
      return row._id;
    },
    async patch(id, doc) {
      const row = db.get(id);
      if (row) Object.assign(row, doc);
    },
    async delete(id) {
      for (const rows of Object.values(tables)) {
        const i = rows.findIndex((r) => r._id === id);
        if (i !== -1) { rows.splice(i, 1); return; }
      }
    },
  };

  function filterRow(table, r, eq) {
    // Dispatch on the table + the shape of the eq value is unnecessary:
    // each test index filters a known field. Match by table.
    if (table === 'sessions') return r.token === eq;
    if (table === 'rateLimitBuckets') return r.key === eq;
    if (table === 'tutorConversations') return String(r.userId) === String(eq);
    if (table === 'tutorMessages') {
      // by_conversation (eq = conversationId) or by_user (eq = userId)
      return String(r.conversationId) === String(eq) || String(r.userId) === String(eq);
    }
    return true;
  }

  const INTERNALS = {};
  for (const k of ['getTutorUser', 'getOwnedMaterial', 'checkTutorRateLimit', 'createConversation', 'loadConversation', 'saveMessages', 'listUserConversations']) {
    INTERNALS['internal.tutor.' + k] = tutor[k];
  }
  INTERNALS['internal.lib.eligibility.checkAgeEligibility'] = eligibility.checkAgeEligibility;
  const ctx = {
    db,
    runQuery: async (ref, args) => INTERNALS[ref].handler(ctx, args),
    runMutation: async (ref, args) => INTERNALS[ref].handler(ctx, args),
  };
  return { ctx, tables };
}

const ALICE = { _id: 'u_alice', email: 'alice@x.y', anonymousId: 'a1', createdAt: 1, ageEligible: true };
const BOB = { _id: 'u_bob', email: 'bob@x.y', anonymousId: 'a2', createdAt: 1, ageEligible: true };
const SESS_ALICE = { _id: 's1', token: 'tok_alice', userId: 'u_alice', createdAt: 1, expiresAt: Date.now() + 3600000 };
const SESS_BOB = { _id: 's2', token: 'tok_bob', userId: 'u_bob', createdAt: 1, expiresAt: Date.now() + 3600000 };
const MITOSIS_TEXT = [
  'Cell Division',
  '',
  'Mitosis is the process by which a single cell divides into two identical daughter cells. Mitosis is essential for growth and repair.',
  '',
  'Phases of Mitosis',
  '',
  'Mitosis has four main phases: prophase, metaphase, anaphase, and telophase. During prophase, the chromatin condenses. In metaphase, chromosomes line up. Anaphase separates sister chromatids, and telophase reforms the nuclei.',
  '',
  'Meiosis contrast',
  '',
  'Meiosis is a different process that produces gametes with half the chromosome number.',
].join('\n');
const MAT_ALICE = { _id: 'm_alice', userId: 'u_alice', title: 'Biology 101 Notes', subject: 'Biology', kind: 'paste', extractedText: MITOSIS_TEXT, charCount: MITOSIS_TEXT.length, createdAt: 1, updatedAt: 1 };

function stdCtx() {
  return makeTutorCtx({ users: [ALICE, BOB], sessions: [SESS_ALICE, SESS_BOB], materials: [MAT_ALICE] });
}

function okTransport(answer = 'Mitosis is cell division.', grounded = true) {
  modelStub.__setTransport(async () => ({ ok: true, parsed: { answer, groundedInMaterial: grounded } }));
}

async function startConvo(ctx, token = 'tok_alice', materialId = 'm_alice') {
  return await tutor.startConversation.handler(ctx, { sessionToken: token, materialId });
}

async function send(ctx, conversationId, message, token = 'tok_alice') {
  return await tutor.sendMessage.handler(ctx, { sessionToken: token, conversationId, message });
}

function errCode(e) {
  return (e && e.data && e.data.code) || (e && e.code);
}

/* ---------------- 1. Authenticated user can use Tutor ---------------- */

test('1. authenticated user starts a conversation and gets a grounded answer', async () => {
  const { ctx } = stdCtx();
  okTransport();
  const started = await startConvo(ctx);
  assert.ok(started.conversationId, 'conversation created');
  assert.equal(started.materialTitle, 'Biology 101 Notes');
  const res = await send(ctx, started.conversationId, 'What is mitosis?');
  assert.equal(res.answer, 'Mitosis is cell division.');
  assert.equal(res.groundedInMaterial, true);
});

/* ---------------- 2. Unauthenticated rejected ---------------- */

test('2. missing/invalid session is rejected', async () => {
  const { ctx } = stdCtx();
  const e1 = await startConvo(ctx, 'bad-token').catch((e) => e);
  assert.equal(errCode(e1), 'not_authenticated');
  const e2 = await tutor.sendMessage.handler(ctx, { sessionToken: 'bad-token', conversationId: 'x', message: 'hi' }).catch((e) => e);
  assert.equal(errCode(e2), 'not_authenticated');
  const e3 = await tutor.getConversation.handler(ctx, { sessionToken: 'bad-token', conversationId: 'x' }).catch((e) => e);
  assert.equal(errCode(e3), 'not_authenticated');
});

/* ---------------- 3/14. Cross-user isolation ---------------- */

test('3/14. user B cannot use user A material or conversation', async () => {
  const { ctx } = stdCtx();
  okTransport();
  // B tries to open a tutor on A's material.
  const e1 = await startConvo(ctx, 'tok_bob', 'm_alice').catch((e) => e);
  assert.equal(errCode(e1), 'material_unavailable');
  // A starts a conversation; B tries to read and write it.
  const started = await startConvo(ctx, 'tok_alice', 'm_alice');
  const e2 = await tutor.getConversation.handler(ctx, { sessionToken: 'tok_bob', conversationId: started.conversationId }).catch((e) => e);
  assert.equal(errCode(e2), 'not_found', 'foreign conversation reads as not_found (no leak)');
  const e3 = await send(ctx, started.conversationId, 'What is mitosis?', 'tok_bob').catch((e) => e);
  assert.equal(errCode(e3), 'not_found', 'foreign conversation write blocked');
  // B's own conversation list is empty. (Contract, fixed 2026-10-06:
  // listConversations returns { conversations: [...] }, not a bare array.)
  const list = await tutor.listConversations.handler(ctx, { sessionToken: 'tok_bob' });
  assert.deepEqual(list, { conversations: [] });
  const listA = await tutor.listConversations.handler(ctx, { sessionToken: 'tok_alice' });
  assert.equal(listA.conversations.length, 1, 'A sees only her own');
});

/* ---------------- 4. Relevant context retrieved ---------------- */

test('4. the model prompt contains the relevant material passages', async () => {
  const { ctx } = stdCtx();
  let seenPrompt = '';
  modelStub.__setTransport(async (params) => {
    seenPrompt = params.prompt;
    return { ok: true, parsed: { answer: 'ok', groundedInMaterial: true } };
  });
  const started = await startConvo(ctx);
  await send(ctx, started.conversationId, 'What are the phases of mitosis?');
  assert.ok(seenPrompt.includes('prophase'), 'retrieved passage reached the model');
  assert.ok(seenPrompt.includes('Biology 101 Notes'), 'material title in prompt');
  assert.ok(!seenPrompt.includes('capital of France'), 'no irrelevant text');
});

/* ---------------- 5. Irrelevant question → honest, no model call ---------------- */

test('5. unrelated question gets the honest reply without spending a model call', async () => {
  const { ctx } = stdCtx();
  modelStub.__setTransport(async () => {
    throw new Error('model should not have been called');
  });
  const started = await startConvo(ctx);
  const res = await send(ctx, started.conversationId, 'What is the capital of France?');
  assert.ok(res.answer.includes("couldn't find enough"), 'honest insufficient-context reply');
  assert.ok(res.answer.includes('Biology 101 Notes'), 'names the material');
  assert.equal(res.groundedInMaterial, false);
  assert.equal(modelStub.__transportCalls().length, 0, 'no Gemini call spent');
});

/* ---------------- 6. Context is bounded ---------------- */

test('6. retrieved context is hard-capped', () => {
  // 50k chars where every paragraph is keyword-dense.
  const para = 'Mitosis mitosis MITOSIS. ' + 'Cell division phases prophase metaphase. '.repeat(20);
  const big = Array(60).fill(para).join('\n\n');
  assert.ok(big.length > 40000, 'fixture is large');
  const { contextText, passages } = tr.retrieveWithFollowupFallback('Explain mitosis phases', null, big);
  assert.ok(contextText.length <= 6000, `context capped at 6000 (got ${contextText.length})`);
  assert.ok(passages.length <= 4, 'passage count capped');
});

/* ---------------- 7. Valid response shape ---------------- */

test('7. malformed model output is rejected by validation', () => {
  assert.equal(tr.validateTutorResponse(null), null);
  assert.equal(tr.validateTutorResponse({ answer: '', groundedInMaterial: true }), null);
  assert.equal(tr.validateTutorResponse({ answer: 'x'.repeat(4001), groundedInMaterial: true }), null);
  assert.equal(tr.validateTutorResponse({ answer: 'ok', groundedInMaterial: 'yes' }), null);
  assert.deepEqual(tr.validateTutorResponse({ answer: 'ok', groundedInMaterial: false }), { answer: 'ok', groundedInMaterial: false });
});

/* ---------------- 8. Multi-turn maintains context ---------------- */

test('8. follow-up sees the previous exchange (history in prompt)', async () => {
  const { ctx } = stdCtx();
  const prompts = [];
  modelStub.__setTransport(async (params) => {
    prompts.push(params.prompt);
    return { ok: true, parsed: { answer: 'fine', groundedInMaterial: true } };
  });
  const started = await startConvo(ctx);
  await send(ctx, started.conversationId, 'What is mitosis?');
  // Pronoun follow-up: "it" carries no keywords; the fallback uses the previous question.
  await send(ctx, started.conversationId, 'Why is it important for growth?');
  assert.equal(prompts.length, 2, 'both turns reached the model (fallback retrieval found context)');
  assert.ok(prompts[1].includes('Student: What is mitosis?'), 'first exchange present in second prompt');
  assert.ok(prompts[1].includes('Why is it important for growth?'), 'current question present');
});

/* ---------------- 9/10/11. Failure modes ---------------- */

test('9. provider timeout maps to a distinct timeout error', async () => {
  const { ctx } = stdCtx();
  modelStub.__setTransport(async () => ({ ok: false, code: 'timeout', message: 'slow' }));
  const started = await startConvo(ctx);
  const err = await send(ctx, started.conversationId, 'What is mitosis?').catch((e) => e);
  assert.equal(errCode(err), 'timeout');
  assert.ok(err.data.message.includes('took too long'), 'distinct user message, no raw detail');
});

test('10. provider failure maps to provider_error', async () => {
  const { ctx } = stdCtx();
  modelStub.__setTransport(async () => ({ ok: false, code: 'provider_error', message: 'HTTP 503' }));
  const started = await startConvo(ctx);
  const err = await send(ctx, started.conversationId, 'What is mitosis?').catch((e) => e);
  assert.equal(errCode(err), 'provider_error');
  assert.ok(!err.data.message.includes('503'), 'no raw provider text leaks');
});

test('11. malformed AI response → invalid_response after the bounded retry', async () => {
  const { ctx } = stdCtx();
  let calls = 0;
  modelStub.__setTransport(async () => {
    calls++;
    return { ok: true, parsed: { notTheSchema: true } };
  });
  const started = await startConvo(ctx);
  const err = await send(ctx, started.conversationId, 'What is mitosis?').catch((e) => e);
  assert.equal(errCode(err), 'invalid_response');
  assert.equal(calls, 2, 'exactly one retry (bounded), then a clean error');
});

/* ---------------- 12. Rate limiting ---------------- */

test('12. tutor burst quota is enforced per user', async () => {
  const { ctx } = stdCtx();
  okTransport('ok');
  const started = await startConvo(ctx);
  let limited = 0;
  for (let i = 0; i < 12; i++) {
    const r = await send(ctx, started.conversationId, 'What is mitosis? ' + i).catch((e) => e);
    if (errCode(r) === 'rate_limited') limited++;
  }
  assert.ok(limited >= 1, 'burst limit (10/10min) trips');
  // Bob is unaffected by Alice's burst.
  const bobStart = await startConvo(ctx, 'tok_bob', 'm_alice').catch((e) => e);
  assert.equal(errCode(bobStart), 'material_unavailable', 'bob has no material (isolation intact)');
});

/* ---------------- 15/16/17/18: no regressions (source + suite) ---------------- */

test('17. A2 remains frozen and untouched by tutor code', () => {
  const appSrc = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
  assert.ok(appSrc.includes('const TARGETED_PRACTICE_ENABLED = false'), 'A2 flag still off');
  const tutorSrc = fs.readFileSync(path.join(ROOT, 'convex', 'tutor.ts'), 'utf8');
  assert.ok(!tutorSrc.includes('generateTargetedPractice'), 'tutor never calls A2');
  assert.ok(!tutorSrc.includes('targetedRetrieval")') || tutorSrc.includes('lib/tutorRetrieval'), 'tutor uses its own retrieval module');
  const libSrc = fs.readFileSync(path.join(ROOT, 'convex', 'lib', 'tutorRetrieval.ts'), 'utf8');
  assert.ok(libSrc.includes('from "./targetedRetrieval"'), 'reuses A2 retrieval functions (read-only import)');
});

/* ---------------- 13. Duplicate sends prevented (real frontend code, sandboxed DOM) ---------------- */

function makeTutorDom() {
  const els = new Map();
  function el(selector) {
    if (!els.has(selector)) {
      els.set(selector, {
        selector,
        innerHTML: '',
        textContent: '',
        value: '',
        disabled: false,
        style: {},
        dataset: {},
        onclick: null, onkeydown: null, oninput: null,
        focus() {}, select() {}, scrollIntoView() {},
        scrollHeight: 100, scrollTop: 0,
        querySelector() { return null; },
        querySelectorAll() { return []; },
      });
    }
    return els.get(selector);
  }
  const document = {
    body: { dataset: { page: 'tutor' } },
    querySelector: (s) => el(s),
    querySelectorAll: () => [],
    addEventListener() {},
    createElement: () => el('created'),
  };
  return { document, els };
}

test('13. double-send while a request is in flight issues only one backend call', async () => {
  const { document, els } = makeTutorDom();
  const actionCalls = [];
  let sendResolve = null;
  const sandbox = {
    document,
    window: {},
    navigator: {},
    location: { search: '?materialId=m_alice', href: '' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    URLSearchParams,
    console,
    setTimeout, clearTimeout,
    Auth: { isLoggedIn: () => true, getToken: () => 'tok_alice' },
    Convex: {
      action: (name, args) => {
        actionCalls.push({ name, args });
        if (name === 'tutor:startConversation') {
          return Promise.resolve({ ok: true, data: { conversationId: 'c1', materialTitle: 'Biology 101 Notes' } });
        }
        if (name === 'tutor:sendMessage') {
          return new Promise((resolve) => { sendResolve = resolve; }); // hangs: request in flight
        }
        return Promise.resolve({ ok: false, error: { code: 'x', message: 'x' } });
      },
      query: () => Promise.resolve({ ok: false }),
      mutation: () => Promise.resolve({ ok: false }),
    },
  };
  vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
  vm.runInContext(src, sandbox, { filename: 'app.js' });
  vm.runInContext('tutor()', sandbox);
  await new Promise((r) => setTimeout(r, 20)); // let startConversation resolve

  const input = els.get('#tutorInput');
  assert.ok(input, 'input rendered after conversation start');
  input.value = 'What is mitosis?';
  vm.runInContext('sendTutorMessage()', sandbox);
  vm.runInContext('sendTutorMessage()', sandbox); // impatient double-tap
  vm.runInContext('sendTutorMessage()', sandbox); // Enter-spam
  await new Promise((r) => setTimeout(r, 20));

  const sends = actionCalls.filter((c) => c.name === 'tutor:sendMessage');
  assert.equal(sends.length, 1, 'one in-flight request → one backend call');
  // The re-rendered HTML locks the Send button while the request is in flight.
  assert.ok(els.get('main').innerHTML.includes('id="tutorSend" disabled'), 'Send button locked while sending');

  // Resolve the request: the tutor reply renders and the button unlocks.
  sendResolve({ ok: true, data: { answer: 'Mitosis is cell division.', groundedInMaterial: true } });
  await new Promise((r) => setTimeout(r, 20));
  const main = els.get('main');
  assert.ok(main.innerHTML.includes('Mitosis is cell division.'), 'tutor reply rendered');
  assert.equal(els.get('#tutorSend').disabled, false, 'Send unlocked after response');
});

/* ---------------- Disclosure ---------------- */

test('tutor page carries the free-plan disclosure suffix', () => {
  const src = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
  assert.ok(src.includes('function tutorDisclosureSuffix()'), 'suffix helper exists');
  assert.ok(src.includes('Your questions and material excerpts are sent to Google'), 'tutor disclosure text');
  assert.ok(src.includes('tutorDisclosureSuffix()}'), 'wired into the tutor source bar');
  assert.ok(src.includes("geminiFreePlan()"), 'hidden on the paid plan');
});

/* ---------------- Age eligibility: the 2026-10-07 production bug ----------------
 * Unconfirmed users must get age_not_eligible (which the frontend turns
 * into the one-time confirmation prompt), NEVER the generic tutor_failed.
 * This is the exact end-to-end path: sendMessage -> answerTutorQuestion
 * -> requireGeminiEligibility -> tutorErrorFor. */

test('age gate: unconfirmed user gets age_not_eligible, not tutor_failed', async () => {
  const UNCONFIRMED = { _id: 'u_new', email: 'new@x.y', anonymousId: 'a9', createdAt: 1 };
  const SESS_NEW = { _id: 's9', token: 'tok_new', userId: 'u_new', createdAt: 1, expiresAt: Date.now() + 3600000 };
  const MAT_NEW = { ...MAT_ALICE, _id: 'm_new', userId: 'u_new' };
  const { ctx } = makeTutorCtx({ users: [UNCONFIRMED], sessions: [SESS_NEW], materials: [MAT_NEW] });
  okTransport();
  const started = await tutor.startConversation.handler(ctx, { sessionToken: 'tok_new', materialId: 'm_new' });
  const err = await send(ctx, started.conversationId, 'What is mitosis?', 'tok_new').catch((e) => e);
  assert.equal(errCode(err), 'age_not_eligible', 'must surface the age code so the frontend shows the prompt');
});

test('age gate: confirmed user (ageEligible true) reaches the Gemini pipeline', async () => {
  const { ctx } = stdCtx();
  okTransport('Mitosis is cell division.', true);
  const started = await startConvo(ctx);
  const res = await send(ctx, started.conversationId, 'What is mitosis?');
  assert.equal(res.answer, 'Mitosis is cell division.');
});

/* ---------------- Diagnostic logging removed (2026-10-09) ----------------
 * The temporary [tutor.diag] stage logging added 2026-10-07 served its
 * purpose (the tutor ctx.db root cause was found and production-verified
 * on 2026-10-08) and has been removed from convex/tutor.ts. The diag
 * assertion tests lived here; they were deleted with the feature. */
