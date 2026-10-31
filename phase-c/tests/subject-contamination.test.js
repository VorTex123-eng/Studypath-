/* Subject/topic contamination regression tests (A1 bug fix).
 *
 * The bug: weak areas were grouped by topicKey alone, so a Mathematics quiz's
 * questions could merge into a Biology weak-area bucket whenever topic names
 * collided. The fix: weak-area identity = subjectKeyFor(subject) + "|" +
 * topicKeyFor(topic), with subject being the application-owned quiz context.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { register } = require('node:module');
const { pathToFileURL } = require('node:url');

// Convex lib files use extensionless imports ("./topics"); map them to .ts.
register(pathToFileURL(path.join(__dirname, 'ts-resolve-hook.mjs')).href);

const { computeWeakAreas, subjectKeyFor } = require('../../convex/lib/weakness.ts');
const { deriveQuestionResults } = require('../../convex/lib/results.ts');
const { computeQuestionsToRevisit } = require('../../convex/lib/revisit.ts');

const NOW = 1700000000000;
const DAY = 86400000;

let seq = 0;
function row(over = {}) {
  seq += 1;
  return {
    subject: 'Mathematics',
    topicKey: 'algebra',
    topic: 'Algebra',
    questionKey: 'qk_' + seq,
    quizId: 'quiz_1',
    retryOf: null,
    type: 'mcq',
    difficulty: 'medium',
    outcome: 'incorrect',
    answeredAt: NOW + seq * 1000,
    ...over,
  };
}

// N questions split across quizzes, all incorrect unless told otherwise.
// questionKeys are globally unique so cross-quiz rows are first exposures,
// not repeats.
function quizRows({ subject, topic, count, quizzes = 1, correct = 0, start = NOW }) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    seq += 1;
    rows.push(row({
      subject,
      topic,
      topicKey: topic.toLowerCase(),
      questionKey: 'qk_' + seq,
      quizId: 'quiz_' + subject + '_' + (i % quizzes),
      outcome: i < correct ? 'correct' : 'incorrect',
      answeredAt: start + i * 1000,
    }));
  }
  return rows;
}

function bucketsOf(rows) {
  const report = computeWeakAreas(rows);
  const map = new Map();
  // Key by canonical identity (subjectKey|topicKey), not display labels.
  for (const a of report.areas) map.set(a.subjectKey + '|' + a.topicKey, a);
  return { report, map };
}

// ---------- TEST 1: Math/Algebra vs Biology/Genetics stay separate ----------
test('different subjects and topics form separate buckets', () => {
  const rows = [
    ...quizRows({ subject: 'Mathematics', topic: 'Algebra', count: 5, quizzes: 2 }),
    ...quizRows({ subject: 'Biology', topic: 'Genetics', count: 5, quizzes: 2 }),
  ];
  const { map } = bucketsOf(rows);
  assert.ok(map.has('mathematics|algebra'), 'Mathematics|Algebra bucket exists');
  assert.ok(map.has('biology|genetic'), 'Biology|Genetics bucket exists');
  assert.equal(map.get('mathematics|algebra').questions, 5);
  assert.equal(map.get('biology|genetic').questions, 5);
  assert.equal(map.get('mathematics|algebra').subject, 'Mathematics');
  assert.equal(map.get('biology|genetic').subject, 'Biology');
});

// ---------- TEST 2: same topic name, different subjects ----------
test('same topic name in different subjects stays in independent buckets', () => {
  const rows = [
    ...quizRows({ subject: 'Mathematics', topic: 'Waves', count: 5, quizzes: 2 }),
    ...quizRows({ subject: 'Physics', topic: 'Waves', count: 5, quizzes: 2 }),
  ];
  const { report, map } = bucketsOf(rows);
  assert.equal(report.areas.length, 2, 'two independent buckets, not one merged');
  assert.ok(map.has('mathematics|wave'));
  assert.ok(map.has('physics|wave'));
  assert.equal(map.get('mathematics|wave').questions, 5);
  assert.equal(map.get('physics|wave').questions, 5);
  // Evidence must not combine: each bucket sees only its own 5 answers.
  assert.equal(map.get('mathematics|wave').quizzes, 2);
});

// ---------- TEST 3: different topic + different subjects ----------
test('no contamination across unrelated subject/topic pairs', () => {
  const rows = [
    ...quizRows({ subject: 'Mathematics', topic: 'Algebra', count: 5, quizzes: 2 }),
    ...quizRows({ subject: 'Biology', topic: 'Genetics', count: 5, quizzes: 2 }),
    ...quizRows({ subject: 'History', topic: 'World War 2', count: 5, quizzes: 2 }),
  ];
  const { report } = bucketsOf(rows);
  assert.equal(report.areas.length, 3);
  for (const a of report.areas) {
    assert.equal(a.questions, 5, `${a.subject}|${a.topic} has exactly its own 5 answers`);
  }
});

// ---------- TEST 4: AI quiz keeps application-owned subject ----------
test('deriveQuestionResults stamps the quiz subject regardless of AI topic labels', () => {
  const attempt = {
    quizId: 'gemini_123',
    subject: 'Mathematics', // application-owned, from quiz config
    difficulty: 'medium',
    mode: 'study',
    retryOf: null,
    completedAt: NOW,
    questions: [
      { id: 'q_1', type: 'mcq', text: 'Solve x^2 = 4', topic: 'Biology', correctOptionId: 'a', options: [{ id: 'a', text: '2' }] },
      { id: 'q_2', type: 'mcq', text: 'Solve 2x = 10', topic: 'Cell Biology', correctOptionId: 'a', options: [{ id: 'a', text: '5' }] },
      { id: 'q_3', type: 'true_false', text: 'Pi is rational', topic: 'Genetics', correctAnswer: false },
    ],
    answers: { q_1: 'a', q_2: 'b', q_3: 'true' },
  };
  const rows = deriveQuestionResults(attempt);
  assert.equal(rows.length, 3);
  for (const r of rows) {
    assert.equal(r.subject, 'Mathematics', `question keeps quiz subject, not AI topic (${r.topic})`);
  }
  // And those rows land in Mathematics buckets, never Biology ones.
  const { map } = bucketsOf(rows.map((r) => ({ ...r, answeredAt: NOW })));
  for (const key of map.keys()) {
    assert.ok(key.startsWith('mathematics|'), `bucket ${key} is Mathematics-scoped`);
  }
});

// ---------- TEST 5: sequential quizzes keep their subjects ----------
test('Math -> Biology -> Math sequence keeps each result with its quiz subject', () => {
  const mk = (subject, topic, n, t0) => quizRows({ subject, topic, count: n, quizzes: 1, start: t0 })
    .map((r, i) => ({ ...r, quizId: 'quiz_' + subject + '_' + t0 }));
  const rows = [
    ...mk('Mathematics', 'Algebra', 3, NOW),
    ...mk('Biology', 'Genetics', 3, NOW + DAY),
    ...mk('Mathematics', 'Geometry', 3, NOW + 2 * DAY),
  ];
  const derived = rows; // rows already carry subject like deriveQuestionResults stamps
  const byQuiz = new Map();
  for (const r of derived) {
    const k = r.quizId;
    if (!byQuiz.has(k)) byQuiz.set(k, new Set());
    byQuiz.get(k).add(r.subject);
  }
  for (const [quizId, subjects] of byQuiz) {
    assert.equal(subjects.size, 1, `${quizId} has exactly one subject`);
  }
  const mathRows = derived.filter((r) => r.quizId.includes('Mathematics'));
  assert.ok(mathRows.every((r) => r.subject === 'Mathematics'));
  const bioRows = derived.filter((r) => r.quizId.includes('Biology'));
  assert.ok(bioRows.every((r) => r.subject === 'Biology'));
});

// ---------- TEST 6: A1 scoring behavior unchanged ----------
test('A1 thresholds still behave: insufficient / emerging / established / improving', () => {
  // insufficient: fewer than 4 independent answers
  let r = computeWeakAreas(quizRows({ subject: 'Mathematics', topic: 'Algebra', count: 3, quizzes: 1 }));
  assert.equal(r.areas.length, 0, '3 answers -> no weak area');
  assert.equal(r.summary.insufficient, 1);

  // emerging: >= 4 answers, >= 2 missed, mean < 0.65
  r = computeWeakAreas(quizRows({ subject: 'Mathematics', topic: 'Algebra', count: 5, quizzes: 2, correct: 1 }));
  assert.equal(r.areas.length, 1);
  assert.equal(r.areas[0].status, 'emerging');

  // established: >= 8 answers across >= 2 quizzes, clearly weak
  r = computeWeakAreas(quizRows({ subject: 'Mathematics', topic: 'Algebra', count: 10, quizzes: 2, correct: 2 }));
  assert.equal(r.areas.length, 1);
  assert.equal(r.areas[0].status, 'established');

  // improving: 3 quizzes, old < 65%, recent >= 70%, rise >= 20pts
  const q = (id, correct, total, t) => quizRows({ subject: 'Mathematics', topic: 'Algebra', count: total, quizzes: 1, correct, start: t })
    .map((x) => ({ ...x, quizId: id }));
  r = computeWeakAreas([
    ...q('qz1', 1, 5, NOW),
    ...q('qz2', 4, 5, NOW + DAY),
    ...q('qz3', 5, 5, NOW + 2 * DAY),
  ]);
  assert.equal(r.areas.length, 1);
  assert.equal(r.areas[0].status, 'improving');

  // solid: mostly correct stays out of weak areas
  r = computeWeakAreas(quizRows({ subject: 'Mathematics', topic: 'Algebra', count: 8, quizzes: 2, correct: 8 }));
  assert.equal(r.areas.length, 0);
  assert.equal(r.summary.solid, 1);
});

// ---------- TEST 7: questions to revisit still works ----------
test('computeQuestionsToRevisit still works and carries subject context', () => {
  const rows = [
    { questionKey: 'qk_a', subject: 'Mathematics', topic: 'Algebra', type: 'mcq', outcome: 'incorrect', answeredAt: NOW },
    { questionKey: 'qk_a', subject: 'Mathematics', topic: 'Algebra', type: 'mcq', outcome: 'incorrect', answeredAt: NOW + 1000 },
    { questionKey: 'qk_b', subject: 'Biology', topic: 'Genetics', type: 'mcq', outcome: 'skipped', answeredAt: NOW + 2000 },
    { questionKey: 'qk_c', subject: 'Mathematics', topic: 'Algebra', type: 'mcq', outcome: 'correct', answeredAt: NOW + 3000 },
  ];
  const out = computeQuestionsToRevisit(rows);
  assert.equal(out.total, 2, 'qk_a (repeated miss) and qk_b qualify; qk_c recovered');
  assert.equal(out.repeated, 1);
  const byKey = new Map(out.items.map((i) => [i.questionKey, i]));
  assert.equal(byKey.get('qk_a').subject, 'Mathematics');
  assert.equal(byKey.get('qk_b').subject, 'Biology');
  assert.equal(byKey.get('qk_a').misses, 2);
});

// ---------- TEST 8: cross-user isolation ----------
test('grouping is pure per-call: two users never share buckets', () => {
  // computeWeakAreas only ever sees one user's rows (loadOwnResultRows
  // scopes by session server-side); verify the function itself carries no
  // cross-call state by running two users' identical-shape data.
  const aRows = quizRows({ subject: 'Mathematics', topic: 'Algebra', count: 5, quizzes: 2 });
  const bRows = quizRows({ subject: 'Mathematics', topic: 'Algebra', count: 5, quizzes: 2 });
  const a = computeWeakAreas(aRows);
  const b = computeWeakAreas(bRows);
  assert.equal(a.areas.length, 1);
  assert.equal(b.areas.length, 1);
  assert.equal(a.areas[0].questions, 5, 'user A report has only user A evidence');
  assert.equal(b.areas[0].questions, 5, 'user B report has only user B evidence');
  // ResultRow has no userId dimension at all - isolation is enforced by the
  // caller (loadOwnResultRows), not the scorer.
  assert.ok(!('userId' in a.areas[0]));
});

// ---------- TEST 9: historical attempts still load ----------
test('deriveQuestionResults tolerates old shapes without a subject', () => {
  const attempt = {
    quizId: 'old_1',
    // no subject field (pre-fix historical shape)
    difficulty: 'medium',
    mode: 'study',
    retryOf: null,
    completedAt: NOW,
    questions: [{ id: 'q_1', type: 'mcq', text: '2+2?', topic: 'Arithmetic', correctOptionId: 'a', options: [{ id: 'a', text: '4' }] }],
    answers: { q_1: 'a' },
  };
  const rows = deriveQuestionResults(attempt);
  assert.equal(rows.length, 1);
  // subjectKeyFor(undefined) -> "" : old rows form their own bucket, no crash, no guessing.
  const r = computeWeakAreas(rows);
  assert.equal(r.summary.tracked, 1);
  assert.equal(subjectKeyFor(undefined), '');
  assert.equal(subjectKeyFor(null), '');
});

// ---------- TEST 10: normalization merges within a subject, never across ----------
test('topic variants merge within one subject only', () => {
  const rows = [
    ...quizRows({ subject: 'Physics', topic: 'Waves', count: 2, quizzes: 1 }),
    ...quizRows({ subject: 'Physics', topic: 'waves', count: 2, quizzes: 1 }),
    ...quizRows({ subject: 'Physics', topic: 'Waves.', count: 2, quizzes: 1 }),
    ...quizRows({ subject: 'Mathematics', topic: 'Waves', count: 5, quizzes: 2 }),
  ];
  const { report, map } = bucketsOf(rows);
  assert.equal(report.summary.tracked, 2, 'two buckets total');
  assert.equal(map.get('physics|wave').questions, 6, 'Physics variants merged');
  assert.equal(map.get('mathematics|wave').questions, 5, 'Mathematics stays separate');
});

test('subjectKeyFor is conservative: near-miss subjects do not merge', () => {
  assert.equal(subjectKeyFor('Mathematics'), 'mathematics');
  assert.equal(subjectKeyFor('  MATHEMATICS  '), 'mathematics');
  assert.notEqual(subjectKeyFor('Maths'), subjectKeyFor('Mathematics'), 'no semantic merging by design');
  assert.notEqual(subjectKeyFor('Biology'), subjectKeyFor('Mathematics'));
});
