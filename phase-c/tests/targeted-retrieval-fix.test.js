/* A2 false-"no_material" fix — regression tests.
 *
 * The bug: legitimate saved material was rejected as "no saved material
 * found for this weak area" in two places:
 *  1. the metadata gate: materials with no stored subject (saved before
 *     the A1 subject fix) whose title lacked subject words scored 0 and
 *     their text was never read;
 *  2. passage scoring: singular/plural-blind literal matching, so a
 *     material saying "quadratic equation" never matched the topic
 *     "Quadratic Equations" at phrase level and keyword "equation"
 *     never matched "equations".
 *
 * The fix (convex/lib/targetedRetrieval.ts):
 *  - variant-tolerant matching: words match up to singular/plural via
 *    the same singularise() the topic keys use; phrases must still
 *    match in order and contiguously (no semantic matching);
 *  - single-line headings detected (ALL-CAPS, colon, #, Title Case),
 *    with the heading bonus attributed to the heading block;
 *  - known-but-wrong subject is HARD-EXCLUDED (never fetched, whatever
 *    the topic evidence); unknown subject is not wrong — title signals
 *    can admit it, and the passage evidence bar decides;
 *  - retrieval-only subject aliases, documented ("Maths"="Mathematics").
 *
 * What is NOT covered here: the live Convex action wiring (session,
 * rate limit, Gemini) — verified after `npx convex deploy`.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { register } = require('node:module');
const { pathToFileURL } = require('node:url');

register(pathToFileURL(path.join(__dirname, 'ts-resolve-hook.mjs')).href);

const T = require('../../convex/lib/targetedRetrieval.ts');

const WEAK_QE = {
  subject: 'Mathematics', subjectKey: 'mathematics',
  topic: 'Quadratic Equations', topicKey: 'equation-quadratic',
};
const WEAK_WAVES = {
  subject: 'Mathematics', subjectKey: 'mathematics',
  topic: 'Waves', topicKey: 'wave',
};

const QE_TEXT = [
  'Quadratic equations can be solved using the quadratic formula.',
  'The discriminant tells us the nature of the roots.',
].join(' ');
const QE_SINGULAR_TEXT =
  'A quadratic equation has the form ax^2 + bx + c = 0. ' +
  'To solve a quadratic equation, factorise it and check each root.';
const QE_CONTEXTUAL_TEXT =
  'To solve an equation of the form ax^2 + bx + c = 0, first try factorising. ' +
  'A quadratic equation always has at most two real roots.';
const QE_HEADING_TEXT = [
  'Quadratic Equations',
  '',
  'To solve these, first isolate the squared term and take square roots of both sides.',
  'Always verify each candidate root by substitution.',
].join('\n');
const WAVES_TEXT =
  'Waves transfer energy without transferring matter. ' +
  'Transverse waves oscillate perpendicular to the direction of travel.';

/* ---------------- TEST 1: exact match ---------------- */

test('TEST 1 — exact subject+topic match is selected', () => {
  const d = T.diagnoseTargetedRetrieval(WEAK_QE,
    [{ id: 'm1', title: 'JAMB Mathematics Notes', subject: 'Mathematics' }],
    { m1: QE_TEXT });
  assert.equal(d.selectedId, 'm1');
  const s = d.stages[0];
  assert.equal(s.subjectDecision, 'match');
  assert.equal(s.subjectScore, 100);
  assert.equal(s.decision, 'selected');
  assert.ok(s.evidence >= T.TARGETED_MIN_PASSAGE_SCORE);
});

/* ---------------- TEST 2: case difference ---------------- */

test('TEST 2 — subject case difference still matches', () => {
  const d = T.diagnoseTargetedRetrieval(WEAK_QE,
    [{ id: 'm1', title: 'My Notes', subject: 'mathematics' }],
    { m1: QE_TEXT });
  assert.equal(d.selectedId, 'm1');
  assert.equal(d.stages[0].subjectScore, 100);
});

/* ---------------- TEST 3: singular/plural ---------------- */

test('TEST 3 — singular-only text matches the plural topic', () => {
  // "Quadratic Equations" (topic) vs "quadratic equation" (text):
  // variant-tolerant phrase matching must bridge the gap.
  assert.equal(T.phraseMatchesText('Quadratic Equations', 'a quadratic equation has the form'), true);
  assert.equal(T.phraseMatchesText('Quadratic Equations', 'quadratic equations are easy'), true);
  const d = T.diagnoseTargetedRetrieval(WEAK_QE,
    [{ id: 'm1', title: 'JAMB Mathematics Notes', subject: 'Mathematics' }],
    { m1: QE_SINGULAR_TEXT });
  assert.equal(d.selectedId, 'm1', 'singular-only material must be selected');
});

test('plural keyword matches: "equation" finds "equations"', () => {
  const terms = T.topicSearchTerms(WEAK_QE);
  const passages = T.extractPassages(terms, 'Equations of many kinds exist. These equations are hard.');
  assert.ok(passages.length > 0, 'plural "equations" matches keyword "equation"');
  assert.ok(passages[0].score >= 2);
});

test('keyword occurrences are not double-counted after singularise-dedupe', () => {
  // topicSearchTerms yields both "equation" (key) and "equations"
  // (label); both singularise to "equation" and must count once.
  const terms = T.topicSearchTerms(WEAK_QE);
  const passages = T.extractPassages(terms, 'Solve the equation.');
  // one keyword occurrence = 2, no phrase, no heading
  assert.equal(passages[0].score, 2);
});

test('phrase matching preserves word order (no semantic reordering)', () => {
  assert.equal(T.phraseMatchesText('Quadratic Equations', 'the equation is not quadratic at all'), false,
    'out-of-order words must not phrase-match');
  assert.equal(T.phraseMatchesText('Cell Division', 'Mitosis and Meiosis'), false,
    'related-but-different wording must not phrase-match');
});

/* ---------------- TEST 4: title support ---------------- */

test('TEST 4 — title subject signal admits an unknown-subject material', () => {
  const d = T.diagnoseTargetedRetrieval(WEAK_QE,
    [{ id: 'm1', title: 'JAMB Mathematics', subject: '' }],
    { m1: QE_TEXT });
  const s = d.stages[0];
  assert.equal(s.subjectDecision, 'unknown');
  assert.equal(s.fetchCandidate, true, 'title subject signal admits the material');
  assert.equal(d.selectedId, 'm1');
});

test('TEST 4b — title naming the topic admits an unknown-subject material', () => {
  const d = T.diagnoseTargetedRetrieval(WEAK_QE,
    [{ id: 'm1', title: 'Quadratic Equations Summary', subject: '' }],
    { m1: QE_TEXT });
  assert.equal(d.stages[0].fetchCandidate, true);
  assert.equal(d.selectedId, 'm1');
});

test('TEST 4c — unknown subject with no title signal is still not fetched (precision)', () => {
  const d = T.diagnoseTargetedRetrieval(WEAK_QE,
    [{ id: 'm1', title: 'MTH101 Notes', subject: '' }],
    { m1: QE_TEXT });
  assert.equal(d.stages[0].fetchCandidate, false,
    'no subject signal and no topic signal: text is never read');
  assert.equal(d.selectedId, null);
});

/* ---------------- TEST 5: heading support ---------------- */

test('TEST 5 — standalone single-line heading grounds the material', () => {
  const terms = T.topicSearchTerms(WEAK_QE);
  const passages = T.extractPassages(terms, QE_HEADING_TEXT);
  assert.ok(passages.length > 0);
  assert.equal(passages[0].heading, 'Quadratic Equations', 'single-line heading detected');
  assert.ok(passages[0].score >= 18, `heading block scores phrase(10)+keyword+heading bonus, got ${passages[0].score}`);
  const d = T.diagnoseTargetedRetrieval(WEAK_QE,
    [{ id: 'm1', title: 'JAMB Mathematics Notes', subject: 'Mathematics' }],
    { m1: QE_HEADING_TEXT });
  assert.equal(d.selectedId, 'm1');
});

test('heading detection: ALL-CAPS, colon, markdown, Title Case vs sentences', () => {
  const terms = T.topicSearchTerms(WEAK_QE);
  const scoreOf = (block) => {
    const p = T.extractPassages(terms, block);
    return p.length ? { score: p[0].score, heading: p[0].heading } : null;
  };
  assert.ok(scoreOf('QUADRATIC EQUATIONS').heading, 'ALL-CAPS heading');
  assert.ok(scoreOf('# Quadratic Equations').heading, 'markdown heading');
  assert.ok(scoreOf('Quadratic Equations:').heading, 'colon heading');
  assert.ok(scoreOf('Quadratic Equations').heading, 'Title Case heading');
  const sentence = scoreOf('Quadratic equations can be solved in several different ways, including factoring.');
  assert.equal(sentence.heading, null, 'ordinary sentence is not a heading');
  const longLine = scoreOf('Introduction to the general theory of quadratic equations and their many applications');
  assert.equal(longLine.heading, null, 'long descriptive line is not a heading');
});

/* ---------------- TEST 6: contextual wording ---------------- */

test('TEST 6 — contextual wording with sufficient evidence is selected', () => {
  const d = T.diagnoseTargetedRetrieval(WEAK_QE,
    [{ id: 'm1', title: 'JAMB Mathematics Notes', subject: 'Mathematics' }],
    { m1: QE_CONTEXTUAL_TEXT });
  assert.equal(d.selectedId, 'm1');
  assert.ok(d.stages[0].evidence >= T.TARGETED_MIN_PASSAGE_SCORE);
});

test('TEST 6b — thin contextual mention stays below the bar', () => {
  const d = T.diagnoseTargetedRetrieval(WEAK_QE,
    [{ id: 'm1', title: 'JAMB Mathematics Notes', subject: 'Mathematics' }],
    { m1: 'We will solve an equation later.' });
  assert.equal(d.selectedId, null, 'one keyword mention is not enough evidence');
});

/* ---------------- TEST 7: wrong subject ---------------- */

test('TEST 7 — wrong-subject material is hard-excluded even with topic words', () => {
  const d = T.diagnoseTargetedRetrieval(WEAK_WAVES,
    [{ id: 'm1', title: 'Physics Notes', subject: 'Physics' }],
    { m1: WAVES_TEXT });
  const s = d.stages[0];
  assert.equal(s.subjectDecision, 'excluded');
  assert.equal(s.fetchCandidate, false, 'excluded materials are never fetched');
  assert.equal(d.selectedId, null);
});

test('TEST 7b — exclusion holds when the title also names the topic', () => {
  const d = T.diagnoseTargetedRetrieval(WEAK_QE,
    [{ id: 'm1', title: 'Physics: Quadratic Equations Notes', subject: 'Physics' }],
    { m1: QE_TEXT });
  assert.equal(d.stages[0].subjectDecision, 'excluded');
  assert.equal(d.selectedId, null);
});

test('isSubjectExcluded: known mismatch excluded; unknown never excluded', () => {
  assert.equal(T.isSubjectExcluded('mathematics', { id: 'x', title: 't', subject: 'Physics' }), true);
  assert.equal(T.isSubjectExcluded('mathematics', { id: 'x', title: 't', subject: '' }), false);
  assert.equal(T.isSubjectExcluded('mathematics', { id: 'x', title: 't', subject: 'Mathematics' }), false);
  assert.equal(T.isSubjectExcluded('', { id: 'x', title: 't', subject: 'Physics' }), false,
    'unknown weak subject does not exclude');
});

/* ---------------- TEST 8: same topic, correct subject ---------------- */

test('TEST 8 — same topic words with the correct subject are selected', () => {
  const d = T.diagnoseTargetedRetrieval(WEAK_WAVES,
    [{ id: 'm1', title: 'Mathematics Notes', subject: 'Mathematics' }],
    { m1: WAVES_TEXT });
  assert.equal(d.selectedId, 'm1');
});

/* ---------------- subject aliases ---------------- */

test('retrieval-only subject aliases: Maths/Math = Mathematics', () => {
  assert.equal(T.canonicalSubjectKey('Maths'), 'mathematics');
  assert.equal(T.canonicalSubjectKey('MATHS'), 'mathematics');
  assert.equal(T.canonicalSubjectKey('Math'), 'mathematics');
  assert.equal(T.canonicalSubjectKey('Mathematics'), 'mathematics');
  assert.equal(T.canonicalSubjectKey('Physics'), 'physics', 'non-aliased subjects untouched');
  assert.equal(T.canonicalSubjectKey(''), '');
  const d = T.diagnoseTargetedRetrieval(WEAK_QE,
    [{ id: 'm1', title: 'My Notes', subject: 'Maths' }],
    { m1: QE_TEXT });
  assert.equal(d.stages[0].subjectScore, 100);
  assert.equal(d.selectedId, 'm1');
});

test('aliases apply to title-word overlap too, but never across real subjects', () => {
  assert.equal(
    T.subjectMatchScore('Maths', { id: 'x', title: 'Mathematics Notes', subject: '' }),
    60, 'weak "Maths" matches title word "Mathematics" via alias');
  assert.equal(
    T.subjectMatchScore('mathematics', { id: 'x', title: 'Maths Notes', subject: '' }),
    60, 'weak "Mathematics" matches title word "Maths" via alias');
  assert.equal(T.isSubjectExcluded('mathematics', { id: 'x', title: 't', subject: 'Maths' }), false);
  assert.equal(T.isSubjectExcluded('mathematics', { id: 'x', title: 't', subject: 'Physics' }), true);
});

/* ---------------- TEST 9: no material ---------------- */

test('TEST 9 — nothing relevant -> selectedId null (action throws no_material)', () => {
  const d = T.diagnoseTargetedRetrieval(WEAK_QE,
    [{ id: 'm1', title: 'Biology Notes', subject: 'Biology' }],
    { m1: 'Mitochondria generate energy through respiration.' });
  assert.equal(d.selectedId, null);
  const d2 = T.diagnoseTargetedRetrieval(WEAK_QE, [], {});
  assert.equal(d2.selectedId, null);
  assert.deepEqual(d2.stages, []);
});

/* ---------------- TEST 10: cross-user ---------------- */

test('TEST 10 — user B cannot ground on user A material', () => {
  // Ownership is enforced by the action's internal query
  // (getTargetedMaterialTexts -> filterOwnedRows): for user B the
  // texts map is empty, so nothing can be selected.
  const ownedByA = [{ _id: 'm1', userId: 'userA' }];
  assert.deepEqual(T.filterOwnedRows(ownedByA, 'userB'), [],
    'forged/guessed materialId from another account yields nothing');
  const d = T.diagnoseTargetedRetrieval(WEAK_QE,
    [{ id: 'm1', title: 'JAMB Mathematics Notes', subject: 'Mathematics' }],
    {}); // no text available to user B
  assert.equal(d.selectedId, null);
});

/* ---------------- TEST 11: A2 behavior preserved ---------------- */

test('TEST 11 — selected context still grounds the prompt; contract unchanged', () => {
  const d = T.diagnoseTargetedRetrieval(WEAK_QE,
    [{ id: 'm1', title: 'JAMB Mathematics Notes', subject: 'Mathematics' }],
    { m1: QE_TEXT });
  assert.equal(d.selectedId, 'm1');
  const passages = T.extractPassages(T.topicSearchTerms(WEAK_QE), QE_TEXT);
  const contextText = T.buildTargetedContext(passages);
  assert.ok(contextText.length > 0 && contextText.length <= T.TARGETED_MAX_CONTEXT_CHARS);
  const prompt = T.buildTargetedPrompt({
    subject: 'Mathematics', topic: 'Quadratic Equations', contextText,
    materialTitle: 'JAMB Mathematics Notes', questionCount: 8,
    difficulty: 'medium', allowedTypes: ['mcq', 'true_false', 'short_answer'],
  });
  assert.ok(prompt.includes(contextText), 'prompt grounded in the selected passages');
  assert.ok(prompt.includes('NEW'), 'novelty instruction preserved');
  assert.ok(prompt.includes('Generate exactly 8 question(s) at "medium" difficulty.'),
    '8-question medium default preserved');
});

test('TEST 11b — thresholds and caps unchanged', () => {
  assert.equal(T.TARGETED_MIN_PASSAGE_SCORE, 12, 'evidence bar unchanged');
  assert.equal(T.TARGETED_MIN_MATERIAL_SCORE, 60, 'metadata floor unchanged');
  assert.equal(T.TARGETED_MAX_MATERIALS_FETCHED, 3, 'fetch bound unchanged');
  assert.equal(T.TARGETED_MAX_CONTEXT_CHARS, 8000, 'context cap unchanged');
});

/* ---------------- diagnostics ---------------- */

test('diagnoseTargetedRetrieval exposes every decision stage', () => {
  const d = T.diagnoseTargetedRetrieval(WEAK_QE,
    [
      { id: 'm1', title: 'JAMB Mathematics Notes', subject: 'Mathematics' },
      { id: 'm2', title: 'Physics Notes', subject: 'Physics' },
    ],
    { m1: QE_TEXT, m2: QE_TEXT });
  assert.equal(d.stages.length, 2);
  const [s1, s2] = d.stages;
  for (const s of [s1, s2]) {
    assert.ok(typeof s.subjectScore === 'number', 'subject score');
    assert.ok(typeof s.titleTopicScore === 'number', 'title score');
    assert.ok(typeof s.rankScore === 'number', 'rank score');
    assert.ok(typeof s.fetchCandidate === 'boolean', 'fetch decision');
    assert.ok(s.fetchReason.length > 0, 'fetch reason');
    assert.ok(Array.isArray(s.passageScores), 'passage scores');
    assert.ok(typeof s.evidence === 'number', 'evidence score');
    assert.ok(['selected', 'rejected'].includes(s.decision), 'final decision');
    assert.ok(s.decisionReason.length > 0, 'decision reason');
  }
  assert.equal(s1.decision, 'selected');
  assert.equal(s2.decision, 'rejected');
  assert.equal(s2.subjectDecision, 'excluded');
  assert.equal(d.selectedId, 'm1');
});

test('diagnostics: the old false-negative fixture now shows where it passes', () => {
  // Case C from the bug report: singular-only text used to die at the
  // passage stage with evidence 8 < 12.
  const d = T.diagnoseTargetedRetrieval(WEAK_QE,
    [{ id: 'm1', title: 'JAMB Mathematics Notes', subject: 'Mathematics' }],
    { m1: QE_SINGULAR_TEXT });
  const s = d.stages[0];
  assert.equal(s.fetchCandidate, true);
  assert.ok(s.evidence >= 12, `evidence ${s.evidence} now clears the bar`);
  assert.equal(s.decision, 'selected');
});
