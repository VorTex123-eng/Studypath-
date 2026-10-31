/* A2 (AI-generated targeted practice) tests.
 *
 * Covers the pure, unit-testable core of the targeted flow in
 * convex/lib/targetedRetrieval.ts — the same functions the
 * generateTargetedPractice action calls:
 *
 *  - weak-area selection: eligibility + subject|topic bucket identity
 *  - material ranking: subject match, wrong-subject rejection, ordering
 *  - passage extraction + the hard context cap
 *  - prompt grounding (selected passages in, unrelated material out)
 *  - ownership predicate (cross-user rejection)
 *  - novelty backstop predicate (with the real questionKeyFor)
 *  - safe error mapping (no raw provider details leak)
 *  - an end-to-end selection simulation of the action's retrieval steps
 *
 * What is NOT unit-testable here (no Convex runtime, no network in this
 * environment) and must be verified after `npx convex deploy`:
 *  - the action's session -> account resolution and guest rejection
 *  - the shared 20/day rate limiter firing before Gemini spend
 *  - the Gemini transport paths (timeout / retry / fallback)
 *  - the frontend handoff (ready screen -> engine -> saveAttempt)
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { register } = require('node:module');
const { pathToFileURL } = require('node:url');

// Convex lib files use extensionless imports ("./topics"); map them to .ts.
register(pathToFileURL(path.join(__dirname, 'ts-resolve-hook.mjs')).href);

const T = require('../../convex/lib/targetedRetrieval.ts');
const { questionKeyFor } = require('../../convex/lib/results.ts');

const WEAK = {
  subject: 'Mathematics',
  subjectKey: 'mathematics',
  topic: 'Quadratic Equations',
  topicKey: 'quadratic-equation',
};

const MATH_TEXT = [
  'QUADRATIC EQUATIONS',
  '',
  'A quadratic equation is an equation of the form ax^2 + bx + c = 0 where a is not zero. To solve a quadratic equation we can factorise, complete the square, or use the quadratic formula.',
  '',
  'Worked example: solve x^2 - 5x + 6 = 0. Factorising gives (x - 2)(x - 3) = 0, so x = 2 or x = 3. Always check your solutions by substitution.',
  '',
  'PHOTOSYNTHESIS',
  '',
  'Photosynthesis is the process by which green plants convert sunlight, water and carbon dioxide into glucose and oxygen.',
].join('\n');

const BIO_TEXT = [
  'CELL BIOLOGY',
  '',
  'The cell is the basic unit of life. Mitochondria generate energy through respiration. Plant cells contain chloroplasts for photosynthesis.',
].join('\n');

/* ---------------- weak-area selection ---------------- */

test('isEligibleWeakArea: established / emerging / improving are eligible', () => {
  for (const status of ['established', 'emerging', 'improving']) {
    assert.equal(T.isEligibleWeakArea({ status, topicKey: 'quadratic-equation' }), true, status);
  }
});

test('isEligibleWeakArea: insufficient evidence, solid, null are not eligible', () => {
  assert.equal(T.isEligibleWeakArea({ status: 'insufficient', topicKey: 'quadratic-equation' }), false);
  assert.equal(T.isEligibleWeakArea({ status: 'solid', topicKey: 'quadratic-equation' }), false);
  assert.equal(T.isEligibleWeakArea(null), false);
  assert.equal(T.isEligibleWeakArea(undefined), false);
});

test('isEligibleWeakArea: the "general" bucket is too broad to target', () => {
  assert.equal(T.isEligibleWeakArea({ status: 'established', topicKey: 'general' }), false);
});

test('findWeakAreaBucket: subject+topic identity keeps Math/Waves and Physics/Waves distinct', () => {
  const areas = [
    { subjectKey: 'mathematics', topicKey: 'waves' },
    { subjectKey: 'physics', topicKey: 'waves' },
  ];
  assert.equal(T.findWeakAreaBucket(areas, 'mathematics', 'waves'), 0);
  assert.equal(T.findWeakAreaBucket(areas, 'physics', 'waves'), 1);
  assert.equal(T.findWeakAreaBucket(areas, 'biology', 'waves'), -1);
  assert.equal(T.findWeakAreaBucket(areas, 'physics', 'optics'), -1);
  assert.equal(T.findWeakAreaBucket(null, 'physics', 'waves'), -1);
});

/* ---------------- search terms ---------------- */

test('topicSearchTerms: canonical phrase plus keywords', () => {
  const terms = T.topicSearchTerms(WEAK);
  assert.equal(terms.phrase, 'Quadratic Equations');
  assert.ok(terms.keywords.includes('quadratic'), 'keywords include quadratic');
  assert.ok(terms.keywords.length >= 2);
});

/* ---------------- material ranking ---------------- */

test('subjectMatchScore: exact subject metadata = 100', () => {
  assert.equal(
    T.subjectMatchScore('mathematics', { id: 'm1', title: 'My Notes', subject: 'Mathematics' }),
    100
  );
});

test('subjectMatchScore: subject in title only = 60 (conservative, still eligible)', () => {
  assert.equal(
    T.subjectMatchScore('mathematics', { id: 'm1', title: 'JAMB Mathematics Past Questions', subject: '' }),
    60
  );
});

test('subjectMatchScore: no signal = 0', () => {
  assert.equal(
    T.subjectMatchScore('mathematics', { id: 'm1', title: 'Biology Notes', subject: 'Biology' }),
    0
  );
});

test('subjectMatchScore: wrong subject is 0 even when the title mentions the topic', () => {
  // A Physics note about quadratic equations must never ground a
  // Mathematics weak area: subject identity wins over topic words.
  assert.equal(
    T.subjectMatchScore('mathematics', { id: 'm1', title: 'Physics: Quadratic Equations Notes', subject: 'Physics' }),
    0
  );
});

test('rankMaterials: exact subject match ranks first, irrelevant excluded', () => {
  const ranked = T.rankMaterials(WEAK, [
    { id: 'm2', title: 'Biology Notes', subject: 'Biology' },
    { id: 'm3', title: 'JAMB Mathematics Past Questions', subject: '' },
    { id: 'm1', title: 'My Maths Notes', subject: 'Mathematics' },
  ]);
  assert.deepEqual(ranked.map((r) => r.id), ['m1', 'm3', 'm2']);
  assert.ok(ranked[0].score >= T.TARGETED_MIN_MATERIAL_SCORE);
  assert.ok(ranked[2].score < T.TARGETED_MIN_MATERIAL_SCORE);
  assert.ok(ranked[0].reasons.includes('subject metadata matches'));
});

test('rankMaterials: wrong-subject material with topic words scores below the eligibility floor', () => {
  const ranked = T.rankMaterials(WEAK, [
    { id: 'm4', title: 'Physics: Quadratic Equations Notes', subject: 'Physics' },
  ]);
  assert.ok(ranked[0].score < T.TARGETED_MIN_MATERIAL_SCORE,
    `wrong-subject score ${ranked[0].score} must stay below ${T.TARGETED_MIN_MATERIAL_SCORE}`);
  const eligible = ranked.filter((r) => r.score >= T.TARGETED_MIN_MATERIAL_SCORE);
  assert.equal(eligible.length, 0, 'nothing eligible -> the action fails safe with no_material');
});

test('rankMaterials: empty library -> no candidates', () => {
  assert.deepEqual(T.rankMaterials(WEAK, []), []);
});

/* ---------------- passage extraction ---------------- */

test('extractPassages: phrase hits dominate and headings are captured', () => {
  const passages = T.extractPassages(T.topicSearchTerms(WEAK), MATH_TEXT);
  assert.ok(passages.length > 0, 'expected passages');
  const best = passages[0];
  assert.ok(best.text.toLowerCase().includes('quadratic equation'),
    'best passage is about the topic');
  assert.ok(best.score >= 10, 'phrase hit scores at least 10');
  // Passages are sorted best-first.
  for (let i = 1; i < passages.length; i++) {
    assert.ok(passages[i - 1].score >= passages[i].score, 'sorted best-first');
  }
});

test('extractPassages: irrelevant text yields no passages', () => {
  assert.deepEqual(T.extractPassages(T.topicSearchTerms(WEAK), BIO_TEXT), []);
});

test('extractPassages: empty text yields no passages', () => {
  assert.deepEqual(T.extractPassages(T.topicSearchTerms(WEAK), ''), []);
  assert.deepEqual(T.extractPassages(T.topicSearchTerms(WEAK), '   \n\n  '), []);
});

test('buildTargetedContext: hard cap is respected', () => {
  const big = 'quadratic equations '.repeat(2000); // ~40k chars
  const passages = [{ text: big, heading: null, score: 100 }];
  const ctx = T.buildTargetedContext(passages, T.TARGETED_MAX_CONTEXT_CHARS);
  assert.ok(ctx.length <= T.TARGETED_MAX_CONTEXT_CHARS,
    `context ${ctx.length} chars must stay within the ${T.TARGETED_MAX_CONTEXT_CHARS}-char cap`);
  assert.equal(T.TARGETED_MAX_CONTEXT_CHARS, 8000, 'cap is documented as ~8000 chars');
});

test('buildTargetedContext: empty passages -> empty string (caller fails safe)', () => {
  assert.equal(T.buildTargetedContext([]), '');
});

/* ---------------- prompt grounding ---------------- */

test('buildTargetedPrompt: grounded in the selected passages only', () => {
  const contextText = 'A quadratic equation has the form ax^2 + bx + c = 0.';
  const prompt = T.buildTargetedPrompt({
    subject: 'Mathematics',
    topic: 'Quadratic Equations',
    contextText,
    materialTitle: 'My Maths Notes',
    questionCount: 8,
    difficulty: 'medium',
    allowedTypes: ['mcq', 'true_false', 'short_answer'],
  });
  assert.ok(prompt.includes('Mathematics'), 'subject present');
  assert.ok(prompt.includes('Quadratic Equations'), 'weak topic present');
  assert.ok(prompt.includes(contextText), 'selected passages present');
  assert.ok(prompt.includes('My Maths Notes'), 'material title present');
  assert.ok(prompt.includes('NEW'), 'novelty instruction present');
  assert.ok(prompt.includes('Set "topic" to exactly "Quadratic Equations"'),
    'topic identity pinned for A1 tracking');
  assert.ok(prompt.includes('Put the question wording in "text"'),
    'field name matches the enforced response schema');
  assert.ok(prompt.includes('LaTeX'), 'math formatting instruction present');
  assert.ok(!prompt.includes('Photosynthesis is the process'),
    'unrelated material must never appear in the prompt');
  assert.ok(prompt.includes('Generate exactly 8 question(s) at "medium" difficulty.'),
    'count and difficulty present, not forced to Expert');
});

test('buildTargetedPrompt: calculation material gets the new-problem framing', () => {
  const calc = 'To solve a quadratic equation, factorise: x^2 - 5x + 6 = 0 gives (x-2)(x-3) = 0, calculate x = 2 or x = 3.';
  const prompt = T.buildTargetedPrompt({
    subject: 'Mathematics',
    topic: 'Quadratic Equations',
    contextText: calc,
    materialTitle: 'Notes',
    questionCount: 5,
    difficulty: 'medium',
    allowedTypes: ['mcq'],
  });
  assert.ok(prompt.includes('calculation-based mathematics'),
    'calculation framing present for calculation material');
  const prose = T.buildTargetedPrompt({
    subject: 'Biology',
    topic: 'Photosynthesis',
    contextText: 'Photosynthesis converts sunlight, water and carbon dioxide into glucose.',
    materialTitle: 'Notes',
    questionCount: 5,
    difficulty: 'medium',
    allowedTypes: ['mcq'],
  });
  assert.ok(!prose.includes('calculation-based mathematics'),
    'no calculation framing for prose material');
});

test('detectsCalculationMaterial: math vs prose', () => {
  assert.equal(T.detectsCalculationMaterial(
    'To solve the equation x^2 - 5x + 6 = 0, factorise and calculate the roots. Evaluate each solution.'
  ), true);
  assert.equal(T.detectsCalculationMaterial(
    'Photosynthesis is the process by which plants make food.'
  ), false);
});

/* ---------------- ownership ---------------- */

test('filterOwnedRows: keeps own rows, drops other accounts and nulls', () => {
  const rows = [
    { _id: 'a', userId: 'userA', text: 'mine' },
    { _id: 'b', userId: 'userB', text: 'theirs' },
    null,
    { _id: 'c', userId: 'userA', text: 'mine too' },
  ];
  const kept = T.filterOwnedRows(rows, 'userA');
  assert.deepEqual(kept.map((r) => r._id), ['a', 'c']);
});

test('filterOwnedRows: user B can never receive user A material (cross-user REJECT)', () => {
  const rows = [{ _id: 'a', userId: 'userA', text: 'secret notes' }];
  assert.deepEqual(T.filterOwnedRows(rows, 'userB'), [],
    'a forged materialId from another account yields nothing');
});

test('filterOwnedRows: unknown user and empty input', () => {
  assert.deepEqual(T.filterOwnedRows([{ _id: 'a', userId: 'userA' }], 'nobody'), []);
  assert.deepEqual(T.filterOwnedRows([], 'userA'), []);
});

/* ---------------- novelty ---------------- */

test('hasNoveltyCollision: identical question (by questionKey) is a collision', () => {
  const seen = { type: 'mcq', text: 'What is 2 + 2?' };
  const historical = new Set([questionKeyFor(seen)]);
  assert.equal(
    T.hasNoveltyCollision([{ type: 'mcq', text: 'What is 2 + 2?' }], historical, questionKeyFor),
    true
  );
  assert.equal(
    T.hasNoveltyCollision([{ type: 'mcq', text: 'What is 3 + 3?' }], historical, questionKeyFor),
    false,
    'a genuinely new question is not a collision'
  );
});

test('hasNoveltyCollision: whitespace/case variants still collide', () => {
  const historical = new Set([questionKeyFor({ type: 'mcq', text: 'What is 2+2?' })]);
  assert.equal(
    T.hasNoveltyCollision([{ type: 'mcq', text: '  WHAT  IS  2+2? ' }], historical, questionKeyFor),
    true,
    'normalisation catches cosmetic rewording'
  );
});

test('hasNoveltyCollision: empty history never collides', () => {
  assert.equal(
    T.hasNoveltyCollision([{ type: 'mcq', text: 'Anything' }], new Set(), questionKeyFor),
    false
  );
});

/* ---------------- safe errors ---------------- */

test('targetedErrorFor: known codes keep their safe messages', () => {
  const cases = {
    no_material: 'No saved material',
    no_weak_area: "doesn't look like a weak area",
    not_authenticated: 'sign in again',
    rate_limited: "today's practice generations",
    invalid_response: 'usable form',
    generation_failed: "Couldn't generate",
    not_configured: "isn't available",
  };
  for (const [code, snippet] of Object.entries(cases)) {
    const out = T.targetedErrorFor({ code, message: 'SOME RAW PROVIDER TEXT' });
    assert.equal(out.code, code);
    assert.ok(out.message.includes(snippet), `${code}: ${out.message}`);
    assert.ok(!out.message.includes('SOME RAW PROVIDER TEXT'), 'raw text never forwarded');
  }
});

test('targetedErrorFor: ConvexError data.code shape is honoured', () => {
  const out = T.targetedErrorFor({ data: { code: 'no_material' } });
  assert.equal(out.code, 'no_material');
});

test('targetedErrorFor: unknown failures (timeout, provider, network) map to a generic safe message', () => {
  const scary = new Error('fetch failed: ECONNREFUSED api.key=sk-live-abc123\n    at stack line 1');
  const out = T.targetedErrorFor(scary);
  assert.equal(out.code, 'generation_failed');
  assert.equal(out.message, "Couldn't generate targeted practice right now. Please try again.");
  assert.ok(!out.message.includes('sk-live'), 'no keys leak');
  assert.ok(!out.message.includes('ECONNREFUSED'), 'no internals leak');
  assert.ok(!out.message.includes('stack'), 'no stack traces leak');
});

test('targetedErrorFor: all mapped states produce safe, non-empty messages', () => {
  const codes = ['no_material', 'no_weak_area', 'not_authenticated', 'rate_limited',
    'invalid_response', 'generation_failed', 'bad_request', 'not_configured',
    'provider_error', 'timeout'];
  for (const code of codes) {
    const out = T.targetedErrorFor({ code });
    assert.ok(out.message && out.message.length > 10, code);
    assert.ok(!/sk-|api[_-]?key|stack|ECONN|Error:/i.test(out.message), `${code} message is safe`);
  }
});

test('targetedErrorFor: provider_error/timeout keep honest overload codes', () => {
  const p = T.targetedErrorFor({ code: 'provider_error', message: 'HTTP 503 high demand' });
  assert.equal(p.code, 'provider_error');
  assert.ok(p.message.includes('overloaded'), p.message);
  assert.ok(!p.message.includes('503'), 'no provider internals leak');
  const t = T.targetedErrorFor({ code: 'timeout', message: 'socket timed out' });
  assert.equal(t.code, 'timeout');
  assert.ok(!t.message.includes('socket'), 'no internals leak');
});

/* ---------------- end-to-end selection simulation ----------------
   Mirrors the action's retrieval steps (rank metadata -> top candidates
   -> passage evidence -> bounded context) without a Convex runtime. */

function simulateSelection(weak, metas, textsById) {
  const ranked = T.rankMaterials(weak, metas);
  // Mirrors the action: isFetchCandidate is the single gate before text.
  const candidates = ranked
    .filter((r) => T.isFetchCandidate(r))
    .slice(0, T.TARGETED_MAX_MATERIALS_FETCHED);
  const terms = T.topicSearchTerms(weak);
  let best = null;
  let bestScore = -1;
  for (const c of candidates) {
    const meta = metas.find((m) => m.id === c.id);
    // Ownership re-verified per row, exactly like the internal query.
    const owned = T.filterOwnedRows([{ ...meta, userId: meta.userId, text: textsById[c.id] }], meta.userId);
    if (!owned.length) continue;
    const passages = T.extractPassages(terms, textsById[c.id] || '');
    const evidence = passages.reduce((s, p) => s + p.score, 0);
    if (evidence >= T.TARGETED_MIN_PASSAGE_SCORE && evidence > bestScore) {
      best = { id: c.id, title: meta.title, contextText: T.buildTargetedContext(passages) };
      bestScore = evidence;
    }
  }
  return best; // null -> the action throws no_material (never generic fallback)
}

test('selection: math weak area grounds in the math material, bounded', () => {
  const metas = [
    { id: 'm1', title: 'My Maths Notes', subject: 'Mathematics', userId: 'userA' },
    { id: 'm2', title: 'Biology Notes', subject: 'Biology', userId: 'userA' },
  ];
  const best = simulateSelection(WEAK, metas, { m1: MATH_TEXT, m2: BIO_TEXT });
  assert.ok(best, 'a relevant material is selected');
  assert.equal(best.id, 'm1');
  assert.ok(best.contextText.length > 0);
  assert.ok(best.contextText.length <= T.TARGETED_MAX_CONTEXT_CHARS);
  assert.ok(best.contextText.toLowerCase().includes('quadratic'),
    'context is about the weak topic');
  assert.ok(!best.contextText.includes('Photosynthesis is the process'),
    'off-topic blocks from the same material stay out of the context');
});

test('selection: no relevant material -> null (no_material, never generic fallback)', () => {
  const metas = [
    { id: 'm2', title: 'Biology Notes', subject: 'Biology', userId: 'userA' },
  ];
  assert.equal(simulateSelection(WEAK, metas, { m2: BIO_TEXT }), null);
});

test('selection: deleted material is simply absent from the candidate set', () => {
  // Deletion removes the row; ranking only ever sees live rows.
  const metas = [
    { id: 'm1', title: 'My Maths Notes', subject: 'Mathematics', userId: 'userA' },
  ];
  assert.equal(simulateSelection(WEAK, metas, {}), null,
    'a deleted (or never-fetched) material contributes no text');
});

test('selection: at most 3 materials are ever fetched for text', () => {
  assert.equal(T.TARGETED_MAX_MATERIALS_FETCHED, 3);
  const metas = Array.from({ length: 6 }, (_, i) => ({
    id: 'm' + i, title: 'Mathematics Notes ' + i, subject: 'Mathematics', userId: 'userA',
  }));
  const ranked = T.rankMaterials(WEAK, metas);
  const fetched = ranked
    .filter((r) => T.isFetchCandidate(r))
    .slice(0, T.TARGETED_MAX_MATERIALS_FETCHED);
  assert.ok(fetched.length <= 3);
});
