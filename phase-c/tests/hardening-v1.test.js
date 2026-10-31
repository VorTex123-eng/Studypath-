/* Final V1.0 hardening regression tests (2026-10-06).
 *
 * Part A: Secure password recovery (convex/passwordReset.ts).
 * Part B: Gemini age eligibility (convex/lib/eligibility.ts + gates).
 *
 * Backend tests run the REAL modules through a stubbed Convex runtime
 * (same harness pattern as tutor-b1d.test.js). Frontend tests check the
 * wiring in js/app.js and js/auth-client.js. Label: local tests, mocked
 * backend/db/network.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { register } = require('node:module');
const { pathToFileURL } = require('node:url');

register(pathToFileURL(path.join(__dirname, 'a2-gen-resolve-hook.mjs')).href);

const ROOT = path.join(__dirname, '..', '..');
const passwordReset = require('../../convex/passwordReset.ts');
const eligibility = require('../../convex/lib/eligibility.ts');
const auth = require('../../convex/auth.ts');

/* ---------------- Fake Convex ctx ---------------- */

function makeCtx({ users = [] } = {}) {
  const tables = {
    users: users.map((u) => ({ ...u })),
    sessions: [],
    passwordResets: [],
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
          api._name = _name;
          return api;
        },
        order(dir) { api._dir = dir; return api; },
        async take(n) {
          let rows = tables[table].slice();
          if (api._eq !== undefined) {
            rows = rows.filter((r) =>
              r.userId === api._eq || r.token === api._eq ||
              r.tokenHash === api._eq || r.email === api._eq ||
              r.key === api._eq || r.anonymousId === api._eq);
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
  const INTERNALS = {};
  for (const k of ['findUserByEmail', 'createResetToken', 'consumeResetToken', 'checkResetRateLimit']) {
    INTERNALS['internal.passwordReset.' + k] = passwordReset[k];
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

// Mock fetch for Resend: capture the request, return success.
let sentEmails = [];
function mockFetch() {
  sentEmails = [];
  global.fetch = async (url, opts) => {
    sentEmails.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
    return { ok: true, status: 200 };
  };
}
function unmockFetch() { delete global.fetch; }

const ALICE = { _id: 'users_alice', email: 'alice@example.com', passwordHash: 'pbkdf2$old' };

/* ================= PART A: PASSWORD RECOVERY ================= */

test('requestPasswordReset: existing account gets generic response and an email is queued', async () => {
  const { ctx, tables } = makeCtx({ users: [ALICE] });
  mockFetch();
  process.env.RESEND_API_KEY = 'test-key';
  try {
    const res = await passwordReset.requestPasswordReset.handler(ctx, {
      email: 'alice@example.com', siteUrl: 'https://studypath.test',
    });
    assert.equal(res.ok, true);
    assert.match(res.message, /If an account exists/);
    assert.equal(tables.passwordResets.length, 1);
    assert.equal(sentEmails.length, 1);
    assert.equal(sentEmails[0].url, 'https://api.resend.com/emails');
    assert.equal(sentEmails[0].body.to[0], 'alice@example.com');
    assert.match(sentEmails[0].body.subject, /Reset your Studypath password/);
    assert.match(sentEmails[0].body.html, /reset-password\.html\?token=[a-f0-9]{64}/);
    // Raw token is in the email, but only its hash is stored.
    assert.match(tables.passwordResets[0].tokenHash, /^[a-f0-9]{64}$/);
    assert.ok(!tables.passwordResets[0].tokenHash.includes('token'));
    // Authorization header uses the env key (never in frontend).
    assert.equal(sentEmails[0].headers.Authorization, 'Bearer test-key');
  } finally { unmockFetch(); delete process.env.RESEND_API_KEY; }
});

test('requestPasswordReset: default sender is the Resend test sender (no domain needed)', async () => {
  const { ctx } = makeCtx({ users: [ALICE] });
  mockFetch();
  process.env.RESEND_API_KEY = 'test-key';
  delete process.env.RESEND_FROM_EMAIL;
  try {
    await passwordReset.requestPasswordReset.handler(ctx, { email: 'alice@example.com' });
    assert.equal(sentEmails[0].body.from, 'Studypath <onboarding@resend.dev>');
    // Overridable for production.
    process.env.RESEND_FROM_EMAIL = 'Studypath <noreply@example.com>';
    await passwordReset.requestPasswordReset.handler(ctx, { email: 'alice@example.com' });
    assert.equal(sentEmails[1].body.from, 'Studypath <noreply@example.com>');
  } finally { unmockFetch(); delete process.env.RESEND_API_KEY; delete process.env.RESEND_FROM_EMAIL; }
});

test('requestPasswordReset: unknown email gets the IDENTICAL generic response, no token, no email', async () => {
  const { ctx: ctxKnown, tables: tablesKnown } = makeCtx({ users: [ALICE] });
  const { ctx: ctxUnknown, tables: tablesUnknown } = makeCtx({ users: [ALICE] });
  mockFetch();
  process.env.RESEND_API_KEY = 'test-key';
  try {
    const known = await passwordReset.requestPasswordReset.handler(ctxKnown, { email: 'alice@example.com' });
    const unknown = await passwordReset.requestPasswordReset.handler(ctxUnknown, { email: 'nobody@example.com' });
    assert.equal(known.message, unknown.message, 'responses must be indistinguishable (anti-enumeration)');
    assert.equal(tablesUnknown.passwordResets.length, 0);
    assert.equal(sentEmails.filter(e => e.body.to[0] === 'nobody@example.com').length, 0);
  } finally { unmockFetch(); delete process.env.RESEND_API_KEY; }
});

test('requestPasswordReset: email body never contains password or hash', async () => {
  const { ctx } = makeCtx({ users: [ALICE] });
  mockFetch();
  process.env.RESEND_API_KEY = 'test-key';
  try {
    await passwordReset.requestPasswordReset.handler(ctx, { email: 'alice@example.com' });
    const html = sentEmails[0].body.html;
    assert.ok(!html.includes('pbkdf2$old'), 'password hash leaked into email');
    assert.ok(!html.toLowerCase().includes('passwordHash'));
  } finally { unmockFetch(); delete process.env.RESEND_API_KEY; }
});

test('requestPasswordReset: rate limited after 3 requests per hour per email', async () => {
  const { ctx, tables } = makeCtx({ users: [ALICE] });
  mockFetch();
  process.env.RESEND_API_KEY = 'test-key';
  try {
    for (let i = 0; i < 3; i++) {
      await passwordReset.requestPasswordReset.handler(ctx, { email: 'alice@example.com' });
    }
    const before = sentEmails.length;
    const res = await passwordReset.requestPasswordReset.handler(ctx, { email: 'alice@example.com' });
    assert.equal(res.ok, true);
    assert.match(res.message, /If an account exists/, 'still generic when rate limited');
    assert.equal(sentEmails.length, before, 'no additional email sent when rate limited');
  } finally { unmockFetch(); delete process.env.RESEND_API_KEY; }
});

async function setupResetToken() {
  const { ctx, tables } = makeCtx({ users: [ALICE] });
  mockFetch();
  process.env.RESEND_API_KEY = 'test-key';
  await passwordReset.requestPasswordReset.handler(ctx, { email: 'alice@example.com', siteUrl: 'https://x.test' });
  unmockFetch(); delete process.env.RESEND_API_KEY;
  const m = sentEmails[0].body.html.match(/token=([a-f0-9]{64})/);
  assert.ok(m, 'email should contain a 64-hex-char token');
  return { ctx, tables, token: m[1] };
}

test('resetPassword: valid token resets password, invalidates sessions, single-use', async () => {
  const { ctx, tables, token } = await setupResetToken();
  // Give Alice a live session that must die on password change.
  tables.sessions.push({ _id: 'sessions_1', token: 'tok', userId: 'users_alice', createdAt: 1, expiresAt: Date.now() + 99999 });
  const res = await passwordReset.resetPassword.handler(ctx, {
    token, newPassword: 'newpassword123', confirmPassword: 'newpassword123',
  });
  assert.equal(res.ok, true);
  const alice = tables.users.find(u => u._id === 'users_alice');
  assert.ok(alice.passwordHash.startsWith('pbkdf2$'), 'password re-hashed with existing scheme');
  assert.notEqual(alice.passwordHash, 'pbkdf2$old');
  assert.equal(tables.sessions.length, 0, 'sessions invalidated on password change');
  assert.ok(tables.passwordResets[0].usedAt, 'token marked used');
});

test('resetPassword: invalid and malformed tokens rejected', async () => {
  const { ctx } = makeCtx({ users: [ALICE] });
  await assert.rejects(
    passwordReset.resetPassword.handler(ctx, { token: 'a'.repeat(64), newPassword: 'newpassword123', confirmPassword: 'newpassword123' }),
    /invalid or has expired/
  );
  await assert.rejects(
    passwordReset.resetPassword.handler(ctx, { token: 'not-a-token!', newPassword: 'newpassword123', confirmPassword: 'newpassword123' }),
    /invalid or has expired/
  );
  await assert.rejects(
    passwordReset.resetPassword.handler(ctx, { token: '', newPassword: 'newpassword123', confirmPassword: 'newpassword123' }),
    /invalid or has expired/
  );
});

test('resetPassword: token cannot be reused', async () => {
  const { ctx, token } = await setupResetToken();
  await passwordReset.resetPassword.handler(ctx, { token, newPassword: 'newpassword123', confirmPassword: 'newpassword123' });
  await assert.rejects(
    passwordReset.resetPassword.handler(ctx, { token, newPassword: 'anotherpass1', confirmPassword: 'anotherpass1' }),
    /invalid or has expired/
  );
});

test('resetPassword: expired token rejected', async () => {
  const { ctx, tables, token } = await setupResetToken();
  tables.passwordResets[0].expiresAt = Date.now() - 1000;
  await assert.rejects(
    passwordReset.resetPassword.handler(ctx, { token, newPassword: 'newpassword123', confirmPassword: 'newpassword123' }),
    /invalid or has expired/
  );
});

test('resetPassword: mismatched confirmation and weak password rejected server-side', async () => {
  const { ctx, tables } = makeCtx({ users: [ALICE] });
  const mk = async () => {
    mockFetch(); process.env.RESEND_API_KEY = 'k';
    await passwordReset.requestPasswordReset.handler(ctx, { email: 'alice@example.com' });
    unmockFetch(); delete process.env.RESEND_API_KEY;
    return sentEmails[0].body.html.match(/token=([a-f0-9]{64})/)[1];
  };
  const t1 = await mk();
  await assert.rejects(
    passwordReset.resetPassword.handler(ctx, { token: t1, newPassword: 'newpassword123', confirmPassword: 'different123' }),
    /don't match/
  );
  const t2 = await mk();
  await assert.rejects(
    passwordReset.resetPassword.handler(ctx, { token: t2, newPassword: 'short', confirmPassword: 'short' }),
    /at least 8 characters/
  );
  // Failed attempts do not consume the token: the latest token row must
  // still be unused. (The first token was superseded by the second, which
  // is the intended single-active-token behavior.)
  const latest = tables.passwordResets[tables.passwordResets.length - 1];
  assert.ok(!latest.usedAt, 'failed validation must not burn the token');
});

test('RESEND_API_KEY is never exposed to frontend code', () => {
  const jsDir = path.join(ROOT, 'js');
  for (const f of fs.readdirSync(jsDir)) {
    if (!f.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(jsDir, f), 'utf8');
    assert.ok(!src.includes('RESEND_API_KEY'), `js/${f} references RESEND_API_KEY`);
  }
  for (const f of fs.readdirSync(ROOT)) {
    if (!f.endsWith('.html')) continue;
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!src.includes('RESEND_API_KEY'), `${f} references RESEND_API_KEY`);
  }
  // The key is read server-side from the environment only.
  const backend = fs.readFileSync(path.join(ROOT, 'convex', 'passwordReset.ts'), 'utf8');
  assert.ok(backend.includes('process.env.RESEND_API_KEY'), 'backend must read the key from env');
});

/* ================= PART B: AGE ELIGIBILITY ================= */

test('requireGeminiEligibility: eligible user passes', async () => {
  const { ctx } = makeCtx({ users: [{ _id: 'u1', ageEligible: true }] });
  await eligibility.requireGeminiEligibility(ctx, 'u1');
});

test('requireGeminiEligibility: unknown / ineligible / missing user are blocked', async () => {
  const { ctx } = makeCtx({ users: [
    { _id: 'u_unknown' },
    { _id: 'u_no', ageEligible: false },
  ]});
  for (const id of ['u_unknown', 'u_no', null, undefined, 'u_missing']) {
    await assert.rejects(
      eligibility.requireGeminiEligibility(ctx, id),
      (err) => err.data && err.data.code === 'age_not_eligible',
      `expected age_not_eligible for ${id}`
    );
  }
});

test('REGRESSION (2026-10-07): gate works when the action ctx has no db client', async () => {
  // Production failure: "TypeError: Cannot read properties of undefined
  // (reading 'get')" from ctx.db.get inside the gate. The gate must reach
  // its check via ctx.runQuery (the surface every other db access in the
  // tutor/quiz actions already uses), never via the action ctx's own db.
  const { tables } = makeCtx({ users: [{ _id: 'u1', ageEligible: true }] });
  const dbLessCtx = {
    runQuery: async (ref, args) => {
      assert.equal(ref, 'internal.lib.eligibility.checkAgeEligibility');
      const user = tables.users.find((u) => u._id === args.userId);
      return user?.ageEligible === true;
    },
  };
  // Eligible passes with no db on the ctx.
  await eligibility.requireGeminiEligibility(dbLessCtx, 'u1');
  // Ineligible still blocked with the right code, not a TypeError.
  await assert.rejects(
    eligibility.requireGeminiEligibility(dbLessCtx, 'u2'),
    (err) => err.data && err.data.code === 'age_not_eligible'
  );
});

test('setAgeEligibility: sets once, then immutable via this endpoint', async () => {
  const tables = { users: [{ _id: 'u1', email: 'a@x.com' }], sessions: [{ _id: 's1', token: 'tok1', userId: 'u1', expiresAt: Date.now() + 99999 }] };
  let seq = 1;
  const db = {
    get: (id) => [...tables.users, ...tables.sessions].find(r => r._id === id) || null,
    query: (table) => ({
      withIndex() { return this; },
      async unique() { return tables[table][0] || null; },
    }),
    async patch(id, doc) { Object.assign(tables.users.find(u => u._id === id), doc); },
  };
  const ctx = { db };
  const r1 = await auth.setAgeEligibility.handler(ctx, { sessionToken: 'tok1', eligible: true });
  assert.equal(r1.ok, true);
  assert.equal(r1.ageEligible, true);
  assert.equal(tables.users[0].ageEligible, true);
  // Second call cannot flip it back.
  const r2 = await auth.setAgeEligibility.handler(ctx, { sessionToken: 'tok1', eligible: false });
  assert.equal(r2.ageEligible, true, 'eligibility must be sticky once set');
});

test('signUp: rejected without age confirmation (server-side, not just the checkbox)', async () => {
  const ctx = {
    db: {
      query: () => ({ withIndex: () => ({ first: async () => null }) }),
    },
  };
  const res = await auth.signUp.handler(ctx, {
    email: 'new@x.com', password: 'password123', name: 'New',
    anonymousId: 'anon', claimAnonymous: false, ageConfirmed: false,
  });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'age_required');
});

test('frontend: signup collects age confirmation and passes it to the backend', () => {
  const appJs = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
  assert.ok(appJs.includes('authAgeConfirm'), 'signup form must have the age checkbox');
  assert.ok(appJs.includes('18 or older'), 'checkbox must state the 18+ requirement plainly');
  const authJs = fs.readFileSync(path.join(ROOT, 'js', 'auth-client.js'), 'utf8');
  assert.ok(authJs.includes('ageConfirmed'), 'auth-client must forward ageConfirmed to auth:signUp');
});

test('frontend: reset-password page and forgot-password link exist', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'reset-password.html')), 'reset-password.html must exist');
  const appJs = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
  assert.ok(appJs.includes('reset-password.html'), 'signin page must link to reset-password.html');
  assert.ok(appJs.includes('resetPasswordPage'), 'router must include the reset-password page');
  assert.ok(appJs.includes("'reset-password': resetPasswordPage"), 'router must map the hyphenated data-page to the render function');
  assert.ok(appJs.includes('requestPasswordReset'), 'reset page must call Auth.requestPasswordReset');
});

test('frontend: Gemini entry points are wrapped with the age gate', () => {
  const appJs = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
  assert.ok(appJs.includes('withAgeEligibility'), 'age wrapper must exist');
  assert.ok(appJs.includes("tutor:sendMessage"), 'tutor sendMessage must be gated');
  assert.ok(appJs.includes("tutor:startConversation"), 'tutor startConversation must be gated');
  // The gate must trigger on the server error code, not just UI state.
  assert.ok(appJs.includes('age_not_eligible'), 'wrapper must react to the server age_not_eligible code');
});

test('backend: every Gemini call site enforces eligibility server-side', () => {
  const quiz = fs.readFileSync(path.join(ROOT, 'convex', 'quiz.ts'), 'utf8');
  const tutor = fs.readFileSync(path.join(ROOT, 'convex', 'tutor.ts'), 'utf8');
  assert.ok(quiz.includes('requireGeminiEligibility'), 'quiz.ts must import the gate');
  // Both quiz actions (generateQuiz + generateTargetedPractice) call it.
  assert.equal((quiz.match(/await requireGeminiEligibility/g) || []).length >= 2, true, 'both quiz actions must call the gate');
  assert.ok(tutor.includes('requireGeminiEligibility'), 'tutor.ts must enforce the gate');
});

test('backend: age_not_eligible passes through every error mapper unmapped', () => {
  // The frontend's withAgeEligibility only shows the one-time prompt if it
  // sees the age_not_eligible code. If a mapper rewrites it to a generic
  // failure (the 2026-10-07 tutor_failed bug), the user never gets the
  // prompt and AI features look broken.
  for (const f of ['convex/lib/tutorRetrieval.ts', 'convex/quiz.ts', 'convex/lib/targetedRetrieval.ts']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(src.includes('age_not_eligible'), `${f} must pass age_not_eligible through to the client`);
  }
});

test('REGRESSION (2026-10-08): quiz actions resolve the session via ctx.runQuery, never the action ctx db', async () => {
  // Production failure (every signed-in generation attempt):
  //   TypeError: Cannot read properties of undefined (reading 'query')
  // from findValidSessionUserId (convex/attempts.ts), mapped to
  // generation_failed at convex/quiz.ts:994.
  // The 2026-10-06 age gate called findValidSessionUserId(ctx, ...) with the
  // ACTION ctx, but Convex actions have no ctx.db. Both quiz actions must
  // resolve the session through the resolveSessionUserId internal query.
  const quizSrc = fs.readFileSync(path.join(ROOT, 'convex', 'quiz.ts'), 'utf8');
  assert.ok(
    quizSrc.includes('export const resolveSessionUserId = internalQuery('),
    'quiz.ts must export the resolveSessionUserId internal query'
  );
  assert.equal(
    (quizSrc.match(/ctx\.runQuery\(internal\.quiz\.resolveSessionUserId/g) || []).length,
    2,
    'both quiz actions (generateQuiz, generateTargetedPractice) must resolve the session via ctx.runQuery'
  );
  // The two removed action call sites, verbatim: direct session lookups with
  // the action ctx must not come back. (Remaining findValidSessionUserId
  // callers live inside internalQuery/internalMutation handlers, which do
  // have ctx.db.)
  assert.equal(
    (quizSrc.match(/const genUserId = await findValidSessionUserId\(ctx, args\.sessionToken\);/g) || []).length,
    0,
    'generateQuiz must not call findValidSessionUserId with the action ctx'
  );
  assert.equal(
    (quizSrc.match(/const targetedUserId = await findValidSessionUserId\(ctx, args\.sessionToken\);/g) || []).length,
    0,
    'generateTargetedPractice must not call findValidSessionUserId with the action ctx'
  );

  // Behavioral: the internal query resolves exactly like the direct lookup.
  const quiz = require('../../convex/quiz.ts');
  const now = Date.now();
  const { ctx, tables } = makeCtx({});
  tables.sessions.push(
    { _id: 's1', token: 'tok-live', userId: 'u1', expiresAt: now + 99999 },
    { _id: 's2', token: 'tok-expired', userId: 'u1', expiresAt: now - 1 }
  );
  const qctx = { db: ctx.db };
  assert.equal(await quiz.resolveSessionUserId.handler(qctx, { sessionToken: 'tok-live' }), 'u1');
  assert.equal(await quiz.resolveSessionUserId.handler(qctx, { sessionToken: 'tok-expired' }), null);
  assert.equal(await quiz.resolveSessionUserId.handler(qctx, { sessionToken: 'tok-unknown' }), null);
  assert.equal(await quiz.resolveSessionUserId.handler(qctx, {}), null);
});
