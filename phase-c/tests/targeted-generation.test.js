/* A2 generation-path end-to-end harness.
 *
 * Drives the REAL generateTargetedPractice action handler (convex/quiz.ts)
 * with a fake ctx (staged internal query/mutation results) and a stubbed
 * Gemini transport (convex/ai/model's real runWithFallback/getGeminiConfig,
 * mutable callGeminiJson). This exercises the genuine stage sequence:
 *
 *   session/context -> weak-area eligibility -> retrieval -> prompt build ->
 *   transport -> validation -> math check -> topic repair -> novelty check ->
 *   response shape -> frontend ready-screen field reads
 *
 * What is NOT covered here (needs the live deployment): real session rows,
 * the real rate-limit buckets, the real Gemini network call.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { register } = require('node:module');
const { pathToFileURL } = require('node:url');

register(pathToFileURL(path.join(__dirname, 'a2-gen-resolve-hook.mjs')).href);

const { generateTargetedPractice } = require('../../convex/quiz.ts');
const modelStub = require('./stubs/a2-model-stub.mjs');
const { questionKeyFor } = require('../../convex/lib/results.ts');

/* ---------------- fixtures ---------------- */

const WEAK = {
  subject: 'Mathematics',
  subjectKey: 'mathematics',
  topic: 'Quadratic Equations',
  topicKey: 'equation-quadratic',
};

const MATH_TEXT = [
  'QUADRATIC EQUATIONS',
  '',
  'A quadratic equation is an equation of the form ax^2 + bx + c = 0 where a is not zero.',
  '',
  'To solve a quadratic equation we can factorise, complete the square, or use the quadratic formula.',
  '',
  'Worked example: factorising turns the equation into two brackets whose product is zero.',
].join('\n');

const PHYSICS_TEXT = [
  'WAVES',
  '',
  'Waves transfer energy through a medium. The wave equation describes how disturbances propagate.',
].join('\n');

function mathMaterials() {
  return [{ id: 'm1', title: 'JAMB Mathematics Notes', subject: 'Mathematics' }];
}
function mathTexts() {
  return [{ id: 'm1', title: 'JAMB Mathematics Notes', subject: 'Mathematics', extractedText: MATH_TEXT }];
}
function baseContext(over = {}) {
  return {
    ok: true,
    area: { subjectKey: WEAK.subjectKey, topicKey: WEAK.topicKey, subject: WEAK.subject, topic: WEAK.topic, status: 'established' },
    materials: mathMaterials(),
    historicalKeys: [],
    ...over,
  };
}

function mcq(i, text, correctIdx) {
  const opts = ['Factorising', 'Completing the square', 'Using the quadratic formula', 'Graphical estimation'];
  return {
    type: 'mcq',
    text,
    topic: 'Quadratic Equations',
    explanation: 'This follows the methods taught in the material.',
    options: opts.map((t, k) => ({ id: 'o' + k, text: t })),
    correctOptionId: 'o' + correctIdx,
    correctAnswer: false,
    acceptableAnswers: [],
  };
}
function tf(text, answer) {
  return {
    type: 'true_false', text, topic: 'Quadratic Equations',
    explanation: 'Directly supported by the material.',
    options: [], correctOptionId: '', correctAnswer: answer, acceptableAnswers: [],
  };
}
function sa(text, answers) {
  return {
    type: 'short_answer', text, topic: 'Quadratic Equations',
    explanation: 'The material defines this explicitly.',
    options: [], correctOptionId: '', correctAnswer: false, acceptableAnswers: answers,
  };
}
function validParsed() {
  return {
    title: 'Quadratic Equations targeted practice',
    questions: [
      mcq(0, 'Which method rewrites a quadratic as a product of two brackets?', 0),
      mcq(1, 'Which method adds a constant to both sides to make a perfect square?', 1),
      tf('A quadratic equation can have at most two real solutions.', true),
      tf('Every quadratic equation has two distinct real roots.', false),
      sa('What name is given to the expression b squared minus four a c?', ['the discriminant']),
      sa('In ax squared plus bx plus c equals zero, what must a not be?', ['zero']),
      mcq(2, 'Which formula gives the roots directly from a, b and c?', 2),
      tf('Factorising works for every quadratic equation.', false),
    ],
  };
}

/* Fake ctx: staged internal query/mutation results. Captures the args the
 * action passes so tests can assert the ownership-enforcing query is used. */
function makeCtx({ context, texts, rateLimit = { ok: true, idKey: 'test-user-key' }, capture = {} }) {
  // Age gate (2026-10-06): the harness user is a confirmed 18+ account.
  const dbUser = { _id: 'u_harness', ageEligible: true };
  const dbSession = { _id: 's_harness', token: 'sess-123', userId: 'u_harness', expiresAt: Date.now() + 99999 };
  const db = {
    get: async (id) => (id === 'u_harness' ? dbUser : null),
    query: (table) => ({
      withIndex: () => ({
        unique: async () => (table === 'sessions' ? dbSession : null),
      }),
    }),
  };
  return {
    db,
    runQuery: async (ref, args) => {
      if (ref === 'internal.quiz.resolveTargetedPracticeContext') return context;
      if (ref === 'internal.lib.eligibility.checkAgeEligibility') return dbUser.ageEligible === true;
      // Session resolution for the action handlers (2026-10-08): actions have
      // no ctx.db, so they resolve via internal.quiz.resolveSessionUserId.
      if (ref === 'internal.quiz.resolveSessionUserId') {
        return args.sessionToken === 'sess-123' ? 'u_harness' : null;
      }
      if (ref === 'internal.quiz.getTargetedMaterialTexts') {
        capture.textsArgs = args;
        return texts;
      }
      throw new Error('unexpected query: ' + ref);
    },
    runMutation: async (ref, args) => {
      if (ref === 'internal.quiz.resolveIdentityAndCheckRateLimit') return rateLimit;
      if (ref === 'internal.quiz.refundGenerationQuota') {
        (capture.refunds || (capture.refunds = [])).push(args);
        return { ok: true };
      }
      throw new Error('unexpected mutation: ' + ref);
    },
  };
}

const ACTION_ARGS = {
  sessionToken: 'sess-123',
  anonymousId: 'anon-456',
  subjectKey: WEAK.subjectKey,
  topicKey: WEAK.topicKey,
  questionCount: 8,
  difficulty: 'medium',
  questionTypes: ['mcq', 'true_false', 'short_answer'],
};

function errCode(err) {
  return (err && (err.data ? err.data.code : err.code)) || null;
}

/* Mirrors the field reads js/app.js performs when moving a generated quiz
 * into the engine: renderReadyScreen (title/questionCount/difficulty/mode/
 * timeLimitMinutes) -> onStartQuiz -> buildResultRecord (subject,
 * materialId, practiceSource) -> saveAttempt. */
function simulateReadyTransition(quiz) {
  assert.ok(quiz && typeof quiz === 'object', 'quiz object returned');
  const ready = {
    title: quiz.title,
    meta: `${quiz.questionCount} questions · ${quiz.difficulty} · ${quiz.mode === 'exam' ? 'Exam mode' : 'Study mode'}`,
    timeLimit: quiz.timeLimitMinutes,
    subject: quiz.subject,
    materialId: quiz.materialId,
    practiceSource: quiz.practiceSource,
    questionCount: Array.isArray(quiz.questions) ? quiz.questions.length : 0,
  };
  assert.ok(ready.title, 'ready screen needs a title');
  assert.equal(ready.questionCount, 8, 'ready screen needs the 8 generated questions');
  assert.equal(ready.materialId, 'm1', 'attempt must retain the source materialId');
  assert.equal(ready.practiceSource, 'targeted_ai', 'attempt must record practice origin');
  assert.ok(ready.subject, 'attempt must retain the subject');
  return ready;
}

test.beforeEach(() => {
  process.env.GEMINI_API_KEY = 'test-key-not-real';
  modelStub.__setTransport(async () => ({ ok: true, parsed: validParsed() }));
});
test.afterEach(() => {
  delete process.env.GEMINI_API_KEY;
});

/* ---------------- A. happy path: retrieval -> grounded prompt -> valid quiz -> ready ---------------- */

test('A1 material retrieved, prompt grounded, valid quiz returned', async () => {
  const capture = {};
  const ctx = makeCtx({ context: baseContext(), texts: mathTexts(), capture });
  const quiz = await generateTargetedPractice.handler(ctx, ACTION_ARGS);

  // stage 6: the right material won
  assert.equal(quiz.materialId, 'm1');
  assert.equal(quiz.practiceSource, 'targeted_ai');

  // stage 8/9: the transport got the grounded prompt (context + schema)
  const calls = modelStub.__transportCalls();
  assert.equal(calls.length, 1, 'one Gemini call on the happy path');
  assert.ok(calls[0].prompt.includes('ax^2 + bx + c = 0'), 'prompt carries the retrieved passage');
  assert.ok(calls[0].prompt.includes('JAMB Mathematics Notes'), 'prompt names the source material');
  assert.ok(calls[0].prompt.includes('Quadratic Equations'), 'prompt pins the weak topic');
  assert.ok(calls[0].hasSchema, 'response schema enforced on the call');

  // stage 11/14: validated questions, correct shape
  assert.equal(quiz.questions.length, 8);
  assert.ok(quiz.questions.every((q) => q.topic === 'Quadratic Equations'));
  assert.equal(quiz.subject, 'Mathematics');
  assert.equal(quiz.difficulty, 'medium');
});

test('A2 returned quiz passes the frontend ready-screen transition', async () => {
  const ctx = makeCtx({ context: baseContext(), texts: mathTexts() });
  const quiz = await generateTargetedPractice.handler(ctx, ACTION_ARGS);
  const ready = simulateReadyTransition(quiz);
  assert.match(ready.meta, /8 questions · medium · Study mode/);
});

test('A3 validation failure retries once with a correction note, then succeeds', async () => {
  const bad = validParsed();
  bad.questions[0] = { ...bad.questions[0], correctOptionId: '' }; // invalid mcq
  let n = 0;
  modelStub.__setTransport(async () => (++n === 1 ? { ok: true, parsed: bad } : { ok: true, parsed: validParsed() }));
  const ctx = makeCtx({ context: baseContext(), texts: mathTexts() });
  const quiz = await generateTargetedPractice.handler(ctx, ACTION_ARGS);
  assert.equal(n, 2, 'failed validation -> one retry');
  assert.equal(quiz.questions.length, 8);
  const retryPrompt = modelStub.__transportCalls()[1].prompt;
  assert.ok(retryPrompt.includes('Your previous attempt failed validation'), 'retry carries the correction note');
});

test('A4 novelty collision triggers regeneration of genuinely new questions', async () => {
  const oldQ = mcq(9, 'OLD SEEN QUESTION - do not repeat this exact wording', 0);
  const seenKey = questionKeyFor(oldQ);
  const withDup = validParsed();
  withDup.questions[0] = { ...oldQ };
  let n = 0;
  modelStub.__setTransport(async () => (++n === 1 ? { ok: true, parsed: withDup } : { ok: true, parsed: validParsed() }));
  const ctx = makeCtx({ context: baseContext({ historicalKeys: [seenKey] }), texts: mathTexts() });
  const quiz = await generateTargetedPractice.handler(ctx, ACTION_ARGS);
  assert.equal(n, 2, 'novelty collision -> one regeneration');
  const finalKeys = new Set(quiz.questions.map(questionKeyFor));
  assert.ok(!finalKeys.has(seenKey), 'no returned question repeats a seen one');
});

/* ---------------- B. failure paths keep their codes (diagnosable, safe) ---------------- */

test('B1 missing API key fails as not_configured with zero Gemini spend', async () => {
  delete process.env.GEMINI_API_KEY;
  const ctx = makeCtx({ context: baseContext(), texts: mathTexts() });
  const err = await generateTargetedPractice.handler(ctx, ACTION_ARGS).catch((e) => e);
  assert.equal(errCode(err), 'not_configured');
  assert.equal(modelStub.__transportCalls().length, 0, 'no provider call without a key');
});

test('B2 malformed provider JSON twice -> generation_failed (bounded retries)', async () => {
  let n = 0;
  modelStub.__setTransport(async () => (++n, { ok: false, code: 'malformed_json', message: 'bad json' }));
  const ctx = makeCtx({ context: baseContext(), texts: mathTexts() });
  const err = await generateTargetedPractice.handler(ctx, ACTION_ARGS).catch((e) => e);
  assert.equal(errCode(err), 'generation_failed');
  assert.equal(n, 2, 'MAX_ATTEMPTS is 2');
});

test('B3 provider outage fails over to the fallback model, keeps provider_error, refunds quota', async () => {
  let n = 0;
  modelStub.__setTransport(async () => (++n, { ok: false, code: 'provider_error', message: '503' }));
  const capture = {};
  const ctx = makeCtx({ context: baseContext(), texts: mathTexts(), capture });
  const err = await generateTargetedPractice.handler(ctx, ACTION_ARGS).catch((e) => e);
  assert.equal(errCode(err), 'provider_error', 'confirmed root cause survives to the client, not generic');
  const models = modelStub.__transportCalls().map((c) => c.model);
  assert.deepEqual(models, ['gemini-3.6-flash', 'gemini-3.5-flash-lite'], 'primary then fallback model tried');
  assert.deepEqual(capture.refunds, [{ idKey: 'test-user-key' }], 'doomed attempt does not burn quota');
});

test('B3b provider timeout keeps its code and refunds quota', async () => {
  modelStub.__setTransport(async () => ({ ok: false, code: 'timeout', message: 'timed out' }));
  const capture = {};
  const ctx = makeCtx({ context: baseContext(), texts: mathTexts(), capture });
  const err = await generateTargetedPractice.handler(ctx, ACTION_ARGS).catch((e) => e);
  assert.equal(errCode(err), 'timeout');
  assert.deepEqual(capture.refunds, [{ idKey: 'test-user-key' }]);
});

test('B4 provider timeout -> generation_failed, no leak of raw error', async () => {
  modelStub.__setTransport(async () => ({ ok: false, code: 'network_error', message: 'socket hangup: ECONNRESET 10.0.0.1' }));
  const capture = {};
  const ctx = makeCtx({ context: baseContext(), texts: mathTexts(), capture });
  const err = await generateTargetedPractice.handler(ctx, ACTION_ARGS).catch((e) => e);
  assert.equal(errCode(err), 'generation_failed');
  const msg = err.data ? err.data.message : err.message;
  assert.ok(!msg.includes('ECONNRESET') && !msg.includes('10.0.0.1'), 'raw provider detail never reaches the client');
  assert.deepEqual(capture.refunds, [{ idKey: 'test-user-key' }], 'network failure refunds quota too');
});

test('B5 rate limiter refusal keeps its code (frontend can tell the user why)', async () => {
  const ctx = makeCtx({
    context: baseContext(), texts: mathTexts(),
    rateLimit: { ok: false, code: 'rate_limited', message: 'slow down' },
  });
  const err = await generateTargetedPractice.handler(ctx, ACTION_ARGS).catch((e) => e);
  assert.equal(errCode(err), 'rate_limited');
  assert.equal(modelStub.__transportCalls().length, 0, 'no Gemini spend after refusal');
});

test('B6 persistently invalid output -> generation_failed after bounded retries', async () => {
  const bad = validParsed();
  bad.questions[3] = { ...bad.questions[3], correctAnswer: 'yes please' }; // invalid true_false
  modelStub.__setTransport(async () => ({ ok: true, parsed: bad }));
  const capture = {};
  const ctx = makeCtx({ context: baseContext(), texts: mathTexts(), capture });
  const err = await generateTargetedPractice.handler(ctx, ACTION_ARGS).catch((e) => e);
  assert.equal(errCode(err), 'generation_failed');
  assert.equal(modelStub.__transportCalls().length, 2);
  assert.ok(!capture.refunds, 'model-output failures keep the charge (the provider did work)');
});

/* ---------------- E. quota refund: the real mutation + action wiring ---------------- */

function makeRateLimitDb(seed) {
  // seed: { bucketKey: count }
  const rows = new Map();
  let seq = 0;
  for (const [key, count] of Object.entries(seed)) {
    seq += 1;
    rows.set('rl' + seq, { _id: 'rl' + seq, key, count });
  }
  return {
    query: () => ({
      withIndex: (_name, predicate) => {
        let field; let value;
        const q = { eq: (f, v) => { field = f; value = v; return q; } };
        predicate(q);
        return { unique: async () => [...rows.values()].find((r) => r[field] === value) || null };
      },
    }),
    patch: async (id, p) => {
      const row = [...rows.values()].find((r) => r._id === id);
      if (row) Object.assign(row, p);
    },
    __counts: () => Object.fromEntries([...rows.values()].map((r) => [r.key, r.count])),
  };
}

function bucketKeys(idKey) {
  const now = Date.now();
  return {
    burst: `gen:burst:${idKey}:${Math.floor(now / (10 * 60 * 1000))}`,
    daily: `gen:daily:${idKey}:${Math.floor(now / (24 * 60 * 60 * 1000))}`,
  };
}

test('E1 refundGenerationQuota decrements burst+daily, never below zero, missing bucket is a no-op', async () => {
  const { refundGenerationQuota } = require('../../convex/quiz.ts');
  const { burst, daily } = bucketKeys('u1');
  const db = makeRateLimitDb({ [burst]: 3, [daily]: 1 });
  await refundGenerationQuota.handler({ db }, { idKey: 'u1' });
  assert.deepEqual(db.__counts(), { [burst]: 2, [daily]: 0 });

  await refundGenerationQuota.handler({ db }, { idKey: 'u1' });
  assert.deepEqual(db.__counts(), { [burst]: 1, [daily]: 0 }, 'daily never goes negative');

  await refundGenerationQuota.handler({ db: makeRateLimitDb({}) }, { idKey: 'nobody' });
  // no throw on missing buckets
});

test('E2 successful generation never refunds', async () => {
  const capture = {};
  const ctx = makeCtx({ context: baseContext(), texts: mathTexts(), capture });
  await generateTargetedPractice.handler(ctx, ACTION_ARGS);
  assert.ok(!capture.refunds, 'no refund on success');
});

test('E3 validation failure never refunds (provider did the work)', async () => {
  const bad = validParsed();
  bad.questions[0] = { ...bad.questions[0], correctOptionId: '' };
  modelStub.__setTransport(async () => ({ ok: true, parsed: bad }));
  const capture = {};
  const ctx = makeCtx({ context: baseContext(), texts: mathTexts(), capture });
  const err = await generateTargetedPractice.handler(ctx, ACTION_ARGS).catch((e) => e);
  assert.equal(errCode(err), 'generation_failed');
  assert.ok(!capture.refunds);
});

/* ---------------- C. safety: subject isolation + ownership ---------------- */

test('C1 wrong-subject material is rejected even with strong topic evidence', async () => {
  const weakWaves = { subject: 'Mathematics', subjectKey: 'mathematics', topic: 'Waves', topicKey: 'wave' };
  const ctx = makeCtx({
    context: {
      ok: true,
      area: { ...weakWaves, status: 'established' },
      materials: [{ id: 'p1', title: 'Physics Notes', subject: 'Physics' }],
      historicalKeys: [],
    },
    texts: [{ id: 'p1', title: 'Physics Notes', subject: 'Physics', extractedText: PHYSICS_TEXT }],
  });
  const err = await generateTargetedPractice.handler(
    ctx, { ...ACTION_ARGS, subjectKey: 'mathematics', topicKey: 'wave' }
  ).catch((e) => e);
  assert.equal(errCode(err), 'no_material', 'hard subject exclusion -> safe no_material, never generic fallback');
});

test('C2 material texts are fetched through the ownership-enforcing query with the caller session', async () => {
  const capture = {};
  const ctx = makeCtx({ context: baseContext(), texts: [], capture }); // texts [] = ownership filter removed everything
  const err = await generateTargetedPractice.handler(ctx, ACTION_ARGS).catch((e) => e);
  assert.equal(errCode(err), 'no_material');
  assert.ok(capture.textsArgs, 'getTargetedMaterialTexts was invoked');
  assert.equal(capture.textsArgs.sessionToken, 'sess-123', 'ownership is re-verified against the caller session, never trusted input');
  assert.deepEqual(capture.textsArgs.materialIds, ['m1']);
});

/* ---------------- D. frontend: not_configured is actionable, nothing leaks ---------------- */

test('D1 frontend shows actionable copy for not_configured (source-level guard)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../js/app.js'), 'utf8');
  assert.ok(src.includes("code === 'not_configured'"), 'frontend branches on not_configured');
  assert.ok(src.includes('isn\\u2019t set up on this deployment yet'), 'copy tells the user what is wrong');
  assert.ok(!src.includes('GEMINI_API_KEY'), 'no secret name leaks into client copy');
});

test('D2 frontend shows the overload message for provider_error/timeout (source-level guard)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../js/app.js'), 'utf8');
  assert.ok(src.includes("code === 'provider_error'"), 'frontend branches on provider_error');
  assert.ok(src.includes("code === 'timeout'"), 'frontend branches on timeout');
  assert.ok(src.includes('The AI service is overloaded right now'), 'honest overload copy, no provider internals');
});
